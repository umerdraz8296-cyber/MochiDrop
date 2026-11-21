import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import {
  ArrowDownToLine,
  Menu,
  Moon,
  Network,
  Puzzle,
  Settings,
  Sun,
  X,
} from 'lucide-react';
import {
  INITIAL_ADAPTERS,
  INITIAL_DOWNLOADS,
  INITIAL_PLUGINS,
  INITIAL_SETTINGS,
} from './data/initialState';
import {
  DownloadItem,
  DownloadKind,
  DownloadStatus,
  NetworkAdapter,
  PlexoPlugin,
  PlexoSettings,
  TorrentFileItem,
  TransferProtocol,
  WorkspaceTab,
} from './types/plexo';
import { formatSpeedMBps } from './utils/format';
import { DownloadsView } from './components/DownloadsView';
import { NetworksView } from './components/NetworksView';
import { ExtensionView } from './components/ExtensionView';
import { SettingsView } from './components/SettingsView';

const BRAND_NAME = 'MochiDrop';

const NAV_ITEMS: Array<{
  id: WorkspaceTab;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'downloads', label: 'Downloads', icon: ArrowDownToLine },
  { id: 'networks', label: 'Networks', icon: Network },
  { id: 'extension', label: 'Browser Extension', icon: Puzzle },
  { id: 'settings', label: 'Settings & Plugins', icon: Settings },
];

interface ServerTransferDto {
  id: string;
  url: string;
  filename: string;
  contentType: string;
  streamType?: 'hls' | 'dash' | 'progressive' | 'unknown';
  status: DownloadStatus;
  totalBytes: number;
  downloadedBytes: number;
  speedBytesPerSec: number;
  acceptRanges: boolean;
  chunkSizeMb: number;
  parallelStreams: number;
  retryCount: number;
  redirectHops?: number;
  streamInitialized?: boolean;
  savedOnDisk?: boolean;
  quality?: string | null;
  language?: string | null;
  errorMessage: string | null;
  httpStatus: number | null;
  createdAt?: number;
  chunks: Array<{ index: number; progress: number; workerIndex: number }>;
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

function isGenericQuality(q?: string | null): boolean {
  if (!q) return true;
  const low = q.trim().toLowerCase();
  return !low || low === 'source quality' || low === 'original' || low === 'auto';
}

function isGenericLanguage(l?: string | null): boolean {
  if (!l) return true;
  const low = l.trim().toLowerCase();
  return !low || low === 'source audio' || low === 'original audio' || low === 'default';
}

function decodeMetadataCandidate(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    for (const key of ['file', 'url', 'src', 'link', 'target']) {
      const val = u.searchParams.get(key);
      if (val && /^[A-Za-z0-9+/=_-]{16,1024}$/.test(val)) {
        try {
          const decoded = atob(val.replace(/-/g, '+').replace(/_/g, '/'));
          if (/^https?:\/\//i.test(decoded)) {
            return decodeURIComponent(decoded);
          }
        } catch {
          // ignore invalid base64
        }
      }
    }
    return decodeURIComponent(rawUrl);
  } catch {
    return rawUrl;
  }
}

function extractQualityFromUrlMetadata(url: string, filename: string): string | null {
  const hay = `${filename} ${decodeMetadataCandidate(url)}`;
  if (/(?:^|[\W_])(2160p|4k|uhd)(?:$|[\W_])/i.test(hay)) return '2160p (4K)';
  if (/(?:^|[\W_])(1440p|2k|qhd)(?:$|[\W_])/i.test(hay)) return '1440p';
  if (/(?:^|[\W_])(1080p|fhd)(?:$|[\W_])/i.test(hay)) return '1080p';
  if (/(?:^|[\W_])(720p)(?:$|[\W_])/i.test(hay)) return '720p';
  if (/(?:^|[\W_])(480p)(?:$|[\W_])/i.test(hay)) return '480p';
  if (/(?:^|[\W_])(360p)(?:$|[\W_])/i.test(hay)) return '360p';
  if (/(?:^|[\W_])(240p)(?:$|[\W_])/i.test(hay)) return '240p';
  return null;
}

function extractLanguageFromUrlMetadata(url: string, filename: string): string | null {
  const hay = `${filename} ${decodeMetadataCandidate(url)}`.toLowerCase();
  const hasDual = /dual[\s._-]*audio/i.test(hay);
  const found: string[] = [];
  if (/\bhindi\b/.test(hay)) found.push('Hindi');
  if (/\benglish\b|\beng\b/.test(hay)) found.push('English');
  if (/\burdu\b/.test(hay)) found.push('Urdu');
  if (/\btamil\b/.test(hay)) found.push('Tamil');
  if (/\btelugu\b/.test(hay)) found.push('Telugu');
  if (/\bjapanese\b|\bjpn\b/.test(hay)) found.push('Japanese');
  if (/\bkorean\b|\bkor\b/.test(hay)) found.push('Korean');
  if (/\bspanish\b|\besp\b/.test(hay)) found.push('Spanish');
  if (/\bfrench\b|\bfre\b/.test(hay)) found.push('French');
  if (hasDual) {
    if (found.length >= 2) return `Dual Audio (${found.slice(0, 2).join(' + ')})`;
    if (found.length === 1) return `Dual Audio (${found[0]} + English)`;
    return 'Dual Audio';
  }
  if (found.length > 0) return found.join(' + ');
  return null;
}

