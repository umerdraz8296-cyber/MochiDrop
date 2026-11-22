import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { Innertube } from 'youtubei.js';
import type { TransferRecord } from './transferEngine.ts';
import {
  DOWNLOADS_DIR,
  recordBytesSent,
  safeFetchWithRedirects,
  sanitizeFilenameForHeader,
  sleep,
  updateChunkMapFromProgress,
  waitWhilePaused,
} from './transferEngine.ts';

const execFileAsync = promisify(execFile);

const ALLOWED_YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
]);

const PLAYLIST_ID_REGEX = /^[A-Za-z0-9_-]{10,64}$/;
const VIDEO_ID_REGEX = /^[A-Za-z0-9_-]{11}$/;
const MAX_PLAYLIST_ITEMS = 200;

export interface YouTubeResolutionOption {
  id: string;
  label: string;
  height: number; // 0 for audio-only
  kind: 'video' | 'audio';
  badge?: string;
}

export interface YouTubePlaylistVideoItem {
  videoId: string;
  url: string;
  title: string;
  author: string;
  durationText: string;
  durationSec: number;
  thumbnailUrl: string;
  index: number;
  playlistTitle: string;
}

export interface YouTubePlaylistInspectResult {
  playlistId: string;
  playlistUrl: string;
  title: string;
  author: string;
  videoCount: number;
  totalDurationSec: number;
  videos: YouTubePlaylistVideoItem[];
  availableResolutions: YouTubeResolutionOption[];
  resolutionsSource: 'probed' | 'standard';
  truncated: boolean;
}

export const STANDARD_YOUTUBE_RESOLUTIONS: YouTubeResolutionOption[] = [
  { id: '2160p', label: '2160p (4K)', height: 2160, kind: 'video', badge: '4K' },
  { id: '1440p', label: '1440p (2K)', height: 1440, kind: 'video', badge: '2K' },
  { id: '1080p', label: '1080p (Full HD)', height: 1080, kind: 'video', badge: 'FHD' },
  { id: '720p', label: '720p (HD)', height: 720, kind: 'video', badge: 'HD' },
  { id: '480p', label: '480p (SD)', height: 480, kind: 'video' },
  { id: '360p', label: '360p', height: 360, kind: 'video' },
  { id: 'audio', label: 'Audio Only (M4A)', height: 0, kind: 'audio', badge: 'Audio' },
];

let cachedInnertube: Innertube | null = null;
let cachedYtDlpPath: string | null | undefined = undefined;

async function getInnertube(): Promise<Innertube> {
  if (cachedInnertube) return cachedInnertube;
  const cookie = process.env.MOCHIDROP_YT_COOKIES?.trim() || undefined;
  cachedInnertube = await Innertube.create({
    retrieve_player: true,
    cookie,
  });
  return cachedInnertube;
}

async function detectYtDlpBinary(): Promise<string | null> {
  if (cachedYtDlpPath !== undefined) return cachedYtDlpPath;
  const candidates = process.platform === 'win32' ? ['yt-dlp.exe', 'yt-dlp'] : ['yt-dlp'];
  for (const bin of candidates) {
    try {
      await execFileAsync(bin, ['--version'], { timeout: 3000 });
      cachedYtDlpPath = bin;
      return bin;
    } catch {
      // try next
    }
  }
  cachedYtDlpPath = null;
  return null;
}

export function isYouTubeHost(hostname: string): boolean {
  return ALLOWED_YOUTUBE_HOSTS.has(hostname.toLowerCase());
}

export function extractYouTubePlaylistId(rawInput: string): string | null {
  const trimmed = rawInput.trim();
  if (!trimmed) return null;

  // Allow direct playlist ID (e.g., PL..., OLAK5uy_..., UU..., RD...)
  if (PLAYLIST_ID_REGEX.test(trimmed) && /^(PL|UU|FL|LL|WL|OLAK|RD|EL|CL)/i.test(trimmed)) {
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    if (!isYouTubeHost(parsed.hostname)) return null;
    const listParam = parsed.searchParams.get('list')?.trim();
    if (listParam && PLAYLIST_ID_REGEX.test(listParam)) {
      return listParam;
    }
  } catch {
    return null;
  }
  return null;
}

