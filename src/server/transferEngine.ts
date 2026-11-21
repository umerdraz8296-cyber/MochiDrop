import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import type express from 'express';
import {
  detectLanguageHint,
  detectQualityHint,
  detectStreamType,
  extractRedirectFromHtml,
  parseAndNormalizeUrl,
  parseHlsPlaylist,
  sniffInitialBytes,
} from './urlParser.ts';
import { inferPlayableMimeType } from './mediaPlayer.ts';

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const MAX_REDIRECTS = 12;
const MAX_ACTIVE_TRANSFERS = 12;
const TRANSFER_RETENTION_MS = 60 * 60 * 1000; // 1 hour
const SLICE_SIZE = 64 * 1024; // 64 KB slices for responsive pause & accurate real speed
const MAX_HTML_INSPECT_BYTES = 256 * 1024;
const DOWNLOADS_DIR = process.env.MOCHIDROP_DATA_DIR
  ? path.resolve(process.env.MOCHIDROP_DATA_DIR)
  : path.resolve(process.cwd(), '.mochidrop-downloads');

try {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
} catch {
  // will retry lazily when writing
}

export type ServerTransferStatus =
  | 'connecting'
  | 'downloading'
  | 'paused'
  | 'completed'
  | 'error'
  | 'cancelled';

export interface ServerChunkProgress {
  index: number;
  progress: number; // 0..100
  workerIndex: number;
}

export interface ProbeResult {
  finalUrl: string;
  totalBytes: number;
  acceptRanges: boolean;
  contentType: string;
  contentDispositionFilename: string | null;
  httpStatus: number;
  verifiedLive: boolean;
  probeError: string | null;
  streamType: 'hls' | 'dash' | 'progressive' | 'unknown';
  redirectHops: number;
  hlsSegmentCount?: number;
  hlsDurationSec?: number;
  hlsVariants?: Array<{ label: string; url: string; bandwidth: number; resolution?: string }>;
  hlsAudioLanguages?: string[];
  cookies?: Record<string, string>;
  referer?: string;
}

export interface TransferRecord {
  id: string;
  url: string;
  resolvedUrl: string;
  filename: string;
  contentType: string;
  expectedBinary: boolean;
  streamType: 'hls' | 'dash' | 'progressive' | 'unknown';
  status: ServerTransferStatus;
  totalBytes: number;
  downloadedBytes: number;
  speedBytesPerSec: number;
  acceptRanges: boolean;
  chunkSizeMb: number;
  parallelStreams: number;
  speedCapMbps: number | null;
  retryCount: number;
  redirectHops: number;
  streamInitialized: boolean;
  errorMessage: string | null;
  httpStatus: number | null;
  quality: string | null;
  language: string | null;
  savedOnDisk: boolean;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  chunks: ServerChunkProgress[];
  // Internal runtime controls (excluded from JSON serialization)
  paused: boolean;
  abortController: AbortController | null;
  speedSamples: Array<{ ts: number; bytes: number }>;
  cookies: Record<string, string>;
  referer: string | null;
  filePath: string | null;
}

const transfers = new Map<string, TransferRecord>();

export function isPrivateOrReservedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }

  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    if (
      normalized === '::1' ||
      normalized === '::' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe80:') ||
      normalized.startsWith('::ffff:127.') ||
      normalized.startsWith('::ffff:10.') ||
      normalized.startsWith('::ffff:192.168.') ||
      normalized.startsWith('::ffff:169.254.')
    ) {
      return true;
    }
    return false;
  }

  return true;
}

export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'metadata.google.internal'
  ) {
    return true;
  }
  if (net.isIP(host) && isPrivateOrReservedIp(host)) {
    return true;
  }
  return false;
}

export async function canSafelyProbePublicHost(hostname: string): Promise<boolean> {
  if (isBlockedHostname(hostname)) return false;
  if (net.isIP(hostname)) return !isPrivateOrReservedIp(hostname);
  try {
    const records = await dns.lookup(hostname, { all: true });
    if (!records.length) return false;
    return records.every((rec) => !isPrivateOrReservedIp(rec.address));
  } catch {
    return false;
  }
}

