import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildStoreReadyExtensionZip,
  generateExtensionFiles,
} from './src/server/extensionBuilder.ts';
import {
  cancelTransfer,
  createTransfer,
  getTransfer,
  isBlockedHostname,
  listTransfers,
  probeRemoteUrl,
  proxyPlayRemoteStream,
  serializeTransfer,
  serveCompletedTransferFile,
  setTransferPaused,
  streamTransferToResponse,
} from './src/server/transferEngine.ts';
import {
  detectLanguageHint,
  detectQualityHint,
  normalizeRawUrlInput,
  parseAndNormalizeUrl,
  sanitizeText,
} from './src/server/urlParser.ts';
import {
  buildM3uPlaylist,
  buildVlcXspfPlaylist,
  filenameSuggestsTranscode,
  isLocalOriginUrl,
  probeMediaStreams,
  streamCompatibleMp4WithFfmpeg,
} from './src/server/mediaPlayer.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type DownloadKind =
  | 'video'
  | 'audio'
  | 'archive'
  | 'software'
  | 'document'
  | 'image'
  | 'torrent'
  | 'file';

type TransferProtocol =
  | 'HTTPS'
  | 'HTTP'
  | 'HLS/DASH'
  | 'MAGNET'
  | 'TORRENT'
  | 'FTP'
  | 'SFTP'
  | 'CLOUD';

interface HandoffItem {
  id: string;
  title: string;
  url: string;
  quality: string;
  language: string;
  subtitles?: string;
  sourcePage: string;
  estimatedSizeMb: number;
  createdAt: number;
}

const handoffQueue: HandoffItem[] = [];
const MAX_QUEUE_LENGTH = 50;
const MAX_URL_LENGTH = 16384;
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'ftp:', 'ftps:', 'sftp:']);

function isAllowedTransferUrl(raw: string): boolean {
  const norm = normalizeRawUrlInput(raw);
  if (norm.startsWith('magnet:?')) return true;
  try {
    const u = new URL(norm);
    return ALLOWED_PROTOCOLS.has(u.protocol);
  } catch {
    return false;
  }
}