function inferKindFromServerTransfer(tr: ServerTransferDto): DownloadKind {
  const lowerName = (tr.filename || '').toLowerCase();
  const lowerCt = (tr.contentType || '').toLowerCase();
  if (tr.streamType === 'hls' || tr.streamType === 'dash' || lowerCt.startsWith('video/') || /\.(mp4|mkv|webm|mov|avi|ts|m4v)$/i.test(lowerName)) {
    return 'video';
  }
  if (lowerCt.startsWith('audio/') || /\.(mp3|flac|wav|aac|m4a|ogg|opus)$/i.test(lowerName)) {
    return 'audio';
  }
  if (/\.(zip|rar|7z|tar|gz|bz2|xz)$/i.test(lowerName)) return 'archive';
  if (/\.(exe|msi|dmg|pkg|apk|deb|rpm|appimage|iso)$/i.test(lowerName)) return 'software';
  if (lowerCt.includes('pdf') || /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|txt|epub)$/i.test(lowerName)) {
    return 'document';
  }
  if (lowerCt.startsWith('image/') || /\.(png|jpg|jpeg|webp|gif|svg|avif)$/i.test(lowerName)) {
    return 'image';
  }
  return 'file';
}

/**
 * Strictly validates requested quality & language against inspected URL metadata
 * and maps multi-variant streams to their exact variant URL before initializing any transfer.
 */
function validateAndMapStreamMetadata(payload: {
  url: string;
  title: string;
  kind: DownloadKind;
  quality?: string;
  language?: string;
  availableQualities?: string[];
  availableLanguages?: string[];
  variantUrls?: Record<string, string>;
}):
  | { ok: true; targetUrl: string; verifiedQuality?: string; verifiedLanguage?: string }
  | { ok: false; error: string } {
  let targetUrl = payload.url;
  let verifiedQuality = payload.quality;
  let verifiedLanguage = payload.language;

  if (payload.kind !== 'video' && payload.kind !== 'audio') {
    return { ok: true, targetUrl, verifiedQuality, verifiedLanguage };
  }

  const realQualities = (payload.availableQualities || []).filter(Boolean);
  const realLanguages = (payload.availableLanguages || []).filter(Boolean);
  const urlQualityHint = extractQualityFromUrlMetadata(payload.url, payload.title);
  const urlLanguageHint = extractLanguageFromUrlMetadata(payload.url, payload.title);

  // 1. Validate quality against real variant list or single-file URL metadata
  if (payload.variantUrls && Object.keys(payload.variantUrls).length > 0) {
    const requested = payload.quality || realQualities[0];
    if (requested && !isGenericQuality(requested)) {
      const exactKey = Object.keys(payload.variantUrls).find(
        (k) =>
          k.toLowerCase() === requested.toLowerCase() ||
          normalizeQualityToken(k) === normalizeQualityToken(requested)
      );
      if (!exactKey) {
        return {
          ok: false,
          error: `Requested quality "${requested}" does not exist in stream metadata. Available: ${Object.keys(payload.variantUrls).join(', ')}`,
        };
      }
      targetUrl = payload.variantUrls[exactKey];
      verifiedQuality = exactKey;
    } else {
      const firstKey = Object.keys(payload.variantUrls)[0];
      targetUrl = payload.variantUrls[firstKey];
      verifiedQuality = firstKey;
    }
  } else if (realQualities.length > 0 && !isGenericQuality(payload.quality)) {
    const matched = realQualities.find(
      (q) =>
        q.toLowerCase() === payload.quality!.toLowerCase() ||
        normalizeQualityToken(q) === normalizeQualityToken(payload.quality!)
    );
    if (!matched) {
      return {
        ok: false,
        error: `Requested quality "${payload.quality}" is not available for this URL. Source quality: ${realQualities.join(', ')}`,
      };
    }
    verifiedQuality = matched;
  } else if (urlQualityHint && !isGenericQuality(payload.quality)) {
    if (normalizeQualityToken(payload.quality!) !== normalizeQualityToken(urlQualityHint)) {
      return {
        ok: false,
        error: `Quality mismatch: this URL only contains ${urlQualityHint}, not ${payload.quality}.`,
      };
    }
    verifiedQuality = urlQualityHint;
  } else if (urlQualityHint && isGenericQuality(payload.quality)) {
    verifiedQuality = urlQualityHint;
  }

  // 2. Validate language against real available audio tracks or URL metadata
  if (payload.kind === 'video') {
    if (realLanguages.length > 0 && !isGenericLanguage(payload.language)) {
      const reqLow = payload.language!.trim().toLowerCase();
      const matchedLang = realLanguages.find(
        (l) => l.toLowerCase() === reqLow || l.toLowerCase().includes(reqLow) || reqLow.includes(l.toLowerCase())
      );
      if (!matchedLang) {
        return {
          ok: false,
          error: `Requested language "${payload.language}" is not available in URL metadata. Available: ${realLanguages.join(', ')}`,
        };
      }
      verifiedLanguage = matchedLang;
    } else if (urlLanguageHint && !isGenericLanguage(payload.language)) {
      const reqLow = payload.language!.trim().toLowerCase();
      const hintLow = urlLanguageHint.toLowerCase();
      if (!hintLow.includes(reqLow) && !reqLow.includes(hintLow)) {
        return {
          ok: false,
          error: `Language mismatch: this URL only contains ${urlLanguageHint}, not ${payload.language}.`,
        };
      }
      verifiedLanguage = urlLanguageHint;
    } else if (urlLanguageHint && isGenericLanguage(payload.language)) {
      verifiedLanguage = urlLanguageHint;
    }
  }

  return { ok: true, targetUrl, verifiedQuality, verifiedLanguage };
}