export function extractYouTubeVideoId(rawInput: string): string | null {
  const trimmed = rawInput.trim();
  if (!trimmed) return null;
  if (VIDEO_ID_REGEX.test(trimmed)) return trimmed;

  try {
    const parsed = new URL(trimmed);
    if (!isYouTubeHost(parsed.hostname)) return null;
    const host = parsed.hostname.toLowerCase();
    if (host === 'youtu.be' || host === 'www.youtu.be') {
      const seg = parsed.pathname.split('/').filter(Boolean)[0];
      return seg && VIDEO_ID_REGEX.test(seg) ? seg : null;
    }
    const vParam = parsed.searchParams.get('v')?.trim();
    if (vParam && VIDEO_ID_REGEX.test(vParam)) return vParam;
    const parts = parsed.pathname.split('/').filter(Boolean);
    if ((parts[0] === 'shorts' || parts[0] === 'embed' || parts[0] === 'live') && parts[1] && VIDEO_ID_REGEX.test(parts[1])) {
      return parts[1];
    }
  } catch {
    return null;
  }
  return null;
}

export function isYouTubeVideoUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl.trim());
    if (!isYouTubeHost(parsed.hostname)) return false;
    return Boolean(extractYouTubeVideoId(rawUrl));
  } catch {
    return false;
  }
}

export function isYouTubePlaylistUrl(rawUrl: string): boolean {
  return Boolean(extractYouTubePlaylistId(rawUrl));
}

function parseDurationToSeconds(text: string): number {
  const cleaned = text.trim();
  if (!cleaned) return 0;
  const parts = cleaned.split(':').map((p) => Number(p));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return 0;
}

function formatDurationClock(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0:00';
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

function extractTextFromNode(node: unknown): string {
  if (!node) return '';
  if (typeof node === 'string') return node.trim();
  if (typeof node === 'object') {
    const rec = node as Record<string, unknown>;
    if (typeof rec.text === 'string') return rec.text.trim();
    if (typeof rec.simpleText === 'string') return rec.simpleText.trim();
    if (Array.isArray(rec.runs)) {
      return rec.runs
        .map((r) => (r && typeof (r as Record<string, unknown>).text === 'string' ? (r as Record<string, unknown>).text : ''))
        .join('')
        .trim();
    }
    if (typeof (rec as { toString?: () => string }).toString === 'function') {
      const str = String(rec);
      if (str && str !== '[object Object]') return str.trim();
    }
  }
  return '';
}

function normalizePlaylistNode(raw: unknown, index: number, playlistTitle: string): YouTubePlaylistVideoItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const node = raw as Record<string, unknown>;

  // Supports both classic PlaylistVideo and newer YouTube LockupView renderers
  const candidateId =
    (typeof node.id === 'string' && node.id) ||
    (typeof node.content_id === 'string' && node.content_id) ||
    (typeof node.video_id === 'string' && node.video_id) ||
    '';

  if (!VIDEO_ID_REGEX.test(candidateId)) return null;

  const meta = (node.metadata as Record<string, unknown> | undefined) || {};
  const title =
    extractTextFromNode(node.title) ||
    extractTextFromNode(meta.title) ||
    `YouTube Video ${index}`;

  let author = '';
  if (node.author && typeof node.author === 'object') {
    author = extractTextFromNode((node.author as Record<string, unknown>).name);
  }
  if (!author) {
    const innerMeta = meta.metadata as Record<string, unknown> | undefined;
    const rows = Array.isArray(innerMeta?.metadata_rows) ? innerMeta.metadata_rows : [];
    const firstRow = rows[0] as Record<string, unknown> | undefined;
    const firstPart = Array.isArray(firstRow?.metadata_parts)
      ? (firstRow.metadata_parts[0] as Record<string, unknown> | undefined)
      : undefined;
    author = extractTextFromNode(firstPart?.text) || 'YouTube';
  }

  let durationText = '';
  let durationSec = 0;
  if (node.duration && typeof node.duration === 'object') {
    const durObj = node.duration as Record<string, unknown>;
    durationText = extractTextFromNode(durObj.text);
    durationSec = typeof durObj.seconds === 'number' ? durObj.seconds : parseDurationToSeconds(durationText);
  }
  if (!durationText && durationSec > 0) {
    durationText = formatDurationClock(durationSec);
  }

  let thumbnailUrl = `https://i.ytimg.com/vi/${candidateId}/hqdefault.jpg`;
  const thumbList = Array.isArray(node.thumbnails)
    ? node.thumbnails
    : Array.isArray((node.content_image as Record<string, unknown> | undefined)?.image)
    ? ((node.content_image as Record<string, unknown>).image as unknown[])
    : [];
  const firstThumb = thumbList[0] as Record<string, unknown> | undefined;
  if (firstThumb && typeof firstThumb.url === 'string' && /^https:\/\//i.test(firstThumb.url)) {
    thumbnailUrl = firstThumb.url;
  }

  return {
    videoId: candidateId,
    url: `https://www.youtube.com/watch?v=${candidateId}`,
    title,
    author,
    durationText: durationText || '--:--',
    durationSec,
    thumbnailUrl,
    index,
    playlistTitle,
  };
}

