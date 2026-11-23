import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import {
  ArrowUpCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Download,
  FileArchive,
  FileText,
  Film,
  FolderOpen,
  HardDrive,
  Magnet,
  Menu,
  Moon,
  Music,
  Network,
  Package,
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
  AddDownloadPayload,
  CategoryFilter,
  ConcurrentLimit,
  DownloadItem,
  DownloadKind,
  DownloadStatus,
  NetworkAdapter,
  PlexoPlugin,
  PlexoSettings,
  StreamCountOption,
  UpdateCheckInfo,
  UpdateDownloadStatus,
  WorkspaceTab,
} from './types/plexo';
import { formatSpeedMBps } from './utils/format';
import { DownloadsView } from './components/DownloadsView';
import { NetworksView } from './components/NetworksView';
import { SettingsView } from './components/SettingsView';
import { UpdateModal } from './components/UpdateModal';

const BRAND_NAME = 'MochiDrop';

const CATEGORY_TREE_CHILDREN: Array<{
  id: CategoryFilter;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  iconColor: string;
}> = [
  { id: 'compressed', label: 'Compressed', icon: FileArchive, iconColor: 'text-teal-600 dark:text-teal-400' },
  { id: 'documents', label: 'Documents', icon: FileText, iconColor: 'text-emerald-600 dark:text-[#3BE098]' },
  { id: 'music', label: 'Music', icon: Music, iconColor: 'text-lime-600 dark:text-lime-400' },
  { id: 'video', label: 'Video', icon: Film, iconColor: 'text-[#187A54] dark:text-[#2FD48B]' },
  { id: 'programs', label: 'Programs', icon: Package, iconColor: 'text-amber-600 dark:text-amber-400' },
  { id: 'torrent', label: 'Torrents', icon: Magnet, iconColor: 'text-cyan-600 dark:text-cyan-400' },
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
  chunks: Array<{ index: number; progress: number; workerIndex: number; adapterId?: string }>;
}

interface ServerNetworkDto {
  id: string;
  deviceCode: string;
  name: string;
  ipAddress: string;
  ssid?: string;
  interfaceType: NetworkAdapter['interfaceType'];
  connected: boolean;
  enabled: boolean;
  maxCapacityMbps: number;
  linkSpeedKnown: boolean;
  currentSpeedBytesPerSec: number;
  currentSpeedMbps: number;
  usedDataGb: number;
  metered: boolean;
  shade: NetworkAdapter['shade'];
  historyMbps: number[];
}