export function sanitizeFilenameForHeader(raw: string): string {
  const cleaned = raw
    .replace(/[\r\n\t\0/\\:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  return cleaned || 'download.bin';
}

function parseContentDispositionFilename(cd: string | null): string | null {
  if (!cd) return null;
  const starMatch = cd.match(/filename\*\s*=\s*(?:UTF-8''|utf-8'')([^;\r\n]+)/i);
  if (starMatch && starMatch[1]) {
    try {
      return sanitizeFilenameForHeader(decodeURIComponent(starMatch[1].replace(/^"|"$/g, '')));
    } catch {
      return sanitizeFilenameForHeader(starMatch[1].replace(/^"|"$/g, ''));
    }
  }
  const plainMatch = cd.match(/filename\s*=\s*"?([^";\r\n]+)"?/i);
  if (plainMatch && plainMatch[1]) {
    try {
      return sanitizeFilenameForHeader(decodeURIComponent(plainMatch[1]));
    } catch {
      return sanitizeFilenameForHeader(plainMatch[1]);
    }
  }
  return null;
}

function collectSetCookies(res: Response, jar: Record<string, string>) {
  const headerBag = res.headers as Headers & { getSetCookie?: () => string[] };
  const rawList =
    typeof headerBag.getSetCookie === 'function'
      ? headerBag.getSetCookie()
      : res.headers.get('set-cookie')
      ? [res.headers.get('set-cookie')!]
      : [];

  for (const entry of rawList) {
    const firstPair = entry.split(';')[0]?.trim();
    if (!firstPair) continue;
    const eqIdx = firstPair.indexOf('=');
    if (eqIdx <= 0) continue;
    const name = firstPair.slice(0, eqIdx).trim();
    const val = firstPair.slice(eqIdx + 1).trim();
    if (name && name.length <= 128 && val.length <= 2048) {
      jar[name] = val;
    }
  }
}

function formatCookieHeader(jar: Record<string, string>): string {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function shareSiteOrHost(a: string, b: string): boolean {
  const ha = a.toLowerCase();
  const hb = b.toLowerCase();
  if (ha === hb) return true;
  const pa = ha.split('.');
  const pb = hb.split('.');
  if (pa.length >= 2 && pb.length >= 2) {
    return pa.slice(-2).join('.') === pb.slice(-2).join('.');
  }
  return false;
}

async function readTextBounded(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        const remaining = maxBytes - total;
        const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;
        chunks.push(Buffer.from(slice));
        total += slice.byteLength;
        if (total >= maxBytes) {
          await reader.cancel().catch(() => {});
          break;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

export interface SafeFetchOptions extends Omit<RequestInit, 'redirect'> {
  timeoutMs?: number;
  followHtmlRedirects?: boolean;
  cookies?: Record<string, string>;
  referer?: string | null;
}

export interface SafeFetchResult {
  response: Response;
  finalUrl: string;
  redirectHops: number;
  cookies: Record<string, string>;
  referer: string | null;
}

/**
 * Performs an outbound HTTP/HTTPS fetch across complex redirect chains (3xx + cookies +
 * Referer + optional HTML meta-refresh / JS location interstitials) while strictly validating
 * EVERY hop against private/loopback/metadata IP ranges (SSRF protection).
 */
export async function safeFetchWithRedirects(
  initialUrl: string,
  options: SafeFetchOptions = {}
): Promise<SafeFetchResult> {
  const {
    timeoutMs = 15000,
    followHtmlRedirects = false,
    cookies: initialCookies,
    referer: initialReferer = null,
    ...fetchInit
  } = options;

  const cookieJar: Record<string, string> = { ...(initialCookies || {}) };
  let currentUrl = initialUrl;
  let currentHost = '';
  let prevUrl: string | null = initialReferer;
  const visited = new Set<string>();

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(currentUrl);
    } catch {
      throw new Error('Invalid download URL.');
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only HTTP and HTTPS links can be downloaded directly.');
    }

    if (visited.has(parsed.href)) {
      throw new Error('Redirect loop detected from remote server.');
    }
    visited.add(parsed.href);

    const safe = await canSafelyProbePublicHost(parsed.hostname);
    if (!safe) {
      throw new Error('Host could not be resolved or is a blocked private network address.');
    }

    const externalSignal = fetchInit.signal;
    const hopController = new AbortController();
    const timer = setTimeout(() => hopController.abort(), timeoutMs);

    const onExternalAbort = () => hopController.abort();
    if (externalSignal) {
      if (externalSignal.aborted) {
        clearTimeout(timer);
        throw new Error('Transfer aborted');
      }
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    let response: Response;
    try {
      const headers = new Headers(fetchInit.headers);
      if (!headers.has('User-Agent')) {
        headers.set('User-Agent', BROWSER_USER_AGENT);
      }
      if (!headers.has('Accept')) {
        headers.set('Accept', '*/*');
      }
      if (!headers.has('Accept-Language')) {
        headers.set('Accept-Language', 'en-US,en;q=0.9');
      }
      if (prevUrl && !headers.has('Referer')) {
        headers.set('Referer', prevUrl);
      }
      // Only forward accumulated cookies to same host / same site
      if (
        Object.keys(cookieJar).length > 0 &&
        (!currentHost || shareSiteOrHost(currentHost, parsed.hostname)) &&
        !headers.has('Cookie')
      ) {
        headers.set('Cookie', formatCookieHeader(cookieJar));
      }

      response = await fetch(parsed.href, {
        ...fetchInit,
        headers,
        redirect: 'manual',
        signal: hopController.signal,
      });
    } finally {
      clearTimeout(timer);
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
    }

    collectSetCookies(response, cookieJar);
    currentHost = parsed.hostname;

    // Standard HTTP 3xx redirect
    if (
      response.status === 301 ||
      response.status === 302 ||
      response.status === 303 ||
      response.status === 307 ||
      response.status === 308
    ) {
      const location = response.headers.get('location');
      try {
        await response.body?.cancel();
      } catch {
        // ignore cancel error
      }
      if (!location) {
        return {
          response,
          finalUrl: parsed.href,
          redirectHops: hop,
          cookies: cookieJar,
          referer: prevUrl,
        };
      }
      prevUrl = parsed.href;
      currentUrl = new URL(location, parsed.href).href;
      continue;
    }

    // Optional HTML interstitial redirect resolution (meta refresh / JS location / <video> / <source>)
    if (followHtmlRedirects && response.ok && (fetchInit.method || 'GET').toUpperCase() === 'GET') {
      const ct = (response.headers.get('content-type') || '').toLowerCase();
      const cl = Number(response.headers.get('content-length') || 0);
      if (ct.includes('text/html') && (cl === 0 || cl <= MAX_HTML_INSPECT_BYTES)) {
        const html = await readTextBounded(response, MAX_HTML_INSPECT_BYTES);
        const extractedNext = extractRedirectFromHtml(html, parsed.href);
        if (extractedNext && !visited.has(extractedNext)) {
          prevUrl = parsed.href;
          currentUrl = extractedNext;
          continue;
        }
        // Return a synthetic response preserving the HTML content-type so caller knows it was HTML
        return {
          response: new Response(html, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          }),
          finalUrl: parsed.href,
          redirectHops: hop,
          cookies: cookieJar,
          referer: prevUrl,
        };
      }
    }

    return {
      response,
      finalUrl: parsed.href,
      redirectHops: hop,
      cookies: cookieJar,
      referer: prevUrl,
    };
  }

  throw new Error('Too many redirects from remote server (exceeded 12 hops).');
}

function describeHttpError(status: number): string {
  if (status === 401 || status === 403) {
    return `Remote server rejected the request (HTTP ${status}). The download token may be expired or locked to your browser IP.`;
  }
  if (status === 404) {
    return 'File not found on remote server (HTTP 404).';
  }
  if (status === 410) {
    return 'This download link has expired (HTTP 410). Generate a fresh link and try again.';
  }
  if (status === 429) {
    return 'Remote server rate-limited requests (HTTP 429). Wait a moment and retry.';
  }
  if (status >= 500) {
    return `Remote host error (HTTP ${status}). Try again shortly.`;
  }
  return `Remote server returned HTTP ${status}.`;
}

async function resolveHlsMediaPlaylist(
  initialUrl: string,
  cookies: Record<string, string>,
  referer: string | null,
  signal?: AbortSignal
): Promise<{
  mediaPlaylistUrl: string;
  variants: Array<{ label: string; url: string; bandwidth: number; resolution?: string }>;
  audioLanguages: string[];
  segments: string[];
  initSegmentUrl: string | null;
  totalDurationSec: number;
  encrypted: boolean;
  encryptionMethod: string | null;
  cookies: Record<string, string>;
}> {
  let targetUrl = initialUrl;
  let activeCookies = { ...cookies };
  let activeReferer = referer;
  let discoveredVariants: Array<{ label: string; url: string; bandwidth: number; resolution?: string }> = [];
  let discoveredAudioLanguages: string[] = [];

  for (let depth = 0; depth < 3; depth++) {
    const attempt = await safeFetchWithRedirects(targetUrl, {
      method: 'GET',
      timeoutMs: 15000,
      cookies: activeCookies,
      referer: activeReferer,
      signal,
    });
    activeCookies = attempt.cookies;
    activeReferer = attempt.finalUrl;

    if (!attempt.response.ok) {
      try {
        await attempt.response.body?.cancel();
      } catch {
        // ignore
      }
      throw new Error(describeHttpError(attempt.response.status));
    }

    const text = await readTextBounded(attempt.response, 2 * 1024 * 1024);
    if (!text.trimStart().startsWith('#EXTM3U')) {
      throw new Error('Stream URL did not return a valid HLS (#EXTM3U) playlist.');
    }

    const parsed = parseHlsPlaylist(text, attempt.finalUrl);
    if (parsed.audioLanguages.length > 0) {
      discoveredAudioLanguages = parsed.audioLanguages;
    }
    if (parsed.isMaster && parsed.variants.length > 0) {
      discoveredVariants = parsed.variants;
      targetUrl = parsed.variants[0].url;
      continue;
    }

    return {
      mediaPlaylistUrl: attempt.finalUrl,
      variants: discoveredVariants,
      audioLanguages: discoveredAudioLanguages,
      segments: parsed.segments,
      initSegmentUrl: parsed.initSegmentUrl,
      totalDurationSec: parsed.totalDurationSec,
      encrypted: parsed.encrypted,
      encryptionMethod: parsed.encryptionMethod,
      cookies: activeCookies,
    };
  }

  throw new Error('Could not resolve HLS media segments from master playlist.');
}

/**
 * Probes an HTTP/HTTPS URL safely across complex redirect chains (3xx + cookies + HTML interstitials)
 * and streaming manifests (HLS .m3u8) to discover real byte size, Range support, and stream validity.
 */
export async function probeRemoteUrl(rawUrl: string): Promise<ProbeResult> {
  const parsedMeta = parseAndNormalizeUrl(rawUrl);
  let finalUrl = parsedMeta.normalizedUrl;
  let totalBytes = 0;
  let acceptRanges = false;
  let contentType = '';
  let contentDispositionFilename: string | null = null;
  let httpStatus = 0;
  let verifiedLive = false;
  let probeError: string | null = null;
  let redirectHops = 0;
  let cookies: Record<string, string> = {};
  let referer: string | null = null;
  let streamType: 'hls' | 'dash' | 'progressive' | 'unknown' = parsedMeta.streamType;
  let hlsSegmentCount: number | undefined;
  let hlsDurationSec: number | undefined;
  let hlsVariants:
    | Array<{ label: string; url: string; bandwidth: number; resolution?: string }>
    | undefined;
  let hlsAudioLanguages: string[] | undefined;

  const extractFromResponse = (res: Response, isRangeOneByte: boolean) => {
    httpStatus = res.status;
    const cr = res.headers.get('content-range');
    if (cr) {
      const m = cr.match(/\/(\d+)$/);
      if (m) {
        const parsedTotal = Number(m[1]);
        if (Number.isFinite(parsedTotal) && parsedTotal > 0) {
          totalBytes = parsedTotal;
        }
      }
    }

    if (totalBytes <= 0 && !isRangeOneByte) {
      const cl = Number(res.headers.get('content-length') || 0);
      if (Number.isFinite(cl) && cl > 0) {
        totalBytes = cl;
      }
    }

    const ar = res.headers.get('accept-ranges');
    if (res.status === 206 || (ar && ar.toLowerCase().includes('bytes'))) {
      acceptRanges = true;
    }

    const ct = res.headers.get('content-type');
    if (ct) {
      contentType = ct.split(';')[0].trim().toLowerCase();
    }

    const cdName = parseContentDispositionFilename(res.headers.get('content-disposition'));
    if (cdName) {
      contentDispositionFilename = cdName;
    }
  };

  // Step 1: Try HEAD across redirect chain first (skip HEAD for obvious HLS playlists)
  if (streamType !== 'hls') {
    try {
      const headAttempt = await safeFetchWithRedirects(parsedMeta.normalizedUrl, {
        method: 'HEAD',
        timeoutMs: 8000,
      });
      finalUrl = headAttempt.finalUrl;
      redirectHops = headAttempt.redirectHops;
      cookies = headAttempt.cookies;
      referer = headAttempt.referer;
      httpStatus = headAttempt.response.status;
      try {
        await headAttempt.response.body?.cancel();
      } catch {
        // ignore
      }

      if (headAttempt.response.ok) {
        extractFromResponse(headAttempt.response, false);
        if (!contentType.includes('text/html')) {
          verifiedLive = true;
        }
      }
    } catch (err) {
      probeError = err instanceof Error ? err.message : 'Could not reach remote host.';
    }
  }

  // Step 2: Fallback 1-byte Range GET (or HTML interstitial follow if host returned HTML or blocked HEAD)
  if (!verifiedLive || totalBytes <= 0 || !acceptRanges || contentType.includes('text/html')) {
    try {
      const rangeAttempt = await safeFetchWithRedirects(finalUrl, {
        method: 'GET',
        headers: streamType === 'hls' ? {} : { Range: 'bytes=0-1023' },
        timeoutMs: 10000,
        followHtmlRedirects: true,
        cookies,
        referer,
      });

      finalUrl = rangeAttempt.finalUrl;
      redirectHops = Math.max(redirectHops, rangeAttempt.redirectHops);
      cookies = rangeAttempt.cookies;
      referer = rangeAttempt.referer;
      httpStatus = rangeAttempt.response.status;

      if (rangeAttempt.response.status === 206 || rangeAttempt.response.ok) {
        const isPartial = rangeAttempt.response.status === 206;
        extractFromResponse(rangeAttempt.response, isPartial);

        // Read small sample to sniff #EXTM3U / HTML error pages before claiming verifiedLive
        let sampleBuf = new Uint8Array(0);
        if (rangeAttempt.response.body) {
          const reader = rangeAttempt.response.body.getReader();
          try {
            const first = await reader.read();
            if (!first.done && first.value) {
              sampleBuf = first.value.subarray(0, Math.min(1024, first.value.byteLength));
            }
          } finally {
            await reader.cancel().catch(() => {});
          }
        }

        const sniffed = sniffInitialBytes(sampleBuf);
        if (sniffed === 'hls' || detectStreamType(finalUrl, contentDispositionFilename || parsedMeta.extractedFilename, contentType) === 'hls') {
          streamType = 'hls';
          totalBytes = 0; // Playlist size is NOT the video size
          acceptRanges = false;
          try {
            const hls = await resolveHlsMediaPlaylist(finalUrl, cookies, referer);
            finalUrl = hls.mediaPlaylistUrl;
            cookies = hls.cookies;
            hlsSegmentCount = hls.segments.length;
            hlsDurationSec = Math.round(hls.totalDurationSec);
            if (hls.variants.length > 0) {
              hlsVariants = hls.variants;
            }
            if (hls.audioLanguages.length > 0) {
              hlsAudioLanguages = hls.audioLanguages;
            }
            if (hls.encrypted) {
              verifiedLive = false;
              probeError = `This HLS stream uses ${hls.encryptionMethod || 'DRM'} encryption and cannot be assembled directly.`;
            } else if (hls.segments.length === 0) {
              verifiedLive = false;
              probeError = 'HLS playlist contains no downloadable media segments.';
            } else {
              verifiedLive = true;
              probeError = null;
            }
          } catch (hlsErr) {
            verifiedLive = false;
            probeError = hlsErr instanceof Error ? hlsErr.message : 'Could not parse HLS stream.';
          }
        } else if (sniffed === 'html') {
          verifiedLive = false;
          probeError =
            'Link resolved to an HTML webpage instead of a direct media stream. Open the page and copy the direct video/download link.';
        } else if (sniffed === 'json_error') {
          verifiedLive = false;
          probeError = 'Remote server returned a JSON error response (token may have expired).';
        } else {
          streamType = detectStreamType(
            finalUrl,
            contentDispositionFilename || parsedMeta.extractedFilename,
            contentType
          );
          verifiedLive = true;
          probeError = null;
        }
      } else {
        probeError = describeHttpError(rangeAttempt.response.status);
      }
    } catch (err) {
      if (!verifiedLive) {
        probeError = err instanceof Error ? err.message : 'Could not connect to remote host.';
      }
    }
  }

  return {
    finalUrl,
    totalBytes,
    acceptRanges,
    contentType,
    contentDispositionFilename,
    httpStatus,
    verifiedLive,
    probeError,
    streamType,
    redirectHops,
    hlsSegmentCount,
    hlsDurationSec,
    hlsVariants,
    hlsAudioLanguages,
    cookies,
    referer: referer || undefined,
  };
}

function pruneOldTransfers() {
  const now = Date.now();
  for (const [id, rec] of transfers.entries()) {
    if (
      (rec.status === 'completed' || rec.status === 'error' || rec.status === 'cancelled') &&
      now - rec.updatedAt > TRANSFER_RETENTION_MS
    ) {
      transfers.delete(id);
    }
  }
}

function recordBytesSent(rec: TransferRecord, bytes: number) {
  const now = Date.now();
  rec.downloadedBytes += bytes;
  rec.updatedAt = now;
  rec.speedSamples.push({ ts: now, bytes });

  const cutoff = now - 2000;
  while (rec.speedSamples.length > 0 && rec.speedSamples[0].ts < cutoff) {
    rec.speedSamples.shift();
  }

  if (rec.speedSamples.length === 0) {
    rec.speedBytesPerSec = 0;
  } else {
    const windowBytes = rec.speedSamples.reduce((sum, s) => sum + s.bytes, 0);
    const oldestTs = rec.speedSamples[0].ts;
    const elapsedSec = Math.max(0.35, (now - oldestTs) / 1000);
    rec.speedBytesPerSec = windowBytes / elapsedSec;
  }

  if (rec.streamType !== 'hls') {
    updateChunkMapFromProgress(rec);
  }
}

function refreshIdleSpeed(rec: TransferRecord) {
  if (rec.status !== 'downloading') {
    rec.speedBytesPerSec = 0;
    return;
  }
  const now = Date.now();
  const cutoff = now - 2200;
  while (rec.speedSamples.length > 0 && rec.speedSamples[0].ts < cutoff) {
    rec.speedSamples.shift();
  }
  if (rec.speedSamples.length === 0) {
    rec.speedBytesPerSec = 0;
  }
}

function updateChunkMapFromProgress(
  rec: TransferRecord,
  inFlightMap?: Map<number, { start: number; end: number; received: number; workerIndex: number }>
) {
  const SLOTS = 24;
  if (rec.totalBytes <= 0) {
    const filled =
      rec.status === 'completed'
        ? SLOTS
        : Math.min(SLOTS - 1, Math.floor(rec.downloadedBytes / (2 * 1024 * 1024)) % SLOTS);
    rec.chunks = Array.from({ length: SLOTS }, (_, idx) => ({
      index: idx,
      progress: rec.status === 'completed' ? 100 : idx < filled ? 100 : idx === filled ? 50 : 0,
      workerIndex: idx % Math.max(1, rec.parallelStreams),
    }));
    return;
  }

  const slotBytes = rec.totalBytes / SLOTS;
  rec.chunks = Array.from({ length: SLOTS }, (_, idx) => {
    const slotStart = idx * slotBytes;
    const slotEnd = (idx + 1) * slotBytes;

    let pct = 0;
    if (rec.downloadedBytes >= slotEnd || rec.status === 'completed') {
      pct = 100;
    } else if (rec.downloadedBytes > slotStart) {
      pct = Math.min(100, Math.round(((rec.downloadedBytes - slotStart) / slotBytes) * 100));
    }

    let workerIndex = idx % Math.max(1, rec.parallelStreams);

    if (pct < 100 && inFlightMap && inFlightMap.size > 0) {
      for (const info of inFlightMap.values()) {
        const chunkLoadedEnd = info.start + info.received;
        if (chunkLoadedEnd > slotStart && info.start < slotEnd) {
          const overlapStart = Math.max(slotStart, info.start);
          const overlapEnd = Math.min(slotEnd, chunkLoadedEnd);
          if (overlapEnd > overlapStart) {
            const extraPct = Math.round(((overlapEnd - overlapStart) / slotBytes) * 100);
            pct = Math.min(99, Math.max(pct, extraPct));
            workerIndex = info.workerIndex;
          }
        }
      }
    }

    return {
      index: idx,
      progress: pct,
      workerIndex,
    };
  });
}

function updateHlsChunkMap(rec: TransferRecord, completedSegments: number, totalSegments: number) {
  const SLOTS = 24;
  if (totalSegments <= 0) return;
  const ratio = Math.min(1, completedSegments / totalSegments);
  const fullSlots = Math.floor(ratio * SLOTS);
  const partialPct = Math.round((ratio * SLOTS - fullSlots) * 100);
  rec.chunks = Array.from({ length: SLOTS }, (_, idx) => ({
    index: idx,
    progress:
      rec.status === 'completed'
        ? 100
        : idx < fullSlots
        ? 100
        : idx === fullSlots
        ? partialPct
        : 0,
    workerIndex: idx % Math.max(1, rec.parallelStreams),
  }));
}

export function serializeTransfer(rec: TransferRecord) {
  refreshIdleSpeed(rec);
  return {
    id: rec.id,
    url: rec.url,
    resolvedUrl: rec.resolvedUrl,
    filename: rec.filename,
    contentType: rec.contentType,
    streamType: rec.streamType,
    status: rec.status,
    totalBytes: rec.totalBytes,
    downloadedBytes: rec.downloadedBytes,
    speedBytesPerSec: rec.speedBytesPerSec,
    acceptRanges: rec.acceptRanges,
    chunkSizeMb: rec.chunkSizeMb,
    parallelStreams: rec.parallelStreams,
    retryCount: rec.retryCount,
    redirectHops: rec.redirectHops,
    streamInitialized: rec.streamInitialized,
    errorMessage: rec.errorMessage,
    httpStatus: rec.httpStatus,
    quality: rec.quality,
    language: rec.language,
    savedOnDisk: rec.savedOnDisk,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    completedAt: rec.completedAt,
    chunks: rec.chunks,
  };
}

export function listTransfers() {
  pruneOldTransfers();
  return Array.from(transfers.values())
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(serializeTransfer);
}

export function getTransfer(id: string): TransferRecord | undefined {
  return transfers.get(id);
}

function isGenericQualityLabel(q: string | undefined | null): boolean {
  if (!q) return true;
  const low = q.trim().toLowerCase();
  return !low || low === 'source quality' || low === 'original' || low === 'auto';
}

function isGenericLanguageLabel(l: string | undefined | null): boolean {
  if (!l) return true;
  const low = l.trim().toLowerCase();
  return !low || low === 'source audio' || low === 'original audio' || low === 'default';
}

function normalizeQualityToken(q: string): string {
  const low = q.toLowerCase();
  if (/2160p|\b4k\b|uhd/.test(low)) return '2160p';
  if (/1440p|\b2k\b|qhd/.test(low)) return '1440p';
  if (/1080p|full\s*hd|fhd/.test(low)) return '1080p';
  if (/720p|\bhd\b/.test(low)) return '720p';
  if (/480p/.test(low)) return '480p';
  if (/360p/.test(low)) return '360p';
  if (/240p/.test(low)) return '240p';
  return low.trim();
}

export async function createTransfer(params: {
  url: string;
  filename: string;
  expectedBinary: boolean;
  chunkSizeMb?: number;
  parallelStreams?: number;
  speedCapMbps?: number | null;
  requestedQuality?: string;
  requestedLanguage?: string;
  autoStart?: boolean;
}): Promise<TransferRecord> {
  pruneOldTransfers();

  const activeCount = Array.from(transfers.values()).filter(
    (t) => t.status === 'connecting' || t.status === 'downloading' || t.status === 'paused'
  ).length;
  if (activeCount >= MAX_ACTIVE_TRANSFERS) {
    throw new Error('Too many active downloads running at once. Finish or cancel one first.');
  }

  const parsedMeta = parseAndNormalizeUrl(params.url);
  if (parsedMeta.parsed.protocol !== 'http:' && parsedMeta.parsed.protocol !== 'https:') {
    throw new Error('Only HTTP/HTTPS links can be downloaded directly through MochiDrop.');
  }
  if (isBlockedHostname(parsedMeta.parsed.hostname)) {
    throw new Error('Local or private network addresses are blocked.');
  }

  const probe = await probeRemoteUrl(parsedMeta.normalizedUrl);
  const id = `tr-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  const chunkSizeMb = Math.min(8, Math.max(2, Math.round(params.chunkSizeMb || 4)));
  const parallelStreams = Math.min(6, Math.max(1, Math.round(params.parallelStreams || 4)));

  let filename = sanitizeFilenameForHeader(
    probe.contentDispositionFilename || params.filename || parsedMeta.extractedFilename
  );
  if (probe.streamType === 'hls') {
    filename = filename.replace(/\.m3u8$/i, '') + (/\.(?:ts|mp4)$/i.test(filename) ? '' : '.ts');
  }

  // Strict quality & language validation mapped directly to real URL/HLS metadata
  let resolvedUrl = probe.finalUrl || parsedMeta.normalizedUrl;
  let verifiedQuality: string | null = null;
  let verifiedLanguage: string | null = null;

  if (probe.streamType === 'hls' && probe.hlsVariants && probe.hlsVariants.length > 0) {
    if (!isGenericQualityLabel(params.requestedQuality)) {
      const reqToken = normalizeQualityToken(params.requestedQuality!);
      const matchedVariant = probe.hlsVariants.find(
        (v) =>
          v.label.toLowerCase() === params.requestedQuality!.trim().toLowerCase() ||
          normalizeQualityToken(v.label) === reqToken
      );
      if (!matchedVariant) {
        const available = probe.hlsVariants.map((v) => v.label).join(', ');
        throw new Error(
          `Requested quality "${params.requestedQuality}" is not available in this stream. Available: ${available}`
        );
      }
      resolvedUrl = matchedVariant.url;
      verifiedQuality = matchedVariant.label;
    } else {
      resolvedUrl = probe.hlsVariants[0].url;
      verifiedQuality = probe.hlsVariants[0].label;
    }

    if (probe.hlsAudioLanguages && probe.hlsAudioLanguages.length > 0) {
      if (!isGenericLanguageLabel(params.requestedLanguage)) {
        const matchedLang = probe.hlsAudioLanguages.find(
          (l) => l.toLowerCase() === params.requestedLanguage!.trim().toLowerCase()
        );
        if (!matchedLang) {
          throw new Error(
            `Requested language "${params.requestedLanguage}" is not in this stream. Available: ${probe.hlsAudioLanguages.join(', ')}`
          );
        }
        verifiedLanguage = matchedLang;
      } else {
        verifiedLanguage = probe.hlsAudioLanguages[0];
      }
    }
  } else {
    const metadataSource = `${filename} ${parsedMeta.embeddedTargetUrl || parsedMeta.normalizedUrl}`;
    const detectedQuality = detectQualityHint(metadataSource);
    const detectedLanguage = detectLanguageHint(metadataSource);

    if (detectedQuality && !isGenericQualityLabel(params.requestedQuality)) {
      if (normalizeQualityToken(params.requestedQuality!) !== normalizeQualityToken(detectedQuality)) {
        throw new Error(
          `Quality mismatch: this direct link only provides ${detectedQuality}, not ${params.requestedQuality}.`
        );
      }
    }
    verifiedQuality = detectedQuality || (isGenericQualityLabel(params.requestedQuality) ? 'Source Quality' : params.requestedQuality!);

    if (detectedLanguage && !isGenericLanguageLabel(params.requestedLanguage)) {
      const reqLow = params.requestedLanguage!.trim().toLowerCase();
      const detLow = detectedLanguage.toLowerCase();
      if (!detLow.includes(reqLow) && !reqLow.includes(detLow)) {
        throw new Error(
          `Language mismatch: this direct link provides ${detectedLanguage}, not ${params.requestedLanguage}.`
        );
      }
    }
    verifiedLanguage = detectedLanguage || (isGenericLanguageLabel(params.requestedLanguage) ? 'Source Audio' : params.requestedLanguage!);
  }

  const fatalPreFlightError =
    !probe.verifiedLive &&
    probe.probeError &&
    (probe.httpStatus === 401 ||
      probe.httpStatus === 403 ||
      probe.httpStatus === 404 ||
      probe.httpStatus === 410 ||
      probe.probeError.includes('HTML webpage') ||
      probe.probeError.includes('encryption') ||
      probe.probeError.includes('zero downloadable') ||
      probe.probeError.includes('no downloadable'));

  const safeDiskBase = filename.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'download.bin';
  const diskFilePath = path.join(DOWNLOADS_DIR, `${id}_${safeDiskBase}`);

  const rec: TransferRecord = {
    id,
    url: parsedMeta.normalizedUrl,
    resolvedUrl,
    filename,
    contentType:
      probe.streamType === 'hls'
        ? 'video/mp2t'
        : probe.contentType || 'application/octet-stream',
    expectedBinary: params.expectedBinary,
    streamType: probe.streamType,
    status: fatalPreFlightError ? 'error' : 'connecting',
    totalBytes: probe.streamType === 'hls' ? 0 : probe.totalBytes,
    downloadedBytes: 0,
    speedBytesPerSec: 0,
    acceptRanges: probe.streamType === 'hls' ? false : probe.acceptRanges,
    chunkSizeMb,
    parallelStreams,
    speedCapMbps:
      typeof params.speedCapMbps === 'number' && params.speedCapMbps > 0
        ? params.speedCapMbps
        : null,
    retryCount: 0,
    redirectHops: probe.redirectHops,
    streamInitialized: false,
    errorMessage: fatalPreFlightError ? probe.probeError : null,
    httpStatus: probe.httpStatus || null,
    quality: verifiedQuality,
    language: verifiedLanguage,
    savedOnDisk: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completedAt: null,
    chunks: Array.from({ length: 24 }, (_, idx) => ({
      index: idx,
      progress: 0,
      workerIndex: idx % parallelStreams,
    })),
    paused: false,
    abortController: null,
    speedSamples: [],
    cookies: probe.cookies || {},
    referer: probe.referer || null,
    filePath: diskFilePath,
  };

  transfers.set(id, rec);

  if (params.autoStart !== false && rec.status !== 'error') {
    startBackgroundTransfer(rec);
  }

  return rec;
}

export function setTransferPaused(id: string, paused: boolean): TransferRecord | null {
  const rec = transfers.get(id);
  if (!rec) return null;
  rec.paused = paused;
  if (rec.status === 'downloading' && paused) {
    rec.status = 'paused';
    rec.speedBytesPerSec = 0;
  } else if (rec.status === 'paused' && !paused) {
    rec.status = 'downloading';
  }
  rec.updatedAt = Date.now();
  return rec;
}

function cleanupDiskFiles(filePath: string | null) {
  if (!filePath) return;
  void fsp.unlink(filePath).catch(() => {});
  void fsp.unlink(`${filePath}.part`).catch(() => {});
}

export function cancelTransfer(id: string): boolean {
  const rec = transfers.get(id);
  if (!rec) return false;
  rec.paused = false;
  if (rec.abortController) {
    rec.abortController.abort();
    rec.abortController = null;
  }
  if (rec.status !== 'completed') {
    rec.status = 'cancelled';
    rec.speedBytesPerSec = 0;
    rec.updatedAt = Date.now();
  }
  cleanupDiskFiles(rec.filePath);
  transfers.delete(id);
  return true;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Transfer aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Transfer aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitWhilePaused(rec: TransferRecord, signal: AbortSignal): Promise<void> {
  while (rec.paused && !signal.aborted) {
    rec.speedBytesPerSec = 0;
    await sleep(200, signal);
  }
}

function waitForDrain(res: express.Response, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted || res.destroyed || res.writableEnded) {
      reject(new Error('Transfer aborted'));
      return;
    }

    const cleanup = () => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      res.off('error', onError);
      signal.removeEventListener('abort', onAbort);
    };

    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error('Client disconnected'));
    };
    const onError = () => {
      cleanup();
      reject(new Error('Client socket error'));
    };
    const onAbort = () => {
      cleanup();
      reject(new Error('Transfer aborted'));
    };

    res.on('drain', onDrain);
    res.on('close', onClose);
    res.on('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function writeBufferRespectingControls(
  res: express.Response,
  buffer: Uint8Array,
  rec: TransferRecord,
  signal: AbortSignal
): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    if (signal.aborted || res.destroyed || res.writableEnded) {
      throw new Error('Transfer aborted');
    }
    await waitWhilePaused(rec, signal);

    const end = Math.min(buffer.length, offset + SLICE_SIZE);
    const slice = buffer.subarray(offset, end);
    const sliceStart = Date.now();

    const ok = res.write(slice);
    if (!ok) {
      await waitForDrain(res, signal);
    }

    const written = end - offset;
    recordBytesSent(rec, written);
    offset = end;

    if (rec.speedCapMbps && rec.speedCapMbps > 0) {
      const capBytesPerSec = (rec.speedCapMbps * 1024 * 1024) / 8;
      const expectedMs = (written / capBytesPerSec) * 1000;
      const actualMs = Date.now() - sliceStart;
      if (expectedMs > actualMs + 2) {
        await sleep(Math.min(500, expectedMs - actualMs), signal);
      }
    }
  }
}

function sendAttachmentHeaders(res: express.Response, rec: TransferRecord, includeLength: boolean) {
  const safeAscii = rec.filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '');
  const encodedUtf8 = encodeURIComponent(rec.filename);

  res.status(200);
  res.setHeader('Content-Type', rec.contentType || 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${safeAscii || 'download.bin'}"; filename*=UTF-8''${encodedUtf8}`
  );
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Accel-Buffering', 'no');
  if (includeLength && rec.totalBytes > 0) {
    res.setHeader('Content-Length', String(rec.totalBytes));
  }
  // Flush headers immediately so the browser's download manager initializes cleanly
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }
  rec.streamInitialized = true;
}