function buildResolutionOptionsFromHeights(heights: number[]): YouTubeResolutionOption[] {
  const unique = Array.from(new Set(heights.filter((h) => h >= 144))).sort((a, b) => b - a);
  if (unique.length === 0) return STANDARD_YOUTUBE_RESOLUTIONS;

  const list: YouTubeResolutionOption[] = unique.map((h) => {
    const badge =
      h >= 2160 ? '4K' : h >= 1440 ? '2K' : h >= 1080 ? 'FHD' : h >= 720 ? 'HD' : undefined;
    const suffix =
      h >= 2160 ? ' (4K)' : h >= 1440 ? ' (2K)' : h >= 1080 ? ' (Full HD)' : h >= 720 ? ' (HD)' : '';
    return {
      id: `${h}p`,
      label: `${h}p${suffix}`,
      height: h,
      kind: 'video',
      badge,
    };
  });

  list.push({ id: 'audio', label: 'Audio Only (M4A)', height: 0, kind: 'audio', badge: 'Audio' });
  return list;
}

async function probeSampleVideoResolutions(
  yt: Innertube,
  videoId: string
): Promise<{ resolutions: YouTubeResolutionOption[]; source: 'probed' | 'standard' }> {
  // 1. Try yt-dlp JSON format list if installed on host machine (fast & authoritative on PC)
  const ytDlp = await detectYtDlpBinary();
  if (ytDlp) {
    try {
      const { stdout } = await execFileAsync(
        ytDlp,
        ['--dump-single-json', '--no-playlist', '--no-warnings', '--', `https://www.youtube.com/watch?v=${videoId}`],
        { timeout: 12000, maxBuffer: 8 * 1024 * 1024 }
      );
      const parsed = JSON.parse(stdout) as { formats?: Array<{ height?: number; vcodec?: string }> };
      const heights = (parsed.formats || [])
        .filter((f) => f.vcodec && f.vcodec !== 'none' && typeof f.height === 'number' && f.height >= 144)
        .map((f) => f.height!);
      if (heights.length > 0) {
        return { resolutions: buildResolutionOptionsFromHeights(heights), source: 'probed' };
      }
    } catch {
      // fall through to Innertube
    }
  }

  // 2. Try youtubei.js Innertube clients
  const clients = ['IOS', 'ANDROID', 'ANDROID_VR', 'TV', 'WEB'] as const;
  for (const client of clients) {
    try {
      const info = await yt.getBasicInfo(videoId, { client: client as never });
      const allFormats = [
        ...(info.streaming_data?.formats || []),
        ...(info.streaming_data?.adaptive_formats || []),
      ] as Array<{ has_video?: boolean; height?: number }>;
      const heights = allFormats
        .filter((f) => f.has_video && typeof f.height === 'number' && f.height >= 144)
        .map((f) => f.height!);
      if (heights.length > 0) {
        return { resolutions: buildResolutionOptionsFromHeights(heights), source: 'probed' };
      }
    } catch {
      // try next client
    }
  }

  return { resolutions: STANDARD_YOUTUBE_RESOLUTIONS, source: 'standard' };
}