function classifyUrl(
  parsed: URL,
  filename: string,
  contentType: string,
  streamType: 'hls' | 'dash' | 'progressive' | 'unknown',
  hasQualityOrLang: boolean
): {
  kind: DownloadKind;
  protocol: TransferProtocol;
  defaultContentType: string;
} {
  const lowerName = filename.toLowerCase();
  const lowerHref = parsed.href.toLowerCase();
  const host = parsed.hostname.toLowerCase();
  const lowerCt = contentType.toLowerCase();

  let protocol: TransferProtocol = parsed.protocol === 'http:' ? 'HTTP' : 'HTTPS';
  if (parsed.protocol === 'ftp:' || parsed.protocol === 'ftps:') protocol = 'FTP';
  if (parsed.protocol === 'sftp:') protocol = 'SFTP';

  if (
    /(drive\.google\.com|dropbox\.com|onedrive\.live\.com|1drv\.ms|mega\.nz|mediafire\.com|github\.com\/.+\/releases|huggingface\.co|sourceforge\.net|archive\.org|workers\.dev|pixeldrain\.com|gofile\.io)/i.test(
      lowerHref
    )
  ) {
    protocol = 'CLOUD';
  }

  if (/\.torrent(\?|$)/i.test(lowerName) || lowerCt.includes('bittorrent')) {
    return {
      kind: 'torrent',
      protocol: 'TORRENT',
      defaultContentType: 'application/x-bittorrent',
    };
  }

  if (streamType === 'hls' || streamType === 'dash') {
    return {
      kind: 'video',
      protocol: 'HLS/DASH',
      defaultContentType:
        streamType === 'hls' ? 'video/mp2t' : 'application/dash+xml',
    };
  }

  if (
    streamType === 'progressive' ||
    /\.(mp4|mkv|webm|mov|avi|flv|wmv|m4v|ts|m2ts)(\?|$)/i.test(lowerName) ||
    lowerCt.startsWith('video/') ||
    lowerCt === 'application/x-matroska' ||
    hasQualityOrLang ||
    /(youtube\.com|youtu\.be|vimeo\.com|twitch\.tv|dailymotion\.com|tiktok\.com|instagram\.com\/reel|facebook\.com\/watch|x\.com\/.*\/status|bilibili\.com|rumble\.com)/i.test(
      lowerHref
    )
  ) {
    return {
      kind: 'video',
      protocol,
      defaultContentType: lowerName.endsWith('.mkv') ? 'video/x-matroska' : 'video/mp4',
    };
  }

  if (
    /\.(mp3|flac|wav|m4a|aac|ogg|opus|wma|aiff)(\?|$)/i.test(lowerName) ||
    lowerCt.startsWith('audio/') ||
    /(soundcloud\.com|bandcamp\.com|mixcloud\.com|podcasts\.apple\.com)/i.test(host)
  ) {
    return {
      kind: 'audio',
      protocol,
      defaultContentType: 'audio/mpeg',
    };
  }

  if (
    /\.(zip|rar|7z|tar|gz|tgz|bz2|xz|zst)(\?|$)/i.test(lowerName) ||
    lowerCt.includes('zip') ||
    lowerCt.includes('compressed')
  ) {
    return {
      kind: 'archive',
      protocol,
      defaultContentType: 'application/zip',
    };
  }

  if (/\.(iso|img|dmg|exe|msi|apk|aab|deb|rpm|appimage|pkg|bin|run)(\?|$)/i.test(lowerName)) {
    return {
      kind: 'software',
      protocol,
      defaultContentType: 'application/octet-stream',
    };
  }

  if (
    /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|epub|mobi|csv|txt|md|rtf|odt)(\?|$)/i.test(lowerName) ||
    lowerCt.includes('pdf') ||
    lowerCt.includes('document') ||
    lowerCt.startsWith('text/')
  ) {
    return {
      kind: 'document',
      protocol,
      defaultContentType: 'application/pdf',
    };
  }

  if (
    /\.(png|jpg|jpeg|webp|gif|svg|bmp|tiff|tif|heic|raw|psd|ai|fig|ico)(\?|$)/i.test(lowerName) ||
    lowerCt.startsWith('image/')
  ) {
    return {
      kind: 'image',
      protocol,
      defaultContentType: 'image/png',
    };
  }

  return {
    kind: 'file',
    protocol,
    defaultContentType: 'application/octet-stream',
  };
}