/**
 * Fetches an exact byte range [start, end] completely, automatically resuming sub-ranges
 * and retrying with backoff if a Cloudflare Worker or CDN drops the connection mid-chunk.
 */
async function fetchExactByteRange(
  rec: TransferRecord,
  start: number,
  end: number,
  workerIndex: number,
  signal: AbortSignal,
  inFlightMap: Map<number, { start: number; end: number; received: number; workerIndex: number }>,
  chunkIndex: number
): Promise<Buffer> {
  const expectedLength = end - start + 1;
  const parts: Buffer[] = [];
  let received = 0;
  const maxAttempts = 8;

  inFlightMap.set(chunkIndex, { start, end, received: 0, workerIndex });

  try {
    for (let attempt = 1; attempt <= maxAttempts && received < expectedLength; attempt++) {
      if (signal.aborted) throw new Error('Transfer aborted');
      await waitWhilePaused(rec, signal);

      const reqStart = start + received;
      const targetUrl = attempt % 2 === 1 ? rec.resolvedUrl : rec.url;

      try {
        const { response, cookies } = await safeFetchWithRedirects(targetUrl, {
          method: 'GET',
          headers: {
            Range: `bytes=${reqStart}-${end}`,
          },
          timeoutMs: 25000,
          cookies: rec.cookies,
          referer: rec.referer,
          signal,
        });
        rec.cookies = cookies;

        if (response.status !== 206 && !(response.status === 200 && reqStart === 0)) {
          const status = response.status;
          try {
            await response.body?.cancel();
          } catch {
            // ignore
          }
          if (status === 401 || status === 403 || status === 404 || status === 410) {
            rec.httpStatus = status;
            throw new Error(describeHttpError(status));
          }
          throw new Error(`Chunk range HTTP ${status}`);
        }

        const ct = (response.headers.get('content-type') || '').toLowerCase();
        if (rec.expectedBinary && ct.includes('text/html') && expectedLength > 200 * 1024) {
          try {
            await response.body?.cancel();
          } catch {
            // ignore
          }
          throw new Error(
            'Remote link returned an HTML webpage instead of the media file. The signed link may have expired.'
          );
        }

        if (!response.body) {
          throw new Error('Upstream returned empty response body.');
        }

        const reader = response.body.getReader();
        while (received < expectedLength) {
          if (signal.aborted) {
            await reader.cancel().catch(() => {});
            throw new Error('Transfer aborted');
          }
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) {
            const needed = expectedLength - received;
            const take = value.byteLength > needed ? value.subarray(0, needed) : value;
            parts.push(Buffer.from(take));
            received += take.byteLength;
            inFlightMap.set(chunkIndex, { start, end, received, workerIndex });
            updateChunkMapFromProgress(rec, inFlightMap);
            if (received >= expectedLength) {
              await reader.cancel().catch(() => {});
              break;
            }
          }
        }
      } catch (err) {
        if (signal.aborted) throw err;
        const msg = err instanceof Error ? err.message : 'Chunk read failed';
        if (
          msg.includes('HTTP 401') ||
          msg.includes('HTTP 403') ||
          msg.includes('HTTP 404') ||
          msg.includes('HTTP 410') ||
          msg.includes('HTML webpage')
        ) {
          throw err;
        }
        if (attempt >= maxAttempts) {
          throw new Error(`Connection dropped while downloading (${msg}).`);
        }
        rec.retryCount += 1;
        rec.updatedAt = Date.now();
        await sleep(Math.min(4000, 400 * Math.pow(1.7, attempt - 1)), signal);
      }
    }

    if (received < expectedLength) {
      throw new Error('Remote server closed the connection before the byte range completed.');
    }

    return Buffer.concat(parts, expectedLength);
  } finally {
    inFlightMap.delete(chunkIndex);
  }
}

