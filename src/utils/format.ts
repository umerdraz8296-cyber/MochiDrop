export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let val = bytes;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val >= 100 ? val.toFixed(0) : val >= 10 ? val.toFixed(1) : val.toFixed(2)} ${units[i]}`;
}

export function formatSpeedMBps(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0.0 MB/s';
  const mbps = bytesPerSec / (1024 * 1024);
  if (mbps < 0.1) {
    return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
  }
  return `${mbps.toFixed(1)} MB/s`;
}

export function formatEta(remainingBytes: number, bytesPerSec: number): string {
  if (remainingBytes <= 0) return 'Done';
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '-';
  const sec = Math.ceil(remainingBytes / bytesPerSec);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return `${min}m ${remSec}s`;
  const hrs = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hrs}h ${remMin}m`;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem.toString().padStart(2, '0')}`;
}

const SIGNED_QUERY_KEYS = [
  'token',
  'sig',
  'signature',
  'expiry',
  'expires',
  'expire',
  'x-amz-signature',
  'x-amz-credential',
  'googleaccessid',
  'policy',
  'key-pair-id',
  'hdnts',
  'auth',
  'session',
  'hash',
  'hmac',
  'file',
];

export function isSignedDirectUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.search.length > 120) return true;
    for (const key of parsed.searchParams.keys()) {
      if (SIGNED_QUERY_KEYS.includes(key.toLowerCase())) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function buildDirectVideoLink(
  baseUrl: string,
  quality?: string,
  language?: string
): string {
  try {
    if (isSignedDirectUrl(baseUrl)) {
      return baseUrl;
    }
    const parsed = new URL(baseUrl);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      if (quality) parsed.searchParams.set('mochidrop_quality', quality);
      if (language) parsed.searchParams.set('mochidrop_lang', language);
      return parsed.href;
    }
    return baseUrl;
  } catch {
    return baseUrl;
  }
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'ftp:', 'ftps:', 'sftp:']);
const PROTOCOL_RELATIVE_RE = /^\/\/[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?(?:\/.*)?$/i;
const EMBEDDED_URL_RE = /\b(?:https?|ftps?|sftp):\/\/[^\s"'<>`\\]+|\bmagnet:\?[^\s"'<>`\\]+/i;

export function normalizeUrlInput(raw: string): string {
  let cleaned = raw.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'")) ||
    (cleaned.startsWith('<') && cleaned.endsWith('>'))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  cleaned = cleaned
    .replace(/&amp;/gi, '&')
    .replace(/\\\//g, '/');

  if (PROTOCOL_RELATIVE_RE.test(cleaned)) {
    cleaned = `https:${cleaned}`;
  }

  if (!/^(?:https?|ftps?|sftp|magnet):/i.test(cleaned)) {
    const match = cleaned.match(EMBEDDED_URL_RE);
    if (match && match[0]) {
      cleaned = match[0].replace(/[),.;]+$/, '');
    }
  }
  return cleaned;
}

export function isSafeTransferUrl(raw: string): boolean {
  const normalized = normalizeUrlInput(raw);
  if (!normalized) return false;
  if (normalized.startsWith('magnet:?')) return true;
  try {
    const u = new URL(normalized);
    return ALLOWED_PROTOCOLS.has(u.protocol);
  } catch {
    return false;
  }
}

export function extractUrlsFromText(rawText: string): string[] {
  return rawText
    .split(/[\r\n]+/)
    .map((line) => normalizeUrlInput(line))
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

export function createInitialChunks(
  count: number,
  adapterIds: string[],
  progressRatio: number
): Array<{ index: number; progress: number; adapterId: string; raced?: boolean }> {
  const safeAdapters = adapterIds.length ? adapterIds : ['adapter-wifi'];
  const completedCount = Math.floor(count * progressRatio);
  return Array.from({ length: count }, (_, idx) => {
    const adapterId = safeAdapters[idx % safeAdapters.length];
    if (idx < completedCount) {
      return { index: idx, progress: 100, adapterId };
    }
    if (idx < completedCount + safeAdapters.length && progressRatio > 0 && progressRatio < 1) {
      return {
        index: idx,
        progress: Math.min(92, Math.max(18, Math.round(((idx * 37) % 65) + 22))),
        adapterId,
        raced: idx === completedCount + safeAdapters.length - 1,
      };
    }
    return { index: idx, progress: 0, adapterId };
  });
}
