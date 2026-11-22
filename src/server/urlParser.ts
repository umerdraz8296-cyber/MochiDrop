export interface ParsedMediaUrl {
  rawUrl: string;
  normalizedUrl: string;
  parsed: URL;
  extractedFilename: string;
  embeddedTargetUrl: string | null;
  streamType: 'hls' | 'dash' | 'progressive' | 'unknown';
  qualityHint?: string;
  languageHint?: string;
  isSignedUrl: boolean;
}

const MAX_URL_LENGTH = 16384;
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'ftp:', 'ftps:', 'sftp:']);

// Linear-time anchored regexes (ReDoS-safe)
const PROTOCOL_RELATIVE_RE = /^\/\/[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?(?:\/.*)?$/i;
const BARE_DOMAIN_URL_RE = /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s"'<>`\\]*)?$/i;
const TORRENT_INFOHASH_RE = /^[a-f0-9]{40}$/i;
const URL_IN_TEXT_RE = /\b(?:https?|ftps?|sftp):\/\/[^\s"'<>`\\]+|\bmagnet:\?[^\s"'<>`\\]+/i;
const EXT_HLS_RE = /\.m3u8(?:$|[?#&/])|(?:^|[?&])(?:format|type|ext)=m3u8(?:$|[&#])|\/hls\/|playlist\.m3u8|master\.m3u8|index(?:-[a-z0-9_]+)?\.m3u8/i;
const EXT_DASH_RE = /\.mpd(?:$|[?#&/])|(?:^|[?&])(?:format|type|ext)=dash(?:$|[&#])|manifest\.mpd/i;
const EXT_VIDEO_RE = /\.(?:mp4|mkv|webm|mov|avi|flv|wmv|m4v|ts|m2ts|3gp)(?:$|[?#&])|(?:^|[?&])mime=video(?:%2f|\/)/i;
const SIGNED_KEY_RE = /^(?:token|sig|signature|expiry|expires|expire|x-amz-signature|x-amz-credential|googleaccessid|policy|key-pair-id|hdnts|auth|session|hash|hmac|file|k|e|s)$/i;
const BASE64_SAFE_RE = /^[A-Za-z0-9+/=_-]{8,4096}$/;
const HEX_URL_RE = /^(?:68747470|48545450)[0-9a-fA-F]{12,4096}$/;
const FILE_EXT_RE = /\.[a-z0-9]{2,5}$/i;

const GENERIC_FILENAMES = new Set([
  '',
  'download',
  'dl',
  'file',
  'get',
  'stream',
  'watch',
  'play',
  'player',
  'embed',
  'index',
  'index.html',
  'index.php',
  'media',
  'video',
  'videoplayback',
  'master.m3u8',
  'playlist.m3u8',
  'index.m3u8',
]);

const WRAPPER_QUERY_KEYS = [
  'filename',
  'file',
  'name',
  'title',
  'url',
  'link',
  'src',
  'stream',
  'media',
  'redirect',
  'dest',
  'path',
  'f',
  'dl',
  'target',
  'u',
];

export function sanitizeText(value: unknown, maxLen: number, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().replace(/[\r\n\t\0]+/g, ' ');
  return trimmed ? trimmed.slice(0, maxLen) : fallback;
}

export function safeDecodeURIComponent(raw: string): string {
  let current = raw;
  for (let i = 0; i < 2; i++) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      current = decoded;
    } catch {
      break;
    }
  }
  return current;
}

export function unescapeHtmlEntities(raw: string): string {
  return raw
    .replace(/&amp;/gi, '&')
    .replace(/&#x2f;/gi, '/')
    .replace(/&#47;/gi, '/')
    .replace(/&#x3d;/gi, '=')
    .replace(/&#61;/gi, '=')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

export function normalizeRawUrlInput(raw: string): string {
  let cleaned = raw
    .replace(/[\u200B-\u200D\uFEFF]/g, '') // strip zero-width spaces
    .trim();

  // Strip wrapping quotes or angle brackets
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'")) ||
    (cleaned.startsWith('<') && cleaned.endsWith('>'))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }

  cleaned = unescapeHtmlEntities(cleaned).replace(/\\\//g, '/');

  if (TORRENT_INFOHASH_RE.test(cleaned)) {
    return `magnet:?xt=urn:btih:${cleaned.toLowerCase()}`;
  }

  if (PROTOCOL_RELATIVE_RE.test(cleaned)) {
    cleaned = `https:${cleaned}`;
  } else if (BARE_DOMAIN_URL_RE.test(cleaned)) {
    cleaned = `https://${cleaned}`;
  }

  // If user pasted extra text around a link (e.g. "Download link: https://..."), extract the URL cleanly
  if (!/^(?:https?|ftps?|sftp|magnet):/i.test(cleaned)) {
    const match = cleaned.match(URL_IN_TEXT_RE);
    if (match && match[0]) {
      cleaned = match[0].replace(/[),.;]+$/, '');
    }
  }

  return cleaned;
}

export function tryDecodeBase64ToString(raw: string): string | null {
  const trimmed = raw.trim();
  if (!BASE64_SAFE_RE.test(trimmed)) return null;
  const standard = trimmed.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const pad = standard.length % 4 === 0 ? '' : '='.repeat(4 - (standard.length % 4));
    const decoded = Buffer.from(standard + pad, 'base64').toString('utf8');
    const printable = decoded.replace(/[^\x20-\x7E\u00A0-\uFFFF]/g, '');
    if (printable.length < decoded.length * 0.9 || printable.length < 4) return null;
    return printable;
  } catch {
    return null;
  }
}

export function tryDecodeHexUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length % 2 !== 0 || !HEX_URL_RE.test(trimmed)) return null;
  try {
    const decoded = Buffer.from(trimmed, 'hex').toString('utf8');
    if (/^https?:\/\//i.test(decoded)) return decoded;
    return null;
  } catch {
    return null;
  }
}

export function detectQualityHint(text: string): string | undefined {
  if (/(?:^|[\s._\-[(\/])(?:2160p|4k|uhd)(?:$|[\s._\-\])\/])/i.test(text)) return '2160p 4K';
  if (/(?:^|[\s._\-[(\/])(?:1440p|2k)(?:$|[\s._\-\])\/])/i.test(text)) return '1440p QHD';
  if (/(?:^|[\s._\-[(\/])(?:1080p|fhd)(?:$|[\s._\-\])\/])/i.test(text)) return '1080p HD';
  if (/(?:^|[\s._\-[(\/])720p(?:$|[\s._\-\])\/])/i.test(text)) return '720p';
  if (/(?:^|[\s._\-[(\/])576p(?:$|[\s._\-\])\/])/i.test(text)) return '576p';
  if (/(?:^|[\s._\-[(\/])480p(?:$|[\s._\-\])\/])/i.test(text)) return '480p';
  if (/(?:^|[\s._\-[(\/])360p(?:$|[\s._\-\])\/])/i.test(text)) return '360p';
  if (/(?:^|[\s._\-[(\/])240p(?:$|[\s._\-\])\/])/i.test(text)) return '240p';
  return undefined;
}

export function detectLanguageHint(text: string): string | undefined {
  const langs: string[] = [];
  if (/\bhindi\b/i.test(text)) langs.push('Hindi');
  if (/\burdu\b/i.test(text)) langs.push('Urdu');
  if (/\benglish\b|\beng\b/i.test(text)) langs.push('English');
  if (/\btamil\b/i.test(text)) langs.push('Tamil');
  if (/\btelugu\b/i.test(text)) langs.push('Telugu');
  if (/\bmalayalam\b/i.test(text)) langs.push('Malayalam');
  if (/\bkannada\b/i.test(text)) langs.push('Kannada');
  if (/\bpunjabi\b/i.test(text)) langs.push('Punjabi');
  if (/\bbengali\b|\bbangla\b/i.test(text)) langs.push('Bengali');
  if (/\bjapanese\b|\bjpn\b/i.test(text)) langs.push('Japanese');
  if (/\bkorean\b|\bkor\b/i.test(text)) langs.push('Korean');
  if (/\bspanish\b|\besp\b/i.test(text)) langs.push('Spanish');
  if (/\bfrench\b|\bfre\b/i.test(text)) langs.push('French');
  if (/\barabic\b/i.test(text)) langs.push('Arabic');
  if (/\bchinese\b|\bmandarin\b/i.test(text)) langs.push('Chinese');
  if (/\bindonesian\b/i.test(text)) langs.push('Indonesian');

  const isDual = /dual[\s._-]*audio/i.test(text);
  const isMulti = /multi[\s._-]*audio/i.test(text);
  const hasESub = /\besub\b|\besubs\b|\bsubtitles?\b|\bmsub\b/i.test(text);

  if (isDual) {
    if (langs.length >= 2) return `Dual Audio (${langs.join(' + ')})`;
    if (langs.length === 1) {
      const other = langs[0] === 'English' ? 'Original' : 'English';
      return `Dual Audio (${langs[0]} + ${other})`;
    }
    return 'Dual Audio';
  }
  if (isMulti) {
    return langs.length > 0 ? `Multi Audio (${langs.join(', ')})` : 'Multi Audio';
  }
  if (langs.length > 0) {
    const base = langs.join(' + ');
    return hasESub ? `${base} (Audio + Subs)` : `${base} (Audio)`;
  }
  if (hasESub) return 'Original Audio (With Subtitles)';
  return undefined;
}

export function detectStreamType(urlStr: string, filename: string, contentType = ''): 'hls' | 'dash' | 'progressive' | 'unknown' {
  const ct = contentType.toLowerCase();
  if (
    ct.includes('mpegurl') ||
    ct.includes('x-mpegurl') ||
    EXT_HLS_RE.test(urlStr) ||
    EXT_HLS_RE.test(filename)
  ) {
    return 'hls';
  }
  if (
    ct.includes('dash+xml') ||
    EXT_DASH_RE.test(urlStr) ||
    EXT_DASH_RE.test(filename)
  ) {
    return 'dash';
  }
  if (
    ct.startsWith('video/') ||
    ct === 'application/x-matroska' ||
    EXT_VIDEO_RE.test(urlStr) ||
    EXT_VIDEO_RE.test(filename)
  ) {
    return 'progressive';
  }
  return 'unknown';
}

export function extractFilenameAndEmbeddedUrl(parsed: URL): {
  filename: string;
  embeddedTargetUrl: string | null;
} {
  let embeddedTargetUrl: string | null = null;
  let foundName: string | null = null;

  // 1. Inspect query parameters (handles Base64, Hex, double-encoded, and plain wrapped URLs)
  for (const key of WRAPPER_QUERY_KEYS) {
    const val = parsed.searchParams.get(key);
    if (!val) continue;

    const decoded =
      tryDecodeHexUrl(val) ||
      tryDecodeBase64ToString(val) ||
      safeDecodeURIComponent(val);

    if (/^https?:\/\//i.test(decoded)) {
      if (!embeddedTargetUrl) embeddedTargetUrl = decoded;
      try {
        const innerUrl = new URL(decoded);
        const seg = safeDecodeURIComponent(
          innerUrl.pathname.split('/').filter(Boolean).pop() || ''
        );
        if (seg && !GENERIC_FILENAMES.has(seg.toLowerCase())) {
          foundName = sanitizeText(seg, 180, seg);
          break;
        }
      } catch {
        // continue
      }
    }

    const candidate = safeDecodeURIComponent(
      decoded.split('/').filter(Boolean).pop() || decoded
    );
    if (
      candidate &&
      FILE_EXT_RE.test(candidate) &&
      !GENERIC_FILENAMES.has(candidate.toLowerCase())
    ) {
      foundName = sanitizeText(candidate, 180, candidate);
      break;
    }
  }

  // 2. Check all path segments from last to first (some streaming CDNs put filename before /stream or /download)
  if (!foundName) {
    const segments = parsed.pathname.split('/').filter(Boolean).reverse();
    for (const rawSeg of segments) {
      const seg = safeDecodeURIComponent(rawSeg);
      if (seg && FILE_EXT_RE.test(seg) && !GENERIC_FILENAMES.has(seg.toLowerCase())) {
        foundName = sanitizeText(seg, 180, seg);
        break;
      }
    }
    if (!foundName && segments[0]) {
      const lastSeg = safeDecodeURIComponent(segments[0]);
      if (lastSeg && !GENERIC_FILENAMES.has(lastSeg.toLowerCase())) {
        foundName = sanitizeText(lastSeg, 180, lastSeg);
      }
    }
  }

  // 3. Fallback filename
  const fallback = sanitizeText(
    parsed.hostname.replace(/^www\./, '') + '_download',
    100,
    'download.bin'
  );

  return {
    filename: foundName || fallback,
    embeddedTargetUrl,
  };
}

export function parseAndNormalizeUrl(rawInput: string): ParsedMediaUrl {
  const normalizedUrl = normalizeRawUrlInput(rawInput);
  if (!normalizedUrl || normalizedUrl.length > MAX_URL_LENGTH) {
    throw new Error('Provide a valid download URL.');
  }

  let parsed: URL;
  try {
    parsed = new URL(normalizedUrl);
  } catch {
    throw new Error('Invalid URL format.');
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error('Supported links: http, https, ftp, ftps, sftp, and magnet.');
  }

  const { filename, embeddedTargetUrl } = extractFilenameAndEmbeddedUrl(parsed);
  const hintSource = `${filename} ${embeddedTargetUrl || ''} ${parsed.pathname}`;
  const qualityHint = detectQualityHint(hintSource);
  const languageHint = detectLanguageHint(hintSource);
  const streamType = detectStreamType(
    embeddedTargetUrl ? `${parsed.href} ${embeddedTargetUrl}` : parsed.href,
    filename
  );

  let isSignedUrl = parsed.search.length > 120;
  if (!isSignedUrl) {
    for (const key of parsed.searchParams.keys()) {
      if (SIGNED_KEY_RE.test(key)) {
        isSignedUrl = true;
        break;
      }
    }
  }

  return {
    rawUrl: rawInput,
    normalizedUrl: parsed.href,
    parsed,
    extractedFilename: filename,
    embeddedTargetUrl,
    streamType,
    qualityHint,
    languageHint,
    isSignedUrl,
  };
}

/**
 * Extracts a redirect or direct media stream URL from an HTML/JS interstitial page
 * commonly returned by Cloudflare Worker download pages, Drive mirrors, and movie hosts.
 * Uses bounded, linear-time regex patterns to avoid catastrophic backtracking.
 */
export function extractRedirectFromHtml(html: string, baseUrl: string): string | null {
  const sample = html.slice(0, 200_000);

  const resolveCandidate = (rawCandidate: string | undefined): string | null => {
    if (!rawCandidate) return null;
    const unescaped = unescapeHtmlEntities(rawCandidate.trim()).replace(/\\\//g, '/');
    if (
      !unescaped ||
      unescaped.startsWith('#') ||
      unescaped.startsWith('javascript:') ||
      unescaped.startsWith('data:') ||
      unescaped.startsWith('mailto:')
    ) {
      return null;
    }
    try {
      const resolved = new URL(unescaped, baseUrl);
      if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
      if (resolved.href === baseUrl) return null;
      return resolved.href;
    } catch {
      return null;
    }
  };

  // 1. <meta http-equiv="refresh" content="0; url=...">
  const metaMatch = sample.match(
    /<meta[^>]{0,200}http-equiv\s*=\s*["']?refresh["']?[^>]{0,300}content\s*=\s*["'][^"']*url\s*=\s*([^"'\s>]+)/i
  );
  const metaUrl = resolveCandidate(metaMatch?.[1]);
  if (metaUrl) return metaUrl;

  // 2. JS redirects: window.location(.href|.replace|.assign) = "..."
  const jsRedirectPatterns = [
    /(?:window|self|top|document)\.location(?:\.href)?\s*=\s*["']([^"'\r\n]{8,4096})["']/i,
    /(?:window|self|top)?\.?location\.(?:replace|assign)\(\s*["']([^"'\r\n]{8,4096})["']\s*\)/i,
  ];
  for (const re of jsRedirectPatterns) {
    const m = sample.match(re);
    const candidate = resolveCandidate(m?.[1]);
    if (candidate) return candidate;
  }

  // 3. Direct <video src>, <source src>, or <a ... download href="...">
  const mediaTagPatterns = [
    /<(?:video|source)[^>]{0,300}\bsrc\s*=\s*["']([^"'\r\n]{8,4096})["']/i,
    /<a[^>]{0,200}\bdownload\b[^>]{0,200}\bhref\s*=\s*["']([^"'\r\n]{8,4096})["']/i,
    /<a[^>]{0,200}\bhref\s*=\s*["']([^"'\r\n]{8,4096})["'][^>]{0,200}\bdownload\b/i,
  ];
  for (const re of mediaTagPatterns) {
    const m = sample.match(re);
    const candidate = resolveCandidate(m?.[1]);
    if (candidate) return candidate;
  }

  // 4. Embedded player JSON / JS config pointing directly to .m3u8 / .mkv / .mp4
  const jsonStreamMatch = sample.match(
    /["'](?:file|src|url|source|streamUrl|downloadUrl|videoUrl)["']\s*:\s*["'](https?:\\?\/\\?\/[^"'\r\n]{8,4096})["']/i
  );
  if (jsonStreamMatch?.[1]) {
    const candidate = resolveCandidate(jsonStreamMatch[1]);
    if (
      candidate &&
      (EXT_HLS_RE.test(candidate) || EXT_VIDEO_RE.test(candidate) || /\/download\b/i.test(candidate))
    ) {
      return candidate;
    }
  }

  // 5. Fallback: explicit direct media URL (.mkv/.mp4/.m3u8) inside anchor or script
  const directMediaMatch = sample.match(
    /["'](https?:\\?\/\\?\/[^"'\s<>]{8,4096}\.(?:mkv|mp4|m3u8|webm|mov)(?:\?[^"'\s<>]{0,2048})?)["']/i
  );
  const directCandidate = resolveCandidate(directMediaMatch?.[1]);
  if (directCandidate) return directCandidate;

  return null;
}

export interface HlsVariantInfo {
  label: string;
  url: string;
  bandwidth: number;
  resolution?: string;
}

export interface ParsedHlsPlaylist {
  isMaster: boolean;
  variants: HlsVariantInfo[];
  audioLanguages: string[];
  segments: string[];
  initSegmentUrl: string | null;
  totalDurationSec: number;
  encrypted: boolean;
  encryptionMethod: string | null;
}

function formatHlsVariantLabel(resolution: string | undefined, bandwidth: number): string {
  if (resolution) {
    const height = Number(resolution.split('x')[1] || 0);
    if (height >= 2160) return '2160p 4K';
    if (height >= 1440) return '1440p QHD';
    if (height >= 1080) return '1080p HD';
    if (height >= 720) return '720p';
    if (height >= 540) return '540p';
    if (height >= 480) return '480p';
    if (height >= 360) return '360p';
    if (height > 0) return `${height}p`;
  }
  if (bandwidth > 0) {
    return `${(bandwidth / 1_000_000).toFixed(1)} Mbps`;
  }
  return 'Source Quality';
}

/**
 * Parses an HLS (#EXTM3U) master or media playlist into real variant URLs, real audio tracks,
 * and absolute segment URLs.
 */
export function parseHlsPlaylist(content: string, playlistUrl: string): ParsedHlsPlaylist {
  const lines = content.split(/\r?\n/).map((l) => l.trim());
  const variants: HlsVariantInfo[] = [];
  const audioLanguages: string[] = [];
  const segments: string[] = [];
  let initSegmentUrl: string | null = null;
  let totalDurationSec = 0;
  let encrypted = false;
  let encryptionMethod: string | null = null;

  let pendingVariant: { bandwidth: number; resolution?: string } | null = null;
  let expectingSegment = false;

  const resolveRel = (rel: string): string | null => {
    try {
      const u = new URL(rel, playlistUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u.href;
    } catch {
      return null;
    }
  };

  for (const line of lines) {
    if (!line) continue;

    if (line.startsWith('#EXT-X-MEDIA:')) {
      const typeMatch = line.match(/TYPE=([A-Z]+)/i);
      const mediaType = typeMatch?.[1]?.toUpperCase();
      if (mediaType === 'AUDIO' || mediaType === 'SUBTITLES') {
        const nameMatch = line.match(/NAME="([^"]+)"/i);
        const langMatch = line.match(/LANGUAGE="([^"]+)"/i);
        const labelBase = nameMatch?.[1]?.trim() || langMatch?.[1]?.trim();
        if (labelBase) {
          const suffix = mediaType === 'AUDIO' ? 'Audio' : 'Subtitles';
          const formatted = labelBase.toLowerCase().includes(suffix.toLowerCase())
            ? labelBase
            : `${labelBase} (${suffix})`;
          if (!audioLanguages.includes(formatted)) {
            audioLanguages.push(formatted);
          }
        }
      }
      continue;
    }

    if (line.startsWith('#EXT-X-KEY:')) {
      const methodMatch = line.match(/METHOD=([A-Z0-9-]+)/i);
      const method = methodMatch?.[1]?.toUpperCase() || null;
      if (method && method !== 'NONE') {
        encrypted = true;
        encryptionMethod = method;
      }
      continue;
    }

    if (line.startsWith('#EXT-X-MAP:')) {
      const uriMatch = line.match(/URI="([^"]+)"/i);
      if (uriMatch?.[1]) {
        initSegmentUrl = resolveRel(uriMatch[1]);
      }
      continue;
    }

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const bwMatch = line.match(/BANDWIDTH=(\d+)/i);
      const resMatch = line.match(/RESOLUTION=(\d+x\d+)/i);
      pendingVariant = {
        bandwidth: bwMatch ? Number(bwMatch[1]) : 0,
        resolution: resMatch?.[1],
      };
      continue;
    }

    if (line.startsWith('#EXTINF:')) {
      const durMatch = line.match(/^#EXTINF:([\d.]+)/i);
      if (durMatch?.[1]) {
        const val = Number(durMatch[1]);
        if (Number.isFinite(val)) totalDurationSec += val;
      }
      expectingSegment = true;
      continue;
    }

    if (line.startsWith('#')) continue;

    if (pendingVariant) {
      const resolved = resolveRel(line);
      if (resolved) {
        variants.push({
          label: formatHlsVariantLabel(pendingVariant.resolution, pendingVariant.bandwidth),
          url: resolved,
          bandwidth: pendingVariant.bandwidth,
          resolution: pendingVariant.resolution,
        });
      }
      pendingVariant = null;
      continue;
    }

    if (expectingSegment) {
      const resolved = resolveRel(line);
      if (resolved) {
        segments.push(resolved);
      }
      expectingSegment = false;
    }
  }

  variants.sort((a, b) => b.bandwidth - a.bandwidth);

  // Deduplicate variant labels cleanly (append bitrate if two variants share a label)
  const seenLabels = new Set<string>();
  for (const v of variants) {
    if (seenLabels.has(v.label)) {
      v.label = `${v.label} (${(v.bandwidth / 1_000_000).toFixed(1)} Mbps)`;
    }
    seenLabels.add(v.label);
  }

  return {
    isMaster: variants.length > 0 && segments.length === 0,
    variants,
    audioLanguages,
    segments,
    initSegmentUrl,
    totalDurationSec,
    encrypted,
    encryptionMethod,
  };
}

/**
 * Inspects the first bytes of a stream payload to detect disguised HTML/JSON/XML error pages
 * or HLS playlists before initializing a binary download in the browser.
 */
export function sniffInitialBytes(bytes: Uint8Array): 'hls' | 'html' | 'json_error' | 'binary' {
  if (bytes.byteLength === 0) return 'binary';
  const slice = bytes.subarray(0, Math.min(512, bytes.byteLength));
  const text = Buffer.from(slice).toString('utf8').trimStart();

  if (text.startsWith('#EXTM3U')) {
    return 'hls';
  }
  if (/^(?:<!doctype\s+html|<html\b|<head\b|<body\b|<script\b|<meta\b)/i.test(text)) {
    return 'html';
  }
  if (
    text.startsWith('{') &&
    /"(?:error|message|status|code|detail)"\s*:/i.test(text) &&
    bytes.byteLength < 65536
  ) {
    return 'json_error';
  }
  return 'binary';
}