async function inspectSingleUrl(rawUrl: string) {
  const normalized = normalizeRawUrlInput(rawUrl);
  if (!normalized || normalized.length > MAX_URL_LENGTH) {
    throw new Error('Provide a valid download URL.');
  }

  if (normalized.startsWith('magnet:?')) {
    const params = new URLSearchParams(normalized.slice('magnet:?'.length));
    const dn = sanitizeText(params.get('dn'), 180, 'Magnet_Download');
    return {
      kind: 'torrent' as DownloadKind,
      protocol: 'MAGNET' as TransferProtocol,
      url: normalized,
      filename: dn,
      domain: 'bittorrent.dht',
      sizeBytes: 0,
      acceptRanges: false,
      contentType: 'application/x-bittorrent',
      verifiedLive: false,
      probeError: 'Magnet links require a BitTorrent client on your device.',
      torrentFiles: [],
    };
  }

  const parsedMeta = parseAndNormalizeUrl(normalized);
  const { parsed } = parsedMeta;

  if (isBlockedHostname(parsed.hostname)) {
    throw new Error('Local or private network addresses are blocked.');
  }

  let cleanName = parsedMeta.extractedFilename;
  const qualityParam = sanitizeText(
    parsed.searchParams.get('mochidrop_quality') || parsed.searchParams.get('plexo_quality'),
    40,
    ''
  );
  const langParam = sanitizeText(
    parsed.searchParams.get('mochidrop_lang') || parsed.searchParams.get('plexo_lang'),
    60,
    ''
  );

  let sizeBytes = 0;
  let liveContentType = '';
  let acceptRanges = false;
  let verifiedLive = false;
  let httpStatus = 0;
  let probeError: string | null = null;
  let streamType = parsedMeta.streamType;
  let redirectHops = 0;
  let hlsSegmentCount: number | undefined;
  let hlsDurationSec: number | undefined;
  let hlsVariants:
    | Array<{ label: string; url: string; bandwidth: number; resolution?: string }>
    | undefined;
  let hlsAudioLanguages: string[] | undefined;

  let resolvedUrl = parsed.href;
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    const probe = await probeRemoteUrl(parsed.href);
    resolvedUrl = probe.finalUrl || parsed.href;
    sizeBytes = probe.totalBytes;
    liveContentType = probe.contentType;
    acceptRanges = probe.acceptRanges;
    verifiedLive = probe.verifiedLive;
    httpStatus = probe.httpStatus;
    probeError = probe.probeError;
    streamType = probe.streamType;
    redirectHops = probe.redirectHops;
    hlsSegmentCount = probe.hlsSegmentCount;
    hlsDurationSec = probe.hlsDurationSec;
    hlsVariants = probe.hlsVariants;
    hlsAudioLanguages = probe.hlsAudioLanguages;
    if (probe.contentDispositionFilename) {
      cleanName = probe.contentDispositionFilename;
    }
    if (streamType === 'hls') {
      cleanName = cleanName.replace(/\.m3u8$/i, '') + (/\.(?:ts|mp4)$/i.test(cleanName) ? '' : '.ts');
    }
  } else {
    probeError = `${parsed.protocol.replace(':', '').toUpperCase()} links require an external FTP/SFTP client.`;
  }

  const detectedQuality = qualityParam || detectQualityHint(cleanName) || parsedMeta.qualityHint;
  const detectedLang = langParam || detectLanguageHint(cleanName) || parsedMeta.languageHint;

  const classified = classifyUrl(
    parsed,
    cleanName,
    liveContentType,
    streamType,
    Boolean(detectedQuality || detectedLang)
  );

  const contentType = liveContentType || classified.defaultContentType;

  // Build ONLY real qualities & languages from the source link or real HLS master manifest
  let finalQuality: string | undefined;
  let availableQualities: string[] = [];
  let variantUrls: Record<string, string> | undefined;

  if (classified.kind === 'video') {
    if (hlsVariants && hlsVariants.length > 0) {
      availableQualities = hlsVariants.map((v) => v.label);
      variantUrls = Object.fromEntries(hlsVariants.map((v) => [v.label, v.url]));
      finalQuality = availableQualities[0];
    } else {
      finalQuality = detectedQuality || 'Source Quality';
      availableQualities = [finalQuality];
    }
  } else if (classified.kind === 'audio') {
    const extMatch = cleanName.match(/\.([a-z0-9]{2,5})$/i);
    finalQuality = extMatch ? extMatch[1].toUpperCase() : 'Source Format';
    availableQualities = [finalQuality];
  }

  let finalLanguage: string | undefined;
  let availableLanguages: string[] = [];

  if (classified.kind === 'video') {
    if (hlsAudioLanguages && hlsAudioLanguages.length > 0) {
      availableLanguages = hlsAudioLanguages;
      finalLanguage = hlsAudioLanguages[0];
    } else {
      finalLanguage = detectedLang || 'Source Audio';
      availableLanguages = [finalLanguage];
    }
  }

  return {
    kind: classified.kind,
    protocol: classified.protocol,
    url: parsed.href,
    resolvedUrl,
    filename: cleanName,
    domain: parsed.hostname,
    sizeBytes,
    acceptRanges,
    contentType,
    verifiedLive,
    httpStatus: httpStatus || undefined,
    probeError,
    streamType,
    redirectHops,
    hlsSegmentCount,
    hlsDurationSec,
    quality: finalQuality,
    language: finalLanguage,
    availableLanguages,
    availableQualities,
    variantUrls,
  };
}

