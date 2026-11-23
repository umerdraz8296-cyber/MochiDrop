import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertCircle,
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  Clipboard,
  Copy,
  Download,
  ExternalLink,
  Eye,
  File,
  FileArchive,
  FileText,
  Film,
  Globe,
  HardDrive,
  Image as ImageIcon,
  Info,
  Languages,
  Layers,
  LayoutList,
  Link2,
  List,
  ListPlus,
  ListVideo,
  Loader2,
  Magnet,
  MonitorPlay,
  MoreVertical,
  Music,
  Network,
  Package,
  Pause,
  Play,
  RotateCcw,
  Search,
  Trash2,
  Upload,
  X,
  Zap,
} from 'lucide-react';
import { ActivePlayerSession, MediaPlayerModal } from './MediaPlayerModal';
import { NetworkBondingVisualizer } from './NetworkBondingVisualizer';
import { YouTubePlaylistModal } from './YouTubePlaylistModal';
import {
  AddDownloadPayload,
  CategoryFilter,
  ConcurrentLimit,
  DownloadItem,
  DownloadKind,
  InspectResponse,
  NetworkAdapter,
  PlexoSettings,
  StreamCountOption,
  TorrentFileItem,
} from '../types/plexo';
import {
  extractUrlsFromText,
  formatBytes,
  formatEta,
  formatSpeedMBps,
  isSafeTransferUrl,
} from '../utils/format';

interface DownloadsViewProps {
  downloads: DownloadItem[];
  adapters: NetworkAdapter[];
  settings: PlexoSettings;
  liveAggregateBytesPerSec: number;
  categoryFilter: CategoryFilter;
  onCategoryChange: (cat: CategoryFilter) => void;
  urlInput: string;
  onUrlInputChange: (val: string) => void;
  onAddDownload: (payload: AddDownloadPayload) => void;
  onEnqueueBatch: (items: AddDownloadPayload[], concurrency?: ConcurrentLimit) => void;
  onStartQueuedNow: (id: string) => void;
  onChangeConcurrent: (limit: ConcurrentLimit) => void;
  onChangePreferredStreams: (streams: StreamCountOption) => void;
  onTogglePause: (id: string) => void;
  onRetryTransfer: (item: DownloadItem) => void;
  onRemove: (id: string) => void;
  onClearCompleted: () => void;
  onMoveItem: (id: string, direction: 'up' | 'down') => void;
  onPauseAll: () => void;
  onResumeAll: () => void;
  onUpdateTrack: (id: string, quality: string, language: string) => void;
  onToggleAdapter: (id: string) => void;
  onNotify: (msg: string) => void;
  onOpenNetworksView: () => void;
}

interface BatchSelectionItem extends InspectResponse {
  selected: boolean;
}

const EASE_STUDIO: [number, number, number, number] = [0.16, 1, 0.3, 1];
const CONCURRENT_SLOTS: ConcurrentLimit[] = [1, 2, 3, 4, 5];
const STREAM_COUNT_OPTIONS: StreamCountOption[] = [4, 8, 16, 32];

function isYouTubePlaylistUrl(line: string): boolean {
  return /(?:^https?:\/\/)?(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)\/.*[?&]list=[A-Za-z0-9_-]{10,}/i.test(
    line.trim()
  );
}

const CATEGORY_LABELS: Record<CategoryFilter, string> = {
  all: 'All Downloads',
  compressed: 'Compressed',
  documents: 'Documents',
  music: 'Music',
  video: 'Video',
  programs: 'Programs',
  torrent: 'Torrents',
  completed: 'Completed',
  incomplete: 'In Progress',
};

function getKindTileStyle(kind: DownloadKind): string {
  switch (kind) {
    case 'video':
      return 'bg-[#E2F5EC] text-[#156E4B] dark:bg-[#0F2B20]/85 dark:text-[#3BE098] border border-[#1C6B4D]/15 dark:border-[#2FD48B]/25';
    case 'image':
      return 'bg-[#E0F2FE] text-[#0369A1] dark:bg-sky-500/15 dark:text-sky-300 border border-sky-500/15 dark:border-sky-400/20';
    case 'audio':
      return 'bg-[#ECFCCB] text-[#4D7C0F] dark:bg-lime-500/15 dark:text-lime-300 border border-lime-500/15 dark:border-lime-400/20';
    case 'software':
      return 'bg-[#FEF3C7] text-[#B45309] dark:bg-amber-500/15 dark:text-amber-300 border border-amber-500/15 dark:border-amber-400/20';
    case 'archive':
      return 'bg-[#CCFBF1] text-[#0F766E] dark:bg-teal-500/15 dark:text-teal-300 border border-teal-500/15 dark:border-teal-400/20';
    case 'document':
      return 'bg-[#D1FAE5] text-[#047857] dark:bg-emerald-500/15 dark:text-emerald-300 border border-emerald-500/15 dark:border-emerald-400/20';
    case 'torrent':
      return 'bg-[#CFFAFE] text-[#0E7490] dark:bg-cyan-500/15 dark:text-cyan-300 border border-cyan-500/15 dark:border-cyan-400/20';
    default:
      return 'bg-black/[0.05] text-[#4D6157] dark:bg-white/[0.06] dark:text-[#9CA7A2] border border-black/[0.06] dark:border-white/[0.08]';
  }
}