async function fetchHlsSegmentWithRetry(
  rec: TransferRecord,
  segmentUrl: string,
  signal: AbortSignal
): Promise<Buffer> {
  const maxAttempts = 6;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal.aborted) throw new Error('Transfer aborted');
    await waitWhilePaused(rec, signal);

    try {
      const { response, cookies } = await safeFetchWithRedirects(segmentUrl, {
        method: 'GET',
        timeoutMs: 20000,
        cookies: rec.cookies,
        referer: rec.referer || rec.resolvedUrl,
        signal,
      });
      rec.cookies = cookies;

      if (!response.ok) {
        const st = response.status;
        try {
          await response.body?.cancel();
        } catch {
          // ignore
        }
        if (st === 401 || st === 403 || st === 404 || st === 410) {
          throw new Error(describeHttpError(st));
        }
        throw new Error(`Segment HTTP ${st}`);
      }

      const arr = await response.arrayBuffer();
      if (arr.byteLength === 0) {
        throw new Error('Empty media segment');
      }
      return Buffer.from(arr);
    } catch (err) {
      if (signal.aborted) throw err;
      const msg = err instanceof Error ? err.message : 'Segment download failed';
      if (
        msg.includes('HTTP 401') ||
        msg.includes('HTTP 403') ||
        msg.includes('HTTP 404') ||
        msg.includes('HTTP 410')
      ) {
        throw err;
      }
      if (attempt >= maxAttempts) {
        throw new Error(`HLS segment failed after retries (${msg}).`);
      }
      rec.retryCount += 1;
      await sleep(Math.min(3500, 350 * attempt), signal);
    }
  }
  throw new Error('HLS segment could not be fetched.');
}