function resolveAppOrigin(req: express.Request): string {
  const configured = process.env.APP_URL?.trim();
  if (configured && /^https?:\/\//i.test(configured)) {
    return configured.replace(/\/+$/, '');
  }
  const proto = req.headers['x-forwarded-proto']?.toString().split(',')[0] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host']?.toString().split(',')[0] || req.get('host') || 'localhost:3000';
  return `${proto}://${host}`;
}

async function startServer() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '512kb' }));

  app.use('/api/extension', (req, res, next) => {
    const origin = req.headers.origin;
    if (
      origin &&
      (origin.startsWith('chrome-extension://') ||
        origin.startsWith('moz-extension://') ||
        origin.startsWith('http://localhost:') ||
        origin.startsWith('http://127.0.0.1:') ||
        origin === resolveAppOrigin(req))
    ) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'mochidrop' });
  });

  app.post('/api/inspect', async (req, res) => {
    const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    try {
      const result = await inspectSingleUrl(rawUrl);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Could not inspect URL' });
    }
  });

  app.post('/api/inspect-batch', async (req, res) => {
    const rawList = Array.isArray(req.body?.urls) ? req.body.urls : [];
    const urls = rawList
      .filter((u: unknown): u is string => typeof u === 'string' && u.trim().length > 0)
      .slice(0, 25);

    if (urls.length === 0) {
      res.status(400).json({ error: 'Provide at least one valid link.' });
      return;
    }

    const items = [];
    const errors: Array<{ url: string; error: string }> = [];

    for (const u of urls) {
      try {
        items.push(await inspectSingleUrl(u));
      } catch (err) {
        errors.push({ url: u, error: err instanceof Error ? err.message : 'Invalid URL' });
      }
    }

    res.json({ items, errors });
  });

  // Real In-App Download Transfer Engine API (downloads directly into MochiDrop app storage)
  app.post('/api/transfers', async (req, res) => {
    const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    const filename = sanitizeText(req.body?.filename, 180, 'download.bin');
    const kind = sanitizeText(req.body?.kind, 32, 'file');
    const requestedQuality =
      typeof req.body?.quality === 'string' ? sanitizeText(req.body.quality, 48, '') : undefined;
    const requestedLanguage =
      typeof req.body?.language === 'string' ? sanitizeText(req.body.language, 64, '') : undefined;
    const chunkSizeMb = Number(req.body?.chunkSizeMb || 4);
    const parallelStreams = Number(req.body?.parallelStreams || 4);
    const speedCapMbps =
      req.body?.speedCapMbps !== undefined && req.body?.speedCapMbps !== null
        ? Number(req.body.speedCapMbps)
        : null;
    const autoStart = req.body?.autoStart !== false;

    if (!rawUrl || rawUrl.length > MAX_URL_LENGTH) {
      res.status(400).json({ error: 'Valid HTTP/HTTPS download URL is required.' });
      return;
    }

    try {
      const expectedBinary = kind !== 'document';
      const transfer = await createTransfer({
        url: rawUrl,
        filename,
        expectedBinary,
        chunkSizeMb,
        parallelStreams,
        speedCapMbps,
        requestedQuality,
        requestedLanguage,
        autoStart,
      });
      res.status(201).json({
        transfer: serializeTransfer(transfer),
        canStream: transfer.status !== 'error',
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Could not start transfer.',
      });
    }
  });

  app.get('/api/transfers', (_req, res) => {
    res.json({ transfers: listTransfers() });
  });

  app.get('/api/transfers/:id/file', async (req, res) => {
    const rec = getTransfer(req.params.id);
    if (!rec) {
      res.status(404).json({ error: 'Downloaded file session not found.' });
      return;
    }
    try {
      await serveCompletedTransferFile(rec, req, res);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          error: err instanceof Error ? err.message : 'Could not open downloaded file.',
        });
      } else if (!res.writableEnded) {
        res.destroy();
      }
    }
  });

  function resolveExternalVlcTarget(req: express.Request, rec: ReturnType<typeof getTransfer>): string {
    if (!rec) return '';
    const origin = resolveAppOrigin(req);
    // On localhost, VLC can stream directly from the completed file on local disk.
    // On cloud/hosted origins (e.g. *.run.app behind Google auth), VLC on the user's PC
    // MUST receive the direct public media URL so it connects straight to the media host.
    if (isLocalOriginUrl(origin) && rec.savedOnDisk && req.query.mode !== 'source') {
      return `${origin}/api/transfers/${encodeURIComponent(rec.id)}/file`;
    }
    return rec.resolvedUrl || rec.url;
  }

  function buildTransferUpstreamHeaders(rec: NonNullable<ReturnType<typeof getTransfer>>): Record<string, string> {
    const h: Record<string, string> = {};
    const cookieStr = Object.entries(rec.cookies || {})
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    if (cookieStr) h.Cookie = cookieStr;
    if (rec.referer) h.Referer = rec.referer;
    return h;
  }

  // Generates a universal .m3u playlist file for VLC, MPV, IINA, PotPlayer, etc.
  app.get('/api/transfers/:id/playlist.m3u', (req, res) => {
    const rec = getTransfer(req.params.id);
    if (!rec) {
      res.status(404).json({ error: 'Transfer not found.' });
      return;
    }
    const streamTarget = resolveExternalVlcTarget(req, rec);
    const fileStem = rec.filename.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 96) || 'mochidrop_stream';
    const m3uBody = buildM3uPlaylist(rec.filename, streamTarget);

    res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileStem}.m3u"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(m3uBody);
  });

  // Generates VLC's native .xspf XML playlist file (with network caching tuned for smooth movie streaming)
  app.get('/api/transfers/:id/playlist.xspf', (req, res) => {
    const rec = getTransfer(req.params.id);
    if (!rec) {
      res.status(404).json({ error: 'Transfer not found.' });
      return;
    }
    const streamTarget = resolveExternalVlcTarget(req, rec);
    const fileStem = rec.filename.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 96) || 'mochidrop_stream';
    const xspfBody = buildVlcXspfPlaylist(rec.filename, streamTarget);

    res.setHeader('Content-Type', 'application/xspf+xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileStem}.xspf"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(xspfBody);
  });

  // Media stream inspector via ffprobe (detects duration, codecs, Dual Audio tracks, and transcode need)
  app.get('/api/play/probe', async (req, res) => {
    const transferId = typeof req.query.transferId === 'string' ? req.query.transferId.trim() : '';
    const rawUrl = typeof req.query.url === 'string' ? req.query.url.trim() : '';

    let input = '';
    let headers: Record<string, string> | undefined;
    let filename = 'stream.mp4';
    let contentType = '';
    let directStreamUrl = '';

    if (transferId) {
      const rec = getTransfer(transferId);
      if (!rec) {
        res.status(404).json({ error: 'Transfer not found.' });
        return;
      }
      filename = rec.filename;
      contentType = rec.contentType;
      directStreamUrl = resolveExternalVlcTarget(req, rec);
      if (rec.savedOnDisk && rec.filePath) {
        input = rec.filePath;
      } else {
        input = rec.resolvedUrl || rec.url;
        headers = buildTransferUpstreamHeaders(rec);
      }
    } else if (rawUrl && rawUrl.length <= MAX_URL_LENGTH) {
      try {
        const parsedMeta = parseAndNormalizeUrl(rawUrl);
        if (parsedMeta.parsed.protocol !== 'http:' && parsedMeta.parsed.protocol !== 'https:') {
          res.status(400).json({ error: 'Only HTTP/HTTPS links can be played.' });
          return;
        }
        if (isBlockedHostname(parsedMeta.parsed.hostname)) {
          res.status(403).json({ error: 'Local or private addresses are blocked.' });
          return;
        }
        input = parsedMeta.normalizedUrl;
        filename = parsedMeta.extractedFilename;
        directStreamUrl = parsedMeta.normalizedUrl;
      } catch {
        res.status(400).json({ error: 'Invalid media URL.' });
        return;
      }
    } else {
      res.status(400).json({ error: 'Provide either transferId or url.' });
      return;
    }

    try {
      const info = await probeMediaStreams(input, headers);
      res.json({
        ...info,
        filename,
        directStreamUrl,
      });
    } catch {
      res.json({
        durationSec: 0,
        videoCodec: '',
        videoPixFmt: '',
        width: 0,
        height: 0,
        audioTracks: [],
        hasVideo: true,
        hasAudio: true,
        needsTranscode: filenameSuggestsTranscode(filename, contentType),
        filename,
        directStreamUrl,
      });
    }
  });

  // Universal media playback endpoint:
  // - mode=direct: native HTTP Range stream with corrected playable MIME type
  // - mode=compat: real-time ffmpeg fragmented MP4 remux/transcode (fixes MKV, HEVC, AC3/EAC3/DTS, Dual Audio, AVI, TS, HLS!)
  app.get('/api/play/stream', async (req, res) => {
    const transferId = typeof req.query.transferId === 'string' ? req.query.transferId.trim() : '';
    const rawUrl = typeof req.query.url === 'string' ? req.query.url.trim() : '';
    const mode = typeof req.query.mode === 'string' ? req.query.mode.trim().toLowerCase() : 'auto';
    const startSec = Math.max(0, Number(req.query.start || 0) || 0);
    const audioTrack = Math.max(0, Math.floor(Number(req.query.audioTrack || 0) || 0));
    const vcodec = typeof req.query.vcodec === 'string' ? req.query.vcodec.trim().toLowerCase() : '';
    const pixfmt = typeof req.query.pixfmt === 'string' ? req.query.pixfmt.trim().toLowerCase() : '';
    const hasVideo = req.query.hasVideo !== '0';

    if (transferId) {
      const rec = getTransfer(transferId);
      if (!rec) {
        res.status(404).json({ error: 'Transfer not found.' });
        return;
      }
      const useCompat =
        mode === 'compat' ||
        (mode === 'auto' && filenameSuggestsTranscode(rec.filename, rec.contentType));

      if (!useCompat) {
        await serveCompletedTransferFile(rec, req, res);
        return;
      }

      const input = rec.savedOnDisk && rec.filePath ? rec.filePath : rec.resolvedUrl || rec.url;
      const headers = rec.savedOnDisk ? undefined : buildTransferUpstreamHeaders(rec);
      streamCompatibleMp4WithFfmpeg({
        input,
        req,
        res,
        startSec,
        audioTrackIndex: audioTrack,
        videoCodec: vcodec,
        videoPixFmt: pixfmt,
        hasVideo,
        headers,
      });
      return;
    }

    if (!rawUrl || rawUrl.length > MAX_URL_LENGTH) {
      res.status(400).json({ error: 'Valid HTTP/HTTPS media URL is required.' });
      return;
    }

    let parsedMeta;
    try {
      parsedMeta = parseAndNormalizeUrl(rawUrl);
    } catch {
      res.status(400).json({ error: 'Invalid media URL.' });
      return;
    }
    if (parsedMeta.parsed.protocol !== 'http:' && parsedMeta.parsed.protocol !== 'https:') {
      res.status(400).json({ error: 'Only HTTP/HTTPS streams can be played.' });
      return;
    }
    if (isBlockedHostname(parsedMeta.parsed.hostname)) {
      res.status(403).json({ error: 'Local or private addresses are blocked.' });
      return;
    }

    const useCompat =
      mode === 'compat' ||
      (mode === 'auto' && filenameSuggestsTranscode(parsedMeta.extractedFilename));

    if (!useCompat) {
      await proxyPlayRemoteStream(parsedMeta.normalizedUrl, req, res, undefined, null, parsedMeta.extractedFilename);
      return;
    }

    streamCompatibleMp4WithFfmpeg({
      input: parsedMeta.normalizedUrl,
      req,
      res,
      startSec,
      audioTrackIndex: audioTrack,
      videoCodec: vcodec,
      videoPixFmt: pixfmt,
      hasVideo,
    });
  });

  // Online stream playback proxy (SSRF-safe with HTTP Range support for instant streaming)
  app.get('/api/play/proxy', async (req, res) => {
    const rawUrl = typeof req.query.url === 'string' ? req.query.url.trim() : '';
    if (!rawUrl || rawUrl.length > MAX_URL_LENGTH) {
      res.status(400).json({ error: 'Valid HTTP/HTTPS media URL is required.' });
      return;
    }
    await proxyPlayRemoteStream(rawUrl, req, res);
  });

  // Generates a universal .m3u playlist for any pasted link so VLC / external players stream it directly
  app.get('/api/play/playlist.m3u', (req, res) => {
    const rawUrl = typeof req.query.url === 'string' ? req.query.url.trim() : '';
    const title = sanitizeText(req.query.title, 140, 'MochiDrop Online Stream');
    if (!rawUrl || rawUrl.length > MAX_URL_LENGTH || !/^https?:\/\//i.test(rawUrl)) {
      res.status(400).json({ error: 'Valid HTTP/HTTPS media URL is required.' });
      return;
    }
    const fileStem = title.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 96) || 'mochidrop_stream';
    const m3uBody = buildM3uPlaylist(title, rawUrl);

    res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileStem}.m3u"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(m3uBody);
  });

  // Generates VLC's native .xspf XML playlist for any pasted online link
  app.get('/api/play/playlist.xspf', (req, res) => {
    const rawUrl = typeof req.query.url === 'string' ? req.query.url.trim() : '';
    const title = sanitizeText(req.query.title, 140, 'MochiDrop Online Stream');
    if (!rawUrl || rawUrl.length > MAX_URL_LENGTH || !/^https?:\/\//i.test(rawUrl)) {
      res.status(400).json({ error: 'Valid HTTP/HTTPS media URL is required.' });
      return;
    }
    const fileStem = title.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 96) || 'mochidrop_stream';
    const xspfBody = buildVlcXspfPlaylist(title, rawUrl);

    res.setHeader('Content-Type', 'application/xspf+xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileStem}.xspf"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(xspfBody);
  });

  app.get('/api/transfers/:id/stream', async (req, res) => {
    const rec = getTransfer(req.params.id);
    if (!rec) {
      res.status(404).json({ error: 'Transfer session not found or expired.' });
      return;
    }
    try {
      await streamTransferToResponse(rec, req, res);
    } catch (err) {
      if (!res.headersSent) {
        res.status(502).json({
          error: err instanceof Error ? err.message : 'Download stream error.',
        });
      } else if (!res.writableEnded) {
        res.destroy();
      }
    }
  });

  app.post('/api/transfers/:id/pause', (req, res) => {
    const rec = setTransferPaused(req.params.id, true);
    if (!rec) {
      res.status(404).json({ error: 'Transfer not found.' });
      return;
    }
    res.json({ transfer: serializeTransfer(rec) });
  });

  app.post('/api/transfers/:id/resume', (req, res) => {
    const rec = setTransferPaused(req.params.id, false);
    if (!rec) {
      res.status(404).json({ error: 'Transfer not found.' });
      return;
    }
    res.json({ transfer: serializeTransfer(rec) });
  });

  app.delete('/api/transfers/:id', (req, res) => {
    cancelTransfer(req.params.id);
    res.json({ ok: true });
  });

  app.post('/api/extension/handoff', (req, res) => {
    const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    const normalized = normalizeRawUrlInput(rawUrl);
    if (!normalized || normalized.length > MAX_URL_LENGTH || !isAllowedTransferUrl(normalized)) {
      res.status(400).json({ error: 'Valid download URL is required.' });
      return;
    }

    const item: HandoffItem = {
      id: `ext-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      title: sanitizeText(req.body?.title, 180, 'Browser Captured Download'),
      url: normalized,
      quality: sanitizeText(req.body?.quality, 40, 'Original'),
      language: sanitizeText(req.body?.language, 64, 'Original Audio'),
      subtitles: sanitizeText(req.body?.subtitles, 64, ''),
      sourcePage: sanitizeText(req.body?.sourcePage, 500, ''),
      estimatedSizeMb: Math.max(0, Math.min(18000, Number(req.body?.estimatedSizeMb) || 0)),
      createdAt: Date.now(),
    };

    handoffQueue.push(item);
    if (handoffQueue.length > MAX_QUEUE_LENGTH) {
      handoffQueue.shift();
    }

    res.status(201).json({ ok: true, item });
  });

  app.get('/api/extension/handoff', (req, res) => {
    const since = Number(req.query.since || 0);
    const items = handoffQueue.filter((item) => item.createdAt > since);
    res.json({ items, serverTime: Date.now() });
  });

  function isAuthorizedOwnerExtensionRequest(req: express.Request): boolean {
    const configuredKey = process.env.MOCHIDROP_OWNER_KEY?.trim() || '';
    // Fail closed: unless the owner explicitly sets a strong private key in .env, never serve the extension over HTTP.
    if (configuredKey.length < 12) return false;
    const headerVal = req.headers['x-mochidrop-owner-key'];
    const provided =
      (typeof headerVal === 'string' ? headerVal : Array.isArray(headerVal) ? headerVal[0] : '') ||
      (typeof req.query.key === 'string' ? req.query.key : '');
    if (!provided) return false;
    const expectedBuf = Buffer.from(configuredKey, 'utf8');
    const providedBuf = Buffer.from(provided.trim(), 'utf8');
    if (expectedBuf.length !== providedBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, providedBuf);
  }

  // Owner-only private endpoints (returns 404 for all public users)
  app.get('/api/extension/files', (req, res) => {
    if (!isAuthorizedOwnerExtensionRequest(req)) {
      res.status(404).json({ error: 'Not found.' });
      return;
    }
    const origin = resolveAppOrigin(req);
    const files = generateExtensionFiles({ plexoOrigin: origin, name: 'MochiDrop' });
    res.json({ origin, files });
  });

  app.get('/api/extension/download', (req, res) => {
    if (!isAuthorizedOwnerExtensionRequest(req)) {
      res.status(404).json({ error: 'Not found.' });
      return;
    }
    const customOrigin =
      typeof req.query.origin === 'string' && /^https?:\/\//i.test(req.query.origin.trim())
        ? req.query.origin.trim().replace(/\/+$/, '')
        : resolveAppOrigin(req);
    const { filename, buffer } = buildStoreReadyExtensionZip({
      plexoOrigin: customOrigin,
      name: 'MochiDrop',
    });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = fs.existsSync(path.join(__dirname, 'index.html'))
      ? __dirname
      : path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const PORT = Number(process.env.PORT || 3000) || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  if (msg.includes('Transfer aborted') || msg.includes('Client disconnected') || msg.includes('AbortError')) {
    return;
  }
  console.error('[server] Unhandled promise rejection:', msg);
});

startServer();