export const DownloadsView: React.FC<DownloadsViewProps> = ({
  downloads,
  adapters,
  settings,
  liveAggregateBytesPerSec,
  categoryFilter,
  onCategoryChange,
  urlInput,
  onUrlInputChange,
  onAddDownload,
  onEnqueueBatch,
  onStartQueuedNow,
  onChangeConcurrent,
  onChangePreferredStreams,
  onTogglePause,
  onRetryTransfer,
  onRemove,
  onClearCompleted,
  onMoveItem,
  onPauseAll,
  onResumeAll,
  onUpdateTrack,
  onToggleAdapter,
  onNotify,
  onOpenNetworksView,
}) => {
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState<'cards' | 'compact'>('cards');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [contextMenuId, setContextMenuId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showNetworkBond, setShowNetworkBond] = useState(true);

  const [ytPlaylistModalOpen, setYtPlaylistModalOpen] = useState(false);
  const [ytPlaylistInitialUrl, setYtPlaylistInitialUrl] = useState('');
  const [failedCardThumbs, setFailedCardThumbs] = useState<Set<string>>(new Set());
  const [batchMode, setBatchMode] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [startingPlay, setStartingPlay] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [inspected, setInspected] = useState<InspectResponse | null>(null);
  const [batchItems, setBatchItems] = useState<BatchSelectionItem[]>([]);
  const [selectedQuality, setSelectedQuality] = useState('Source Quality');
  const [selectedLanguage, setSelectedLanguage] = useState('Source Audio');
  const [selectedStreams, setSelectedStreams] = useState<StreamCountOption>(
    settings.preferredStreams
  );
  const [torrentSelection, setTorrentSelection] = useState<TorrentFileItem[]>([]);
  const [playerSession, setPlayerSession] = useState<ActivePlayerSession | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pasteInputRef = useRef<HTMLInputElement | null>(null);
  const lastAutoClipboardRef = useRef<string>('');
  const lastInspectedUrlRef = useRef<string>('');

  useEffect(() => {
    setSelectedStreams(settings.preferredStreams);
  }, [settings.preferredStreams]);

  const openYouTubePlaylistModal = useCallback((initial = '') => {
    setYtPlaylistInitialUrl(initial);
    setYtPlaylistModalOpen(true);
    setInspectError(null);
  }, []);

  const activeQueueCount = useMemo(
    () =>
      downloads.filter((d) => d.status === 'downloading' || d.status === 'connecting').length,
    [downloads]
  );

  const waitingQueueCount = useMemo(
    () => downloads.filter((d) => d.status === 'queued' && !d.directOnly).length,
    [downloads]
  );

  const activeStreamsSum = useMemo(() => {
    const running = downloads.filter(
      (d) => d.status === 'downloading' || d.status === 'connecting'
    );
    if (running.length === 0) return settings.preferredStreams;
    return running.reduce((sum, d) => sum + (d.parallelStreams || 1), 0);
  }, [downloads, settings.preferredStreams]);

  const livePlayerTransfer = useMemo(
    () =>
      playerSession?.mode === 'transfer' && playerSession.transferId
        ? downloads.find((d) => d.serverTransferId === playerSession.transferId) ?? null
        : null,
    [downloads, playerSession]
  );

  // Close floating card context menu when clicking outside or pressing Escape
  useEffect(() => {
    if (!contextMenuId) return;
    const handleGlobalClick = () => setContextMenuId(null);
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenuId(null);
    };
    window.addEventListener('click', handleGlobalClick);
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('click', handleGlobalClick);
      window.removeEventListener('keydown', handleKey);
    };
  }, [contextMenuId]);

  const filteredDownloads = useMemo(() => {
    const q = search.trim().toLowerCase();
    return downloads.filter((item) => {
      if (categoryFilter === 'compressed' && item.kind !== 'archive') return false;
      if (
        categoryFilter === 'documents' &&
        item.kind !== 'document' &&
        item.kind !== 'image' &&
        item.kind !== 'file'
      ) {
        return false;
      }
      if (categoryFilter === 'music' && item.kind !== 'audio') return false;
      if (categoryFilter === 'video' && item.kind !== 'video') return false;
      if (categoryFilter === 'programs' && item.kind !== 'software') return false;
      if (categoryFilter === 'torrent' && item.kind !== 'torrent') return false;
      if (categoryFilter === 'completed' && item.status !== 'completed') return false;
      if (categoryFilter === 'incomplete' && item.status === 'completed') return false;

      if (q) {
        const hay =
          `${item.title} ${item.domain} ${item.playlistTitle ?? ''} ${item.protocol ?? ''} ${item.language ?? ''} ${item.quality ?? ''}`.toLowerCase();
        return hay.includes(q);
      }
      return true;
    });
  }, [downloads, categoryFilter, search]);

  const handleSelectStreams = useCallback(
    (count: StreamCountOption) => {
      setSelectedStreams(count);
      onChangePreferredStreams(count);
    },
    [onChangePreferredStreams]
  );

  const handleInspectInput = useCallback(
    async (rawOverride?: string) => {
      const raw = (rawOverride ?? urlInput).trim();
      if (!raw) {
        setInspectError('Paste any link — YouTube, playlist, video, audio track, cloud, torrent, or direct file.');
        return;
      }

      const lines = extractUrlsFromText(raw);
      if (lines.length === 0) {
        setInspectError('No links found.');
        return;
      }

      // Auto-detect YouTube playlist URLs and open Playlist Batch Downloader
      if (lines.length > 0 && lines.every((l) => isYouTubePlaylistUrl(l))) {
        onUrlInputChange('');
        setBatchMode(false);
        openYouTubePlaylistModal(lines.join('\n'));
        onNotify('YouTube playlist detected — select resolution & downloads at a time');
        return;
      }

      // Multiple links -> batch inspect
      if (lines.length > 1) {
        const validLines = lines.filter((l) => isSafeTransferUrl(l));
        if (validLines.length === 0) {
          setInspectError('Paste valid links (HTTP/HTTPS, YouTube, SoundCloud, Cloud, FTP/SFTP, or Magnet/Torrent).');
          return;
        }

        setInspectError(null);
        setInspected(null);
        setBatchMode(true);
        setInspecting(true);
        try {
          const res = await fetch('/api/inspect-batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ urls: validLines.slice(0, 25) }),
          });
          const data = await res.json();
          if (!res.ok) {
            setInspectError(data.error || 'Batch inspection failed.');
            return;
          }
          const results = Array.isArray(data.items) ? (data.items as InspectResponse[]) : [];
          if (results.length === 0) {
            setInspectError('None of the pasted links could be inspected.');
            return;
          }
          setBatchItems(results.map((item) => ({ ...item, selected: true })));
          if (Array.isArray(data.errors) && data.errors.length > 0) {
            onNotify(`Inspected ${results.length} links (${data.errors.length} skipped)`);
          }
        } catch {
          setInspectError('Batch inspection failed. Check your links and try again.');
        } finally {
          setInspecting(false);
        }
        return;
      }

      // Single URL inspect — reveals Play Online + 4/8/16/32 Stream picker cleanly
      const target = lines[0];
      if (!isSafeTransferUrl(target)) {
        setInspectError('Supported links: YouTube, Playlists, Direct Files, Video/Audio Tracks, Cloud, FTP/SFTP, Torrent/Magnet.');
        return;
      }

      setInspectError(null);
      setBatchItems([]);
      setInspecting(true);
      try {
        const res = await fetch('/api/inspect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: target }),
        });
        const data = await res.json();
        if (!res.ok) {
          setInspectError(data.error || 'Could not inspect this link.');
          return;
        }
        const result = data as InspectResponse;
        const resolvedQ = result.quality || result.availableQualities?.[0] || 'Source Quality';
        const resolvedL = result.language || result.availableLanguages?.[0] || 'Source Audio';
        lastInspectedUrlRef.current = target;

        setInspected(result);
        setSelectedQuality(resolvedQ);
        setSelectedLanguage(resolvedL);
        setTorrentSelection(result.torrentFiles || []);
      } catch {
        setInspectError('Inspection request failed. Check the link and try again.');
      } finally {
        setInspecting(false);
      }
    },
    [onNotify, onUrlInputChange, openYouTubePlaylistModal, urlInput]
  );

  const openOnlinePlayer = useCallback(
    (result: InspectResponse, chosenQuality?: string, chosenLanguage?: string) => {
      const q = chosenQuality || result.quality || result.availableQualities?.[0];
      const l = chosenLanguage || result.language || result.availableLanguages?.[0];
      const streamUrl = (q && result.variantUrls?.[q]) || result.url;
      const directResolved = (q && result.variantUrls?.[q]) || result.resolvedUrl || streamUrl;
      if (!/^https?:\/\//i.test(streamUrl)) {
        setInspectError('Direct online playback supports HTTP/HTTPS media links.');
        return;
      }
      setPlayerSession({
        mode: 'online',
        title: result.filename,
        url: streamUrl,
        resolvedUrl: directResolved,
        kind: result.kind === 'file' ? 'video' : result.kind,
        quality: q,
        language: l,
        sizeBytes: result.sizeBytes,
      });
    },
    []
  );

  const handlePlayOnlineInput = useCallback(async () => {
    if (inspected) {
      openOnlinePlayer(inspected, selectedQuality, selectedLanguage);
      return;
    }
    const raw = urlInput.trim();
    if (!raw) {
      pasteInputRef.current?.focus();
      return;
    }
    const lines = extractUrlsFromText(raw);
    const target = lines[0];
    if (!target || !/^https?:\/\//i.test(target)) {
      setInspectError('Online playback supports HTTP/HTTPS links.');
      return;
    }
    setInspectError(null);
    setStartingPlay(true);
    try {
      const res = await fetch('/api/inspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: target }),
      });
      const data = await res.json();
      if (!res.ok) {
        setInspectError(data.error || 'Could not prepare stream for playback.');
        return;
      }
      const result = data as InspectResponse;
      const resolvedQ = result.quality || result.availableQualities?.[0] || 'Source Quality';
      const resolvedL = result.language || result.availableLanguages?.[0] || 'Source Audio';
      lastInspectedUrlRef.current = target;
      setInspected(result);
      setSelectedQuality(resolvedQ);
      setSelectedLanguage(resolvedL);
      openOnlinePlayer(result, resolvedQ, resolvedL);
    } catch {
      setInspectError('Could not connect to stream. Check the link and try again.');
    } finally {
      setStartingPlay(false);
    }
  }, [inspected, openOnlinePlayer, selectedLanguage, selectedQuality, urlInput]);

  const handleDownloadOnlineSession = useCallback(
    (session: ActivePlayerSession) => {
      const existing = downloads.find(
        (d) =>
          d.url === session.url &&
          d.serverTransferId &&
          d.status !== 'error' &&
          d.status !== 'cancelled'
      );
      if (existing && existing.serverTransferId) {
        setPlayerSession({
          mode: 'transfer',
          transferId: existing.serverTransferId,
          title: existing.title,
          url: existing.url,
          kind: existing.kind,
          quality: existing.quality,
          language: existing.language,
          sizeBytes: existing.totalBytes,
        });
        onNotify('Already downloading in MochiDrop — switched to live local stream');
        return;
      }

      let domain = 'stream';
      try {
        domain = new URL(session.url).hostname;
      } catch {
        domain = 'stream';
      }

      onAddDownload({
        title: session.title,
        url: session.url,
        domain,
        kind: session.kind,
        protocol: session.url.toLowerCase().includes('.m3u8') ? 'HLS/DASH' : 'HTTPS',
        totalBytes: session.sizeBytes || 0,
        quality: session.quality,
        language: session.language,
        source: 'direct',
        resumable: true,
        parallelStreams: selectedStreams,
      });
      onNotify(`Downloading "${session.title}" with ${selectedStreams} streams`);
    },
    [downloads, onAddDownload, onNotify, selectedStreams]
  );

  // Automatic clipboard link detection on open & window focus
  const checkClipboardSilently = useCallback(async () => {
    if (!settings.autoDetectClipboard || batchMode) return;
    if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') return;
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text || text === lastAutoClipboardRef.current) return;
      const lines = extractUrlsFromText(text);
      if (lines.length === 0 || !isSafeTransferUrl(lines[0])) return;
      if (urlInput.trim() === text) return;
      lastAutoClipboardRef.current = text;
      if (lines.length > 1 && !lines.every((l) => isYouTubePlaylistUrl(l))) {
        setBatchMode(true);
      }
      onUrlInputChange(text);
      onNotify(
        lines.length > 1
          ? `Detected ${lines.length} copied links`
          : 'Link pasted automatically from clipboard'
      );
      void handleInspectInput(text);
    } catch {
      // Clipboard read may require permission or active focus; fail quietly
    }
  }, [batchMode, handleInspectInput, onNotify, onUrlInputChange, settings.autoDetectClipboard, urlInput]);

  useEffect(() => {
    if (!settings.autoDetectClipboard) return;
    const onFocus = () => {
      void checkClipboardSilently();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void checkClipboardSilently();
      }
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    void checkClipboardSilently();
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [checkClipboardSilently, settings.autoDetectClipboard]);

  async function handlePasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.trim()) {
        const cleaned = text.trim();
        lastAutoClipboardRef.current = cleaned;
        const lines = extractUrlsFromText(cleaned);
        if (lines.length > 1 && !lines.every((l) => isYouTubePlaylistUrl(l))) {
          setBatchMode(true);
        }
        onUrlInputChange(cleaned);
        void handleInspectInput(cleaned);
      } else {
        onNotify('Clipboard is empty');
      }
    } catch {
      pasteInputRef.current?.focus();
      onNotify('Press Ctrl+V / Cmd+V inside the link bar');
    }
  }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    if (file.name.toLowerCase().endsWith('.torrent')) {
      const baseName = file.name.replace(/\.torrent$/i, '');
      setBatchItems([]);
      setInspectError(null);
      setInspected({
        kind: 'torrent',
        protocol: 'TORRENT',
        url: `magnet:?xt=urn:btih:localtorrent&dn=${encodeURIComponent(baseName)}`,
        filename: baseName,
        domain: 'local.torrent',
        sizeBytes: Math.max(250 * 1024 * 1024, file.size * 8000),
        acceptRanges: true,
        contentType: 'application/x-bittorrent',
        verifiedLive: true,
        torrentFiles: [
          { id: 'lt-1', name: `${baseName}/Main_Content`, sizeMb: 680, selected: true },
          { id: 'lt-2', name: `${baseName}/Attachments`, sizeMb: 140, selected: true },
        ],
      });
      setTorrentSelection([
        { id: 'lt-1', name: `${baseName}/Main_Content`, sizeMb: 680, selected: true },
        { id: 'lt-2', name: `${baseName}/Attachments`, sizeMb: 140, selected: true },
      ]);
      onNotify(`Loaded ${file.name}`);
      return;
    }

    try {
      const text = await file.text();
      const urls = extractUrlsFromText(text).filter((u) => isSafeTransferUrl(u));
      if (urls.length === 0) {
        setInspectError('No valid download links found inside that file.');
        return;
      }
      setBatchMode(urls.length > 1);
      const joined = urls.slice(0, 25).join('\n');
      onUrlInputChange(joined);
      onNotify(`Loaded ${Math.min(urls.length, 25)} links from ${file.name}`);
      void handleInspectInput(joined);
    } catch {
      setInspectError('Could not read the selected file.');
    }
  }

  function handleConfirmInspectedDownload() {
    if (!inspected) return;

    let finalBytes = inspected.sizeBytes;
    let finalTorrentFiles: TorrentFileItem[] | undefined;

    if (inspected.kind === 'torrent' && torrentSelection.length > 0) {
      const chosen = torrentSelection.filter((f) => f.selected);
      if (chosen.length === 0) {
        setInspectError('Select at least one file in this torrent.');
        return;
      }
      finalBytes = chosen.reduce((acc, f) => acc + f.sizeMb * 1024 * 1024, 0);
      finalTorrentFiles = torrentSelection;
    }

    const finalUrl = inspected.variantUrls?.[selectedQuality] || inspected.url;
    const isAudioSelection = /audio|m4a|mp3/i.test(selectedQuality);

    onAddDownload({
      title: isAudioSelection
        ? inspected.filename.replace(/\.(mp4|mkv|webm)$/i, '.m4a')
        : inspected.filename,
      url: finalUrl,
      domain: inspected.domain,
      kind: isAudioSelection ? 'audio' : inspected.kind,
      protocol: inspected.protocol,
      totalBytes: finalBytes,
      quality:
        inspected.kind === 'video' || inspected.kind === 'audio'
          ? selectedQuality
          : undefined,
      language: inspected.kind === 'video' && !isAudioSelection ? selectedLanguage : undefined,
      availableLanguages: inspected.availableLanguages,
      availableQualities: inspected.availableQualities,
      variantUrls: inspected.variantUrls,
      source: inspected.kind === 'torrent' ? 'magnet' : 'direct',
      torrentFiles: finalTorrentFiles,
      resumable: inspected.acceptRanges,
      parallelStreams: selectedStreams,
    });

    setInspected(null);
    lastInspectedUrlRef.current = '';
    onUrlInputChange('');
  }

  function handleConfirmBatchDownload() {
    const selected = batchItems.filter((item) => item.selected);
    if (selected.length === 0) {
      setInspectError('Select at least one link to queue.');
      return;
    }

    const payloads: AddDownloadPayload[] = selected.map((item) => ({
      title: item.filename,
      url: item.url,
      domain: item.domain,
      kind: item.kind,
      protocol: item.protocol,
      totalBytes: item.sizeBytes,
      quality: item.quality,
      language: item.language,
      availableLanguages: item.availableLanguages,
      availableQualities: item.availableQualities,
      variantUrls: item.variantUrls,
      source: 'batch',
      torrentFiles: item.torrentFiles,
      resumable: item.acceptRanges,
      parallelStreams: selectedStreams,
    }));

    onEnqueueBatch(payloads);
    setBatchItems([]);
    onUrlInputChange('');
    setBatchMode(false);
  }

  async function handleCopyLink(item: DownloadItem) {
    try {
      await navigator.clipboard.writeText(item.url);
      setCopiedId(item.id);
      onNotify('Direct link copied');
      setTimeout(() => setCopiedId((prev) => (prev === item.id ? null : prev)), 1600);
    } catch {
      onNotify('Copy blocked by browser permissions');
    }
  }

  function getAdapterBarColor(adapterId: string): string {
    const found = adapters.find((a) => a.id === adapterId);
    if (!found) return 'bg-[#2FD48B]';
    switch (found.shade) {
      case 'solid':
        return 'bg-[#2FD48B]';
      case 'mid':
        return 'bg-[#38BDF8]';
      case 'soft':
        return 'bg-[#A3E635]';
      default:
        return 'bg-[#2DD4BF]';
    }
  }

  function renderKindIcon(kind: DownloadKind, sizeClass = 'h-4 w-4') {
    switch (kind) {
      case 'video':
        return <Film className={sizeClass} />;
      case 'audio':
        return <Music className={sizeClass} />;
      case 'archive':
        return <FileArchive className={sizeClass} />;
      case 'software':
        return <Package className={sizeClass} />;
      case 'document':
        return <FileText className={sizeClass} />;
      case 'image':
        return <ImageIcon className={sizeClass} />;
      case 'torrent':
        return <Magnet className={sizeClass} />;
      default:
        return <File className={sizeClass} />;
    }
  }

  function getProgressGradient(item: DownloadItem, pct: number): string {
    if (item.status === 'error') return 'bg-rose-500';
    if (item.status === 'paused' || item.status === 'cancelled') return 'bg-amber-400';
    if (item.status === 'completed' || pct >= 85) {
      return 'bg-gradient-to-r from-[#1A7A54] to-[#3BE098]';
    }
    return 'bg-gradient-to-r from-[#1A6B4D] via-[#26B87A] to-[#4ADE80]';
  }

  const isMinimalIdle = downloads.length === 0;

  return (
    <div className={isMinimalIdle ? 'min-h-[calc(100vh-8.5rem)] flex flex-col justify-center' : 'space-y-5'}>
      {/* Hidden universal file import input (.torrent / .txt / .m3u8) */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".torrent,.txt,.csv,.m3u,.m3u8"
        onChange={handleImportFile}
        className="hidden"
      />

      {/* UNIFIED MINIMALIST PASTE STAGE (Centered hero when idle; crisp top bar once downloads exist) */}
      <motion.section
        layout="position"
        transition={{ duration: 0.24, ease: EASE_STUDIO }}
        className={
          isMinimalIdle
            ? 'w-full max-w-2xl mx-auto space-y-5 py-6'
            : 'rounded-2xl border border-[#0F241B]/10 dark:border-white/[0.09] bg-white/65 dark:bg-white/[0.03] backdrop-blur-md p-3.5 space-y-3'
        }
      >
        {isMinimalIdle && (
          <div className="text-center space-y-2">
            <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-[#111B16] dark:text-white">
              Paste any link to begin
            </h1>
            <p className="text-xs sm:text-sm text-[#52655C] dark:text-[#8E9B95]">
              Copied links paste automatically — choose online playback or split up to 32 parallel streams.
            </p>
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleInspectInput();
          }}
          className={
            isMinimalIdle
              ? 'rounded-2xl border border-[#0F241B]/10 dark:border-white/[0.09] bg-white/65 dark:bg-white/[0.035] backdrop-blur-md p-3 shadow-[0_8px_32px_rgba(0,0,0,0.06)] dark:shadow-[0_12px_40px_rgba(0,0,0,0.4)] space-y-3'
              : 'space-y-2.5'
          }
        >
          {batchMode ? (
            <div className="space-y-2.5">
              <textarea
                rows={4}
                value={urlInput}
                onChange={(e) => {
                  onUrlInputChange(e.target.value);
                  if (inspectError) setInspectError(null);
                }}
                placeholder="Paste multiple links (one per line) — YouTube, playlists, video/audio tracks, cloud links, torrents, or direct files"
                className="w-full rounded-xl border border-[#0F241B]/12 dark:border-white/[0.1] bg-white/80 dark:bg-black/45 p-3 text-xs text-[#111B16] dark:text-white placeholder:text-[#768A80] dark:placeholder:text-[#66756E] font-mono resize-y focus:bg-white dark:focus:bg-black/60 focus:border-[#1B6B4D] dark:focus:border-[#2FD48B]/60 transition-colors"
              />
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setBatchMode(false)}
                  className="text-xs text-[#52655C] dark:text-[#8E9B95] hover:text-[#111B16] dark:hover:text-white cursor-pointer"
                >
                  ← Single link
                </button>
                <button
                  type="submit"
                  disabled={inspecting || !urlInput.trim()}
                  className="h-9 px-4 rounded-xl bg-[#1C6B4D] hover:bg-[#16593F] dark:bg-[#1A5E44]/90 dark:hover:bg-[#217455] border border-[#2FD48B]/35 text-white text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-45 transition-colors shadow-[0_0_20px_rgba(34,197,126,0.16)]"
                >
                  {inspecting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ArrowDownToLine className="h-3.5 w-3.5" />
                  )}
                  {inspecting ? 'Checking...' : 'Check All Links'}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
              <div className="relative flex-1">
                <Link2 className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-[#6B7E74] dark:text-[#6E7E77]" />
                <input
                  ref={pasteInputRef}
                  type="text"
                  value={urlInput}
                  onFocus={() => {
                    if (!urlInput.trim()) {
                      void checkClipboardSilently();
                    }
                  }}
                  onPaste={(e) => {
                    const pasted = e.clipboardData.getData('text').trim();
                    if (pasted) {
                      lastAutoClipboardRef.current = pasted;
                      const lines = extractUrlsFromText(pasted);
                      if (lines.length > 1 && !lines.every((l) => isYouTubePlaylistUrl(l))) {
                        setBatchMode(true);
                      }
                      if (lines.length > 0 && isSafeTransferUrl(lines[0])) {
                        setTimeout(() => void handleInspectInput(pasted), 0);
                      }
                    }
                  }}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val.includes('\n')) setBatchMode(true);
                    onUrlInputChange(val);
                    if (inspectError) setInspectError(null);
                  }}
                  placeholder="Paste any link (YouTube, playlist, audio track, video, cloud, torrent, direct)..."
                  className={`w-full ${
                    isMinimalIdle ? 'h-12 text-sm' : 'h-10 text-xs sm:text-sm'
                  } rounded-xl border border-[#0F241B]/12 dark:border-white/[0.1] bg-white/80 dark:bg-black/45 pl-10 pr-20 text-[#111B16] dark:text-white placeholder:text-[#768A80] dark:placeholder:text-[#66756E] font-mono focus:bg-white dark:focus:bg-black/60 focus:border-[#1B6B4D] dark:focus:border-[#2FD48B]/60 transition-colors`}
                />
                <button
                  type="button"
                  onClick={() => void handlePasteFromClipboard()}
                  className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 rounded-lg border border-[#0F241B]/12 dark:border-white/[0.1] bg-white/90 dark:bg-white/[0.06] px-2.5 py-1.5 text-[11px] font-medium text-[#22352C] dark:text-[#D5DFDA] hover:border-[#1B6B4D]/40 dark:hover:border-[#2FD48B]/40 transition-colors cursor-pointer"
                >
                  <Clipboard className="h-3 w-3" />
                  Paste
                </button>
              </div>

              <button
                type="submit"
                disabled={inspecting || !urlInput.trim()}
                className={`${
                  isMinimalIdle ? 'h-12 px-5' : 'h-10 px-4'
                } rounded-xl bg-[#1C6B4D] hover:bg-[#16593F] dark:bg-[#1A5E44]/90 dark:hover:bg-[#217455] border border-[#2FD48B]/35 text-white text-xs font-semibold shadow-[0_0_22px_rgba(34,197,126,0.18)] disabled:opacity-45 active:scale-[0.98] transition-all inline-flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer shrink-0`}
              >
                {inspecting ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Checking...
                  </>
                ) : (
                  <>
                    <ArrowDownToLine className="h-3.5 w-3.5" />
                    Continue
                  </>
                )}
              </button>
            </div>
          )}

          {/* Quiet micro-actions row (zero clutter, zero duplicate modals) */}
          <div className="flex flex-wrap items-center justify-between gap-2 px-0.5 text-[11px] text-[#52655C] dark:text-[#8A9891]">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <button
                type="button"
                onClick={() => openYouTubePlaylistModal('')}
                className="inline-flex items-center gap-1 text-[#156E4B] dark:text-[#3BE098] hover:underline font-medium cursor-pointer"
              >
                <ListVideo className="h-3.5 w-3.5" />
                YouTube Playlist
              </button>
              <span className="text-[#B8C4BE] dark:text-white/20" aria-hidden="true">
                ·
              </span>
              <button
                type="button"
                onClick={() => setBatchMode((b) => !b)}
                className="inline-flex items-center gap-1 hover:text-[#156E4B] dark:hover:text-[#3BE098] font-medium cursor-pointer transition-colors"
              >
                <ListPlus className="h-3.5 w-3.5" />
                {batchMode ? 'Single Link' : 'Multiple Links'}
              </button>
              <span className="text-[#B8C4BE] dark:text-white/20" aria-hidden="true">
                ·
              </span>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-1 hover:text-[#156E4B] dark:hover:text-[#3BE098] font-medium cursor-pointer transition-colors"
              >
                <Upload className="h-3.5 w-3.5" />
                Import .torrent / .txt
              </button>
            </div>

            {isMinimalIdle && (
              <span className="hidden sm:inline font-mono text-[10px] text-[#687B72] dark:text-[#6E7C76]">
                Auto-paste active
              </span>
            )}
          </div>

          {inspectError && (
            <p className="text-xs font-medium text-rose-600 dark:text-rose-400 flex items-center gap-1.5 pt-0.5">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              <span>{inspectError}</span>
            </p>
          )}
        </form>

        {/* STEP 2 (PROGRESSIVE): Inspected Link Action Panel — Play Online + 4 / 8 / 16 / 32 Stream Selector */}
        <AnimatePresence>
          {inspected && (
            <motion.div
              key="progressive-inspector"
              initial={{ opacity: 0, y: 8, scale: 0.99 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.99 }}
              transition={{ duration: 0.2, ease: EASE_STUDIO }}
              className="rounded-2xl border border-[#1C6B4D]/25 dark:border-[#2FD48B]/28 bg-white/75 dark:bg-[#0B1712]/70 backdrop-blur-xl p-4 shadow-[0_12px_36px_rgba(0,0,0,0.08)] dark:shadow-[0_14px_40px_rgba(0,0,0,0.45)] space-y-4"
            >
              {/* Detected file header */}
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3 min-w-0">
                  <div
                    className={`h-10 w-10 shrink-0 rounded-xl flex items-center justify-center ${getKindTileStyle(
                      inspected.kind
                    )}`}
                  >
                    {renderKindIcon(inspected.kind, 'h-5 w-5')}
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-[#111B16] dark:text-white truncate">
                      {inspected.filename}
                    </h3>
                    <p className="text-[11px] font-mono text-[#52655C] dark:text-[#8A9891] truncate mt-0.5">
                      {inspected.protocol} · {inspected.domain} ·{' '}
                      {inspected.streamType === 'hls' && inspected.hlsSegmentCount
                        ? `${inspected.hlsSegmentCount} HLS segments`
                        : inspected.sizeBytes > 0
                        ? formatBytes(inspected.sizeBytes)
                        : 'Size resolved on start'}
                    </p>
                    {inspected.probeError && (
                      <p className="mt-1 text-xs text-rose-600 dark:text-rose-400 flex items-center gap-1">
                        <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                        <span>{inspected.probeError}</span>
                      </p>
                    )}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    setInspected(null);
                    lastInspectedUrlRef.current = '';
                  }}
                  aria-label="Dismiss detected link"
                  className="p-1.5 rounded-lg text-[#687B72] hover:text-[#111B16] dark:hover:text-white hover:bg-black/[0.05] dark:hover:bg-white/[0.08] cursor-pointer"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {/* Quality & Audio Selectors (only when video has choices) */}
              {inspected.kind === 'video' &&
                ((inspected.availableQualities?.length ?? 0) > 1 ||
                  (inspected.availableLanguages?.length ?? 0) > 1) && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {(inspected.availableQualities?.length ?? 0) > 1 && (
                      <label className="space-y-1">
                        <span className="text-[11px] font-medium text-[#52655C] dark:text-[#8E9B95]">
                          Resolution / Format
                        </span>
                        <select
                          value={selectedQuality}
                          onChange={(e) => setSelectedQuality(e.target.value)}
                          className="w-full h-9 rounded-xl border border-[#0F241B]/12 dark:border-white/[0.1] bg-white/80 dark:bg-[#0B120F] px-2.5 text-xs text-[#111B16] dark:text-white"
                        >
                          {inspected.availableQualities!.map((q) => (
                            <option key={q} value={q}>
                              {q}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}

                    {(inspected.availableLanguages?.length ?? 0) > 1 && (
                      <label className="space-y-1">
                        <span className="text-[11px] font-medium text-[#52655C] dark:text-[#8E9B95]">
                          Audio Language
                        </span>
                        <select
                          value={selectedLanguage}
                          onChange={(e) => setSelectedLanguage(e.target.value)}
                          className="w-full h-9 rounded-xl border border-[#0F241B]/12 dark:border-white/[0.1] bg-white/80 dark:bg-[#0B120F] px-2.5 text-xs text-[#111B16] dark:text-white"
                        >
                          {inspected.availableLanguages!.map((lang) => (
                            <option key={lang} value={lang}>
                              {lang}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </div>
                )}

              {/* Torrent File Picker (only for .torrent files) */}
              {inspected.kind === 'torrent' && torrentSelection.length > 0 && (
                <div className="divide-y divide-[#0F241B]/8 dark:divide-white/[0.07] border border-[#0F241B]/10 dark:border-white/[0.09] rounded-xl max-h-36 overflow-y-auto bg-white/50 dark:bg-black/30">
                  {torrentSelection.map((tf) => (
                    <label
                      key={tf.id}
                      className="flex items-center justify-between gap-2 px-3 py-2 text-xs cursor-pointer hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <input
                          type="checkbox"
                          checked={tf.selected}
                          onChange={() =>
                            setTorrentSelection((prev) =>
                              prev.map((item) =>
                                item.id === tf.id ? { ...item, selected: !item.selected } : item
                              )
                            )
                          }
                          className="h-3.5 w-3.5 accent-[#2FD48B]"
                        />
                        <span className="truncate font-mono text-[#111B16] dark:text-white">
                          {tf.name}
                        </span>
                      </span>
                      <span className="font-mono tabular-nums text-[#64786E] dark:text-[#7E8E87] shrink-0">
                        {tf.sizeMb} MB
                      </span>
                    </label>
                  ))}
                </div>
              )}

              {/* STREAM SEGMENTATION PICKER (4 / 8 / 16 / 32 parallel streams) */}
              <div className="rounded-xl border border-[#0F241B]/10 dark:border-white/[0.08] bg-white/55 dark:bg-black/35 p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="space-y-0.5">
                  <div className="text-xs font-semibold text-[#111B16] dark:text-white inline-flex items-center gap-1.5">
                    <Zap className="h-3.5 w-3.5 text-[#156E4B] dark:text-[#3BE098]" />
                    <span>Parallel Download Streams</span>
                  </div>
                  <p className="text-[11px] text-[#52655C] dark:text-[#8A9891]">
                    Slices this file into {selectedStreams} parallel streams across your active networks (32-box map).
                  </p>
                </div>

                <div
                  role="group"
                  aria-label="Choose number of parallel streams"
                  className="grid grid-cols-4 gap-1.5 shrink-0"
                >
                  {STREAM_COUNT_OPTIONS.map((count) => {
                    const active = selectedStreams === count;
                    return (
                      <button
                        key={count}
                        type="button"
                        onClick={() => handleSelectStreams(count)}
                        className={`h-9 min-w-[3.4rem] px-2.5 rounded-lg border font-mono text-xs font-semibold tabular-nums transition-all cursor-pointer ${
                          active
                            ? 'bg-[#E2F5EC] border-[#1C6B4D]/35 text-[#126646] dark:bg-[#0F2B20]/90 dark:border-[#2FD48B]/45 dark:text-[#3BE098]'
                            : 'bg-white/75 dark:bg-white/[0.04] border-[#0F241B]/12 dark:border-white/[0.1] text-[#354B41] dark:text-[#C5D1CB] hover:border-[#1B6B4D]/40 dark:hover:border-[#2FD48B]/35'
                        }`}
                      >
                        {count}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Primary Actions: Play Online | VLC | Download (N Streams) */}
              <div className="flex flex-wrap items-center justify-between gap-2.5 pt-1">
                <div className="flex flex-wrap items-center gap-2">
                  {/^https?:\/\//i.test(inspected.variantUrls?.[selectedQuality] || inspected.url) && (
                    <>
                      <motion.button
                        whileTap={{ scale: 0.97 }}
                        type="button"
                        disabled={startingPlay}
                        onClick={() => void handlePlayOnlineInput()}
                        className="h-10 px-4 rounded-xl bg-[#E2F5EC] hover:bg-[#CBEEDB] text-[#115E41] dark:bg-[#0F2B20]/85 dark:hover:bg-[#14392B] dark:text-[#3BE098] border border-[#1C6B4D]/25 dark:border-[#2FD48B]/35 text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer transition-colors"
                      >
                        <Play className="h-3.5 w-3.5 fill-current" />
                        Play Online
                      </motion.button>
                      <a
                        href={`/api/play/playlist.xspf?url=${encodeURIComponent(
                          inspected.variantUrls?.[selectedQuality] ||
                            inspected.resolvedUrl ||
                            inspected.url
                        )}&title=${encodeURIComponent(inspected.filename)}`}
                        download
                        onClick={() =>
                          onNotify('Downloaded VLC Playlist (.xspf) — double-click to stream in VLC')
                        }
                        className="h-10 px-3 rounded-xl border border-[#0F241B]/12 dark:border-white/[0.1] bg-white/75 dark:bg-white/[0.04] text-xs font-medium text-[#22352C] dark:text-[#DCE6E1] hover:border-[#1B6B4D]/40 dark:hover:border-[#2FD48B]/35 inline-flex items-center gap-1.5 whitespace-nowrap transition-colors"
                      >
                        <MonitorPlay className="h-3.5 w-3.5 text-amber-500" />
                        VLC
                      </a>
                    </>
                  )}
                </div>

                <motion.button
                  whileTap={{ scale: 0.97 }}
                  type="button"
                  onClick={handleConfirmInspectedDownload}
                  className="h-10 px-5 rounded-xl bg-[#1C6B4D] hover:bg-[#16593F] dark:bg-[#1A5E44]/90 dark:hover:bg-[#217455] border border-[#2FD48B]/40 text-white text-xs font-semibold shadow-[0_0_24px_rgba(34,197,126,0.2)] inline-flex items-center gap-2 whitespace-nowrap cursor-pointer transition-colors"
                >
                  <Download className="h-3.5 w-3.5" />
                  <span>Download ({selectedStreams} Streams)</span>
                </motion.button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Multi-Link Batch Inspector */}
        <AnimatePresence>
          {batchItems.length > 0 && (
            <motion.div
              key="batch-inspector"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18, ease: EASE_STUDIO }}
              className="rounded-2xl border border-[#1C6B4D]/25 dark:border-[#2FD48B]/28 bg-white/75 dark:bg-[#0B1712]/70 backdrop-blur-xl p-4 space-y-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-xs font-semibold text-[#111B16] dark:text-white">
                  Batch Queue Ready ({batchItems.filter((b) => b.selected).length}/{batchItems.length} selected)
                </h3>
                <div className="flex items-center gap-2">
                  <div className="inline-flex items-center gap-1 text-[11px] text-[#52655C] dark:text-[#8E9B95]">
                    <span>Streams:</span>
                    {STREAM_COUNT_OPTIONS.map((count) => (
                      <button
                        key={count}
                        type="button"
                        onClick={() => handleSelectStreams(count)}
                        className={`h-6 px-2 rounded-md font-mono text-[11px] font-semibold cursor-pointer border ${
                          selectedStreams === count
                            ? 'bg-[#E2F5EC] border-[#1C6B4D]/30 text-[#126646] dark:bg-[#0F2B20] dark:border-[#2FD48B]/40 dark:text-[#3BE098]'
                            : 'bg-white/70 dark:bg-white/[0.04] border-transparent text-[#4D6157] dark:text-[#96A39D]'
                        }`}
                      >
                        {count}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => setBatchItems([])}
                    aria-label="Close batch preview"
                    className="p-1 text-[#687B72] hover:text-[#111B16] dark:hover:text-white cursor-pointer"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>

              <div className="divide-y divide-[#0F241B]/8 dark:divide-white/[0.07] border border-[#0F241B]/10 dark:border-white/[0.09] bg-white/60 dark:bg-black/35 rounded-xl max-h-56 overflow-y-auto">
                {batchItems.map((b, idx) => (
                  <label
                    key={`${b.url}-${idx}`}
                    className="flex items-center justify-between gap-3 px-3 py-2 text-xs cursor-pointer hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                  >
                    <span className="flex items-center gap-2.5 min-w-0">
                      <input
                        type="checkbox"
                        checked={b.selected}
                        onChange={() =>
                          setBatchItems((prev) =>
                            prev.map((item, i) =>
                              i === idx ? { ...item, selected: !item.selected } : item
                            )
                          )
                        }
                        className="h-3.5 w-3.5 accent-[#2FD48B]"
                      />
                      <span
                        className={`h-6 w-6 rounded-md flex items-center justify-center shrink-0 ${getKindTileStyle(
                          b.kind
                        )}`}
                      >
                        {renderKindIcon(b.kind, 'h-3.5 w-3.5')}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-[#111B16] dark:text-white">
                          {b.filename}
                        </span>
                        <span className="block truncate font-mono text-[11px] text-[#64786E] dark:text-[#7E8E87]">
                          {b.protocol} · {b.domain}
                        </span>
                      </span>
                    </span>
                    <span className="font-mono tabular-nums text-[#52655C] dark:text-[#8E9B95] shrink-0">
                      {formatBytes(b.sizeBytes)}
                    </span>
                  </label>
                ))}
              </div>

              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={handleConfirmBatchDownload}
                  className="h-9 px-4 rounded-xl bg-[#1C6B4D] hover:bg-[#16593F] dark:bg-[#1A5E44]/90 dark:hover:bg-[#217455] border border-[#2FD48B]/35 text-white text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer shadow-[0_0_20px_rgba(34,197,126,0.16)]"
                >
                  <Download className="h-3.5 w-3.5" />
                  Queue {batchItems.filter((b) => b.selected).length} Files ({selectedStreams} Streams)
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.section>

      {/* STEP 3 (PROGRESSIVE — REVEALS ONLY AFTER DOWNLOADS EXIST): Network Bonding Visualizer + Queue Controls + 32-Box Cards */}
      {downloads.length > 0 && (
        <>
          {/* Animated Multi-Network Speed Bonding Diagram */}
          <div className="space-y-2">
            {showNetworkBond ? (
              <NetworkBondingVisualizer
                adapters={adapters}
                totalBytesPerSec={liveAggregateBytesPerSec}
                activeStreams={activeStreamsSum}
                isDownloading={activeQueueCount > 0}
                onToggleAdapter={onToggleAdapter}
                onOpenNetworksView={onOpenNetworksView}
                onHide={() => setShowNetworkBond(false)}
                compact
              />
            ) : (
              <button
                type="button"
                onClick={() => setShowNetworkBond(true)}
                className="w-full px-4 py-2 rounded-xl border border-[#0F241B]/10 dark:border-white/[0.09] bg-white/65 dark:bg-white/[0.03] backdrop-blur-md hover:border-[#1B6B4D]/40 dark:hover:border-[#2FD48B]/35 flex items-center justify-between text-xs text-[#4D6157] dark:text-[#96A39D] cursor-pointer transition-colors"
              >
                <span className="inline-flex items-center gap-2 font-medium">
                  <Network className="h-3.5 w-3.5 text-[#156E4B] dark:text-[#3BE098]" />
                  <span>
                    {adapters.filter((a) => a.connected && a.enabled).length}{' '}
                    {adapters.filter((a) => a.connected && a.enabled).length === 1
                      ? 'Network Active'
                      : 'Networks Bonded'}{' '}
                    →{' '}
                    <strong className="font-mono text-[#126646] dark:text-[#3BE098]">
                      {formatSpeedMBps(liveAggregateBytesPerSec)}
                    </strong>
                  </span>
                </span>
                <span className="inline-flex items-center gap-1 text-[11px]">
                  Show Live Bonding
                  <ChevronDown className="h-3.5 w-3.5" />
                </span>
              </button>
            )}
          </div>

          {/* Minimal Queue Header: Category + Search + At-a-Time (1–5) + Playback Controls */}
          <div className="flex flex-wrap items-center justify-between gap-2.5 text-xs text-[#52655C] dark:text-[#8A9891] px-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-display text-sm font-semibold text-[#111B16] dark:text-white">
                {CATEGORY_LABELS[categoryFilter]}
              </h2>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">
                {filteredDownloads.length} {filteredDownloads.length === 1 ? 'file' : 'files'}
              </span>
              {(activeQueueCount > 0 || waitingQueueCount > 0) && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums text-[#156E4B] dark:text-[#3BE098]">
                    {activeQueueCount} active
                    {waitingQueueCount > 0 ? ` · ${waitingQueueCount} queued` : ''}
                  </span>
                </>
              )}
              {categoryFilter !== 'all' && (
                <button
                  type="button"
                  onClick={() => onCategoryChange('all')}
                  className="ml-1 text-[#156E4B] dark:text-[#3BE098] hover:underline font-medium cursor-pointer"
                >
                  Show All
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {/* Live Simultaneous Downloads (1..5 at a time) */}
              <div className="flex items-center gap-1.5">
                <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[#4D6157] dark:text-[#8E9B95]">
                  <Layers className="h-3.5 w-3.5 text-[#156E4B] dark:text-[#3BE098]" />
                  <span>At a time:</span>
                </span>
                <div
                  role="group"
                  aria-label="Simultaneous downloads at a time"
                  className="inline-flex items-center p-0.5 rounded-lg bg-white/65 dark:bg-white/[0.04] border border-[#0F241B]/12 dark:border-white/[0.09] backdrop-blur-sm"
                >
                  {CONCURRENT_SLOTS.map((slot) => {
                    const isSelected = settings.maxConcurrentDownloads === slot;
                    return (
                      <button
                        key={slot}
                        type="button"
                        onClick={() => onChangeConcurrent(slot)}
                        title={`Download ${slot} ${slot === 1 ? 'file' : 'files'} at a time`}
                        className={`h-6 w-6 rounded-md font-mono text-[11px] font-semibold tabular-nums transition-colors cursor-pointer ${
                          isSelected
                            ? 'bg-[#E2F5EC] text-[#126646] dark:bg-[#0F2B20] dark:text-[#3BE098] border border-[#1C6B4D]/25 dark:border-[#2FD48B]/35'
                            : 'text-[#52655C] dark:text-[#8E9B95] hover:text-[#111B16] dark:hover:text-white'
                        }`}
                      >
                        {slot}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Queue Bulk Actions */}
              <div className="inline-flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={onResumeAll}
                  title="Resume all paused downloads"
                  aria-label="Resume all"
                  className="h-7 w-7 rounded-lg text-[#4D6157] dark:text-[#8E9B95] hover:text-[#156E4B] dark:hover:text-[#3BE098] hover:bg-black/[0.04] dark:hover:bg-white/[0.06] inline-flex items-center justify-center cursor-pointer"
                >
                  <Play className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={onPauseAll}
                  title="Pause all active downloads"
                  aria-label="Pause all"
                  className="h-7 w-7 rounded-lg text-[#4D6157] dark:text-[#8E9B95] hover:text-[#156E4B] dark:hover:text-[#3BE098] hover:bg-black/[0.04] dark:hover:bg-white/[0.06] inline-flex items-center justify-center cursor-pointer"
                >
                  <Pause className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={onClearCompleted}
                  title="Clear completed downloads"
                  aria-label="Clear completed"
                  className="h-7 w-7 rounded-lg text-[#4D6157] dark:text-[#8E9B95] hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-500/10 inline-flex items-center justify-center cursor-pointer"
                >
                  <CheckCheck className="h-3.5 w-3.5" />
                </button>
              </div>

              {/* Card / Compact View Toggle */}
              <div className="inline-flex items-center p-0.5 rounded-lg bg-white/65 dark:bg-white/[0.04] border border-[#0F241B]/12 dark:border-white/[0.09] backdrop-blur-sm">
                <button
                  type="button"
                  onClick={() => setViewMode('cards')}
                  aria-label="Card view"
                  className={`h-6 w-6 rounded-md inline-flex items-center justify-center cursor-pointer ${
                    viewMode === 'cards'
                      ? 'bg-[#E2F5EC] dark:bg-[#0F2B20] text-[#126646] dark:text-[#3BE098]'
                      : 'text-[#64786E] dark:text-[#8E9B95]'
                  }`}
                >
                  <LayoutList className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('compact')}
                  aria-label="Compact list view"
                  className={`h-6 w-6 rounded-md inline-flex items-center justify-center cursor-pointer ${
                    viewMode === 'compact'
                      ? 'bg-[#E2F5EC] dark:bg-[#0F2B20] text-[#126646] dark:text-[#3BE098]'
                      : 'text-[#64786E] dark:text-[#8E9B95]'
                  }`}
                >
                  <List className="h-3.5 w-3.5" />
                </button>
              </div>

              {/* Search Filter (appears only when 2+ downloads exist) */}
              {downloads.length >= 2 && (
                <div className="relative w-44">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[#687B72] dark:text-[#76857E]" />
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Filter downloads..."
                    className="w-full h-7 rounded-lg border border-[#0F241B]/12 dark:border-white/[0.1] bg-white/70 dark:bg-black/40 pl-7 pr-2.5 text-xs text-[#111B16] dark:text-white placeholder:text-[#768A80] dark:placeholder:text-[#66756E]"
                  />
                </div>
              )}
            </div>
          </div>

          {/* Transfer Cards with Live 32-Stream Segment Boxes + Animated Progress Bob */}
          {filteredDownloads.length === 0 ? (
            <div className="rounded-2xl border border-[#0F241B]/10 dark:border-white/[0.09] bg-white/65 dark:bg-white/[0.03] backdrop-blur-md p-10 text-center space-y-2.5">
              <p className="text-sm font-semibold text-[#111B16] dark:text-white">
                No files match this filter
              </p>
              <button
                type="button"
                onClick={() => {
                  onCategoryChange('all');
                  setSearch('');
                }}
                className="h-8 px-3.5 rounded-xl bg-[#1C6B4D] hover:bg-[#16593F] dark:bg-[#1A5E44]/90 dark:hover:bg-[#217455] border border-[#2FD48B]/35 text-white text-xs font-semibold cursor-pointer"
              >
                Show All Downloads
              </button>
            </div>
          ) : (
            <div
              className={
                viewMode === 'cards'
                  ? 'space-y-3'
                  : 'rounded-2xl border border-[#0F241B]/10 dark:border-white/[0.09] divide-y divide-[#0F241B]/8 dark:divide-white/[0.07] bg-white/65 dark:bg-white/[0.03] backdrop-blur-md'
              }
            >
              {filteredDownloads.map((item, index) => {
                const pct = item.totalBytes
                  ? Math.min(100, (item.downloadedBytes / item.totalBytes) * 100)
                  : item.status === 'completed'
                  ? 100
                  : 0;
                const remainingBytes = Math.max(0, item.totalBytes - item.downloadedBytes);
                const isExpanded = expandedId === item.id;
                const isMenuOpen = contextMenuId === item.id;
                const isActiveDownload =
                  item.status === 'downloading' || item.status === 'connecting';

                // Live 32-stream boxes stats
                const boxes = item.chunks.length > 0 ? item.chunks : [];
                const totalBoxes = boxes.length || 32;
                const filledBoxes =
                  item.status === 'completed'
                    ? totalBoxes
                    : boxes.filter((c) => c.progress >= 100).length;
                const activeBoxes = boxes.filter((c) => c.progress > 0 && c.progress < 100).length;

                const canPlayInApp =
                  Boolean(item.serverTransferId) &&
                  !item.directOnly &&
                  (item.status === 'connecting' ||
                    item.status === 'downloading' ||
                    item.status === 'paused' ||
                    item.status === 'completed') &&
                  (item.kind === 'video' ||
                    item.kind === 'audio' ||
                    item.kind === 'image' ||
                    item.kind === 'document' ||
                    item.kind === 'file');

                const canStreamVlc =
                  Boolean(item.serverTransferId) &&
                  !item.directOnly &&
                  (item.kind === 'video' || item.kind === 'audio' || item.kind === 'file') &&
                  (item.status === 'connecting' ||
                    item.status === 'downloading' ||
                    item.status === 'paused' ||
                    item.status === 'completed');

                const clampedBarPct = Math.max(
                  item.status === 'connecting' ? 6 : 0,
                  Math.min(100, pct)
                );

                return (
                  <motion.article
                    key={item.id}
                    layout="position"
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setContextMenuId(isMenuOpen ? null : item.id);
                    }}
                    className={`relative transition-colors ${
                      viewMode === 'cards'
                        ? `rounded-2xl border backdrop-blur-md ${
                            isActiveDownload
                              ? 'bg-[#EAF7F1]/80 border-[#1C6B4D]/25 dark:bg-[#0D211A]/55 dark:border-[#2FD48B]/30'
                              : 'bg-white/65 border-[#0F241B]/10 hover:border-[#1B6B4D]/30 dark:bg-white/[0.03] dark:border-white/[0.08] dark:hover:border-white/[0.16]'
                          }`
                        : 'bg-transparent hover:bg-black/[0.025] dark:hover:bg-white/[0.035]'
                    }`}
                  >
                    <div
                      className={
                        viewMode === 'cards'
                          ? 'p-4 space-y-3'
                          : 'px-4 py-3 flex items-center gap-3.5'
                      }
                    >
                      {/* Top Row: Icon/Thumb + Title/Meta + Percentage + Action Strip */}
                      <div
                        className={
                          viewMode === 'cards'
                            ? 'flex items-center gap-3.5'
                            : 'flex-1 flex items-center gap-3.5 min-w-0'
                        }
                      >
                        {viewMode === 'cards' &&
                        item.thumbnailUrl &&
                        /^https?:\/\//i.test(item.thumbnailUrl) &&
                        !failedCardThumbs.has(item.id) ? (
                          <div className="h-11 w-16 rounded-xl overflow-hidden shrink-0 bg-black/10 dark:bg-white/[0.05] border border-[#0F241B]/10 dark:border-white/[0.1]">
                            <img
                              src={item.thumbnailUrl}
                              alt=""
                              loading="lazy"
                              referrerPolicy="no-referrer"
                              onError={() =>
                                setFailedCardThumbs((prev) => new Set(prev).add(item.id))
                              }
                              className="h-full w-full object-cover"
                            />
                          </div>
                        ) : (
                          <div
                            className={`${
                              viewMode === 'cards' ? 'h-11 w-11 rounded-xl' : 'h-8 w-8 rounded-lg'
                            } shrink-0 flex items-center justify-center ${getKindTileStyle(
                              item.kind
                            )}`}
                          >
                            {renderKindIcon(item.kind, viewMode === 'cards' ? 'h-5 w-5' : 'h-4 w-4')}
                          </div>
                        )}

                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <button
                              type="button"
                              onClick={() => setExpandedId(isExpanded ? null : item.id)}
                              className="text-left text-xs sm:text-sm font-semibold text-[#111B16] dark:text-white hover:text-[#156E4B] dark:hover:text-[#3BE098] truncate block max-w-full cursor-pointer transition-colors"
                            >
                              {item.title}
                            </button>
                            <span className="font-mono text-xs sm:text-sm font-bold tabular-nums text-[#126646] dark:text-[#3BE098] shrink-0">
                              {item.totalBytes > 0
                                ? `${pct.toFixed(1)}%`
                                : item.status === 'completed'
                                ? '100%'
                                : item.status === 'connecting'
                                ? '...'
                                : '0.0%'}
                            </span>
                          </div>

                          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-[#52655C] dark:text-[#8A9891]">
                            <span className="truncate max-w-[200px]">
                              {item.playlistTitle ? item.playlistTitle : item.domain}
                            </span>
                            {item.durationText && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="font-mono tabular-nums">{item.durationText}</span>
                              </>
                            )}
                            {item.quality &&
                              item.quality !== 'Source Quality' &&
                              item.quality !== 'Original' && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span className="font-mono">{item.quality}</span>
                                </>
                              )}
                            {item.language &&
                              item.language !== 'Source Audio' &&
                              item.language !== 'Original Audio' && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span>{item.language}</span>
                                </>
                              )}
                            <span aria-hidden="true">·</span>
                            <span className="font-mono tabular-nums">
                              {item.parallelStreams} streams
                            </span>
                          </div>
                        </div>

                        {/* Right Action Strip */}
                        <div className="flex items-center gap-1.5 shrink-0">
                          {canPlayInApp && (
                            <button
                              type="button"
                              onClick={() =>
                                setPlayerSession({
                                  mode: 'transfer',
                                  transferId: item.serverTransferId,
                                  title: item.title,
                                  url: item.url,
                                  kind: item.kind,
                                  quality: item.quality,
                                  language: item.language,
                                  sizeBytes: item.totalBytes || item.downloadedBytes,
                                })
                              }
                              title="Play inside MochiDrop"
                              className="h-8 px-2.5 rounded-lg bg-[#1C6B4D] hover:bg-[#16593F] dark:bg-[#1A5E44]/90 dark:hover:bg-[#217455] border border-[#2FD48B]/35 text-white text-xs font-semibold inline-flex items-center gap-1 whitespace-nowrap cursor-pointer transition-colors"
                            >
                              {item.kind === 'video' ||
                              item.kind === 'audio' ||
                              item.kind === 'file' ? (
                                <>
                                  <Play className="h-3 w-3 fill-current" />
                                  <span className="hidden sm:inline">Play</span>
                                </>
                              ) : (
                                <>
                                  <Eye className="h-3 w-3" />
                                  <span className="hidden sm:inline">Open</span>
                                </>
                              )}
                            </button>
                          )}

                          {canStreamVlc && (
                            <a
                              href={`/api/transfers/${encodeURIComponent(
                                item.serverTransferId!
                              )}/playlist.xspf`}
                              download
                              onClick={() =>
                                onNotify('Downloaded VLC Playlist (.xspf) — double-click to stream in VLC')
                              }
                              title="Stream continuously in VLC"
                              className="h-8 px-2.5 rounded-lg border border-[#0F241B]/12 dark:border-white/[0.1] bg-white/75 dark:bg-white/[0.04] text-xs font-medium text-[#22352C] dark:text-[#DCE6E1] hover:border-[#1B6B4D]/40 dark:hover:border-[#2FD48B]/35 inline-flex items-center gap-1 whitespace-nowrap transition-colors"
                            >
                              <MonitorPlay className="h-3.5 w-3.5 text-amber-500" />
                              <span className="hidden md:inline">VLC</span>
                            </a>
                          )}

                          {(item.status === 'downloading' ||
                            item.status === 'connecting' ||
                            item.status === 'paused') &&
                            !item.directOnly && (
                              <button
                                type="button"
                                onClick={() => onTogglePause(item.id)}
                                title={item.status === 'paused' ? 'Resume' : 'Pause'}
                                aria-label={item.status === 'paused' ? 'Resume' : 'Pause'}
                                className="h-8 w-8 rounded-lg border border-[#0F241B]/12 dark:border-white/[0.1] bg-white/75 dark:bg-white/[0.04] text-[#354B41] dark:text-[#C5D1CB] hover:text-[#156E4B] dark:hover:text-[#3BE098] inline-flex items-center justify-center cursor-pointer transition-colors"
                              >
                                {item.status === 'paused' ? (
                                  <Play className="h-3.5 w-3.5" />
                                ) : (
                                  <Pause className="h-3.5 w-3.5" />
                                )}
                              </button>
                            )}

                          {item.status === 'queued' && !item.directOnly && (
                            <button
                              type="button"
                              onClick={() => onStartQueuedNow(item.id)}
                              title="Start now"
                              className="h-8 px-2.5 rounded-lg border border-[#1C6B4D]/30 dark:border-[#2FD48B]/35 bg-[#E2F5EC] dark:bg-[#0F2B20]/85 text-[#126646] dark:text-[#3BE098] text-xs font-semibold inline-flex items-center gap-1 whitespace-nowrap cursor-pointer"
                            >
                              <Play className="h-3 w-3 fill-current" />
                              <span className="hidden sm:inline">Start Now</span>
                            </button>
                          )}

                          {(item.status === 'error' || item.status === 'cancelled') &&
                            !item.directOnly && (
                              <button
                                type="button"
                                onClick={() => onRetryTransfer(item)}
                                title="Retry download"
                                className="h-8 px-2.5 rounded-lg bg-[#1C6B4D] hover:bg-[#16593F] dark:bg-[#1A5E44]/90 dark:hover:bg-[#217455] border border-[#2FD48B]/35 text-white text-xs font-semibold inline-flex items-center gap-1 cursor-pointer"
                              >
                                <RotateCcw className="h-3 w-3" />
                                <span className="hidden sm:inline">Retry</span>
                              </button>
                            )}

                          {item.directOnly && (
                            <a
                              href={item.url}
                              rel="noopener noreferrer"
                              className="h-8 px-2.5 rounded-lg bg-[#1C6B4D] hover:bg-[#16593F] dark:bg-[#1A5E44]/90 dark:hover:bg-[#217455] border border-[#2FD48B]/35 text-white text-xs font-semibold inline-flex items-center gap-1 whitespace-nowrap"
                            >
                              <ExternalLink className="h-3 w-3" />
                              Open
                            </a>
                          )}

                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setContextMenuId(isMenuOpen ? null : item.id);
                            }}
                            aria-label="More actions"
                            className={`h-8 w-8 rounded-lg inline-flex items-center justify-center cursor-pointer transition-colors ${
                              isMenuOpen
                                ? 'bg-[#E2F5EC] text-[#126646] dark:bg-[#0F2B20] dark:text-[#3BE098]'
                                : 'text-[#52655C] dark:text-[#8E9B95] hover:text-[#111B16] dark:hover:text-white hover:bg-black/[0.05] dark:hover:bg-white/[0.06]'
                            }`}
                          >
                            <MoreVertical className="h-4 w-4" />
                          </button>
                        </div>
                      </div>

                      {/* Progress Bar with Glowing Animated Bob + Always-Visible 32-Stream Segment Boxes (Card Mode) */}
                      {viewMode === 'cards' && (
                        <div className="space-y-2.5">
                          {/* Progress Bar + Glowing Leading Bob */}
                          <div className="relative py-1">
                            <div className="h-2 w-full rounded-full bg-black/[0.08] dark:bg-white/[0.08] overflow-hidden">
                              <div
                                style={{ width: `${clampedBarPct}%` }}
                                className={`h-full rounded-full transition-all duration-300 ${getProgressGradient(
                                  item,
                                  pct
                                )}`}
                              />
                            </div>

                            {/* Glowing Animated Bob Indicator at the Leading Edge */}
                            {(isActiveDownload || (item.status === 'paused' && clampedBarPct > 0)) && (
                              <span
                                style={{ left: `calc(${clampedBarPct}% - 7px)` }}
                                className="pointer-events-none absolute top-1/2 -translate-y-1/2 flex h-3.5 w-3.5 items-center justify-center transition-all duration-300"
                              >
                                {isActiveDownload && (
                                  <span className="absolute inline-flex h-5 w-5 rounded-full bg-[#3BE098]/45 animate-ping" />
                                )}
                                <span
                                  className={`relative inline-flex h-3.5 w-3.5 rounded-full border-2 border-white dark:border-[#07110D] shadow-[0_0_12px_rgba(59,224,152,0.85)] ${
                                    item.status === 'paused' ? 'bg-amber-400' : 'bg-[#3BE098]'
                                  }`}
                                />
                              </span>
                            )}
                          </div>

                          {/* Always-Visible 32-Stream Segment Boxes */}
                          {!item.directOnly && (
                            <div className="space-y-1.5">
                              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono tabular-nums text-[#52655C] dark:text-[#8A9891]">
                                <span className="inline-flex items-center gap-1.5">
                                  <span className="font-sans font-medium text-[#22352C] dark:text-[#D1DCD6]">
                                    Stream Boxes
                                  </span>
                                  <span>
                                    {filledBoxes}/{totalBoxes} filled
                                  </span>
                                  {isActiveDownload && activeBoxes > 0 && (
                                    <span className="text-[#156E4B] dark:text-[#3BE098]">
                                      · {activeBoxes} active
                                    </span>
                                  )}
                                </span>

                                <div className="flex items-center gap-2.5 text-[10px]">
                                  {adapters
                                    .filter((a) => a.connected && a.enabled)
                                    .map((adapter) => (
                                      <span
                                        key={adapter.id}
                                        className="inline-flex items-center gap-1"
                                      >
                                        <span
                                          className={`inline-block h-1.5 w-1.5 rounded-full ${getAdapterBarColor(
                                            adapter.id
                                          )}`}
                                        />
                                        <span>{adapter.name}</span>
                                      </span>
                                    ))}
                                </div>
                              </div>

                              {/* 32 Individual Segmented Boxes */}
                              <div className="grid grid-cols-16 sm:grid-cols-32 gap-1">
                                {(boxes.length > 0
                                  ? boxes
                                  : Array.from({ length: 32 }, (_, idx) => ({
                                      index: idx,
                                      progress: item.status === 'completed' ? 100 : 0,
                                      adapterId: adapters[idx % Math.max(1, adapters.length)]?.id || 'adapter-wifi',
                                    }))
                                ).map((chunk) => {
                                  const isFilling = chunk.progress > 0 && chunk.progress < 100 && isActiveDownload;
                                  const isDone = chunk.progress >= 100 || item.status === 'completed';
                                  const adapterName =
                                    adapters.find((a) => a.id === chunk.adapterId)?.name || 'Bonded Link';
                                  return (
                                    <div
                                      key={chunk.index}
                                      title={`Stream Box #${chunk.index + 1}: ${
                                        isDone ? 100 : chunk.progress
                                      }% (${adapterName})`}
                                      className={`h-4 rounded-[3px] border overflow-hidden relative transition-colors ${
                                        isDone
                                          ? 'border-transparent bg-[#E2F5EC] dark:bg-[#0F2B20]/80'
                                          : isFilling
                                          ? 'border-[#2FD48B]/70 bg-[#EBF9F2] dark:bg-[#0D241C]'
                                          : 'border-[#0F241B]/10 dark:border-white/[0.08] bg-white/60 dark:bg-black/35'
                                      }`}
                                    >
                                      <div
                                        style={{ height: `${isDone ? 100 : chunk.progress}%` }}
                                        className={`absolute bottom-0 inset-x-0 transition-all duration-300 ${getAdapterBarColor(
                                          chunk.adapterId
                                        )} ${isFilling ? 'animate-pulse' : ''}`}
                                      />
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}

                          {/* Bottom 3-Column Tabular Stats Row */}
                          <div className="grid grid-cols-3 items-center gap-2 font-mono text-[11px] tabular-nums text-[#52655C] dark:text-[#8A9891] pt-0.5">
                            <span className="truncate">
                              {formatBytes(item.downloadedBytes)}
                              {item.totalBytes > 0 ? ` / ${formatBytes(item.totalBytes)}` : ''}
                            </span>

                            <span
                              className={`text-center truncate ${
                                item.status === 'error'
                                  ? 'text-rose-600 dark:text-rose-400 font-medium'
                                  : item.status === 'completed'
                                  ? 'text-[#156E4B] dark:text-[#3BE098] font-medium'
                                  : item.status === 'queued'
                                  ? 'text-[#187A54] dark:text-[#2FD48B] font-medium'
                                  : ''
                              }`}
                            >
                              {item.status === 'downloading' && item.totalBytes > 0
                                ? formatEta(remainingBytes, item.speedBytesPerSec)
                                : item.status === 'connecting'
                                ? 'Connecting...'
                                : item.status === 'completed'
                                ? 'Saved in App'
                                : item.status === 'paused'
                                ? 'Paused'
                                : item.status === 'error'
                                ? 'Failed'
                                : item.status === 'cancelled'
                                ? 'Stopped'
                                : 'Waiting in queue'}
                            </span>

                            <span className="text-right truncate text-[#111B16] dark:text-[#E5ECE8] font-semibold">
                              {item.status === 'downloading'
                                ? formatSpeedMBps(item.speedBytesPerSec)
                                : item.status === 'completed'
                                ? 'Complete'
                                : item.status === 'queued'
                                ? 'Auto-next'
                                : '0.0 MB/s'}
                            </span>
                          </div>

                          {item.errorMessage && (
                            <p className="text-xs text-rose-600 dark:text-rose-400 flex items-center gap-1.5">
                              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                              <span className="truncate">{item.errorMessage}</span>
                            </p>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Floating Context Menu Dropdown */}
                    <AnimatePresence>
                      {isMenuOpen && (
                        <motion.div
                          key={`ctx-${item.id}`}
                          initial={{ opacity: 0, y: -4, scale: 0.97 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, y: -4, scale: 0.97 }}
                          transition={{ duration: 0.14, ease: EASE_STUDIO }}
                          onClick={(e) => e.stopPropagation()}
                          className="absolute right-4 top-14 z-30 w-52 rounded-xl border border-[#0F241B]/12 dark:border-white/[0.11] bg-white/92 dark:bg-[#0B110F]/95 backdrop-blur-xl shadow-2xl py-1.5 text-xs text-[#1F332A] dark:text-[#DCE6E1]"
                        >
                          {canPlayInApp && (
                            <button
                              type="button"
                              onClick={() => {
                                setContextMenuId(null);
                                setPlayerSession({
                                  mode: 'transfer',
                                  transferId: item.serverTransferId,
                                  title: item.title,
                                  url: item.url,
                                  kind: item.kind,
                                  quality: item.quality,
                                  language: item.language,
                                  sizeBytes: item.totalBytes || item.downloadedBytes,
                                });
                              }}
                              className="w-full px-3.5 py-2 text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.06] flex items-center gap-2.5 cursor-pointer"
                            >
                              <Play className="h-3.5 w-3.5 text-[#156E4B] dark:text-[#3BE098]" />
                              <span>Play in MochiDrop</span>
                            </button>
                          )}

                          {canStreamVlc && (
                            <a
                              href={`/api/transfers/${encodeURIComponent(
                                item.serverTransferId!
                              )}/playlist.xspf`}
                              download
                              onClick={() => {
                                setContextMenuId(null);
                                onNotify('Downloaded VLC Playlist (.xspf)');
                              }}
                              className="w-full px-3.5 py-2 text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.06] flex items-center gap-2.5"
                            >
                              <MonitorPlay className="h-3.5 w-3.5 text-amber-500" />
                              <span>Open with VLC (.xspf)</span>
                            </a>
                          )}

                          {item.status === 'completed' &&
                            item.serverTransferId &&
                            !item.directOnly && (
                              <a
                                href={`/api/transfers/${encodeURIComponent(
                                  item.serverTransferId
                                )}/file?download=1`}
                                download={item.title}
                                onClick={() => setContextMenuId(null)}
                                className="w-full px-3.5 py-2 text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.06] flex items-center gap-2.5"
                              >
                                <Download className="h-3.5 w-3.5 text-[#156E4B] dark:text-[#3BE098]" />
                                <span>Export / Save File</span>
                              </a>
                            )}

                          {!item.directOnly && item.status === 'queued' && (
                            <button
                              type="button"
                              onClick={() => {
                                setContextMenuId(null);
                                onStartQueuedNow(item.id);
                              }}
                              className="w-full px-3.5 py-2 text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.06] flex items-center gap-2.5 cursor-pointer"
                            >
                              <Play className="h-3.5 w-3.5 text-[#156E4B] dark:text-[#3BE098]" />
                              <span>Start Now</span>
                            </button>
                          )}

                          {!item.directOnly &&
                            (item.status === 'downloading' ||
                              item.status === 'connecting' ||
                              item.status === 'paused') && (
                              <button
                                type="button"
                                onClick={() => {
                                  setContextMenuId(null);
                                  onTogglePause(item.id);
                                }}
                                className="w-full px-3.5 py-2 text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.06] flex items-center gap-2.5 cursor-pointer"
                              >
                                {item.status === 'paused' ? (
                                  <>
                                    <Play className="h-3.5 w-3.5 text-[#156E4B] dark:text-[#3BE098]" />
                                    <span>Resume</span>
                                  </>
                                ) : (
                                  <>
                                    <Pause className="h-3.5 w-3.5 text-[#156E4B] dark:text-[#3BE098]" />
                                    <span>Pause</span>
                                  </>
                                )}
                              </button>
                            )}

                          {!item.directOnly && (
                            <button
                              type="button"
                              onClick={() => {
                                setContextMenuId(null);
                                onRetryTransfer(item);
                              }}
                              className="w-full px-3.5 py-2 text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.06] flex items-center gap-2.5 cursor-pointer"
                            >
                              <RotateCcw className="h-3.5 w-3.5 text-[#52655C] dark:text-[#8E9B95]" />
                              <span>Redownload</span>
                            </button>
                          )}

                          <button
                            type="button"
                            onClick={() => {
                              setContextMenuId(null);
                              void handleCopyLink(item);
                            }}
                            className="w-full px-3.5 py-2 text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.06] flex items-center gap-2.5 cursor-pointer"
                          >
                            {copiedId === item.id ? (
                              <Check className="h-3.5 w-3.5 text-[#156E4B] dark:text-[#3BE098]" />
                            ) : (
                              <Copy className="h-3.5 w-3.5 text-[#52655C] dark:text-[#8E9B95]" />
                            )}
                            <span>Copy Direct URL</span>
                          </button>

                          <div className="my-1 border-t border-[#0F241B]/10 dark:border-white/[0.08]" />

                          <button
                            type="button"
                            disabled={index === 0}
                            onClick={() => {
                              setContextMenuId(null);
                              onMoveItem(item.id, 'up');
                            }}
                            className="w-full px-3.5 py-2 text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.06] flex items-center gap-2.5 disabled:opacity-35 cursor-pointer"
                          >
                            <ArrowUp className="h-3.5 w-3.5 text-[#52655C] dark:text-[#8E9B95]" />
                            <span>Move Up</span>
                          </button>
                          <button
                            type="button"
                            disabled={index === filteredDownloads.length - 1}
                            onClick={() => {
                              setContextMenuId(null);
                              onMoveItem(item.id, 'down');
                            }}
                            className="w-full px-3.5 py-2 text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.06] flex items-center gap-2.5 disabled:opacity-35 cursor-pointer"
                          >
                            <ArrowDown className="h-3.5 w-3.5 text-[#52655C] dark:text-[#8E9B95]" />
                            <span>Move Down</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              setContextMenuId(null);
                              setExpandedId(isExpanded ? null : item.id);
                            }}
                            className="w-full px-3.5 py-2 text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.06] flex items-center gap-2.5 cursor-pointer"
                          >
                            <Info className="h-3.5 w-3.5 text-[#52655C] dark:text-[#8E9B95]" />
                            <span>{isExpanded ? 'Hide Details' : 'Details & URL'}</span>
                          </button>

                          <div className="my-1 border-t border-[#0F241B]/10 dark:border-white/[0.08]" />

                          <button
                            type="button"
                            onClick={() => {
                              setContextMenuId(null);
                              onRemove(item.id);
                            }}
                            className="w-full px-3.5 py-2 text-left text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 flex items-center gap-2.5 cursor-pointer"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            <span>Delete</span>
                          </button>
                        </motion.div>
                      )}
                    </AnimatePresence>

                    {/* Expandable Details Drawer (Track switcher, adapter split bytes & direct URL) */}
                    <AnimatePresence initial={false}>
                      {isExpanded && (
                        <motion.div
                          key={`details-${item.id}`}
                          initial={{ opacity: 0, y: -4 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -4 }}
                          transition={{ duration: 0.16, ease: EASE_STUDIO }}
                          className="px-4 py-3.5 bg-white/55 dark:bg-black/30 border-t border-[#0F241B]/10 dark:border-white/[0.08] rounded-b-2xl space-y-3"
                        >
                          <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono text-[#52655C] dark:text-[#8A9891] tabular-nums">
                            {adapters.map((adapter) => (
                              <span key={adapter.id} className="inline-flex items-center gap-1.5">
                                <span
                                  className={`inline-block h-2 w-2 rounded-full ${getAdapterBarColor(
                                    adapter.id
                                  )}`}
                                />
                                <span>{adapter.name}</span>
                                <span>{formatBytes(item.adapterSplit[adapter.id] || 0)}</span>
                              </span>
                            ))}
                          </div>

                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            {item.kind === 'video' && (
                              <div className="space-y-1">
                                <span className="text-[11px] font-medium text-[#52655C] dark:text-[#8E9B95] inline-flex items-center gap-1">
                                  <Languages className="h-3 w-3" />
                                  Quality & Language
                                </span>
                                <div className="grid grid-cols-2 gap-1.5">
                                  {(item.availableQualities?.length ?? 0) > 1 ? (
                                    <select
                                      value={item.quality || 'Source Quality'}
                                      onChange={(e) =>
                                        onUpdateTrack(
                                          item.id,
                                          e.target.value,
                                          item.language || 'Source Audio'
                                        )
                                      }
                                      className="h-8 rounded-lg border border-[#0F241B]/12 dark:border-white/[0.1] bg-white/80 dark:bg-[#0B120F] px-2 text-xs text-[#111B16] dark:text-white"
                                    >
                                      {item.availableQualities!.map((q) => (
                                        <option key={q} value={q}>
                                          {q}
                                        </option>
                                      ))}
                                    </select>
                                  ) : (
                                    <div className="h-8 rounded-lg border border-[#0F241B]/10 dark:border-white/[0.08] bg-white/60 dark:bg-black/35 px-2.5 flex items-center text-xs font-mono text-[#111B16] dark:text-white truncate">
                                      {item.quality || 'Source Quality'}
                                    </div>
                                  )}

                                  {(item.availableLanguages?.length ?? 0) > 1 ? (
                                    <select
                                      value={item.language || 'Source Audio'}
                                      onChange={(e) =>
                                        onUpdateTrack(
                                          item.id,
                                          item.quality || 'Source Quality',
                                          e.target.value
                                        )
                                      }
                                      className="h-8 rounded-lg border border-[#0F241B]/12 dark:border-white/[0.1] bg-white/80 dark:bg-[#0B120F] px-2 text-xs text-[#111B16] dark:text-white"
                                    >
                                      {item.availableLanguages!.map((lang) => (
                                        <option key={lang} value={lang}>
                                          {lang}
                                        </option>
                                      ))}
                                    </select>
                                  ) : (
                                    <div className="h-8 rounded-lg border border-[#0F241B]/10 dark:border-white/[0.08] bg-white/60 dark:bg-black/35 px-2.5 flex items-center text-xs text-[#111B16] dark:text-white truncate">
                                      {item.language || 'Source Audio'}
                                    </div>
                                  )}
                                </div>
                              </div>
                            )}

                            <div className="space-y-1 min-w-0">
                              <span className="text-[11px] font-medium text-[#52655C] dark:text-[#8E9B95]">
                                Source URL
                              </span>
                              <div className="flex items-center gap-1.5">
                                <input
                                  type="text"
                                  readOnly
                                  value={item.url}
                                  className="flex-1 min-w-0 h-8 rounded-lg border border-[#0F241B]/10 dark:border-white/[0.09] bg-white/70 dark:bg-black/40 px-2.5 text-[11px] font-mono text-[#354B41] dark:text-[#A5B4AD]"
                                />
                                <button
                                  type="button"
                                  onClick={() => void handleCopyLink(item)}
                                  className="h-8 px-2.5 rounded-lg border border-[#0F241B]/12 dark:border-white/[0.1] bg-white/80 dark:bg-white/[0.04] text-xs font-medium text-[#1F332A] dark:text-[#DCE6E1] hover:border-[#1B6B4D]/40 dark:hover:border-[#2FD48B]/35 shrink-0 cursor-pointer"
                                >
                                  Copy
                                </button>
                              </div>
                              <div className="flex flex-wrap items-center gap-x-3 text-[11px] font-mono text-[#64786E] dark:text-[#7A8A83]">
                                <span className="inline-flex items-center gap-1">
                                  <HardDrive className="h-3 w-3" />
                                  MochiDrop Storage
                                </span>
                                <span className="inline-flex items-center gap-1">
                                  <Globe className="h-3 w-3" />
                                  {item.resumable
                                    ? `${item.parallelStreams} parallel streams`
                                    : 'Single stream'}
                                </span>
                              </div>
                            </div>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.article>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* YouTube Playlist Batch Downloader Modal */}
      <YouTubePlaylistModal
        open={ytPlaylistModalOpen}
        initialUrl={ytPlaylistInitialUrl}
        maxConcurrent={settings.maxConcurrentDownloads}
        onChangeConcurrent={onChangeConcurrent}
        onClose={() => setYtPlaylistModalOpen(false)}
        onEnqueuePlaylist={onEnqueueBatch}
        onNotify={onNotify}
      />

      {/* In-App Cinema Player & External VLC Modal */}
      <MediaPlayerModal
        session={playerSession}
        liveTransfer={livePlayerTransfer}
        onClose={() => setPlayerSession(null)}
        onTogglePause={onTogglePause}
        onDownloadOnlineSession={handleDownloadOnlineSession}
        onNotify={onNotify}
      />
    </div>
  );
};