/**
 * Streams an HLS (.m3u8) stream as one continuous playable binary video file (.ts or .mp4),
 * pre-verifying segment 0 before sending attachment headers so false-positive 2 KB playlist saves never occur.
 */
async function streamHlsToResponse(
  rec: TransferRecord,
  res: express.Response,
  signal: AbortSignal,
  isClientAborted: () => boolean
): Promise<void> {
  const playlist = await resolveHlsMediaPlaylist(
    rec.resolvedUrl || rec.url,
    rec.cookies,
    rec.referer,
    signal
  );

  rec.resolvedUrl = playlist.mediaPlaylistUrl;
  rec.cookies = playlist.cookies;

  if (playlist.encrypted) {
    throw new Error(
      `This HLS stream is encrypted (${playlist.encryptionMethod || 'DRM'}) and cannot be downloaded without decryption keys.`
    );
  }
  if (playlist.segments.length === 0) {
    throw new Error('HLS playlist returned zero downloadable video segments.');
  }

  const allUrls: string[] = [];
  if (playlist.initSegmentUrl) {
    allUrls.push(playlist.initSegmentUrl);
    rec.contentType = 'video/mp4';
    rec.filename = rec.filename.replace(/\.(?:m3u8|ts)$/i, '') + '.mp4';
  } else {
    rec.contentType = 'video/mp2t';
    if (!/\.ts$/i.test(rec.filename)) {
      rec.filename = rec.filename.replace(/\.m3u8$/i, '') + '.ts';
    }
  }
  allUrls.push(...playlist.segments);

  const totalSegments = allUrls.length;
  const maxAhead = Math.min(4, Math.max(1, rec.parallelStreams));
  const pending = new Map<number, Promise<Buffer>>();

  const schedule = (idx: number) => {
    if (idx >= totalSegments || pending.has(idx)) return;
    const p = fetchHlsSegmentWithRetry(rec, allUrls[idx], signal);
    p.catch(() => {});
    pending.set(idx, p);
  };

  // Pre-fetch and verify segment 0 BEFORE initializing browser download headers
  schedule(0);
  const firstSegment = await pending.get(0)!;
  pending.delete(0);

  if (signal.aborted || isClientAborted()) return;

  const sniffed = sniffInitialBytes(firstSegment);
  if (sniffed === 'html' || sniffed === 'json_error') {
    throw new Error('HLS media segment returned an HTML/JSON error instead of video data.');
  }

  rec.status = 'downloading';
  rec.totalBytes = 0; // Chunked streaming — total bytes unknown until all segments complete
  sendAttachmentHeaders(res, rec, false);

  for (let w = 1; w <= maxAhead && w < totalSegments; w++) {
    schedule(w);
  }

  await writeBufferRespectingControls(res, firstSegment, rec, signal);
  let completedSegments = 1;
  updateHlsChunkMap(rec, completedSegments, totalSegments);

  for (let i = 1; i < totalSegments; i++) {
    if (signal.aborted || isClientAborted()) return;

    for (let lookahead = i; lookahead < Math.min(totalSegments, i + maxAhead); lookahead++) {
      schedule(lookahead);
    }

    const segBuf = await pending.get(i)!;
    pending.delete(i);
    await writeBufferRespectingControls(res, segBuf, rec, signal);
    completedSegments += 1;
    updateHlsChunkMap(rec, completedSegments, totalSegments);
  }

  if (completedSegments < totalSegments || rec.downloadedBytes <= 0) {
    throw new Error(
      `HLS stream ended prematurely (${completedSegments}/${totalSegments} segments).`
    );
  }

  if (!res.writableEnded) {
    res.end();
  }
  rec.totalBytes = rec.downloadedBytes;
  rec.status = 'completed';
  rec.speedBytesPerSec = 0;
  rec.completedAt = Date.now();
  rec.updatedAt = Date.now();
  updateHlsChunkMap(rec, totalSegments, totalSegments);
}

/**
 * Streams a real download directly from the remote host to the user's browser Downloads folder.
 * Strictly verifies initial binary bytes BEFORE flushing attachment headers and NEVER triggers
 * a false-positive completion on 0-byte, HTML, or truncated streams.
 */