/**
 * Inspects one YouTube playlist (handling continuation pages up to MAX_PLAYLIST_ITEMS)
 * and probes available resolutions for the whole playlist session.
 */
export async function inspectYouTubePlaylist(rawUrlOrId: string): Promise<YouTubePlaylistInspectResult> {
  const playlistId = extractYouTubePlaylistId(rawUrlOrId);
  if (!playlistId) {
    throw new Error('Provide a valid YouTube playlist link (containing ?list=...) or playlist ID.');
  }

  const yt = await getInnertube();
  let playlist = await yt.getPlaylist(playlistId);

  const playlistTitle = extractTextFromNode(playlist.info?.title) || `YouTube Playlist (${playlistId.slice(0, 8)})`;
  const author =
    extractTextFromNode((playlist.info?.author as unknown as { name?: unknown } | undefined)?.name) ||
    'YouTube';

  const seenIds = new Set<string>();
  const videos: YouTubePlaylistVideoItem[] = [];
  let truncated = false;

  const collectFromPage = (items: unknown[]) => {
    for (const raw of items) {
      if (videos.length >= MAX_PLAYLIST_ITEMS) {
        truncated = true;
        return;
      }
      const normalized = normalizePlaylistNode(raw, videos.length + 1, playlistTitle);
      if (normalized && !seenIds.has(normalized.videoId)) {
        seenIds.add(normalized.videoId);
        videos.push(normalized);
      }
    }
  };

  collectFromPage((playlist.videos as unknown[]) || (playlist.items as unknown[]) || []);

  // Follow playlist continuation pages (up to 4 extra pages / 200 items)
  let pages = 0;
  while (playlist.has_continuation && videos.length < MAX_PLAYLIST_ITEMS && pages < 4) {
    try {
      playlist = await playlist.getContinuation();
      collectFromPage((playlist.videos as unknown[]) || (playlist.items as unknown[]) || []);
      pages += 1;
    } catch {
      break;
    }
  }

  if (videos.length === 0) {
    throw new Error('This YouTube playlist is private, empty, or unavailable.');
  }

  const totalDurationSec = videos.reduce((acc, v) => acc + v.durationSec, 0);
  const sampleProbe = await probeSampleVideoResolutions(yt, videos[0].videoId);

  return {
    playlistId,
    playlistUrl: `https://www.youtube.com/playlist?list=${playlistId}`,
    title: playlistTitle,
    author,
    videoCount: videos.length,
    totalDurationSec,
    videos,
    availableResolutions: sampleProbe.resolutions,
    resolutionsSource: sampleProbe.source,
    truncated,
  };
}

function parseTargetHeight(requestedQuality?: string | null): { audioOnly: boolean; maxHeight: number } {
  if (!requestedQuality) return { audioOnly: false, maxHeight: 1080 };
  const low = requestedQuality.trim().toLowerCase();
  if (low.includes('audio') || low === 'm4a' || low === 'mp3') {
    return { audioOnly: true, maxHeight: 0 };
  }
  const m = low.match(/(\d{3,4})p/);
  if (m) {
    const h = Number(m[1]);
    if (Number.isFinite(h) && h >= 144 && h <= 4320) {
      return { audioOnly: false, maxHeight: h };
    }
  }
  if (low.includes('4k') || low.includes('uhd')) return { audioOnly: false, maxHeight: 2160 };
  if (low.includes('2k') || low.includes('qhd')) return { audioOnly: false, maxHeight: 1440 };
  if (low.includes('fhd') || low.includes('full hd')) return { audioOnly: false, maxHeight: 1080 };
  if (low.includes('hd')) return { audioOnly: false, maxHeight: 720 };
  return { audioOnly: false, maxHeight: 1080 };
}