export default function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try {
      const saved = localStorage.getItem('plexo_theme');
      if (saved === 'light' || saved === 'dark') return saved;
    } catch {
      // ignore storage errors
    }
    return 'dark';
  });

  const [activeTab, setActiveTab] = useState<WorkspaceTab>('downloads');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const [downloads, setDownloads] = useState<DownloadItem[]>(INITIAL_DOWNLOADS);
  const [adapters, setAdapters] = useState<NetworkAdapter[]>(INITIAL_ADAPTERS);
  const [plugins, setPlugins] = useState<PlexoPlugin[]>(INITIAL_PLUGINS);
  const [settings, setSettings] = useState<PlexoSettings>(INITIAL_SETTINGS);
  const [urlInput, setUrlInput] = useState('');

  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const lastHandoffSyncRef = useRef<number>(Date.now());
  const seenHandoffIdsRef = useRef<Set<string>>(new Set());
  const prevTotalBytesRef = useRef<Record<string, number>>({});
  const prevTransferStatusRef = useRef<Record<string, DownloadStatus>>({});
  const adaptersRef = useRef<NetworkAdapter[]>(INITIAL_ADAPTERS);
  const enabledAdapterIdsRef = useRef<string[]>(
    INITIAL_ADAPTERS.filter((a) => a.enabled).map((a) => a.id)
  );

  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
    }, 3500);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    try {
      localStorage.setItem('plexo_theme', theme);
    } catch {
      // ignore
    }
  }, [theme]);

  const handleToggleAdapter = useCallback((id: string) => {
    setAdapters((prev) =>
      prev.map((a) => (a.id === id ? { ...a, enabled: !a.enabled } : a))
    );
  }, []);

  const enabledAdapters = useMemo(() => adapters.filter((a) => a.enabled), [adapters]);

  useEffect(() => {
    adaptersRef.current = adapters;
    const ids = adapters.filter((a) => a.enabled).map((a) => a.id);
    enabledAdapterIdsRef.current = ids.length ? ids : ['adapter-wifi'];
  }, [adapters]);

  const startRealHttpTransfer = useCallback(
    async (payload: {
      existingItemId?: string;
      title: string;
      url: string;
      domain: string;
      kind: DownloadKind;
      protocol?: TransferProtocol;
      totalBytes: number;
      quality?: string;
      language?: string;
      availableLanguages?: string[];
      availableQualities?: string[];
      variantUrls?: Record<string, string>;
      source: 'direct' | 'extension' | 'magnet' | 'batch';
      torrentFiles?: TorrentFileItem[];
      resumable?: boolean;
    }) => {
      const isHttp = payload.url.startsWith('http://') || payload.url.startsWith('https://');
      const rangeEnabled = plugins.find((p) => p.id === 'plugin-range')?.enabled ?? true;
      const parallelStreams = rangeEnabled
        ? Math.min(6, Math.max(1, settings.maxConnectionsPerAdapter))
        : 1;
      const currentAdapters = adaptersRef.current;
      const enabledIds = enabledAdapterIdsRef.current;

      // Strict pre-flight quality & language validation mapped directly to URL metadata
      const validation = validateAndMapStreamMetadata({
        url: payload.url,
        title: payload.title,
        kind: payload.kind,
        quality: payload.quality,
        language: payload.language,
        availableQualities: payload.availableQualities,
        availableLanguages: payload.availableLanguages,
        variantUrls: payload.variantUrls,
      });

      if (!validation.ok) {
        notify(validation.error);
        return;
      }

      const resolvedTargetUrl = validation.targetUrl;
      const verifiedQuality = validation.verifiedQuality;
      const verifiedLanguage = validation.verifiedLanguage;

      // Non-HTTP links (magnet, ftp, sftp) cannot be streamed by HTTP engine directly
      if (!isHttp) {
        const externalItem: DownloadItem = {
          id: payload.existingItemId || `dl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          title: payload.title,
          url: resolvedTargetUrl,
          domain: payload.domain,
          kind: payload.kind,
          protocol: payload.protocol,
          status: 'queued',
          totalBytes: payload.totalBytes || 0,
          downloadedBytes: 0,
          speedBytesPerSec: 0,
          quality: verifiedQuality,
          language: verifiedLanguage,
          availableLanguages: payload.availableLanguages,
          availableQualities: payload.availableQualities,
          variantUrls: payload.variantUrls,
          source: payload.source,
          createdAt: Date.now(),
          chunkSizeMb: settings.chunkSizeMb,
          parallelStreams: 1,
          chunks: Array.from({ length: 24 }, (_, idx) => ({
            index: idx,
            progress: 0,
            adapterId: enabledIds[0],
          })),
          adapterSplit: Object.fromEntries(currentAdapters.map((a) => [a.id, 0])),
          torrentFiles: payload.torrentFiles,
          resumable: false,
          retryCount: 0,
          directOnly: true,
          errorMessage: `${payload.protocol || 'This link'} requires a native torrent/FTP client on your device.`,
        };

        setDownloads((prev) => [externalItem, ...prev]);
        notify(`Queued ${payload.title} (open in native client)`);
        return;
      }

      try {
        const res = await fetch('/api/transfers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: resolvedTargetUrl,
            filename: payload.title,
            kind: payload.kind,
            quality: verifiedQuality,
            language: verifiedLanguage,
            chunkSizeMb: settings.chunkSizeMb,
            parallelStreams,
            speedCapMbps: settings.globalSpeedCapMbps,
            autoStart: true,
          }),
        });

        const data = await res.json();
        if (!res.ok || !data?.transfer) {
          throw new Error(data?.error || 'Could not start download.');
        }

        const serverTr = data.transfer as ServerTransferDto;
        const canStream = data.canStream !== false && serverTr.status !== 'error';
        const itemId = payload.existingItemId || serverTr.id;

        const mappedChunks = serverTr.chunks.map((c) => ({
          index: c.index,
          progress: c.progress,
          adapterId: enabledIds[c.workerIndex % enabledIds.length] || enabledIds[0],
        }));

        const item: DownloadItem = {
          id: itemId,
          serverTransferId: serverTr.id,
          title: serverTr.filename || payload.title,
          url: resolvedTargetUrl,
          domain: payload.domain,
          kind: payload.kind,
          protocol: serverTr.streamType === 'hls' ? 'HLS/DASH' : payload.protocol,
          status: canStream ? serverTr.status : 'error',
          totalBytes: serverTr.totalBytes || payload.totalBytes || 0,
          downloadedBytes: serverTr.downloadedBytes || 0,
          speedBytesPerSec: serverTr.speedBytesPerSec || 0,
          quality: serverTr.quality || verifiedQuality,
          language: serverTr.language || verifiedLanguage,
          availableLanguages: payload.availableLanguages,
          availableQualities: payload.availableQualities,
          variantUrls: payload.variantUrls,
          source: payload.source,
          createdAt: Date.now(),
          chunkSizeMb: serverTr.chunkSizeMb,
          parallelStreams: serverTr.parallelStreams,
          chunks: mappedChunks,
          adapterSplit: Object.fromEntries(currentAdapters.map((a) => [a.id, 0])),
          torrentFiles: payload.torrentFiles,
          resumable: serverTr.acceptRanges,
          retryCount: 0,
          redirectHops: serverTr.redirectHops || 0,
          streamType: serverTr.streamType,
          streamInitialized: serverTr.streamInitialized ?? false,
          savedOnDisk: serverTr.savedOnDisk ?? false,
          errorMessage: serverTr.errorMessage || null,
          httpStatus: serverTr.httpStatus,
        };

        prevTotalBytesRef.current[serverTr.id] = serverTr.downloadedBytes || 0;
        prevTransferStatusRef.current[serverTr.id] = item.status;

        setDownloads((prev) => {
          if (payload.existingItemId) {
            return prev.map((d) => (d.id === payload.existingItemId ? item : d));
          }
          return [item, ...prev];
        });

        if (!canStream) {
          notify(serverTr.errorMessage || 'Download could not be initialized');
          return;
        }

        // Download runs entirely inside MochiDrop's in-app engine (no Chrome download bar)
        notify(`Downloading ${item.title} inside MochiDrop`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Could not start download.';
        notify(msg);
      }
    },
    [notify, plugins, settings]
  );

  // Restore any active or completed in-app transfers already stored on the server
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const res = await fetch('/api/transfers');
        if (!res.ok || !active) return;
        const data = await res.json();
        if (!Array.isArray(data.transfers) || !active) return;
        const serverList = data.transfers as ServerTransferDto[];
        if (serverList.length === 0) return;

        const currentAdapters = adaptersRef.current;
        const enabledIds = enabledAdapterIdsRef.current;

        const hydrated: DownloadItem[] = serverList.map((tr) => {
          let domain = 'direct.link';
          try {
            domain = new URL(tr.url).hostname;
          } catch {
            // fallback
          }
          prevTotalBytesRef.current[tr.id] = tr.downloadedBytes;
          prevTransferStatusRef.current[tr.id] = tr.status;
          const kind = inferKindFromServerTransfer(tr);
          return {
            id: tr.id,
            serverTransferId: tr.id,
            title: tr.filename,
            url: tr.url,
            domain,
            kind,
            protocol: tr.streamType === 'hls' ? 'HLS/DASH' : tr.url.startsWith('https://') ? 'HTTPS' : 'HTTP',
            status: tr.status,
            totalBytes: tr.totalBytes,
            downloadedBytes: tr.downloadedBytes,
            speedBytesPerSec: tr.status === 'downloading' ? tr.speedBytesPerSec : 0,
            quality: tr.quality || undefined,
            language: tr.language || undefined,
            source: 'direct',
            createdAt: tr.createdAt || Date.now(),
            chunkSizeMb: tr.chunkSizeMb,
            parallelStreams: tr.parallelStreams,
            chunks: tr.chunks.map((c) => ({
              index: c.index,
              progress: c.progress,
              adapterId: enabledIds[c.workerIndex % enabledIds.length] || enabledIds[0],
            })),
            adapterSplit: Object.fromEntries(currentAdapters.map((a) => [a.id, 0])),
            resumable: tr.acceptRanges,
            retryCount: tr.retryCount,
            redirectHops: tr.redirectHops || 0,
            streamType: tr.streamType,
            streamInitialized: tr.streamInitialized ?? false,
            savedOnDisk: tr.savedOnDisk ?? false,
            errorMessage: tr.errorMessage,
            httpStatus: tr.httpStatus,
          };
        });

        setDownloads((prev) => {
          const existingServerIds = new Set(prev.map((d) => d.serverTransferId).filter(Boolean));
          const merged = [...prev];
          for (const h of hydrated) {
            if (!existingServerIds.has(h.serverTransferId)) {
              merged.push(h);
            }
          }
          return merged;
        });
      } catch {
        // ignore startup sync error
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // Poll /api/extension/handoff for real browser extension clicks
  useEffect(() => {
    const interval = window.setInterval(async () => {
      try {
        const res = await fetch(`/api/extension/handoff?since=${lastHandoffSyncRef.current}`);
        if (!res.ok) return;
        const data = await res.json();
        if (typeof data.serverTime === 'number') {
          lastHandoffSyncRef.current = data.serverTime;
        }
        if (Array.isArray(data.items)) {
          for (const item of data.items) {
            if (seenHandoffIdsRef.current.has(item.id)) continue;
            seenHandoffIdsRef.current.add(item.id);
            let domain = 'browser.extension';
            try {
              domain = new URL(item.url).hostname;
            } catch {
              // fallback
            }
            const cleanTitle =
              item.title
                .replace(/[^\w\-. ]+/g, '')
                .slice(0, 80)
                .trim()
                .replace(/\s+/g, '_') || 'download';
            const hasExt = /\.[a-z0-9]{2,5}$/i.test(cleanTitle);

            const realQuality = item.quality || 'Source Quality';
            const realLang = item.language || 'Source Audio';
            void startRealHttpTransfer({
              title: hasExt ? cleanTitle : `${cleanTitle}.mp4`,
              url: item.url,
              domain,
              kind: 'video',
              protocol: item.url.startsWith('https://') ? 'HTTPS' : 'HTTP',
              totalBytes: 0,
              quality: realQuality,
              language: realLang,
              availableLanguages: [realLang],
              availableQualities: [realQuality],
              source: 'extension',
            });
          }
        }
      } catch {
        // retry next tick
      }
    }, 3000);

    return () => window.clearInterval(interval);
  }, [startRealHttpTransfer]);

  // Real Live Transfer Sync: pulls actual bytes/sec, real downloaded bytes, retries & errors from server
  const hasTrackableTransfer = useMemo(
    () =>
      downloads.some(
        (d) =>
          Boolean(d.serverTransferId) &&
          (d.status === 'connecting' || d.status === 'downloading' || d.status === 'paused')
      ),
    [downloads]
  );

  useEffect(() => {
    if (!hasTrackableTransfer) {
      // Zero out live adapter speeds honestly when nothing is actively transferring
      setAdapters((prev) => {
        const anyNonZero = prev.some((a) => a.currentSpeedMbps > 0);
        if (!anyNonZero) return prev;
        return prev.map((a) => ({ ...a, currentSpeedMbps: 0 }));
      });
      return;
    }

    let cancelled = false;
    let timerId: number | null = null;

    const scheduleNext = () => {
      if (!cancelled) {
        timerId = window.setTimeout(() => {
          void poll();
        }, 800);
      }
    };

    const poll = async () => {
      try {
        const res = await fetch('/api/transfers');
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!Array.isArray(data.transfers) || cancelled) return;

        const serverList = data.transfers as ServerTransferDto[];
        const mapById = new Map<string, ServerTransferDto>();
        const deltasById = new Map<string, number>();
        let totalRealBytesPerSec = 0;
        let totalRealDeltaBytes = 0;
        const notifications: string[] = [];

        for (const tr of serverList) {
          mapById.set(tr.id, tr);

          const prevBytes = prevTotalBytesRef.current[tr.id] ?? 0;
          const deltaBytes = Math.max(0, tr.downloadedBytes - prevBytes);
          prevTotalBytesRef.current[tr.id] = tr.downloadedBytes;
          deltasById.set(tr.id, deltaBytes);
          totalRealDeltaBytes += deltaBytes;

          if (tr.status === 'downloading') {
            totalRealBytesPerSec += tr.speedBytesPerSec;
          }

          const isTrulyCompleted =
            tr.status === 'completed' &&
            tr.streamInitialized !== false &&
            tr.downloadedBytes > 0;
          const nextEffectiveStatus: DownloadStatus =
            tr.status === 'completed' && !isTrulyCompleted ? 'error' : tr.status;
          const prevStatus = prevTransferStatusRef.current[tr.id];

          if (prevStatus && prevStatus !== nextEffectiveStatus) {
            if (isTrulyCompleted) {
              notifications.push(`Completed: ${tr.filename || 'file'} ready inside MochiDrop`);
            } else if (nextEffectiveStatus === 'error' && tr.errorMessage) {
              notifications.push(`Download failed: ${tr.errorMessage}`);
            }
          }
          prevTransferStatusRef.current[tr.id] = nextEffectiveStatus;
        }

        const activeIds = enabledAdapterIdsRef.current;

        setDownloads((prev) =>
          prev.map((item) => {
            if (!item.serverTransferId) return item;
            const live = mapById.get(item.serverTransferId);
            if (!live) return item;

            const deltaBytes = deltasById.get(live.id) ?? 0;
            const isTrulyCompleted =
              live.status === 'completed' &&
              live.streamInitialized !== false &&
              live.downloadedBytes > 0;

            const nextSplit =
              deltaBytes > 0 ? { ...item.adapterSplit } : item.adapterSplit;
            if (deltaBytes > 0) {
              const perId = deltaBytes / activeIds.length;
              for (const id of activeIds) {
                nextSplit[id] = (nextSplit[id] || 0) + perId;
              }
            }

            const mappedChunks = live.chunks.map((c) => ({
              index: c.index,
              progress: c.progress,
              adapterId: activeIds[c.workerIndex % activeIds.length] || activeIds[0],
            }));

            return {
              ...item,
              title: live.filename || item.title,
              status: live.status === 'completed' && !isTrulyCompleted ? 'error' : live.status,
              totalBytes: live.totalBytes || item.totalBytes,
              downloadedBytes: live.downloadedBytes,
              speedBytesPerSec: live.status === 'downloading' ? live.speedBytesPerSec : 0,
              quality: live.quality || item.quality,
              language: live.language || item.language,
              resumable: live.acceptRanges,
              parallelStreams: live.parallelStreams,
              retryCount: live.retryCount,
              redirectHops: live.redirectHops ?? item.redirectHops,
              streamType: live.streamType ?? item.streamType,
              streamInitialized: live.streamInitialized ?? item.streamInitialized,
              savedOnDisk: live.savedOnDisk ?? item.savedOnDisk,
              errorMessage:
                live.status === 'completed' && !isTrulyCompleted
                  ? 'Byte stream closed with 0 bytes received.'
                  : live.errorMessage,
              httpStatus: live.httpStatus,
              chunks: mappedChunks,
              adapterSplit: nextSplit,
            };
          })
        );

        for (const msg of notifications) {
          notify(msg);
        }

        // Reflect REAL measured internet throughput across active network links
        const totalRealMbps = (totalRealBytesPerSec * 8) / (1024 * 1024);
        const deltaGb = totalRealDeltaBytes / (1024 * 1024 * 1024);

        setAdapters((prev) => {
          const active = prev.filter((a) => a.enabled);
          const count = Math.max(1, active.length);
          const perAdapterMbps = active.length > 0 ? totalRealMbps / count : 0;
          const perAdapterGb = active.length > 0 ? deltaGb / count : 0;

          const allIdleAndUnchanged =
            perAdapterMbps === 0 &&
            perAdapterGb === 0 &&
            prev.every((a) => a.currentSpeedMbps === 0);
          if (allIdleAndUnchanged) return prev;

          return prev.map((a) => {
            if (!a.enabled) {
              return {
                ...a,
                currentSpeedMbps: 0,
                historyMbps: [...a.historyMbps.slice(1), 0],
              };
            }
            return {
              ...a,
              currentSpeedMbps: perAdapterMbps,
              usedDataGb: a.usedDataGb + perAdapterGb,
              historyMbps: [...a.historyMbps.slice(1), Number(perAdapterMbps.toFixed(1))],
            };
          });
        });
      } catch {
        // retry next tick
      } finally {
        scheduleNext();
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timerId !== null) {
        window.clearTimeout(timerId);
      }
    };
  }, [hasTrackableTransfer, notify]);

  const handleTogglePause = useCallback(
    async (id: string) => {
      const target = downloads.find((d) => d.id === id);
      if (!target || !target.serverTransferId) return;

      const shouldPause = target.status === 'downloading' || target.status === 'connecting';
      const action = shouldPause ? 'pause' : 'resume';

      try {
        const res = await fetch(
          `/api/transfers/${encodeURIComponent(target.serverTransferId)}/${action}`,
          { method: 'POST' }
        );
        if (res.ok) {
          setDownloads((prev) =>
            prev.map((d) =>
              d.id === id
                ? {
                    ...d,
                    status: shouldPause ? 'paused' : 'downloading',
                    speedBytesPerSec: shouldPause ? 0 : d.speedBytesPerSec,
                  }
                : d
            )
          );
          notify(shouldPause ? `Paused ${target.title}` : `Resumed ${target.title}`);
        }
      } catch {
        notify('Could not update transfer state');
      }
    },
    [downloads, notify]
  );

  const handleRetryOrRedownload = useCallback(
    (item: DownloadItem) => {
      void startRealHttpTransfer({
        existingItemId: item.id,
        title: item.title,
        url: item.url,
        domain: item.domain,
        kind: item.kind,
        protocol: item.protocol,
        totalBytes: item.totalBytes,
        quality: item.quality,
        language: item.language,
        availableLanguages: item.availableLanguages,
        availableQualities: item.availableQualities,
        variantUrls: item.variantUrls,
        source: item.source,
        torrentFiles: item.torrentFiles,
        resumable: item.resumable,
      });
    },
    [startRealHttpTransfer]
  );

  const handleRemove = useCallback(
    async (id: string) => {
      const target = downloads.find((d) => d.id === id);
      if (target?.serverTransferId) {
        try {
          await fetch(`/api/transfers/${encodeURIComponent(target.serverTransferId)}`, {
            method: 'DELETE',
          });
        } catch {
          // ignore cleanup error
        }
      }
      setDownloads((prev) => prev.filter((d) => d.id !== id));
      notify('Removed transfer');
    },
    [downloads, notify]
  );

  const handlePauseAll = useCallback(async () => {
    const active = downloads.filter(
      (d) =>
        d.serverTransferId &&
        (d.status === 'downloading' || d.status === 'connecting')
    );
    await Promise.all(
      active.map((d) =>
        fetch(`/api/transfers/${encodeURIComponent(d.serverTransferId!)}/pause`, {
          method: 'POST',
        }).catch(() => {})
      )
    );
    setDownloads((prev) =>
      prev.map((d) =>
        d.status === 'downloading' || d.status === 'connecting'
          ? { ...d, status: 'paused', speedBytesPerSec: 0 }
          : d
      )
    );
    notify('Paused active downloads');
  }, [downloads, notify]);

  const handleResumeAll = useCallback(async () => {
    const paused = downloads.filter((d) => d.serverTransferId && d.status === 'paused');
    await Promise.all(
      paused.map((d) =>
        fetch(`/api/transfers/${encodeURIComponent(d.serverTransferId!)}/resume`, {
          method: 'POST',
        }).catch(() => {})
      )
    );
    setDownloads((prev) =>
      prev.map((d) => (d.status === 'paused' ? { ...d, status: 'downloading' } : d))
    );
    notify('Resumed paused downloads');
  }, [downloads, notify]);

  const liveAggregateBytesPerSec = useMemo(
    () =>
      downloads.reduce(
        (sum, d) => sum + (d.status === 'downloading' ? d.speedBytesPerSec : 0),
        0
      ),
    [downloads]
  );

  const activeDownloadCount = useMemo(
    () =>
      downloads.filter((d) => d.status === 'downloading' || d.status === 'connecting').length,
    [downloads]
  );

  const activeNavTitle =
    NAV_ITEMS.find((item) => item.id === activeTab)?.label || 'Downloads';

  return (
    <MotionConfig reducedMotion="user">
      <div className="min-h-screen flex bg-[#F8F8F8] text-[#0A0A0A] dark:bg-[#050505] dark:text-[#F5F5F5] transition-colors duration-200">
        <AnimatePresence>
          {mobileNavOpen && (
            <motion.div
              key="mobile-nav-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              onClick={() => setMobileNavOpen(false)}
              className="fixed inset-0 z-40 bg-black/75 backdrop-blur-xs lg:hidden"
            />
          )}
        </AnimatePresence>

        {/* Left Sidebar Navigation */}
        <aside
          className={`fixed lg:sticky top-0 left-0 z-50 h-screen w-64 shrink-0 border-r border-neutral-200/90 dark:border-neutral-800/85 bg-white dark:bg-[#090909] flex flex-col justify-between transition-transform duration-200 ease-out lg:translate-x-0 ${
            mobileNavOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          <div className="flex flex-col">
            <div className="h-16 px-5 border-b border-neutral-200/80 dark:border-neutral-800/80 flex items-center justify-between">
              <button
                type="button"
                onClick={() => {
                  setActiveTab('downloads');
                  setMobileNavOpen(false);
                }}
                className="flex items-center gap-3 text-left cursor-pointer whitespace-nowrap shrink-0 group"
              >
                <span className="h-7 w-7 rounded-xs bg-black text-white dark:bg-white dark:text-black font-display font-bold text-sm flex items-center justify-center transition-transform duration-150 group-hover:scale-105">
                  M
                </span>
                <span className="font-display text-lg font-bold tracking-tight text-black dark:text-white">
                  {BRAND_NAME}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setMobileNavOpen(false)}
                aria-label="Close menu"
                className="lg:hidden p-1.5 text-neutral-500 hover:text-black dark:hover:text-white transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <nav className="p-3 space-y-1">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const isActive = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setActiveTab(item.id);
                      setMobileNavOpen(false);
                    }}
                    className={`relative w-full flex items-center justify-between gap-2 px-3.5 py-2.5 rounded-xs text-sm font-medium transition-colors duration-150 whitespace-nowrap cursor-pointer ${
                      isActive
                        ? 'text-white dark:text-black'
                        : 'text-neutral-600 dark:text-neutral-400 hover:text-black dark:hover:text-white hover:bg-neutral-100/80 dark:hover:bg-neutral-900/70'
                    }`}
                  >
                    {isActive && (
                      <motion.span
                        layoutId="mochidrop-nav-indicator"
                        transition={{ type: 'spring', stiffness: 440, damping: 36 }}
                        className="absolute inset-0 rounded-xs bg-black dark:bg-white"
                      />
                    )}
                    <span className="relative z-10 inline-flex items-center gap-2.5">
                      <Icon className="h-4 w-4 shrink-0" />
                      <span>{item.label}</span>
                    </span>

                    {item.id === 'downloads' && activeDownloadCount > 0 && (
                      <span
                        className={`relative z-10 font-mono text-xs tabular-nums ${
                          isActive ? 'text-white/80 dark:text-black/75' : 'text-neutral-400'
                        }`}
                      >
                        {activeDownloadCount}
                      </span>
                    )}
                  </button>
                );
              })}
            </nav>
          </div>

          <div className="p-5 border-t border-neutral-200/80 dark:border-neutral-800/80">
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[11px] text-neutral-500 dark:text-neutral-400">
                <span>Live throughput</span>
                <span className="font-mono tabular-nums">
                  {activeDownloadCount} active
                </span>
              </div>
              <div className="font-mono text-lg font-semibold tracking-tight tabular-nums text-black dark:text-white">
                {formatSpeedMBps(liveAggregateBytesPerSec)}
              </div>
            </div>
          </div>
        </aside>

        {/* Main Content Area */}
        <div className="flex-1 min-w-0 flex flex-col">
          {/* Solid Opaque Top Bar (Single Theme Toggle Only) */}
          <header className="sticky top-0 z-30 h-16 px-4 sm:px-8 border-b border-neutral-200/85 dark:border-neutral-800/85 bg-white/95 dark:bg-[#050505]/95 backdrop-blur-xs flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <button
                type="button"
                onClick={() => setMobileNavOpen(true)}
                aria-label="Open menu"
                className="lg:hidden h-9 w-9 rounded-xs border border-neutral-200 dark:border-neutral-800 inline-flex items-center justify-center text-neutral-700 dark:text-neutral-200"
              >
                <Menu className="h-4 w-4" />
              </button>

              <div className="flex items-center gap-2 text-sm truncate">
                <span className="text-neutral-400 dark:text-neutral-500 whitespace-nowrap">
                  {BRAND_NAME}
                </span>
                <span className="text-neutral-300 dark:text-neutral-700" aria-hidden="true">
                  /
                </span>
                <h1 className="font-display font-semibold tracking-tight text-black dark:text-white truncate">
                  {activeNavTitle}
                </h1>
              </div>
            </div>

            <motion.button
              whileTap={{ scale: 0.96 }}
              type="button"
              onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              className="h-9 px-3 rounded-xs border border-neutral-200 dark:border-neutral-800 text-xs font-medium text-neutral-800 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-900 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
            >
              {theme === 'dark' ? (
                <>
                  <Sun className="h-3.5 w-3.5" />
                  <span>Light</span>
                </>
              ) : (
                <>
                  <Moon className="h-3.5 w-3.5" />
                  <span>Dark</span>
                </>
              )}
            </motion.button>
          </header>

          <main className="flex-1 p-4 sm:p-8 max-w-[1440px] w-full mx-auto">
            <AnimatePresence mode="wait">
              <motion.div
                key={activeTab}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              >
                {activeTab === 'downloads' && (
                  <DownloadsView
                    downloads={downloads}
                    adapters={adapters}
                    settings={settings}
                    urlInput={urlInput}
                    onUrlInputChange={setUrlInput}
                    onAddDownload={(payload) => void startRealHttpTransfer(payload)}
                    onTogglePause={(id) => void handleTogglePause(id)}
                    onRetryTransfer={handleRetryOrRedownload}
                    onRemove={(id) => void handleRemove(id)}
                    onMoveItem={(id, dir) => {
                      setDownloads((prev) => {
                        const idx = prev.findIndex((d) => d.id === id);
                        if (idx === -1) return prev;
                        const target = dir === 'up' ? idx - 1 : idx + 1;
                        if (target < 0 || target >= prev.length) return prev;
                        const copy = [...prev];
                        const [moved] = copy.splice(idx, 1);
                        copy.splice(target, 0, moved);
                        return copy;
                      });
                    }}
                    onPauseAll={() => void handlePauseAll()}
                    onResumeAll={() => void handleResumeAll()}
                    onUpdateTrack={(id, quality, language) => {
                      setDownloads((prev) =>
                        prev.map((d) =>
                          d.id === id
                            ? {
                                ...d,
                                url: d.variantUrls?.[quality] || d.url,
                                quality,
                                language,
                              }
                            : d
                        )
                      );
                      notify(`Selected track: ${quality} · ${language}`);
                    }}
                    onToggleAdapter={handleToggleAdapter}
                    onNotify={notify}
                    onOpenExtensionView={() => setActiveTab('extension')}
                    onOpenNetworksView={() => setActiveTab('networks')}
                  />
                )}

                {activeTab === 'networks' && (
                  <NetworksView
                    adapters={adapters}
                    settings={settings}
                    onToggleAdapter={handleToggleAdapter}
                    onUpdateAdapter={(id, patch) => {
                      setAdapters((prev) =>
                        prev.map((a) => (a.id === id ? { ...a, ...patch } : a))
                      );
                    }}
                    onAddAdapter={(name, interfaceType, maxCapacityMbps) => {
                      const idx = adapters.length;
                      const newAdapter: NetworkAdapter = {
                        id: `adapter-${Date.now()}`,
                        deviceCode: interfaceType === 'Cellular USB' ? `usb${idx}` : `en${idx}`,
                        name,
                        interfaceType,
                        enabled: true,
                        maxCapacityMbps,
                        currentSpeedMbps: 0,
                        speedCapMbps: null,
                        dataBudgetGb: null,
                        budgetPeriod: 'monthly',
                        usedDataGb: 0,
                        metered: interfaceType === 'Cellular USB',
                        shade: 'stripe',
                        historyMbps: Array(16).fill(0),
                      };
                      setAdapters((prev) => [...prev, newAdapter]);
                      notify(`Added ${name}`);
                    }}
                    onUpdateSettings={(patch) => setSettings((prev) => ({ ...prev, ...patch }))}
                  />
                )}

                {activeTab === 'extension' && (
                  <ExtensionView
                    settings={settings}
                    onUpdateSettings={(patch) => setSettings((prev) => ({ ...prev, ...patch }))}
                    onNotify={notify}
                  />
                )}

                {activeTab === 'settings' && (
                  <SettingsView
                    plugins={plugins}
                    settings={settings}
                    onTogglePlugin={(id) => {
                      setPlugins((prev) =>
                        prev.map((p) => (p.id === id ? { ...p, enabled: !p.enabled } : p))
                      );
                    }}
                    onUpdateSettings={(patch) => setSettings((prev) => ({ ...prev, ...patch }))}
                    onNotify={notify}
                  />
                )}
              </motion.div>
            </AnimatePresence>
          </main>
        </div>

        <AnimatePresence>
          {toast && (
            <motion.div
              key="mochidrop-toast"
              role="status"
              aria-live="polite"
              initial={{ opacity: 0, y: 12, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              className="fixed bottom-5 right-5 z-50 max-w-sm rounded-xs border border-neutral-700/80 dark:border-neutral-300/80 bg-[#0A0A0A] text-white dark:bg-white dark:text-black px-4 py-2.5 text-xs font-medium shadow-lg"
            >
              {toast}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </MotionConfig>
  );
}