export async function streamTransferToResponse(
  rec: TransferRecord,
  req: express.Request,
  res: express.Response
): Promise<void> {
  if (rec.abortController) {
    rec.abortController.abort();
  }

  const controller = new AbortController();
  const signal = controller.signal;
  rec.abortController = controller;
  rec.paused = false;
  rec.status = 'connecting';
  rec.streamInitialized = false;
  rec.downloadedBytes = 0;
  rec.speedBytesPerSec = 0;
  rec.speedSamples = [];
  rec.errorMessage = null;
  rec.retryCount = 0;
  rec.completedAt = null;
  rec.updatedAt = Date.now();

  let clientAborted = false;
  const onDisconnect = () => {
    if (!res.writableEnded) {
      clientAborted = true;
      controller.abort();
      if (rec.status !== 'completed' && rec.status !== 'error') {
        rec.status = 'cancelled';
        rec.speedBytesPerSec = 0;
        rec.updatedAt = Date.now();
      }
    }
  };
  req.on('close', onDisconnect);
  req.on('error', onDisconnect);
  res.on('error', onDisconnect);

  try {
    // Re-probe if size/type wasn't confirmed yet
    if (rec.streamType !== 'hls' && rec.totalBytes <= 0) {
      const freshProbe = await probeRemoteUrl(rec.url);
      if (freshProbe.totalBytes > 0) rec.totalBytes = freshProbe.totalBytes;
      if (freshProbe.acceptRanges) rec.acceptRanges = true;
      if (freshProbe.contentType) rec.contentType = freshProbe.contentType;
      if (freshProbe.finalUrl) rec.resolvedUrl = freshProbe.finalUrl;
      if (freshProbe.httpStatus) rec.httpStatus = freshProbe.httpStatus;
      if (freshProbe.cookies) rec.cookies = freshProbe.cookies;
      if (freshProbe.referer) rec.referer = freshProbe.referer;
      rec.redirectHops = Math.max(rec.redirectHops, freshProbe.redirectHops);
      rec.streamType = freshProbe.streamType;
      if (freshProbe.probeError && !freshProbe.verifiedLive) {
        throw new Error(freshProbe.probeError);
      }
    }

    // MODE 0: HLS (.m3u8) Streaming Assembly
    if (rec.streamType === 'hls') {
      await streamHlsToResponse(rec, res, signal, () => clientAborted);
      return;
    }

    // MODE 1: Parallel Resumable Multi-Chunk HTTP Range Streaming
    if (rec.acceptRanges && rec.totalBytes > 0) {
      // Keep per-transfer memory flat (<= ~4-6 MB RAM) even for multi-GB movies
      const chunkBytes = Math.min(2, Math.max(1, rec.chunkSizeMb)) * 1024 * 1024;
      const totalChunks = Math.ceil(rec.totalBytes / chunkBytes);
      const maxWindow = Math.min(2, Math.max(1, rec.parallelStreams));

      const inFlightMap = new Map<
        number,
        { start: number; end: number; received: number; workerIndex: number }
      >();
      const chunkPromises = new Map<number, Promise<Buffer>>();

      const scheduleChunk = (idx: number) => {
        if (idx >= totalChunks || chunkPromises.has(idx)) return;
        const start = idx * chunkBytes;
        const end = Math.min(rec.totalBytes - 1, start + chunkBytes - 1);
        const workerIndex = idx % maxWindow;
        const p = fetchExactByteRange(rec, start, end, workerIndex, signal, inFlightMap, idx);
        p.catch(() => {});
        chunkPromises.set(idx, p);
      };

      // Fetch and verify chunk 0 BEFORE sending attachment headers
      scheduleChunk(0);
      const firstChunk = await chunkPromises.get(0)!;
      chunkPromises.delete(0);

      if (signal.aborted || clientAborted) return;

      if (firstChunk.byteLength === 0) {
        throw new Error('Remote host returned an empty byte stream.');
      }

      const sniffed = sniffInitialBytes(firstChunk);
      if (sniffed === 'hls') {
        rec.streamType = 'hls';
        rec.totalBytes = 0;
        rec.acceptRanges = false;
        await streamHlsToResponse(rec, res, signal, () => clientAborted);
        return;
      }
      if (rec.expectedBinary && (sniffed === 'html' || sniffed === 'json_error')) {
        throw new Error(
          'Remote link returned an HTML/JSON error page instead of binary media data. The link may have expired.'
        );
      }

      rec.status = 'downloading';
      sendAttachmentHeaders(res, rec, true);

      for (let w = 1; w <= maxWindow && w < totalChunks; w++) {
        scheduleChunk(w);
      }

      await writeBufferRespectingControls(res, firstChunk, rec, signal);

      for (let nextIdx = 1; nextIdx < totalChunks; nextIdx++) {
        if (signal.aborted || clientAborted) return;

        for (
          let lookahead = nextIdx;
          lookahead < Math.min(totalChunks, nextIdx + maxWindow);
          lookahead++
        ) {
          scheduleChunk(lookahead);
        }

        const buf = await chunkPromises.get(nextIdx)!;
        chunkPromises.delete(nextIdx);
        await writeBufferRespectingControls(res, buf, rec, signal);
      }

      // Strict byte-count verification — never allow false-positive completion
      if (rec.downloadedBytes < rec.totalBytes || rec.downloadedBytes <= 0) {
        throw new Error(
          `Transfer ended early (${rec.downloadedBytes} / ${rec.totalBytes} bytes received).`
        );
      }

      if (!res.writableEnded) {
        res.end();
      }
      rec.status = 'completed';
      rec.speedBytesPerSec = 0;
      rec.completedAt = Date.now();
      rec.updatedAt = Date.now();
      updateChunkMapFromProgress(rec);
      return;
    }

    // MODE 2: Resilient Single-Stream Piping (with initial byte verification & Range drop-recovery)
    let headersSent = false;
    let bytesWritten = 0;
    const maxStreamRetries = 6;

    for (let attempt = 1; attempt <= maxStreamRetries; attempt++) {
      if (signal.aborted || clientAborted) return;
      const reqHeaders: Record<string, string> = {};
      if (bytesWritten > 0) {
        reqHeaders.Range = `bytes=${bytesWritten}-`;
      }

      const targetUrl = attempt % 2 === 1 ? rec.resolvedUrl : rec.url;
      const { response, finalUrl, cookies, redirectHops } = await safeFetchWithRedirects(targetUrl, {
        method: 'GET',
        headers: reqHeaders,
        timeoutMs: 25000,
        followHtmlRedirects: !headersSent,
        cookies: rec.cookies,
        referer: rec.referer,
        signal,
      });

      rec.resolvedUrl = finalUrl;
      rec.cookies = cookies;
      rec.redirectHops = Math.max(rec.redirectHops, redirectHops);
      rec.httpStatus = response.status;

      if (!response.ok && response.status !== 206) {
        try {
          await response.body?.cancel();
        } catch {
          // ignore
        }
        throw new Error(describeHttpError(response.status));
      }

      if (bytesWritten > 0 && response.status !== 206) {
        try {
          await response.body?.cancel();
        } catch {
          // ignore
        }
        throw new Error('Remote server dropped the connection and does not support resume.');
      }

      if (!response.body) {
        throw new Error('Upstream returned an empty response body.');
      }

      const reader = response.body.getReader();

      try {
        // Before sending headers, read & verify the FIRST real non-empty byte chunk
        if (!headersSent) {
          let firstChunk: Uint8Array | null = null;
          while (true) {
            if (signal.aborted || clientAborted) {
              await reader.cancel().catch(() => {});
              return;
            }
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.byteLength > 0) {
              firstChunk = value;
              break;
            }
          }

          if (!firstChunk || firstChunk.byteLength === 0) {
            await reader.cancel().catch(() => {});
            throw new Error('Remote server returned an empty (0 byte) file.');
          }

          const sniffed = sniffInitialBytes(firstChunk);
          if (sniffed === 'hls') {
            await reader.cancel().catch(() => {});
            rec.streamType = 'hls';
            rec.totalBytes = 0;
            await streamHlsToResponse(rec, res, signal, () => clientAborted);
            return;
          }

          const ct = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
          const cl = Number(response.headers.get('content-length') || 0);
          if (
            rec.expectedBinary &&
            (sniffed === 'html' || sniffed === 'json_error' || (ct.includes('text/html') && (cl === 0 || cl < 500 * 1024)))
          ) {
            await reader.cancel().catch(() => {});
            throw new Error(
              'Remote link returned an HTML/JSON page instead of a downloadable media stream. The signed link may have expired.'
            );
          }

          if (ct) rec.contentType = ct;
          if (cl > 0 && rec.totalBytes <= 0) rec.totalBytes = cl;
          const cdName = parseContentDispositionFilename(response.headers.get('content-disposition'));
          if (cdName) rec.filename = cdName;

          rec.status = 'downloading';
          sendAttachmentHeaders(res, rec, rec.totalBytes > 0);
          headersSent = true;

          await writeBufferRespectingControls(res, firstChunk, rec, signal);
          bytesWritten += firstChunk.byteLength;
        }

        while (true) {
          if (signal.aborted || clientAborted) {
            await reader.cancel().catch(() => {});
            return;
          }
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) {
            await writeBufferRespectingControls(res, value, rec, signal);
            bytesWritten += value.byteLength;
          }
        }
      } catch (err) {
        if (signal.aborted || clientAborted) return;
        const msg = err instanceof Error ? err.message : 'Stream read error';
        if (
          !headersSent &&
          (msg.includes('HTML') ||
            msg.includes('empty') ||
            msg.includes('HTTP 401') ||
            msg.includes('HTTP 403') ||
            msg.includes('HTTP 404') ||
            msg.includes('HTTP 410'))
        ) {
          throw err;
        }
        if (attempt >= maxStreamRetries) {
          throw err;
        }
        rec.retryCount += 1;
        await sleep(Math.min(4000, 500 * attempt), signal);
        continue;
      }

      // Guard against silent upstream truncation
      if (rec.totalBytes > 0 && bytesWritten < rec.totalBytes) {
        if (attempt >= maxStreamRetries) {
          throw new Error(
            `Remote host closed early at ${bytesWritten} / ${rec.totalBytes} bytes.`
          );
        }
        rec.retryCount += 1;
        await sleep(Math.min(4000, 500 * attempt), signal);
        continue;
      }

      break;
    }

    // Final strict verification — NEVER mark completed on 0 bytes or uninitialized stream
    if (!rec.streamInitialized || bytesWritten <= 0) {
      throw new Error('Download stream never initialized with valid media bytes.');
    }
    if (rec.totalBytes > 0 && bytesWritten < rec.totalBytes) {
      throw new Error(
        `Stream ended prematurely at ${bytesWritten} / ${rec.totalBytes} bytes.`
      );
    }

    if (!res.writableEnded) {
      res.end();
    }
    if (rec.totalBytes <= 0) {
      rec.totalBytes = rec.downloadedBytes;
    }
    rec.status = 'completed';
    rec.speedBytesPerSec = 0;
    rec.completedAt = Date.now();
    rec.updatedAt = Date.now();
    updateChunkMapFromProgress(rec);
  } catch (err) {
    if (clientAborted || signal.aborted) {
      if (rec.status !== 'completed') {
        rec.status = 'cancelled';
        rec.speedBytesPerSec = 0;
        rec.updatedAt = Date.now();
      }
      return;
    }

    const message = err instanceof Error ? err.message : 'Download failed.';
    rec.status = 'error';
    rec.errorMessage = message;
    rec.speedBytesPerSec = 0;
    rec.updatedAt = Date.now();

    if (!res.headersSent) {
      res.status(rec.httpStatus && rec.httpStatus >= 400 ? rec.httpStatus : 502).json({
        error: message,
      });
    } else if (!res.writableEnded) {
      // Destroy incomplete response so the browser's download manager marks it failed/interrupted instead of complete
      res.destroy();
    }
  } finally {
    req.off('close', onDisconnect);
    req.off('error', onDisconnect);
    res.off('error', onDisconnect);
    if (rec.abortController === controller) {
      rec.abortController = null;
    }
  }
}

function waitForFileStreamDrain(stream: fs.WriteStream, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted || stream.destroyed) {
      reject(new Error('Transfer aborted'));
      return;
    }
    const cleanup = () => {
      stream.off('drain', onDrain);
      stream.off('error', onError);
      stream.off('close', onClose);
      signal.removeEventListener('abort', onAbort);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('Disk write stream closed unexpectedly'));
    };
    const onAbort = () => {
      cleanup();
      reject(new Error('Transfer aborted'));
    };
    stream.on('drain', onDrain);
    stream.on('error', onError);
    stream.on('close', onClose);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function writeBufferToDiskRespectingControls(
  stream: fs.WriteStream,
  buffer: Uint8Array,
  rec: TransferRecord,
  signal: AbortSignal
): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    if (signal.aborted || stream.destroyed) {
      throw new Error('Transfer aborted');
    }
    await waitWhilePaused(rec, signal);

    const end = Math.min(buffer.length, offset + SLICE_SIZE);
    const slice = buffer.subarray(offset, end);
    const sliceStart = Date.now();

    const ok = stream.write(slice);
    if (!ok) {
      await waitForFileStreamDrain(stream, signal);
    }

    const written = end - offset;
    recordBytesSent(rec, written);
    offset = end;

    if (rec.speedCapMbps && rec.speedCapMbps > 0) {
      const capBytesPerSec = (rec.speedCapMbps * 1024 * 1024) / 8;
      const expectedMs = (written / capBytesPerSec) * 1000;
      const actualMs = Date.now() - sliceStart;
      if (expectedMs > actualMs + 2) {
        await sleep(Math.min(500, expectedMs - actualMs), signal);
      }
    }
  }
}

function finalizeFileStream(stream: fs.WriteStream): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (stream.destroyed) {
      reject(new Error('Disk write stream destroyed'));
      return;
    }
    stream.once('finish', resolve);
    stream.once('error', reject);
    stream.end();
  });
}

/**
 * Downloads the file completely INSIDE MochiDrop's server-managed storage directory
 * (never hijacking Chrome's download manager or triggering browser iframe crashes).
 */