function mergeServerNetworks(
  prev: NetworkAdapter[],
  incoming: ServerNetworkDto[]
): NetworkAdapter[] {
  const prevById = new Map(prev.map((a) => [a.id, a]));
  return incoming.map((net) => {
    const existing = prevById.get(net.id);
    const keepCustomName = Boolean(existing?.customNamed && existing.name.trim() && net.connected);
    return {
      id: net.id,
      deviceCode: net.deviceCode,
      name: keepCustomName ? existing!.name : net.name,
      ipAddress: net.ipAddress,
      ssid: net.ssid,
      customNamed: keepCustomName,
      interfaceType: net.interfaceType,
      connected: net.connected,
      enabled: net.connected && net.enabled,
      maxCapacityMbps: net.maxCapacityMbps,
      linkSpeedKnown: net.linkSpeedKnown,
      currentSpeedBytesPerSec: net.connected ? net.currentSpeedBytesPerSec : 0,
      currentSpeedMbps: net.connected ? net.currentSpeedMbps : 0,
      speedCapMbps: existing?.speedCapMbps ?? null,
      dataBudgetGb: existing?.dataBudgetGb ?? null,
      budgetPeriod: existing?.budgetPeriod ?? 'monthly',
      usedDataGb: net.usedDataGb,
      metered: net.metered,
      shade: net.shade,
      historyMbps: net.historyMbps?.length ? net.historyMbps : Array(16).fill(0),
    };
  });
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

  // YouTube watch URLs resolve requested resolution server-side from Innertube/yt-dlp formats
  if (/^https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)\//i.test(payload.url)) {
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
      const saved = localStorage.getItem('mochidrop_theme_v2');
      if (saved === 'light' || saved === 'dark') return saved;
    } catch {
      // ignore storage errors
    }
    return 'dark';
  });

  const [activeTab, setActiveTab] = useState<WorkspaceTab>('downloads');
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all');
  const [treeExpanded, setTreeExpanded] = useState(true);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const [downloads, setDownloads] = useState<DownloadItem[]>(INITIAL_DOWNLOADS);
  const [adapters, setAdapters] = useState<NetworkAdapter[]>(INITIAL_ADAPTERS);
  const [plugins, setPlugins] = useState<PlexoPlugin[]>(INITIAL_PLUGINS);
  const [settings, setSettings] = useState<PlexoSettings>(() => {
    let concurrent = INITIAL_SETTINGS.maxConcurrentDownloads;
    let preferredStreams = INITIAL_SETTINGS.preferredStreams;
    try {
      const savedConc = Number(localStorage.getItem('mochidrop_concurrent'));
      if (savedConc === 1 || savedConc === 2 || savedConc === 3 || savedConc === 4 || savedConc === 5) {
        concurrent = savedConc;
      }
      const savedStreams = Number(localStorage.getItem('mochidrop_streams'));
      if (savedStreams === 4 || savedStreams === 8 || savedStreams === 16 || savedStreams === 32) {
        preferredStreams = savedStreams;
      }
    } catch {
      // ignore storage errors
    }
    return {
      ...INITIAL_SETTINGS,
      maxConcurrentDownloads: concurrent,
      preferredStreams,
    };
  });
  const [urlInput, setUrlInput] = useState('');

  const [toast, setToast] = useState<string | null>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckInfo | null>(null);
  const [updateDownload, setUpdateDownload] = useState<UpdateDownloadStatus>({
    state: 'idle',
    version: null,
    filename: null,
    downloadedBytes: 0,
    totalBytes: 0,
    percent: 0,
    error: null,
  });
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const [dismissedUpdateTag, setDismissedUpdateTag] = useState<string>(() => {
    try {
      return localStorage.getItem('mochidrop_dismissed_update_tag') || '';
    } catch {
      return '';
    }
  });
  const toastTimerRef = useRef<number | null>(null);
  const lastHandoffSyncRef = useRef<number>(Date.now());
  const seenHandoffIdsRef = useRef<Set<string>>(new Set());
  const prevTotalBytesRef = useRef<Record<string, number>>({});
  const prevTransferStatusRef = useRef<Record<string, DownloadStatus>>({});
  const startingQueueIdsRef = useRef<Set<string>>(new Set());
  const adaptersRef = useRef<NetworkAdapter[]>(INITIAL_ADAPTERS);
  const enabledAdapterIdsRef = useRef<string[]>(
    INITIAL_ADAPTERS.filter((a) => a.connected && a.enabled).map((a) => a.id)
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
      localStorage.setItem('mochidrop_theme_v2', theme);
    } catch {
      // ignore
    }
  }, [theme]);

  const handleCheckUpdates = useCallback(
    async (manual = false) => {
      setCheckingUpdate(true);
      try {
        const res = await fetch(`/api/updates/check${manual ? '?force=1' : ''}`);
        if (!res.ok) {
          if (manual) notify('Could not check GitHub for updates right now');
          return;
        }
        const data = (await res.json()) as {
          update?: UpdateCheckInfo;
          download?: UpdateDownloadStatus;
        };
        if (data.update) {
          setUpdateInfo(data.update);
          if (manual) {
            if (data.update.updateAvailable) {
              setUpdateModalOpen(true);
            } else if (data.update.error) {
              notify(data.update.error);
            } else {
              notify(`MochiDrop v${data.update.currentVersion} is up to date`);
            }
          }
        }
        if (data.download) {
          setUpdateDownload(data.download);
        }
      } catch {
        if (manual) notify('Could not reach GitHub Releases');
      } finally {
        setCheckingUpdate(false);
      }
    },
    [notify]
  );

  const handleStartUpdateDownload = useCallback(
    async (assetName?: string) => {
      try {
        const res = await fetch('/api/updates/download', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assetName }),
        });
        const data = await res.json();
        if (!res.ok) {
          notify(data?.error || 'Could not start update download');
          return;
        }
        if (data.download) {
          setUpdateDownload(data.download as UpdateDownloadStatus);
        }
      } catch {
        notify('Could not start update download');
      }
    },
    [notify]
  );

  const handleInstallUpdateNow = useCallback(async () => {
    try {
      const res = await fetch('/api/updates/install', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        notify(data?.error || 'Could not launch update installer');
        return;
      }
      setUpdateDownload((prev) => ({ ...prev, state: 'installing' }));
      notify(data?.message || 'Launching MochiDrop update installer...');
    } catch {
      notify('Could not launch update installer');
    }
  }, [notify]);

  const handleDismissUpdateBanner = useCallback(() => {
    if (!updateInfo?.releaseTag) return;
    setDismissedUpdateTag(updateInfo.releaseTag);
    try {
      localStorage.setItem('mochidrop_dismissed_update_tag', updateInfo.releaseTag);
    } catch {
      // ignore
    }
    setUpdateModalOpen(false);
  }, [updateInfo?.releaseTag]);

  // Automatic GitHub Releases update check on startup + every 6 hours
  useEffect(() => {
    const startupTimer = window.setTimeout(() => {
      void handleCheckUpdates(false);
    }, 2200);
    const periodicTimer = window.setInterval(() => {
      void handleCheckUpdates(false);
    }, 6 * 60 * 60 * 1000);
    return () => {
      window.clearTimeout(startupTimer);
      window.clearInterval(periodicTimer);
    };
  }, [handleCheckUpdates]);

  // Poll update download progress while downloading installer
  useEffect(() => {
    if (updateDownload.state !== 'downloading') return;
    let active = true;
    const interval = window.setInterval(async () => {
      try {
        const res = await fetch('/api/updates/status');
        if (!res.ok || !active) return;
        const data = (await res.json()) as { download?: UpdateDownloadStatus };
        if (data.download && active) {
          setUpdateDownload(data.download);
          if (data.download.state === 'ready') {
            notify('Update downloaded — click Install & Restart to finish');
          }
        }
      } catch {
        // retry next tick
      }
    }, 500);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [updateDownload.state, notify]);

  const handleToggleAdapter = useCallback(async (id: string) => {
    setAdapters((prev) =>
      prev.map((a) =>
        a.id === id && a.connected
          ? {
              ...a,
              enabled: !a.enabled,
              currentSpeedBytesPerSec: !a.enabled ? a.currentSpeedBytesPerSec : 0,
              currentSpeedMbps: !a.enabled ? a.currentSpeedMbps : 0,
            }
          : a
      )
    );
    try {
      const res = await fetch(`/api/networks/${encodeURIComponent(id)}/toggle`, {
        method: 'POST',
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.networks)) {
          setAdapters((prev) => mergeServerNetworks(prev, data.networks as ServerNetworkDto[]));
        }
      }
    } catch {
      // keep optimistic state until next sync
    }
  }, []);

  const readBrowserNetworkHint = useCallback(() => {
    const nav = navigator as Navigator & {
      connection?: {
        type?: string;
        downlink?: number;
        addEventListener?: (event: string, cb: () => void) => void;
        removeEventListener?: (event: string, cb: () => void) => void;
      };
    };
    const conn = nav.connection;
    const rawType = (conn?.type || '').toLowerCase();
    let clientType: 'wifi' | 'ethernet' | 'usb' = 'wifi';
    if (rawType === 'ethernet') {
      clientType = 'ethernet';
    } else if (rawType === 'cellular') {
      clientType = 'usb';
    }
    const online = typeof navigator.onLine === 'boolean' ? navigator.onLine : true;
    const downlink =
      typeof conn?.downlink === 'number' && Number.isFinite(conn.downlink) && conn.downlink > 0
        ? Math.round(conn.downlink)
        : 0;
    return { clientType, online, downlink };
  }, []);

  const handleRescanNetworks = useCallback(async () => {
    try {
      const hint = readBrowserNetworkHint();
      const res = await fetch('/api/networks/rescan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(hint),
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.networks)) {
          const list = data.networks as ServerNetworkDto[];
          const connectedList = list.filter((n) => n.connected);
          setAdapters((prev) => mergeServerNetworks(prev, list));
          notify(
            connectedList.length === 0
              ? 'No active network detected'
              : `Connected: ${connectedList.map((n) => n.name).join(', ')}`
          );
        }
      }
    } catch {
      notify('Could not rescan network interfaces');
    }
  }, [notify, readBrowserNetworkHint]);

  // Live OS Network Interface Sync: automatically reflects connected Wi-Fi / Ethernet / USB interfaces
  useEffect(() => {
    let active = true;
    const syncNetworks = async () => {
      try {
        const hint = readBrowserNetworkHint();
        const qs = new URLSearchParams({
          clientType: hint.clientType,
          online: hint.online ? '1' : '0',
          downlink: String(hint.downlink),
        });
        const res = await fetch(`/api/networks?${qs.toString()}`);
        if (!res.ok || !active) return;
        const data = await res.json();
        if (Array.isArray(data.networks) && active) {
          setAdapters((prev) => mergeServerNetworks(prev, data.networks as ServerNetworkDto[]));
        }
      } catch {
        // retry on next tick
      }
    };
    void syncNetworks();
    const timer = window.setInterval(() => {
      void syncNetworks();
    }, 2500);

    const handleConnectionChange = () => {
      void syncNetworks();
    };
    window.addEventListener('online', handleConnectionChange);
    window.addEventListener('offline', handleConnectionChange);
    const navConn = (
      navigator as Navigator & {
        connection?: {
          addEventListener?: (event: string, cb: () => void) => void;
          removeEventListener?: (event: string, cb: () => void) => void;
        };
      }
    ).connection;
    navConn?.addEventListener?.('change', handleConnectionChange);

    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('online', handleConnectionChange);
      window.removeEventListener('offline', handleConnectionChange);
      navConn?.removeEventListener?.('change', handleConnectionChange);
    };
  }, [readBrowserNetworkHint]);

  const enabledAdapters = useMemo(
    () => adapters.filter((a) => a.connected && a.enabled),
    [adapters]
  );

  useEffect(() => {
    adaptersRef.current = adapters;
    const ids = adapters.filter((a) => a.connected && a.enabled).map((a) => a.id);
    const connectedIds = adapters.filter((a) => a.connected).map((a) => a.id);
    enabledAdapterIdsRef.current = ids.length
      ? ids
      : connectedIds.length
      ? [connectedIds[0]]
      : ['slot-wifi'];
  }, [adapters]);

  const startRealHttpTransfer = useCallback(
    async (
      payload: AddDownloadPayload & {
        existingItemId?: string;
        silentToast?: boolean;
      }
    ) => {
      const isHttp = payload.url.startsWith('http://') || payload.url.startsWith('https://');
      const rangeEnabled = plugins.find((p) => p.id === 'plugin-range')?.enabled ?? true;
      const requestedStreams = payload.parallelStreams ?? settings.preferredStreams;
      const parallelStreams = rangeEnabled
        ? Math.min(32, Math.max(1, requestedStreams))
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
        if (payload.existingItemId) {
          startingQueueIdsRef.current.delete(payload.existingItemId);
          setDownloads((prev) =>
            prev.map((d) =>
              d.id === payload.existingItemId
                ? { ...d, status: 'error', autoQueue: false, errorMessage: validation.error }
                : d
            )
          );
        }
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
          chunks: Array.from({ length: 32 }, (_, idx) => ({
            index: idx,
            progress: 0,
            adapterId: enabledIds[0],
          })),
          adapterSplit: Object.fromEntries(currentAdapters.map((a) => [a.id, 0])),
          torrentFiles: payload.torrentFiles,
          resumable: false,
          retryCount: 0,
          directOnly: true,
          autoQueue: false,
          errorMessage: `${payload.protocol || 'This link'} requires a native torrent/FTP client on your device.`,
        };

        if (payload.existingItemId) {
          startingQueueIdsRef.current.delete(payload.existingItemId);
        }
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
          adapterId: c.adapterId || enabledIds[c.workerIndex % enabledIds.length] || enabledIds[0],
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
          playlistTitle: payload.playlistTitle,
          playlistIndex: payload.playlistIndex,
          durationText: payload.durationText,
          thumbnailUrl: payload.thumbnailUrl,
          autoQueue: false,
        };

        prevTotalBytesRef.current[serverTr.id] = serverTr.downloadedBytes || 0;
        prevTransferStatusRef.current[serverTr.id] = item.status;

        setDownloads((prev) => {
          if (payload.existingItemId) {
            return prev.map((d) =>
              d.id === payload.existingItemId
                ? {
                    ...item,
                    createdAt: d.createdAt,
                    playlistTitle: d.playlistTitle ?? item.playlistTitle,
                    playlistIndex: d.playlistIndex ?? item.playlistIndex,
                    durationText: d.durationText ?? item.durationText,
                    thumbnailUrl: d.thumbnailUrl ?? item.thumbnailUrl,
                  }
                : d
            );
          }
          return [item, ...prev];
        });

        if (!canStream) {
          notify(serverTr.errorMessage || 'Download could not be initialized');
          return;
        }

        // Download runs entirely inside MochiDrop's in-app engine (no Chrome download bar)
        if (!payload.silentToast) {
          notify(`Downloading ${item.title} inside MochiDrop`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Could not start download.';
        if (payload.existingItemId) {
          setDownloads((prev) =>
            prev.map((d) =>
              d.id === payload.existingItemId
                ? { ...d, status: 'error', autoQueue: false, speedBytesPerSec: 0, errorMessage: msg }
                : d
            )
          );
        }
        notify(msg);
      } finally {
        if (payload.existingItemId) {
          startingQueueIdsRef.current.delete(payload.existingItemId);
        }
      }
    },
    [notify, plugins, settings]
  );

  const handleChangeConcurrentDownloads = useCallback(
    (limit: ConcurrentLimit) => {
      setSettings((prev) => ({ ...prev, maxConcurrentDownloads: limit }));
      try {
        localStorage.setItem('mochidrop_concurrent', String(limit));
      } catch {
        // ignore
      }
      notify(`Simultaneous downloads set to ${limit} at a time`);
    },
    [notify]
  );

  const handleChangePreferredStreams = useCallback(
    (streams: StreamCountOption) => {
      setSettings((prev) => ({ ...prev, preferredStreams: streams }));
      try {
        localStorage.setItem('mochidrop_streams', String(streams));
      } catch {
        // ignore
      }
    },
    []
  );

  const handleEnqueueBatch = useCallback(
    (items: AddDownloadPayload[], concurrency?: ConcurrentLimit) => {
      if (items.length === 0) return;
      const effectiveLimit = concurrency ?? settings.maxConcurrentDownloads;
      if (concurrency && concurrency !== settings.maxConcurrentDownloads) {
        setSettings((prev) => ({ ...prev, maxConcurrentDownloads: concurrency }));
        try {
          localStorage.setItem('mochidrop_concurrent', String(concurrency));
        } catch {
          // ignore
        }
      }

      const now = Date.now();
      const currentAdapters = adaptersRef.current;
      const enabledIds = enabledAdapterIdsRef.current;
      const defaultAdapterId = enabledIds[0] || 'adapter-wifi';

      const queuedItems: DownloadItem[] = items.map((payload, idx) => ({
        id: `q-${now}-${idx}-${Math.random().toString(36).slice(2, 6)}`,
        title: payload.title,
        url: payload.url,
        domain: payload.domain,
        kind: payload.kind,
        protocol: payload.protocol || 'HTTPS',
        status: 'queued',
        totalBytes: payload.totalBytes || 0,
        downloadedBytes: 0,
        speedBytesPerSec: 0,
        quality: payload.quality,
        language: payload.language,
        availableLanguages: payload.availableLanguages,
        availableQualities: payload.availableQualities,
        variantUrls: payload.variantUrls,
        source: payload.source,
        createdAt: now + idx,
        chunkSizeMb: settings.chunkSizeMb,
        parallelStreams: payload.parallelStreams ?? settings.preferredStreams,
        chunks: Array.from({ length: 32 }, (_, cIdx) => ({
          index: cIdx,
          progress: 0,
          adapterId: defaultAdapterId,
        })),
        adapterSplit: Object.fromEntries(currentAdapters.map((a) => [a.id, 0])),
        torrentFiles: payload.torrentFiles,
        resumable: payload.resumable ?? true,
        retryCount: 0,
        playlistTitle: payload.playlistTitle,
        playlistIndex: payload.playlistIndex,
        durationText: payload.durationText,
        thumbnailUrl: payload.thumbnailUrl,
        autoQueue: true,
      }));

      setDownloads((prev) => [...queuedItems, ...prev]);
      notify(
        `Queued ${queuedItems.length} ${queuedItems.length === 1 ? 'file' : 'files'} (${effectiveLimit} at a time — next starts automatically)`
      );
    },
    [notify, settings.chunkSizeMb, settings.maxConcurrentDownloads, settings.preferredStreams]
  );

  const handleStartQueuedNow = useCallback(
    (id: string) => {
      const target = downloads.find((d) => d.id === id);
      if (!target || target.status !== 'queued' || target.directOnly) return;
      if (startingQueueIdsRef.current.has(id)) return;
      startingQueueIdsRef.current.add(id);

      setDownloads((prev) =>
        prev.map((d) => (d.id === id ? { ...d, status: 'connecting', autoQueue: false } : d))
      );

      void startRealHttpTransfer({
        existingItemId: target.id,
        title: target.title,
        url: target.url,
        domain: target.domain,
        kind: target.kind,
        protocol: target.protocol,
        totalBytes: target.totalBytes,
        quality: target.quality,
        language: target.language,
        availableLanguages: target.availableLanguages,
        availableQualities: target.availableQualities,
        variantUrls: target.variantUrls,
        source: target.source,
        torrentFiles: target.torrentFiles,
        resumable: target.resumable,
        playlistTitle: target.playlistTitle,
        playlistIndex: target.playlistIndex,
        durationText: target.durationText,
        thumbnailUrl: target.thumbnailUrl,
      });
    },
    [downloads, startRealHttpTransfer]
  );

  // Auto-advancing Concurrency Queue Scheduler (runs 1..5 simultaneously, auto-starts next when one finishes)
  useEffect(() => {
    const activeCount = downloads.filter(
      (d) => d.status === 'downloading' || d.status === 'connecting'
    ).length;
    const freeSlots = settings.maxConcurrentDownloads - activeCount;
    if (freeSlots <= 0) return;

    const candidates = downloads.filter(
      (d) =>
        d.status === 'queued' &&
        d.autoQueue &&
        !d.directOnly &&
        !startingQueueIdsRef.current.has(d.id)
    );
    if (candidates.length === 0) return;

    const toLaunch = candidates.slice(0, freeSlots);
    const launchIds = new Set(toLaunch.map((c) => c.id));
    for (const item of toLaunch) {
      startingQueueIdsRef.current.add(item.id);
    }

    setDownloads((prev) =>
      prev.map((d) =>
        launchIds.has(d.id) ? { ...d, status: 'connecting', autoQueue: false } : d
      )
    );

    for (const item of toLaunch) {
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
        playlistTitle: item.playlistTitle,
        playlistIndex: item.playlistIndex,
        durationText: item.durationText,
        thumbnailUrl: item.thumbnailUrl,
        silentToast: toLaunch.length > 1,
      });
    }
  }, [downloads, settings.maxConcurrentDownloads, startRealHttpTransfer]);

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
              adapterId: c.adapterId || enabledIds[c.workerIndex % enabledIds.length] || enabledIds[0],
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
        const anyNonZero = prev.some(
          (a) => a.currentSpeedMbps > 0 || (a.currentSpeedBytesPerSec ?? 0) > 0
        );
        if (!anyNonZero) return prev;
        return prev.map((a) => ({
          ...a,
          currentSpeedBytesPerSec: 0,
          currentSpeedMbps: 0,
        }));
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
        const notifications: string[] = [];

        for (const tr of serverList) {
          mapById.set(tr.id, tr);

          const prevBytes = prevTotalBytesRef.current[tr.id] ?? 0;
          const deltaBytes = Math.max(0, tr.downloadedBytes - prevBytes);
          prevTotalBytesRef.current[tr.id] = tr.downloadedBytes;
          deltasById.set(tr.id, deltaBytes);

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
            if (deltaBytes > 0 && activeIds.length > 0) {
              const perId = deltaBytes / activeIds.length;
              for (const id of activeIds) {
                nextSplit[id] = (nextSplit[id] || 0) + perId;
              }
            }

            const mappedChunks = live.chunks.map((c) => ({
              index: c.index,
              progress: c.progress,
              adapterId: c.adapterId || activeIds[c.workerIndex % activeIds.length] || activeIds[0],
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

        // Apply REAL per-adapter OS throughput snapshot returned atomically from server
        if (Array.isArray(data.networks)) {
          setAdapters((prev) => mergeServerNetworks(prev, data.networks as ServerNetworkDto[]));
        }
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
        playlistTitle: item.playlistTitle,
        playlistIndex: item.playlistIndex,
        durationText: item.durationText,
        thumbnailUrl: item.thumbnailUrl,
      });
    },
    [startRealHttpTransfer]
  );

  const handleRemove = useCallback(
    async (id: string) => {
      startingQueueIdsRef.current.delete(id);
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

  const handleClearCompleted = useCallback(async () => {
    const completed = downloads.filter((d) => d.status === 'completed');
    if (completed.length === 0) {
      notify('No completed transfers to clear');
      return;
    }
    await Promise.all(
      completed
        .filter((d) => Boolean(d.serverTransferId))
        .map((d) =>
          fetch(`/api/transfers/${encodeURIComponent(d.serverTransferId!)}`, {
            method: 'DELETE',
          }).catch(() => {})
        )
    );
    setDownloads((prev) => prev.filter((d) => d.status !== 'completed'));
    notify(`Cleared ${completed.length} completed ${completed.length === 1 ? 'file' : 'files'}`);
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

  const queuedCount = useMemo(
    () => downloads.filter((d) => d.status === 'queued' && !d.directOnly).length,
    [downloads]
  );

  const completedCount = useMemo(
    () => downloads.filter((d) => d.status === 'completed').length,
    [downloads]
  );

  const incompleteCount = useMemo(
    () => downloads.filter((d) => d.status !== 'completed').length,
    [downloads]
  );

  const categoryCounts = useMemo(() => {
    const counts: Record<CategoryFilter, number> = {
      all: downloads.length,
      compressed: 0,
      documents: 0,
      music: 0,
      video: 0,
      programs: 0,
      torrent: 0,
      completed: 0,
      incomplete: 0,
    };
    for (const d of downloads) {
      if (d.kind === 'archive') counts.compressed += 1;
      else if (d.kind === 'document' || d.kind === 'image' || d.kind === 'file') counts.documents += 1;
      else if (d.kind === 'audio') counts.music += 1;
      else if (d.kind === 'video') counts.video += 1;
      else if (d.kind === 'software') counts.programs += 1;
      else if (d.kind === 'torrent') counts.torrent += 1;

      if (d.status === 'completed') counts.completed += 1;
      else counts.incomplete += 1;
    }
    return counts;
  }, [downloads]);

  const selectCategory = useCallback((cat: CategoryFilter) => {
    setActiveTab('downloads');
    setCategoryFilter(cat);
    setMobileNavOpen(false);
  }, []);

  return (
    <MotionConfig reducedMotion="user">
      <div className="mochi-canvas min-h-screen flex flex-col text-[#111B16] dark:text-[#F4F8F6] transition-colors duration-200">
        {/* Minimalist Top Bar: Brand + Single Light/Dark Toggle (No Duplicate Nav Tabs) */}
        <header className="sticky top-0 z-30 h-14 px-4 sm:px-6 border-b border-[#0F241B]/10 dark:border-white/[0.08] bg-white/60 dark:bg-[#070B09]/70 backdrop-blur-xl flex items-center justify-between gap-4">
          {/* Left: Mobile Sidebar Trigger + Brand Wordmark */}
          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              aria-label="Open navigation sidebar"
              className="lg:hidden h-8 w-8 rounded-lg border border-[#0F241B]/12 dark:border-white/[0.1] bg-white/50 dark:bg-white/[0.04] inline-flex items-center justify-center text-[#4D6157] dark:text-[#96A39D] cursor-pointer"
            >
              <Menu className="h-4 w-4" />
            </button>

            <button
              type="button"
              onClick={() => selectCategory('all')}
              className="flex items-center gap-2.5 text-left whitespace-nowrap shrink-0 cursor-pointer group"
            >
              <span className="h-7 w-7 rounded-lg bg-[#0D231A] border border-[#2FD48B]/40 text-[#2FD48B] flex items-center justify-center shadow-[0_0_16px_rgba(47,212,139,0.22)] transition-transform duration-150 group-hover:scale-105">
                <Download className="h-3.5 w-3.5 stroke-[2.5]" />
              </span>
              <span className="font-display text-base font-bold tracking-tight text-[#111B16] dark:text-white">
                {BRAND_NAME}
              </span>
            </button>
          </div>

          {/* Right: Update Indicator (when new GitHub release available) + Light / Dark Toggle */}
          <div className="flex items-center gap-2 shrink-0">
            {updateInfo?.updateAvailable && (
              <motion.button
                whileTap={{ scale: 0.96 }}
                type="button"
                onClick={() => setUpdateModalOpen(true)}
                className="h-8 px-3 rounded-lg border border-[#2FD48B]/40 bg-[#E2F5EC]/90 dark:bg-[#0F2B20]/90 text-xs font-semibold text-[#126646] dark:text-[#3BE098] hover:border-[#2FD48B]/70 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer shadow-[0_0_16px_rgba(47,212,139,0.16)]"
              >
                <ArrowUpCircle className="h-3.5 w-3.5" />
                <span>
                  {updateDownload.state === 'ready'
                    ? 'Install Update'
                    : updateDownload.state === 'downloading'
                    ? `Updating ${updateDownload.percent}%`
                    : `Update ${updateInfo.releaseTag}`}
                </span>
              </motion.button>
            )}

            <motion.button
              whileTap={{ scale: 0.96 }}
              type="button"
              onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              className="h-8 px-3 rounded-lg border border-[#0F241B]/12 dark:border-white/[0.1] bg-white/65 dark:bg-white/[0.04] text-xs font-medium text-[#203329] dark:text-[#D5DFDA] hover:border-[#1B6B4D]/40 dark:hover:border-[#2FD48B]/35 hover:bg-white/90 dark:hover:bg-white/[0.08] transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
            >
              {theme === 'dark' ? (
                <>
                  <Sun className="h-3.5 w-3.5 text-[#3BE098]" />
                  <span>Light</span>
                </>
              ) : (
                <>
                  <Moon className="h-3.5 w-3.5 text-[#1A6B4D]" />
                  <span>Dark</span>
                </>
              )}
            </motion.button>
          </div>
        </header>

        {/* Non-Intrusive New Release Notification Strip (appears automatically when a newer GitHub Release exists) */}
        <AnimatePresence>
          {updateInfo?.updateAvailable &&
            dismissedUpdateTag !== updateInfo.releaseTag && (
              <motion.div
                key="mochidrop-update-banner"
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.2 }}
                className="px-4 sm:px-6 py-2 border-b border-[#1C6B4D]/20 dark:border-[#2FD48B]/25 bg-[#E6F7EF]/90 dark:bg-[#0B2219]/85 backdrop-blur-md flex flex-wrap items-center justify-between gap-2 text-xs"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <ArrowUpCircle className="h-4 w-4 text-[#156E4B] dark:text-[#3BE098] shrink-0" />
                  <span className="text-[#111B16] dark:text-white font-medium truncate">
                    New release <strong className="font-mono">{updateInfo.releaseTag}</strong> is available
                    <span className="hidden sm:inline text-[#52655C] dark:text-[#8E9B95] font-normal">
                      {' '}
                      (you have v{updateInfo.currentVersion})
                    </span>
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => setUpdateModalOpen(true)}
                    className="h-7 px-3 rounded-lg bg-[#1C6B4D] hover:bg-[#16593F] dark:bg-[#1A5E44] dark:hover:bg-[#217455] border border-[#2FD48B]/40 text-white text-[11px] font-semibold cursor-pointer transition-colors"
                  >
                    {updateDownload.state === 'ready' ? 'Install & Restart' : 'Download & Update'}
                  </button>
                  <button
                    type="button"
                    onClick={handleDismissUpdateBanner}
                    aria-label="Dismiss update notification"
                    className="p-1 rounded-md text-[#52655C] dark:text-[#8E9B95] hover:text-[#111B16] dark:hover:text-white cursor-pointer"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </motion.div>
            )}
        </AnimatePresence>

        {/* Workspace Body: Left Single-Side Sidebar + Main Canvas */}
        <div className="flex-1 flex min-h-0 relative">
          <AnimatePresence>
            {mobileNavOpen && (
              <motion.div
                key="mobile-nav-backdrop"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
                onClick={() => setMobileNavOpen(false)}
                className="fixed inset-0 z-40 bg-black/65 backdrop-blur-xs lg:hidden"
              />
            )}
          </AnimatePresence>

          {/* Single-Side Left Navigation Sidebar */}
          <aside
            className={`fixed lg:sticky top-14 left-0 z-40 h-[calc(100vh-3.5rem)] ${
              downloads.length > 0 ? 'lg:h-[calc(100vh-5.75rem)]' : 'lg:h-[calc(100vh-3.5rem)]'
            } w-56 shrink-0 border-r border-[#0F241B]/10 dark:border-white/[0.08] bg-white/55 dark:bg-[#080D0B]/65 backdrop-blur-xl flex flex-col justify-between overflow-y-auto transition-transform duration-200 ease-out lg:translate-x-0 ${
              mobileNavOpen ? 'translate-x-0' : '-translate-x-full'
            }`}
          >
            <div className="p-3.5 space-y-3">
              <div className="flex items-center justify-between lg:hidden pb-2 border-b border-[#0F241B]/10 dark:border-white/[0.08]">
                <span className="font-display text-sm font-semibold text-[#111B16] dark:text-white">
                  Navigation
                </span>
                <button
                  type="button"
                  onClick={() => setMobileNavOpen(false)}
                  aria-label="Close sidebar"
                  className="p-1 text-[#5E7067] hover:text-[#111B16] dark:hover:text-white cursor-pointer"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {/* Primary Single-Side Navigation: Downloads (with progressive category tree once downloads exist) */}
              <div className="space-y-1">
                <div className="flex items-center gap-0.5">
                  {downloads.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setTreeExpanded((v) => !v)}
                      aria-label={treeExpanded ? 'Collapse categories' : 'Expand categories'}
                      className="h-8 w-6 shrink-0 rounded-md inline-flex items-center justify-center text-[#687B72] hover:text-[#111B16] dark:hover:text-white cursor-pointer"
                    >
                      {treeExpanded ? (
                        <ChevronDown className="h-3.5 w-3.5" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5" />
                      )}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => selectCategory('all')}
                    className={`relative flex-1 flex items-center justify-between gap-2 px-3 py-2 rounded-xl text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                      activeTab === 'downloads' && categoryFilter === 'all'
                        ? 'text-[#126646] dark:text-[#3BE098]'
                        : 'text-[#283B32] dark:text-[#C5D1CB] hover:bg-black/[0.04] dark:hover:bg-white/[0.05]'
                    }`}
                  >
                    {activeTab === 'downloads' && categoryFilter === 'all' && (
                      <motion.span
                        layoutId="mochidrop-tree-active"
                        transition={{ type: 'spring', stiffness: 460, damping: 36 }}
                        className="absolute inset-0 rounded-xl bg-[#E2F5EC]/85 dark:bg-[#0F2B20]/85 border border-[#1C6B4D]/20 dark:border-[#2FD48B]/35"
                      />
                    )}
                    <span className="relative z-10 inline-flex items-center gap-2">
                      <FolderOpen className="h-3.5 w-3.5 text-[#1A7A54] dark:text-[#2FD48B]" />
                      <span>Downloads</span>
                    </span>
                    {categoryCounts.all > 0 && (
                      <span className="relative z-10 font-mono text-[11px] tabular-nums text-[#64786E] dark:text-[#7E8E87]">
                        {categoryCounts.all}
                      </span>
                    )}
                  </button>
                </div>

                {/* Show Category Sub-tree & Status filters ONLY once downloads exist */}
                {downloads.length > 0 && treeExpanded && (
                  <div className="ml-3 pl-3 border-l border-[#0F241B]/12 dark:border-white/[0.08] space-y-0.5">
                    {CATEGORY_TREE_CHILDREN.map((node) => {
                      const Icon = node.icon;
                      const isActive = activeTab === 'downloads' && categoryFilter === node.id;
                      const count = categoryCounts[node.id];
                      return (
                        <button
                          key={node.id}
                          type="button"
                          onClick={() => selectCategory(node.id)}
                          className={`relative w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                            isActive
                              ? 'text-[#126646] dark:text-[#3BE098]'
                              : 'text-[#4D6157] dark:text-[#8E9B95] hover:text-[#111B16] dark:hover:text-white hover:bg-black/[0.04] dark:hover:bg-white/[0.05]'
                          }`}
                        >
                          {isActive && (
                            <motion.span
                              layoutId="mochidrop-tree-active"
                              transition={{ type: 'spring', stiffness: 460, damping: 36 }}
                              className="absolute inset-0 rounded-lg bg-[#E2F5EC]/85 dark:bg-[#0F2B20]/85 border border-[#1C6B4D]/20 dark:border-[#2FD48B]/35"
                            />
                          )}
                          <span className="relative z-10 inline-flex items-center gap-2">
                            <Icon className={`h-3.5 w-3.5 shrink-0 ${node.iconColor}`} />
                            <span>{node.label}</span>
                          </span>
                          {count > 0 && (
                            <span className="relative z-10 font-mono text-[11px] tabular-nums text-[#64786E] dark:text-[#7E8E87]">
                              {count}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {downloads.length > 0 && (
                <div className="pt-2 border-t border-[#0F241B]/10 dark:border-white/[0.08] space-y-0.5">
                  <button
                    type="button"
                    onClick={() => selectCategory('completed')}
                    className={`relative w-full flex items-center justify-between gap-2 px-3 py-2 rounded-xl text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                      activeTab === 'downloads' && categoryFilter === 'completed'
                        ? 'text-[#126646] dark:text-[#3BE098]'
                        : 'text-[#4D6157] dark:text-[#8E9B95] hover:text-[#111B16] dark:hover:text-white hover:bg-black/[0.04] dark:hover:bg-white/[0.05]'
                    }`}
                  >
                    {activeTab === 'downloads' && categoryFilter === 'completed' && (
                      <motion.span
                        layoutId="mochidrop-tree-active"
                        transition={{ type: 'spring', stiffness: 460, damping: 36 }}
                        className="absolute inset-0 rounded-xl bg-[#E2F5EC]/85 dark:bg-[#0F2B20]/85 border border-[#1C6B4D]/20 dark:border-[#2FD48B]/35"
                      />
                    )}
                    <span className="relative z-10 inline-flex items-center gap-2">
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-[#3BE098]" />
                      <span>Completed</span>
                    </span>
                    {completedCount > 0 && (
                      <span className="relative z-10 font-mono text-[11px] tabular-nums text-[#64786E] dark:text-[#7E8E87]">
                        {completedCount}
                      </span>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => selectCategory('incomplete')}
                    className={`relative w-full flex items-center justify-between gap-2 px-3 py-2 rounded-xl text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                      activeTab === 'downloads' && categoryFilter === 'incomplete'
                        ? 'text-[#126646] dark:text-[#3BE098]'
                        : 'text-[#4D6157] dark:text-[#8E9B95] hover:text-[#111B16] dark:hover:text-white hover:bg-black/[0.04] dark:hover:bg-white/[0.05]'
                    }`}
                  >
                    {activeTab === 'downloads' && categoryFilter === 'incomplete' && (
                      <motion.span
                        layoutId="mochidrop-tree-active"
                        transition={{ type: 'spring', stiffness: 460, damping: 36 }}
                        className="absolute inset-0 rounded-xl bg-[#E2F5EC]/85 dark:bg-[#0F2B20]/85 border border-[#1C6B4D]/20 dark:border-[#2FD48B]/35"
                      />
                    )}
                    <span className="relative z-10 inline-flex items-center gap-2">
                      <Clock3 className="h-3.5 w-3.5 text-[#1A7A54] dark:text-[#2FD48B]" />
                      <span>In Progress</span>
                    </span>
                    {incompleteCount > 0 && (
                      <span className="relative z-10 font-mono text-[11px] tabular-nums text-[#64786E] dark:text-[#7E8E87]">
                        {incompleteCount}
                      </span>
                    )}
                  </button>
                </div>
              )}

              {/* Networks & Settings (Single-Side Only — Zero Duplication) */}
              <div className="pt-2 border-t border-[#0F241B]/10 dark:border-white/[0.08] space-y-0.5">
                <button
                  type="button"
                  onClick={() => {
                    setActiveTab('networks');
                    setMobileNavOpen(false);
                  }}
                  className={`relative w-full flex items-center justify-between gap-2 px-3 py-2 rounded-xl text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                    activeTab === 'networks'
                      ? 'text-[#126646] dark:text-[#3BE098]'
                      : 'text-[#4D6157] dark:text-[#8E9B95] hover:text-[#111B16] dark:hover:text-white hover:bg-black/[0.04] dark:hover:bg-white/[0.05]'
                  }`}
                >
                  {activeTab === 'networks' && (
                    <motion.span
                      layoutId="mochidrop-tree-active"
                      transition={{ type: 'spring', stiffness: 460, damping: 36 }}
                      className="absolute inset-0 rounded-xl bg-[#E2F5EC]/85 dark:bg-[#0F2B20]/85 border border-[#1C6B4D]/20 dark:border-[#2FD48B]/35"
                    />
                  )}
                  <span className="relative z-10 inline-flex items-center gap-2">
                    <Network className="h-3.5 w-3.5 text-teal-600 dark:text-[#2FD48B]" />
                    <span>Networks</span>
                  </span>
                  <span className="relative z-10 font-mono text-[11px] tabular-nums text-[#64786E] dark:text-[#7E8E87]">
                    {enabledAdapters.length}/{adapters.length}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setActiveTab('settings');
                    setMobileNavOpen(false);
                  }}
                  className={`relative w-full flex items-center justify-between gap-2 px-3 py-2 rounded-xl text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                    activeTab === 'settings'
                      ? 'text-[#126646] dark:text-[#3BE098]'
                      : 'text-[#4D6157] dark:text-[#8E9B95] hover:text-[#111B16] dark:hover:text-white hover:bg-black/[0.04] dark:hover:bg-white/[0.05]'
                  }`}
                >
                  {activeTab === 'settings' && (
                    <motion.span
                      layoutId="mochidrop-tree-active"
                      transition={{ type: 'spring', stiffness: 460, damping: 36 }}
                      className="absolute inset-0 rounded-xl bg-[#E2F5EC]/85 dark:bg-[#0F2B20]/85 border border-[#1C6B4D]/20 dark:border-[#2FD48B]/35"
                    />
                  )}
                  <span className="relative z-10 inline-flex items-center gap-2">
                    <Settings className="h-3.5 w-3.5 text-[#64786E] dark:text-[#8E9B95]" />
                    <span>Settings</span>
                  </span>
                </button>
              </div>
            </div>

            {/* Subtle Footer Storage Indicator */}
            <div className="p-3.5 border-t border-[#0F241B]/10 dark:border-white/[0.08] text-[11px] text-[#5B6E64] dark:text-[#7E8E87]">
              <div className="flex items-center gap-1.5 font-medium text-[#22352C] dark:text-[#D1DCD6]">
                <HardDrive className="h-3.5 w-3.5 text-[#1A7A54] dark:text-[#2FD48B]" />
                <span>In-App Storage</span>
              </div>
            </div>
          </aside>

          {/* Main Workspace Canvas (Transparent so dot-matrix + emerald glow shines through) */}
          <main className="flex-1 min-w-0 bg-transparent p-4 sm:p-6 pb-16">
            <div className="max-w-[1280px] mx-auto w-full">
              <AnimatePresence mode="wait">
                <motion.div
                  key={activeTab}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                >
                  {activeTab === 'downloads' && (
                    <DownloadsView
                      downloads={downloads}
                      adapters={adapters}
                      settings={settings}
                      liveAggregateBytesPerSec={liveAggregateBytesPerSec}
                      categoryFilter={categoryFilter}
                      onCategoryChange={setCategoryFilter}
                      urlInput={urlInput}
                      onUrlInputChange={setUrlInput}
                      onAddDownload={(payload) => void startRealHttpTransfer(payload)}
                      onEnqueueBatch={handleEnqueueBatch}
                      onStartQueuedNow={handleStartQueuedNow}
                      onChangeConcurrent={handleChangeConcurrentDownloads}
                      onChangePreferredStreams={handleChangePreferredStreams}
                      onTogglePause={(id) => void handleTogglePause(id)}
                      onRetryTransfer={handleRetryOrRedownload}
                      onRemove={(id) => void handleRemove(id)}
                      onClearCompleted={() => void handleClearCompleted()}
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
                      onOpenNetworksView={() => setActiveTab('networks')}
                    />
                  )}

                  {activeTab === 'networks' && (
                    <NetworksView
                      adapters={adapters}
                      settings={settings}
                      totalBytesPerSec={liveAggregateBytesPerSec}
                      isDownloading={activeDownloadCount > 0}
                      onToggleAdapter={(id) => void handleToggleAdapter(id)}
                      onUpdateAdapter={(id, patch) => {
                        setAdapters((prev) =>
                          prev.map((a) => (a.id === id ? { ...a, ...patch } : a))
                        );
                      }}
                      onRescanNetworks={handleRescanNetworks}
                      onUpdateSettings={(patch) => setSettings((prev) => ({ ...prev, ...patch }))}
                    />
                  )}

                  {activeTab === 'settings' && (
                    <SettingsView
                      plugins={plugins}
                      settings={settings}
                      updateInfo={updateInfo}
                      updateDownload={updateDownload}
                      checkingUpdate={checkingUpdate}
                      onCheckUpdates={() => void handleCheckUpdates(true)}
                      onOpenUpdateModal={() => setUpdateModalOpen(true)}
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
            </div>
          </main>
        </div>

        {/* Bottom Status Bar: Progressive — appears only once downloads exist */}
        {downloads.length > 0 && (
          <footer className="sticky bottom-0 z-20 h-9 px-4 sm:px-6 border-t border-[#0F241B]/10 dark:border-white/[0.08] bg-white/65 dark:bg-[#070B09]/75 backdrop-blur-xl flex items-center justify-between gap-4 text-[11px] text-[#4D6157] dark:text-[#8E9B95]">
            <div className="flex items-center gap-3 min-w-0">
              <button
                type="button"
                onClick={() => setActiveTab('networks')}
                className="hover:text-[#156E4B] dark:hover:text-[#3BE098] transition-colors whitespace-nowrap cursor-pointer"
              >
                {enabledAdapters.length === 0
                  ? 'No Active Network'
                  : enabledAdapters.length === 1
                  ? `${enabledAdapters[0].name} Active`
                  : `${enabledAdapters.length} Networks Bonded (${enabledAdapters
                      .map((a) => (a.interfaceType === 'Cellular USB' ? 'USB' : a.interfaceType))
                      .join(' + ')})`}{' '}
                · {settings.preferredStreams} streams
              </button>
            </div>

            <div className="flex items-center gap-4 font-mono tabular-nums shrink-0">
              <span className="text-[#126646] dark:text-[#3BE098] font-semibold">
                Speed {formatSpeedMBps(liveAggregateBytesPerSec)}
              </span>
              <span>
                Active [{activeDownloadCount}/{settings.maxConcurrentDownloads}]
              </span>
              {queuedCount > 0 && (
                <span className="text-[#187A54] dark:text-[#2FD48B]">
                  Queued [{queuedCount}]
                </span>
              )}
              <span className="hidden sm:inline">Done [{completedCount}]</span>
            </div>
          </footer>
        )}

        <UpdateModal
          open={updateModalOpen}
          updateInfo={updateInfo}
          downloadStatus={updateDownload}
          checking={checkingUpdate}
          onClose={() => setUpdateModalOpen(false)}
          onRemindLater={handleDismissUpdateBanner}
          onCheckAgain={() => void handleCheckUpdates(true)}
          onStartDownload={(assetName) => void handleStartUpdateDownload(assetName)}
          onInstallNow={() => void handleInstallUpdateNow()}
        />

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
              className="fixed bottom-12 right-5 z-50 max-w-sm rounded-xl border border-[#2FD48B]/30 bg-[#0B1712]/90 backdrop-blur-xl text-[#F1F8F4] px-4 py-2.5 text-xs font-medium shadow-[0_12px_32px_rgba(0,0,0,0.45)]"
            >
              {toast}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </MotionConfig>
  );
}