function assertPathInsideDownloadsDir(targetPath: string): string {
  const base = path.resolve(DOWNLOADS_DIR);
  const resolved = path.resolve(targetPath);
  if (!resolved.startsWith(base + path.sep)) {
    throw new Error('Invalid output path outside storage directory.');
  }
  return resolved;
}

async function downloadStreamToFile(
  url: string,
  destPath: string,
  rec: TransferRecord,
  signal: AbortSignal
): Promise<number> {
  const safeDest = assertPathInsideDownloadsDir(destPath);
  const { response } = await safeFetchWithRedirects(url, {
    method: 'GET',
    timeoutMs: 30000,
    signal,
  });

  if (!response.ok && response.status !== 206) {
    try {
      await response.body?.cancel();
    } catch {
      // ignore
    }
    throw new Error(`YouTube media CDN returned HTTP ${response.status}.`);
  }

  if (!response.body) {
    throw new Error('YouTube media stream returned an empty response body.');
  }

  const ws = fs.createWriteStream(safeDest);
  const reader = response.body.getReader();
  let written = 0;

  try {
    while (true) {
      if (signal.aborted) {
        await reader.cancel().catch(() => {});
        throw new Error('Transfer aborted');
      }
      await waitWhilePaused(rec, signal);

      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        const buf = Buffer.from(value);
        if (!ws.write(buf)) {
          await new Promise<void>((resolve, reject) => {
            ws.once('drain', resolve);
            ws.once('error', reject);
          });
        }
        written += buf.byteLength;
        recordBytesSent(rec, buf.byteLength);
      }
    }

    await new Promise<void>((resolve, reject) => {
      ws.end(() => resolve());
      ws.on('error', reject);
    });
  } catch (err) {
    ws.destroy();
    await fsp.unlink(safeDest).catch(() => {});
    throw err;
  }

  return written;
}

async function muxVideoAndAudioWithFfmpeg(
  videoPath: string,
  audioPath: string,
  outputPath: string,
  signal: AbortSignal
): Promise<void> {
  const safeVideo = assertPathInsideDownloadsDir(videoPath);
  const safeAudio = assertPathInsideDownloadsDir(audioPath);
  const safeOut = assertPathInsideDownloadsDir(outputPath);

  await new Promise<void>((resolve, reject) => {
    const args = [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      safeVideo,
      '-i',
      safeAudio,
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
      safeOut,
    ];

    const proc = spawn('ffmpeg', args, { shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const onAbort = () => {
      proc.kill('SIGKILL');
      reject(new Error('Transfer aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });

    proc.on('error', (err) => {
      signal.removeEventListener('abort', onAbort);
      reject(err);
    });

    proc.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `FFmpeg muxing exited with code ${code}`));
      }
    });
  });
}