export function startBackgroundTransfer(rec: TransferRecord): void {
  if (rec.abortController) {
    rec.abortController.abort();
  }

  const controller = new AbortController();
  const signal = controller.signal;
  rec.abortController = controller;
  rec.paused = false;
  rec.status = 'connecting';
  rec.streamInitialized = false;
  rec.savedOnDisk = false;
  rec.downloadedBytes = 0;
  rec.speedBytesPerSec = 0;
  rec.speedSamples = [];
  rec.errorMessage = null;
  rec.retryCount = 0;
  rec.completedAt = null;
  rec.updatedAt = Date.now();

  void (async () => {
    let writeStream: fs.WriteStream | null = null;
    const finalPath =
      rec.filePath || path.join(DOWNLOADS_DIR, `${rec.id}_${rec.filename.replace(/[^a-zA-Z0-9._-]+/g, '_')}`);
    rec.filePath = finalPath;
    const partPath = `${finalPath}.part`;

    const openPartFile = async () => {
      await fsp.mkdir(DOWNLOADS_DIR, { recursive: true });
      writeStream = fs.createWriteStream(partPath, { flags: 'w' });
      writeStream.on('error', () => {
        controller.abort();
      });
      rec.streamInitialized = true;
      rec.status = 'downloading';
      rec.updatedAt = Date.now();
    };

    try {
      // Re-probe if size/type wasn't confirmed yet
      if (rec.streamType !== 'hls' && rec.totalBytes <= 0) {
        const freshProbe = await probeRemoteUrl(rec.resolvedUrl || rec.url);
        if (freshProbe.totalBytes > 0) rec.totalBytes = freshProbe.totalBytes;
        if (freshProbe.acceptRanges) rec.acceptRanges = true;
        if (freshProbe.contentType) rec.contentType = freshProbe.contentType;
        if (freshProbe.finalUrl) rec.resolvedUrl = freshProbe.finalUrl;
        if (freshProbe.httpStatus) rec.httpStatus = freshProbe.httpStatus;
        if (freshProbe.cookies) rec.cookies = freshProbe.cookies;
        if (freshProbe.referer) rec.referer = freshProbe.referer;
        rec.redirectHops = Math.max(rec.redirectHops, freshProbe.redirectHops);
        rec.streamType = freshProbe.streamType;
        if (freshProbe.probeError && !freshProbe.verifiedLive) {
          throw new Error(freshProbe.probeError);
        }
      }

      // MODE 0: HLS (.m3u8) Streaming Assembly straight to disk
      if (rec.streamType === 'hls') {
        const playlist = await resolveHlsMediaPlaylist(
          rec.resolvedUrl || rec.url,
          rec.cookies,
          rec.referer,
          signal
        );
        rec.resolvedUrl = playlist.mediaPlaylistUrl;
        rec.cookies = playlist.cookies;

        if (playlist.encrypted) {
          throw new Error(
            `This HLS stream is encrypted (${playlist.encryptionMethod || 'DRM'}) and cannot be downloaded without decryption keys.`
          );
        }
        if (playlist.segments.length === 0) {
          throw new Error('HLS playlist returned zero downloadable video segments.');
        }

        const allUrls: string[] = [];
        if (playlist.initSegmentUrl) {
          allUrls.push(playlist.initSegmentUrl);
          rec.contentType = 'video/mp4';
          rec.filename = rec.filename.replace(/\.(?:m3u8|ts)$/i, '') + '.mp4';
        } else {
          rec.contentType = 'video/mp2t';
          if (!/\.ts$/i.test(rec.filename)) {
            rec.filename = rec.filename.replace(/\.m3u8$/i, '') + '.ts';
          }
        }
        allUrls.push(...playlist.segments);

        const totalSegments = allUrls.length;
        const maxAhead = Math.min(2, Math.max(1, rec.parallelStreams));
        const pending = new Map<number, Promise<Buffer>>();
        const schedule = (idx: number) => {
          if (idx >= totalSegments || pending.has(idx)) return;
          const p = fetchHlsSegmentWithRetry(rec, allUrls[idx], signal);
          p.catch(() => {});
          pending.set(idx, p);
        };

        schedule(0);
        const firstSeg = await pending.get(0)!;
        pending.delete(0);
        if (signal.aborted) return;

        const sniffed = sniffInitialBytes(firstSeg);
        if (sniffed === 'html' || sniffed === 'json_error') {
          throw new Error('HLS media segment returned an HTML/JSON error instead of video data.');
        }

        await openPartFile();
        for (let w = 1; w <= maxAhead && w < totalSegments; w++) schedule(w);

        await writeBufferToDiskRespectingControls(writeStream!, firstSeg, rec, signal);
        let completedSegments = 1;
        updateHlsChunkMap(rec, completedSegments, totalSegments);

        for (let idx = 1; idx < totalSegments; idx++) {
          if (signal.aborted) return;
          for (let ahead = idx; ahead < Math.min(totalSegments, idx + maxAhead); ahead++) {
            schedule(ahead);
          }
          const segBuf = await pending.get(idx)!;
          pending.delete(idx);
          await writeBufferToDiskRespectingControls(writeStream!, segBuf, rec, signal);
          completedSegments++;
          updateHlsChunkMap(rec, completedSegments, totalSegments);
        }

        if (completedSegments < totalSegments || rec.downloadedBytes <= 0) {
          throw new Error(`HLS stream ended early (${completedSegments}/${totalSegments} segments).`);
        }

        await finalizeFileStream(writeStream!);
        writeStream = null;
        await fsp.rename(partPath, finalPath);
        rec.totalBytes = rec.downloadedBytes;
        rec.savedOnDisk = true;
        rec.status = 'completed';
        rec.speedBytesPerSec = 0;
        rec.completedAt = Date.now();
        rec.updatedAt = Date.now();
        updateHlsChunkMap(rec, totalSegments, totalSegments);
        return;
      }

      // MODE 1: Parallel Resumable Multi-Chunk HTTP Range Download straight to disk
      if (rec.acceptRanges && rec.totalBytes > 0) {
        const chunkBytes = Math.min(2, Math.max(1, rec.chunkSizeMb)) * 1024 * 1024;
        const totalChunks = Math.ceil(rec.totalBytes / chunkBytes);
        const maxWindow = Math.min(2, Math.max(1, rec.parallelStreams));

        const inFlightMap = new Map<
          number,
          { start: number; end: number; received: number; workerIndex: number }
        >();
        const chunkPromises = new Map<number, Promise<Buffer>>();

        const scheduleChunk = (idx: number) => {
          if (idx >= totalChunks || chunkPromises.has(idx)) return;
          const start = idx * chunkBytes;
          const end = Math.min(rec.totalBytes - 1, start + chunkBytes - 1);
          const workerIndex = idx % maxWindow;
          const p = fetchExactByteRange(rec, start, end, workerIndex, signal, inFlightMap, idx);
          p.catch(() => {});
          chunkPromises.set(idx, p);
        };

        scheduleChunk(0);
        const firstChunk = await chunkPromises.get(0)!;
        chunkPromises.delete(0);
        if (signal.aborted) return;

        if (firstChunk.byteLength === 0) {
          throw new Error('Remote host returned an empty byte stream.');
        }

        const sniffed = sniffInitialBytes(firstChunk);
        if (rec.expectedBinary && (sniffed === 'html' || sniffed === 'json_error')) {
          throw new Error(
            'Remote link returned an HTML/JSON error page instead of binary media data. The link may have expired.'
          );
        }

        await openPartFile();
        for (let w = 1; w <= maxWindow && w < totalChunks; w++) scheduleChunk(w);

        await writeBufferToDiskRespectingControls(writeStream!, firstChunk, rec, signal);

        for (let nextIdx = 1; nextIdx < totalChunks; nextIdx++) {
          if (signal.aborted) return;
          for (
            let lookahead = nextIdx;
            lookahead < Math.min(totalChunks, nextIdx + maxWindow);
            lookahead++
          ) {
            scheduleChunk(lookahead);
          }
          const buf = await chunkPromises.get(nextIdx)!;
          chunkPromises.delete(nextIdx);
          await writeBufferToDiskRespectingControls(writeStream!, buf, rec, signal);
        }

        if (rec.downloadedBytes < rec.totalBytes || rec.downloadedBytes <= 0) {
          throw new Error(
            `Transfer ended early (${rec.downloadedBytes} / ${rec.totalBytes} bytes received).`
          );
        }

        await finalizeFileStream(writeStream!);
        writeStream = null;
        await fsp.rename(partPath, finalPath);
        rec.savedOnDisk = true;
        rec.status = 'completed';
        rec.speedBytesPerSec = 0;
        rec.completedAt = Date.now();
        rec.updatedAt = Date.now();
        updateChunkMapFromProgress(rec);
        return;
      }

      // MODE 2: Resilient Single-Stream Disk Download with Range Drop-Recovery
      let fileOpened = false;
      let bytesWritten = 0;
      const maxStreamRetries = 6;

      for (let attempt = 1; attempt <= maxStreamRetries; attempt++) {
        if (signal.aborted) return;
        const reqHeaders: Record<string, string> = {};
        if (bytesWritten > 0) {
          reqHeaders.Range = `bytes=${bytesWritten}-`;
        }

        const targetUrl = attempt % 2 === 1 ? rec.resolvedUrl : rec.url;
        const { response, finalUrl, cookies, redirectHops } = await safeFetchWithRedirects(targetUrl, {
          method: 'GET',
          headers: reqHeaders,
          timeoutMs: 25000,
          followHtmlRedirects: !fileOpened,
          cookies: rec.cookies,
          referer: rec.referer,
          signal,
        });

        rec.resolvedUrl = finalUrl;
        rec.cookies = cookies;
        rec.redirectHops = Math.max(rec.redirectHops, redirectHops);
        rec.httpStatus = response.status;

        if (!response.ok && response.status !== 206) {
          try {
            await response.body?.cancel();
          } catch {
            // ignore
          }
          throw new Error(describeHttpError(response.status));
        }

        if (bytesWritten > 0 && response.status !== 206) {
          try {
            await response.body?.cancel();
          } catch {
            // ignore
          }
          throw new Error('Remote server dropped the connection and does not support resume.');
        }

        if (!response.body) {
          throw new Error('Upstream returned an empty response body.');
        }

        const reader = response.body.getReader();
        try {
          if (!fileOpened) {
            let firstChunk: Uint8Array | null = null;
            while (true) {
              if (signal.aborted) {
                await reader.cancel().catch(() => {});
                return;
              }
              const { done, value } = await reader.read();
              if (done) break;
              if (value && value.byteLength > 0) {
                firstChunk = value;
                break;
              }
            }
            if (!firstChunk || firstChunk.byteLength === 0) {
              await reader.cancel().catch(() => {});
              throw new Error('Remote server returned an empty (0 byte) file.');
            }
            const sniffed = sniffInitialBytes(firstChunk);
            const ct = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
            const cl = Number(response.headers.get('content-length') || 0);
            if (
              rec.expectedBinary &&
              (sniffed === 'html' ||
                sniffed === 'json_error' ||
                (ct.includes('text/html') && (cl === 0 || cl < 500 * 1024)))
            ) {
              await reader.cancel().catch(() => {});
              throw new Error(
                'Remote link returned an HTML/JSON page instead of a downloadable media stream. The signed link may have expired.'
              );
            }
            if (ct) rec.contentType = ct;
            if (cl > 0 && rec.totalBytes <= 0) rec.totalBytes = cl;
            const cdName = parseContentDispositionFilename(response.headers.get('content-disposition'));
            if (cdName) rec.filename = cdName;

            await openPartFile();
            fileOpened = true;

            await writeBufferToDiskRespectingControls(writeStream!, firstChunk, rec, signal);
            bytesWritten += firstChunk.byteLength;
          }

          while (true) {
            if (signal.aborted) {
              await reader.cancel().catch(() => {});
              return;
            }
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.byteLength > 0) {
              await writeBufferToDiskRespectingControls(writeStream!, value, rec, signal);
              bytesWritten += value.byteLength;
            }
          }
        } catch (err) {
          if (signal.aborted) return;
          const msg = err instanceof Error ? err.message : 'Stream read error';
          if (
            !fileOpened &&
            (msg.includes('HTML') ||
              msg.includes('empty') ||
              msg.includes('HTTP 401') ||
              msg.includes('HTTP 403') ||
              msg.includes('HTTP 404') ||
              msg.includes('HTTP 410'))
          ) {
            throw err;
          }
          if (attempt >= maxStreamRetries) throw err;
          rec.retryCount += 1;
          await sleep(Math.min(4000, 500 * attempt), signal);
          continue;
        }

        if (rec.totalBytes > 0 && bytesWritten < rec.totalBytes) {
          if (attempt >= maxStreamRetries) {
            throw new Error(`Remote host closed early at ${bytesWritten} / ${rec.totalBytes} bytes.`);
          }
          rec.retryCount += 1;
          await sleep(Math.min(4000, 500 * attempt), signal);
          continue;
        }
        break;
      }

      if (!fileOpened || bytesWritten <= 0) {
        throw new Error('Download never received valid media bytes.');
      }
      if (rec.totalBytes > 0 && bytesWritten < rec.totalBytes) {
        throw new Error(`Stream ended prematurely at ${bytesWritten} / ${rec.totalBytes} bytes.`);
      }

      await finalizeFileStream(writeStream!);
      writeStream = null;
      await fsp.rename(partPath, finalPath);
      if (rec.totalBytes <= 0) {
        rec.totalBytes = rec.downloadedBytes;
      }
      rec.savedOnDisk = true;
      rec.status = 'completed';
      rec.speedBytesPerSec = 0;
      rec.completedAt = Date.now();
      rec.updatedAt = Date.now();
      updateChunkMapFromProgress(rec);
    } catch (err) {
      if (writeStream) {
        try {
          writeStream.destroy();
        } catch {
          // ignore
        }
      }
      void fsp.unlink(partPath).catch(() => {});

      if (signal.aborted) {
        if (rec.status !== 'completed') {
          rec.status = 'cancelled';
          rec.speedBytesPerSec = 0;
          rec.updatedAt = Date.now();
        }
        return;
      }

      rec.status = 'error';
      rec.errorMessage = err instanceof Error ? err.message : 'Download failed.';
      rec.speedBytesPerSec = 0;
      rec.updatedAt = Date.now();
    } finally {
      if (rec.abortController === controller) {
        rec.abortController = null;
      }
    }
  })();
}

/**
 * Serves an in-app downloaded file (BOTH while actively downloading from .part AND when completed)
 * with full HTTP Range (206 Partial Content) support for continuous playback in MochiDrop or VLC.
 */
export async function serveCompletedTransferFile(
  rec: TransferRecord,
  req: express.Request,
  res: express.Response
): Promise<void> {
  if (!rec.filePath) {
    res.status(404).json({ error: 'Transfer file path is not initialized.' });
    return;
  }

  const isAttachment = req.query.download === '1' || req.query.download === 'true';
  const partPath = `${rec.filePath}.part`;

  let targetPath: string | null = null;
  let stat: fs.Stats | null = null;

  if (rec.savedOnDisk) {
    try {
      stat = await fsp.stat(rec.filePath);
      targetPath = rec.filePath;
    } catch {
      stat = null;
    }
  }

  // If the file is still downloading in parallel chunks or hasn't written enough sequential data yet,
  // stream live via the upstream Range proxy so seeking (e.g. MP4 moov atom at EOF) works instantaneously!
  if (!rec.savedOnDisk && !isAttachment) {
    if (rec.parallelStreams > 1 || !rec.filePath) {
      await proxyPlayRemoteStream(
        rec.resolvedUrl || rec.url,
        req,
        res,
        rec.cookies,
        rec.referer,
        rec.filename
      );
      return;
    }

    for (let wait = 0; wait < 10; wait++) {
      if (rec.savedOnDisk) {
        try {
          stat = await fsp.stat(rec.filePath);
          targetPath = rec.filePath;
          break;
        } catch {
          // fallback
        }
      }
      try {
        const pStat = await fsp.stat(partPath);
        if (pStat.size > 0) {
          stat = pStat;
          targetPath = partPath;
          break;
        }
      } catch {
        // wait briefly for first bytes to flush to disk
      }
      if (rec.status === 'error' || rec.status === 'cancelled') break;
      await new Promise((r) => setTimeout(r, 150));
    }

    if (!targetPath || !stat || stat.size === 0) {
      await proxyPlayRemoteStream(
        rec.resolvedUrl || rec.url,
        req,
        res,
        rec.cookies,
        rec.referer,
        rec.filename
      );
      return;
    }
  }

  if (!targetPath || !stat || stat.size === 0) {
    if (isAttachment && !rec.savedOnDisk) {
      res.status(409).json({ error: 'File is still downloading inside MochiDrop.' });
      return;
    }
    res.status(404).json({ error: 'Media file is buffering or no longer available in app storage.' });
    return;
  }

  const availableSize = stat.size;
  const safeAscii = rec.filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '');
  const encodedUtf8 = encodeURIComponent(rec.filename);

  const servedMime = isAttachment
    ? rec.contentType || 'application/octet-stream'
    : inferPlayableMimeType(rec.filename, rec.contentType);

  res.setHeader('Content-Type', servedMime);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', rec.savedOnDisk ? 'private, max-age=3600' : 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  if (isAttachment) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeAscii || 'download.bin'}"; filename*=UTF-8''${encodedUtf8}`
    );
  } else {
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${safeAscii || 'download.bin'}"; filename*=UTF-8''${encodedUtf8}`
    );
  }

  const rangeHeader = req.headers.range;
  if (rangeHeader && /^bytes=\d*-\d*$/i.test(rangeHeader)) {
    const [rawStart, rawEnd] = rangeHeader.replace(/^bytes=/i, '').split('-');
    const start = rawStart ? Number(rawStart) : 0;
    const requestedEnd = rawEnd ? Number(rawEnd) : availableSize - 1;

    // If still downloading and player seeks near/past local bytes on disk, proxy live from upstream!
    if (!rec.savedOnDisk && (start >= availableSize || requestedEnd >= availableSize) && rec.acceptRanges) {
      await proxyPlayRemoteStream(
        rec.resolvedUrl || rec.url,
        req,
        res,
        rec.cookies,
        rec.referer,
        rec.filename
      );
      return;
    }

    const end = Math.min(availableSize - 1, requestedEnd);
    if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || start > end || start >= availableSize) {
      res.status(416).setHeader('Content-Range', `bytes */${availableSize}`).end();
      return;
    }

    const reportedTotal = rec.savedOnDisk ? availableSize : Math.max(availableSize, rec.totalBytes || availableSize);
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${reportedTotal}`);
    res.setHeader('Content-Length', String(end - start + 1));
    const readStream = fs.createReadStream(targetPath, { start, end });
    req.on('close', () => readStream.destroy());
    readStream.on('error', () => {
      if (!res.writableEnded) res.destroy();
    });
    readStream.pipe(res);
    return;
  }

  res.status(200);
  res.setHeader('Content-Length', String(availableSize));
  const readStream = fs.createReadStream(targetPath);
  req.on('close', () => readStream.destroy());
  readStream.on('error', () => {
    if (!res.writableEnded) res.destroy();
  });
  readStream.pipe(res);
}

/**
 * SSRF-safe live Range stream proxy for instant online playback in MochiDrop's player or VLC/external players.
 */
export async function proxyPlayRemoteStream(
  rawUrl: string,
  req: express.Request,
  res: express.Response,
  cookies?: Record<string, string>,
  referer?: string | null,
  filenameHint?: string
): Promise<void> {
  const parsedMeta = parseAndNormalizeUrl(rawUrl);
  if (parsedMeta.parsed.protocol !== 'http:' && parsedMeta.parsed.protocol !== 'https:') {
    res.status(400).json({ error: 'Only HTTP/HTTPS streams can be played online.' });
    return;
  }
  if (isBlockedHostname(parsedMeta.parsed.hostname)) {
    res.status(403).json({ error: 'Local or private addresses are blocked.' });
    return;
  }

  const controller = new AbortController();
  const onDisconnect = () => controller.abort();
  req.on('close', onDisconnect);
  req.on('error', onDisconnect);
  res.on('error', onDisconnect);

  try {
    const reqHeaders: Record<string, string> = {};
    if (typeof req.headers.range === 'string' && /^bytes=\d*-\d*$/i.test(req.headers.range)) {
      reqHeaders.Range = req.headers.range;
    }

    const { response } = await safeFetchWithRedirects(parsedMeta.normalizedUrl, {
      method: 'GET',
      headers: reqHeaders,
      timeoutMs: 25000,
      followHtmlRedirects: true,
      cookies,
      referer: referer || null,
      signal: controller.signal,
    });

    if (!response.ok && response.status !== 206) {
      try {
        await response.body?.cancel();
      } catch {
        // ignore
      }
      if (!res.headersSent) {
        res.status(response.status).json({ error: describeHttpError(response.status) });
      }
      return;
    }

    if (!response.body) {
      if (!res.headersSent) {
        res.status(502).json({ error: 'Remote stream returned an empty body.' });
      }
      return;
    }

    const cdName = parseContentDispositionFilename(response.headers.get('content-disposition'));
    const effectiveName = filenameHint || cdName || parsedMeta.extractedFilename;
    const ct = inferPlayableMimeType(effectiveName, response.headers.get('content-type'));
    const cl = response.headers.get('content-length');
    const cr = response.headers.get('content-range');
    const ar = response.headers.get('accept-ranges') || 'bytes';

    res.status(response.status);
    res.setHeader('Content-Type', ct);
    res.setHeader('Accept-Ranges', ar);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    if (cl) res.setHeader('Content-Length', cl);
    if (cr) res.setHeader('Content-Range', cr);
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    const reader = response.body.getReader();
    while (true) {
      if (controller.signal.aborted || res.destroyed || res.writableEnded) {
        await reader.cancel().catch(() => {});
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        const ok = res.write(value);
        if (!ok) {
          await waitForDrain(res, controller.signal);
        }
      }
    }

    if (!res.writableEnded) {
      res.end();
    }
  } catch (err) {
    if (controller.signal.aborted) return;
    if (!res.headersSent) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Online playback stream error.',
      });
    } else if (!res.writableEnded) {
      res.destroy();
    }
  } finally {
    req.off('close', onDisconnect);
    req.off('error', onDisconnect);
    res.off('error', onDisconnect);
  }
}