async function runWithYtDlp(
  ytDlpBin: string,
  videoId: string,
  rec: TransferRecord,
  audioOnly: boolean,
  maxHeight: number,
  signal: AbortSignal
): Promise<boolean> {
  if (!rec.filePath) return false;
  const safeFinal = assertPathInsideDownloadsDir(rec.filePath);
  const ext = audioOnly ? 'm4a' : 'mp4';
  const targetOutput = safeFinal.replace(/\.[a-z0-9]{2,5}$/i, '') + `.${ext}`;
  const finalSafeOutput = assertPathInsideDownloadsDir(targetOutput);

  const formatSelector = audioOnly
    ? 'bestaudio[ext=m4a]/bestaudio'
    : `bestvideo[height<=${maxHeight}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${maxHeight}]+bestaudio/best[height<=${maxHeight}]/best`;

  const args = [
    '--no-playlist',
    '--newline',
    '--progress',
    '-f',
    formatSelector,
    ...(audioOnly ? [] : ['--merge-output-format', 'mp4']),
    '-o',
    finalSafeOutput,
    '--',
    `https://www.youtube.com/watch?v=${videoId}`,
  ];

  rec.filePath = finalSafeOutput;
  rec.filename = sanitizeFilenameForHeader(
    rec.filename.replace(/\.[a-z0-9]{2,5}$/i, '') + `.${ext}`
  );
  rec.contentType = audioOnly ? 'audio/mp4' : 'video/mp4';

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ytDlpBin, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let lastErr = '';
    let prevBytes = 0;

    const handleLine = (line: string) => {
      // Parse yt-dlp progress lines e.g.: [download]  42.3% of ~  84.12MiB at   12.40MiB/s ETA 00:04
      const pctMatch = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%\s+of\s+~?\s*(\d+(?:\.\d+)?)(KiB|MiB|GiB|KB|MB|GB)/i);
      if (pctMatch) {
        const pct = Math.min(100, Math.max(0, Number(pctMatch[1])));
        const num = Number(pctMatch[2]);
        const unit = pctMatch[3].toLowerCase();
        const mult =
          unit.startsWith('g') ? 1024 * 1024 * 1024 : unit.startsWith('m') ? 1024 * 1024 : 1024;
        const totalEst = Math.round(num * mult);
        if (totalEst > 0) rec.totalBytes = Math.max(rec.totalBytes, totalEst);
        const curBytes = Math.round((pct / 100) * rec.totalBytes);
        const delta = Math.max(0, curBytes - prevBytes);
        if (delta > 0) {
          prevBytes = curBytes;
          recordBytesSent(rec, delta);
        }
      }
    };

    proc.stdout.on('data', (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (line.trim()) handleLine(line);
      }
    });
    proc.stderr.on('data', (chunk) => {
      const txt = chunk.toString().trim();
      if (txt) lastErr = txt;
    });

    const onAbort = () => {
      proc.kill('SIGTERM');
      reject(new Error('Transfer aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });

    proc.on('error', (err) => {
      signal.removeEventListener('abort', onAbort);
      reject(err);
    });

    proc.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(lastErr || `yt-dlp exited with code ${code}`));
      }
    });
  });

  const stat = await fsp.stat(finalSafeOutput);
  rec.totalBytes = stat.size;
  rec.downloadedBytes = stat.size;
  rec.savedOnDisk = true;
  rec.streamInitialized = true;
  rec.status = 'completed';
  rec.speedBytesPerSec = 0;
  rec.completedAt = Date.now();
  rec.updatedAt = Date.now();
  updateChunkMapFromProgress(rec);
  return true;
}

/**
 * Starts an in-app YouTube video/audio download into MochiDrop's storage directory
 * at the exact requested playlist session resolution (1080p, 720p, 480p, 360p, Audio Only, etc.).
 */
export function startYouTubeBackgroundTransfer(rec: TransferRecord): void {
  if (!rec.filePath) return;

  const controller = new AbortController();
  rec.abortController = controller;
  const signal = controller.signal;

  void (async () => {
    const tempFiles: string[] = [];
    try {
      const videoId = extractYouTubeVideoId(rec.url);
      if (!videoId) {
        throw new Error('Invalid YouTube video link.');
      }

      const { audioOnly, maxHeight } = parseTargetHeight(rec.quality);
      rec.status = 'downloading';
      rec.streamInitialized = true;
      rec.updatedAt = Date.now();

      await fsp.mkdir(DOWNLOADS_DIR, { recursive: true });

      // 1. Prefer yt-dlp if available on the user's PC desktop environment
      const ytDlp = await detectYtDlpBinary();
      if (ytDlp) {
        try {
          const ok = await runWithYtDlp(ytDlp, videoId, rec, audioOnly, maxHeight, signal);
          if (ok) return;
        } catch (err) {
          if (signal.aborted) throw err;
          // Fall back to Innertube pure-Node engine
        }
      }

      // 2. Pure-Node Innertube (youtubei.js) + FFmpeg Muxer
      const yt = await getInnertube();
      const clients = ['IOS', 'ANDROID', 'ANDROID_VR', 'TV', 'WEB'] as const;
      let selectedInfo: Awaited<ReturnType<Innertube['getBasicInfo']>> | null = null;
      let lastStatusReason = '';

      for (const client of clients) {
        if (signal.aborted) throw new Error('Transfer aborted');
        try {
          const info = await yt.getBasicInfo(videoId, { client: client as never });
          const hasStreams =
            (info.streaming_data?.formats?.length || 0) > 0 ||
            (info.streaming_data?.adaptive_formats?.length || 0) > 0;
          if (hasStreams) {
            selectedInfo = info;
            break;
          }
          if (info.playability_status?.reason) {
            lastStatusReason = info.playability_status.reason;
          }
        } catch (err) {
          lastStatusReason = err instanceof Error ? err.message : lastStatusReason;
        }
        await sleep(120, signal);
      }

      if (!selectedInfo || !selectedInfo.streaming_data) {
        if (/bot|sign in|login/i.test(lastStatusReason)) {
          throw new Error(
            'YouTube requested bot verification from this cloud server IP. Install MochiDrop on your PC (or add yt-dlp) to download playlists directly from your home connection.'
          );
        }
        throw new Error(lastStatusReason || 'Could not retrieve downloadable streams for this YouTube video.');
      }

      const allFormats = [
        ...(selectedInfo.streaming_data.formats || []),
        ...(selectedInfo.streaming_data.adaptive_formats || []),
      ];

      const resolveUrl = async (fmt: (typeof allFormats)[number]): Promise<string | null> => {
        try {
          const deciphered = await fmt.decipher(yt.session.player);
          return deciphered && /^https?:\/\//i.test(deciphered) ? deciphered : null;
        } catch {
          const direct = (fmt as unknown as { url?: string }).url;
          return direct && /^https?:\/\//i.test(direct) ? direct : null;
        }
      };

      const ext = audioOnly ? 'm4a' : 'mp4';
      const basePath =
        rec.filePath ||
        path.join(DOWNLOADS_DIR, `${rec.id}-${sanitizeFilenameForHeader(rec.filename || videoId)}`);
      const safeOut = assertPathInsideDownloadsDir(
        basePath.replace(/\.[a-z0-9]{2,5}$/i, '') + `.${ext}`
      );
      rec.filePath = safeOut;
      rec.filename = sanitizeFilenameForHeader(
        rec.filename.replace(/\.[a-z0-9]{2,5}$/i, '') + `.${ext}`
      );
      rec.contentType = audioOnly ? 'audio/mp4' : 'video/mp4';

      if (audioOnly) {
        const audioCandidates = allFormats
          .filter((f) => f.has_audio && !f.has_video)
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        const bestAudio =
          audioCandidates.find((f) => (f.mime_type || '').includes('mp4')) || audioCandidates[0];
        const audioUrl = bestAudio ? await resolveUrl(bestAudio) : null;
        if (!bestAudio || !audioUrl) {
          throw new Error('No downloadable audio stream was found for this YouTube video.');
        }
        rec.totalBytes = Number(bestAudio.content_length || 0);
        rec.quality = 'Audio Only (M4A)';
        const partPath = `${safeOut}.part`;
        tempFiles.push(partPath);
        const bytes = await downloadStreamToFile(audioUrl, partPath, rec, signal);
        await fsp.rename(partPath, safeOut);
        rec.totalBytes = bytes;
        rec.downloadedBytes = bytes;
      } else {
        // First check if an exact progressive (muxed video+audio) format matches the requested height
        const progressive = (selectedInfo.streaming_data.formats || [])
          .filter((f) => f.has_video && f.has_audio && (f.height || 0) <= maxHeight)
          .sort((a, b) => (b.height || 0) - (a.height || 0));

        const adaptiveVideos = (selectedInfo.streaming_data.adaptive_formats || [])
          .filter((f) => f.has_video && !f.has_audio && (f.height || 0) <= maxHeight)
          .sort((a, b) => {
            const hDiff = (b.height || 0) - (a.height || 0);
            if (hDiff !== 0) return hDiff;
            const aMp4 = (a.mime_type || '').includes('mp4') ? 1 : 0;
            const bMp4 = (b.mime_type || '').includes('mp4') ? 1 : 0;
            if (bMp4 !== aMp4) return bMp4 - aMp4;
            return (b.bitrate || 0) - (a.bitrate || 0);
          });

        const bestProg = progressive[0];
        const bestAdapt = adaptiveVideos[0];

        // Use progressive if it matches or exceeds adaptive height; otherwise download adaptive video + best audio & mux with ffmpeg
        if (bestProg && (!bestAdapt || (bestProg.height || 0) >= (bestAdapt.height || 0))) {
          const progUrl = await resolveUrl(bestProg);
          if (!progUrl) throw new Error('Could not resolve progressive YouTube stream URL.');
          rec.totalBytes = Number(bestProg.content_length || 0);
          rec.quality = bestProg.height ? `${bestProg.height}p` : rec.quality;
          const partPath = `${safeOut}.part`;
          tempFiles.push(partPath);
          const bytes = await downloadStreamToFile(progUrl, partPath, rec, signal);
          await fsp.rename(partPath, safeOut);
          rec.totalBytes = bytes;
          rec.downloadedBytes = bytes;
        } else if (bestAdapt) {
          const audioCandidates = (selectedInfo.streaming_data.adaptive_formats || [])
            .filter((f) => f.has_audio && !f.has_video)
            .sort((a, b) => {
              const aMp4 = (a.mime_type || '').includes('mp4') ? 1 : 0;
              const bMp4 = (b.mime_type || '').includes('mp4') ? 1 : 0;
              if (bMp4 !== aMp4) return bMp4 - aMp4;
              return (b.bitrate || 0) - (a.bitrate || 0);
            });
          const bestAudio = audioCandidates[0];
          const videoUrl = await resolveUrl(bestAdapt);
          const audioUrl = bestAudio ? await resolveUrl(bestAudio) : null;

          if (!videoUrl || !audioUrl) {
            throw new Error('Could not resolve adaptive HD video/audio streams for this video.');
          }

          rec.totalBytes =
            Number(bestAdapt.content_length || 0) + Number(bestAudio.content_length || 0);
          rec.quality = bestAdapt.height ? `${bestAdapt.height}p` : rec.quality;

          const videoTmp = `${safeOut}.video.tmp`;
          const audioTmp = `${safeOut}.audio.tmp`;
          tempFiles.push(videoTmp, audioTmp);

          await Promise.all([
            downloadStreamToFile(videoUrl, videoTmp, rec, signal),
            downloadStreamToFile(audioUrl, audioTmp, rec, signal),
          ]);

          await muxVideoAndAudioWithFfmpeg(videoTmp, audioTmp, safeOut, signal);
          const stat = await fsp.stat(safeOut);
          rec.totalBytes = stat.size;
          rec.downloadedBytes = stat.size;
        } else {
          throw new Error(`No stream available at or below ${maxHeight}p for this YouTube video.`);
        }
      }

      rec.savedOnDisk = true;
      rec.status = 'completed';
      rec.speedBytesPerSec = 0;
      rec.completedAt = Date.now();
      rec.updatedAt = Date.now();
      updateChunkMapFromProgress(rec);
    } catch (err) {
      if (signal.aborted) {
        if (rec.status !== 'completed') {
          rec.status = 'cancelled';
          rec.speedBytesPerSec = 0;
          rec.updatedAt = Date.now();
        }
        return;
      }
      rec.status = 'error';
      rec.errorMessage = err instanceof Error ? err.message : 'YouTube download failed.';
      rec.speedBytesPerSec = 0;
      rec.updatedAt = Date.now();
    } finally {
      for (const f of tempFiles) {
        void fsp.unlink(f).catch(() => {});
      }
      if (rec.abortController === controller) {
        rec.abortController = null;
      }
    }
  })();
}
