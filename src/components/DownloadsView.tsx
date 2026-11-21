import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertCircle,
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  Cable,
  Check,
  ChevronDown,
  ChevronUp,
  Clipboard,
  Copy,
  Cpu,
  Download,
  ExternalLink,
  Eye,
  File,
  FileArchive,
  FileText,
  Film,
  FolderDown,
  Globe,
  HardDrive,
  Image as ImageIcon,
  Languages,
  Link2,
  ListPlus,
  Magnet,
  MonitorPlay,
  Music,
  Package,
  Pause,
  Play,
  RotateCcw,
  Search,
  Smartphone,
  Trash2,
  Upload,
  Wifi,
  X,
} from 'lucide-react';
import { ActivePlayerSession, MediaPlayerModal } from './MediaPlayerModal';
import {
  DownloadItem,
  DownloadKind,
  InspectResponse,
  NetworkAdapter,
  PlexoSettings,
  TorrentFileItem,
  TransferProtocol,
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
  urlInput: string;
  onUrlInputChange: (val: string) => void;
  onAddDownload: (payload: {
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
  }) => void;
  onTogglePause: (id: string) => void;
  onRetryTransfer: (item: DownloadItem) => void;
  onRemove: (id: string) => void;
  onMoveItem: (id: string, direction: 'up' | 'down') => void;
  onPauseAll: () => void;
  onResumeAll: () => void;
  onUpdateTrack: (id: string, quality: string, language: string) => void;
  onToggleAdapter: (id: string) => void;
  onNotify: (msg: string) => void;
  onOpenNetworksView: () => void;
}

type FilterKey = 'all' | 'active' | 'video' | 'audio' | 'files' | 'torrent' | 'completed';

interface BatchSelectionItem extends InspectResponse {
  selected: boolean;
}

const EASE_LUXURY: [number, number, number, number] = [0.16, 1, 0.3, 1];

export const DownloadsView: React.FC<DownloadsViewProps> = ({
  downloads,
  adapters,
  settings,
  urlInput,
  onUrlInputChange,
  onAddDownload,
  onTogglePause,
  onRetryTransfer,
  onRemove,
  onMoveItem,
  onPauseAll,
  onResumeAll,
  onUpdateTrack,
  onToggleAdapter,
  onNotify,
  onOpenNetworksView,
}) => {
  const [filter, setFilter] = useState<FilterKey>('all');
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(downloads[0]?.id ?? null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [batchMode, setBatchMode] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [startingPlay, setStartingPlay] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [inspected, setInspected] = useState<InspectResponse | null>(null);
  const [batchItems, setBatchItems] = useState<BatchSelectionItem[]>([]);
  const [selectedQuality, setSelectedQuality] = useState('Source Quality');
  const [selectedLanguage, setSelectedLanguage] = useState('Source Audio');
  const [torrentSelection, setTorrentSelection] = useState<TorrentFileItem[]>([]);
  const [playerSession, setPlayerSession] = useState<ActivePlayerSession | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lastAutoClipboardRef = useRef<string>('');
  const lastInspectedUrlRef = useRef<string>('');

  const livePlayerTransfer = useMemo(
    () =>
      playerSession?.mode === 'transfer' && playerSession.transferId
        ? downloads.find((d) => d.serverTransferId === playerSession.transferId) ?? null
        : null,
    [downloads, playerSession]
  );

  const enabledAdapters = useMemo(() => adapters.filter((a) => a.enabled), [adapters]);

  const aggregateSpeedBytes = useMemo(
    () =>
      downloads.reduce(
        (sum, d) => sum + (d.status === 'downloading' ? d.speedBytesPerSec : 0),
        0
      ),
    [downloads]
  );

  const totalTransferredBytes = useMemo(
    () => downloads.reduce((sum, d) => sum + d.downloadedBytes, 0),
    [downloads]
  );

  const totalQueueBytes = useMemo(
    () => downloads.reduce((sum, d) => sum + d.totalBytes, 0),
    [downloads]
  );

  const filteredDownloads = useMemo(() => {
    const q = search.trim().toLowerCase();
    return downloads.filter((item) => {
      if (
        filter === 'active' &&
        item.status !== 'downloading' &&
        item.status !== 'connecting' &&
        item.status !== 'queued'
      ) {
        return false;
      }
      if (filter === 'video' && item.kind !== 'video') return false;
      if (filter === 'audio' && item.kind !== 'audio') return false;
      if (
        filter === 'files' &&
        !['archive', 'software', 'document', 'image', 'file'].includes(item.kind)
      ) {
        return false;
      }
      if (filter === 'torrent' && item.kind !== 'torrent') return false;
      if (filter === 'completed' && item.status !== 'completed') return false;
      if (q) {
        const hay =
          `${item.title} ${item.domain} ${item.protocol ?? ''} ${item.language ?? ''} ${item.quality ?? ''}`.toLowerCase();
        return hay.includes(q);
      }
      return true;
    });
  }, [downloads, filter, search]);

  const startInspectedTransfer = useCallback(
    (result: InspectResponse, chosenQuality?: string, chosenLanguage?: string) => {
      const q = chosenQuality || result.quality || result.availableQualities?.[0] || 'Source Quality';
      const l = chosenLanguage || result.language || result.availableLanguages?.[0] || 'Source Audio';
      const finalUrl = result.variantUrls?.[q] || result.url;

      onAddDownload({
        title: result.filename,
        url: finalUrl,
        domain: result.domain,
        kind: result.kind,
        protocol: result.protocol,
        totalBytes: result.sizeBytes,
        quality: result.kind === 'video' || result.kind === 'audio' ? q : undefined,
        language: result.kind === 'video' ? l : undefined,
        availableLanguages: result.availableLanguages,
        availableQualities: result.availableQualities,
        variantUrls: result.variantUrls,
        source: result.kind === 'torrent' ? 'magnet' : 'direct',
        resumable: result.acceptRanges,
      });

      setInspected(null);
      lastInspectedUrlRef.current = '';
      onUrlInputChange('');
    },
    [onAddDownload, onUrlInputChange]
  );

  const handleInspectInput = useCallback(
    async (rawOverride?: string, options?: { startImmediately?: boolean }) => {
      const raw = (rawOverride ?? urlInput).trim();
      if (!raw) {
        setInspectError('Paste one or more download links, or import a .torrent / .txt link file.');
        return;
      }

      const lines = extractUrlsFromText(raw);
      if (lines.length === 0) {
        setInspectError('No links found.');
        return;
      }

      // Multiple links -> batch inspect
      if (lines.length > 1) {
        const validLines = lines.filter((l) => isSafeTransferUrl(l));
        if (validLines.length === 0) {
          setInspectError('Links must start with http://, https://, ftp://, sftp://, or magnet:?');
          return;
        }

        setInspectError(null);
        setInspected(null);
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

      // Single URL inspect
      const target = lines[0];
      if (!isSafeTransferUrl(target)) {
        setInspectError('Supported links: http://, https://, ftp://, ftps://, sftp://, or magnet:?');
        return;
      }

      // If already inspected for this exact link and user clicked Download, start immediately!
      if (options?.startImmediately && inspected && lastInspectedUrlRef.current === target) {
        const finalQuality = selectedQuality;
        const finalLanguage = selectedLanguage;
        startInspectedTransfer(inspected, finalQuality, finalLanguage);
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

        const hasMultipleChoices =
          (result.availableQualities?.length ?? 0) > 1 ||
          (result.availableLanguages?.length ?? 0) > 1 ||
          (result.kind === 'torrent' && (result.torrentFiles?.length ?? 0) > 0);

        if (options?.startImmediately && !hasMultipleChoices && !result.probeError) {
          startInspectedTransfer(result, resolvedQ, resolvedL);
          return;
        }

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
    [inspected, onNotify, selectedLanguage, selectedQuality, startInspectedTransfer, urlInput]
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
    const raw = urlInput.trim();
    if (!raw && inspected) {
      openOnlinePlayer(inspected, selectedQuality, selectedLanguage);
      return;
    }
    if (!raw) {
      setInspectError('Paste a media link to play online or open in VLC.');
      return;
    }

    const lines = extractUrlsFromText(raw);
    const target = lines[0];
    if (!target || !/^https?:\/\//i.test(target)) {
      setInspectError('Online streaming supports HTTP/HTTPS links.');
      return;
    }

    if (inspected && lastInspectedUrlRef.current === target) {
      openOnlinePlayer(inspected, selectedQuality, selectedLanguage);
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
        (d) => d.url === session.url && d.serverTransferId && d.status !== 'error' && d.status !== 'cancelled'
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
      });
      onNotify(`Downloading "${session.title}" in background while you watch`);
    },
    [downloads, onAddDownload, onNotify]
  );

  // Automatic clipboard link detection when user returns to MochiDrop with a copied link
  const checkClipboardSilently = useCallback(async () => {
    if (!settings.autoDetectClipboard || batchMode) return;
    if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') return;
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text || text === lastAutoClipboardRef.current) return;
      const lines = extractUrlsFromText(text);
      if (lines.length === 0 || !isSafeTransferUrl(lines[0])) return;
      // Don't re-import a URL that's already in the input bar or already actively queued
      if (urlInput.trim() === text) return;
      lastAutoClipboardRef.current = text;
      if (lines.length > 1) {
        setBatchMode(true);
      }
      onUrlInputChange(text);
      onNotify(
        lines.length > 1
          ? `Detected ${lines.length} copied links`
          : 'Copied link detected automatically'
      );
      void handleInspectInput(text);
    } catch {
      // Clipboard read requires user focus/permission in some browsers; fail silently
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
        if (lines.length > 1) setBatchMode(true);
        onUrlInputChange(cleaned);
        onNotify(lines.length > 1 ? `Pasted ${lines.length} links` : 'Link pasted');
        void handleInspectInput(cleaned);
      } else {
        onNotify('Clipboard is empty');
      }
    } catch {
      onNotify('Press Ctrl+V / Cmd+V inside the link bar');
    }
  }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    // Local .torrent file import
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

    // Text / link list file (.txt, .csv, .m3u, .m3u8)
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

    // Use the exact real HLS variant URL if the user picked one from a multi-variant manifest;
    // otherwise keep the original source URL completely untouched!
    const finalUrl = inspected.variantUrls?.[selectedQuality] || inspected.url;

    onAddDownload({
      title: inspected.filename,
      url: finalUrl,
      domain: inspected.domain,
      kind: inspected.kind,
      protocol: inspected.protocol,
      totalBytes: finalBytes,
      quality:
        inspected.kind === 'video' || inspected.kind === 'audio'
          ? selectedQuality
          : undefined,
      language: inspected.kind === 'video' ? selectedLanguage : undefined,
      availableLanguages: inspected.availableLanguages,
      availableQualities: inspected.availableQualities,
      variantUrls: inspected.variantUrls,
      source: inspected.kind === 'torrent' ? 'magnet' : 'direct',
      torrentFiles: finalTorrentFiles,
      resumable: inspected.acceptRanges,
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

    for (const item of selected) {
      onAddDownload({
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
      });
    }

    setBatchItems([]);
    onUrlInputChange('');
    setBatchMode(false);
    onNotify(`Started ${selected.length} in-app downloads`);
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

  function getAdapterShadeClass(adapterId: string): string {
    const found = adapters.find((a) => a.id === adapterId);
    if (!found) return 'bg-black dark:bg-white';
    switch (found.shade) {
      case 'solid':
        return 'bg-black dark:bg-white';
      case 'mid':
        return 'bg-neutral-600 dark:bg-neutral-400';
      case 'soft':
        return 'bg-neutral-400 dark:bg-neutral-600';
      default:
        return 'bg-neutral-500';
    }
  }

  function renderAdapterIcon(type: NetworkAdapter['interfaceType']) {
    switch (type) {
      case 'Wi-Fi':
        return <Wifi className="h-3.5 w-3.5" />;
      case 'Ethernet':
        return <Cable className="h-3.5 w-3.5" />;
      case 'Cellular USB':
        return <Smartphone className="h-3.5 w-3.5" />;
      default:
        return <Cpu className="h-3.5 w-3.5" />;
    }
  }

  function renderKindIcon(kind: DownloadKind) {
    switch (kind) {
      case 'video':
        return <Film className="h-4 w-4" />;
      case 'audio':
        return <Music className="h-4 w-4" />;
      case 'archive':
        return <FileArchive className="h-4 w-4" />;
      case 'software':
        return <Package className="h-4 w-4" />;
      case 'document':
        return <FileText className="h-4 w-4" />;
      case 'image':
        return <ImageIcon className="h-4 w-4" />;
      case 'torrent':
        return <Magnet className="h-4 w-4" />;
      default:
        return <File className="h-4 w-4" />;
    }
  }

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[1fr_316px] gap-6 items-start">
      {/* Main Left Column: Universal All-Link Input Bar + Transfer Queue */}
      <div className="min-w-0 space-y-5">
        <section className="border border-neutral-200/90 dark:border-neutral-800/90 bg-white dark:bg-[#0B0B0B] p-5 rounded-md shadow-[0_1px_2px_rgba(0,0,0,0.03)] dark:shadow-none space-y-3.5 transition-colors">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleInspectInput(undefined, { startImmediately: !batchMode });
            }}
            className="space-y-3"
          >
            {batchMode ? (
              <textarea
                rows={4}
                value={urlInput}
                onChange={(e) => {
                  onUrlInputChange(e.target.value);
                  if (inspectError) setInspectError(null);
                }}
                placeholder="Paste multiple links (one per line): HTTP/HTTPS, Video/HLS/DASH, Audio, ZIP/ISO/APK, PDF, Images, Cloud, FTP/SFTP, or Magnet URIs"
                className="w-full rounded-sm border border-neutral-300 dark:border-neutral-800 bg-neutral-50/60 dark:bg-black p-3 text-xs text-black dark:text-white placeholder:text-neutral-400 dark:placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-black dark:focus:ring-white font-mono resize-y transition-colors"
              />
            ) : (
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                <div className="relative flex-1">
                  <Link2 className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-400 dark:text-neutral-500" />
                  <input
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
                        if (lines.length > 1) {
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
                    placeholder="Paste or copy any link to download or stream in VLC..."
                    className="w-full h-11 rounded-sm border border-neutral-300 dark:border-neutral-800 bg-neutral-50/60 dark:bg-black pl-10 pr-20 text-xs sm:text-sm text-black dark:text-white placeholder:text-neutral-400 dark:placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-black dark:focus:ring-white font-mono transition-colors"
                  />
                  <button
                    type="button"
                    onClick={handlePasteFromClipboard}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 rounded-xs border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-[#121212] px-2.5 py-1.5 text-[11px] font-medium text-neutral-800 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-[#1B1B1B] transition-colors cursor-pointer"
                  >
                    <Clipboard className="h-3 w-3" />
                    Paste
                  </button>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    disabled={startingPlay || inspecting}
                    onClick={() => void handlePlayOnlineInput()}
                    title="Stream online now in MochiDrop or VLC"
                    className="h-11 px-4 rounded-sm border border-neutral-300 dark:border-neutral-700 bg-neutral-100/80 dark:bg-[#141414] text-black dark:text-white text-xs font-semibold hover:bg-neutral-200/80 dark:hover:bg-[#1D1D1D] disabled:opacity-50 active:scale-[0.98] transition-all inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer flex-1 sm:flex-none"
                  >
                    <Play className="h-3.5 w-3.5 fill-current" />
                    {startingPlay ? 'Opening...' : 'Play'}
                  </button>

                  <button
                    type="submit"
                    disabled={inspecting || startingPlay}
                    className="h-11 px-5 rounded-sm bg-black text-white dark:bg-white dark:text-black text-xs font-semibold hover:bg-neutral-800 dark:hover:bg-neutral-200 disabled:opacity-50 active:scale-[0.98] transition-all inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer flex-1 sm:flex-none"
                  >
                    <ArrowDownToLine className="h-3.5 w-3.5" />
                    {inspecting ? 'Starting...' : 'Download'}
                  </button>
                </div>
              </div>
            )}

            {/* Utility Row: Multi-link toggle, .torrent / .txt upload, and clean supported-formats note */}
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setBatchMode((b) => !b)}
                  className={`h-7 px-2.5 rounded-xs border text-[11px] font-medium inline-flex items-center gap-1.5 transition-colors cursor-pointer ${
                    batchMode
                      ? 'bg-black text-white border-black dark:bg-white dark:text-black dark:border-white'
                      : 'border-neutral-200 dark:border-neutral-800 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200/60 dark:hover:bg-neutral-900'
                  }`}
                >
                  <ListPlus className="h-3 w-3" />
                  {batchMode ? 'Single Link' : 'Batch Links'}
                </button>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".torrent,.txt,.csv,.m3u,.m3u8"
                  onChange={handleImportFile}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="h-7 px-2.5 rounded-xs border border-neutral-200 dark:border-neutral-800 text-[11px] font-medium text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200/60 dark:hover:bg-neutral-900 inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <Upload className="h-3 w-3" />
                  Import .torrent / .txt
                </button>

                {batchMode && (
                  <button
                    type="submit"
                    disabled={inspecting}
                    className="h-7 px-3 rounded-xs bg-black text-white dark:bg-white dark:text-black text-[11px] font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    <ArrowDownToLine className="h-3 w-3" />
                    {inspecting ? 'Checking Links...' : 'Inspect All Links'}
                  </button>
                )}
              </div>
            </div>
          </form>

          <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
            All link types: HTTP/HTTPS · Videos & HLS/DASH · Audio · ZIP/7z/ISO/APK · PDF/Docs · Images · Drive/GitHub/Cloud · FTP/SFTP · Magnet & .torrent
          </p>

          {inspectError && (
            <p className="text-xs font-medium text-red-600 dark:text-red-400">{inspectError}</p>
          )}

          {/* Single-Link Pre-Download Inspector */}
          <AnimatePresence>
            {inspected && (
              <motion.div
                key="single-inspector"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.2, ease: EASE_LUXURY }}
                className="pt-4 mt-2 border-t border-neutral-200 dark:border-neutral-800 space-y-3.5"
              >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-2.5 min-w-0">
                  <div className="mt-0.5 h-8 w-8 shrink-0 rounded-xs border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-black flex items-center justify-center text-black dark:text-white">
                    {renderKindIcon(inspected.kind)}
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-mono text-neutral-500 dark:text-neutral-400">
                      {inspected.protocol} · {inspected.kind.toUpperCase()} · {inspected.domain} ·{' '}
                      {inspected.streamType === 'hls' && inspected.hlsSegmentCount
                        ? `${inspected.hlsSegmentCount} HLS segments`
                        : inspected.sizeBytes > 0
                        ? formatBytes(inspected.sizeBytes)
                        : 'Size detected on start'}{' '}
                      ·{' '}
                      {inspected.streamType === 'hls'
                        ? 'Live TS Assembly'
                        : inspected.acceptRanges
                        ? `Range OK (${Math.min(6, settings.maxConnectionsPerAdapter)} streams)`
                        : 'Single stream'}
                      {inspected.redirectHops && inspected.redirectHops > 0
                        ? ` · ${inspected.redirectHops} ${inspected.redirectHops === 1 ? 'redirect' : 'redirects'}`
                        : ''}
                    </p>
                    <h3 className="mt-0.5 text-sm font-semibold text-black dark:text-white truncate">
                      {inspected.filename}
                    </h3>
                    {inspected.probeError && (
                      <p className="mt-1 text-xs text-red-600 dark:text-red-400 flex items-center gap-1.5">
                        <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                        <span>{inspected.probeError}</span>
                      </p>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setInspected(null)}
                  aria-label="Close inspector"
                  className="p-1 text-neutral-500 hover:text-black dark:hover:text-white cursor-pointer"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {inspected.kind === 'video' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-xs text-neutral-500 dark:text-neutral-400">
                      <span>Quality</span>
                      <span className="font-mono text-[11px]">
                        {(inspected.availableQualities?.length ?? 0) > 1
                          ? `${inspected.availableQualities!.length} variants in stream`
                          : 'Fixed by link'}
                      </span>
                    </div>
                    {(inspected.availableQualities?.length ?? 0) > 1 ? (
                      <select
                        value={selectedQuality}
                        onChange={(e) => setSelectedQuality(e.target.value)}
                        className="w-full h-9 rounded-sm border border-neutral-300 dark:border-neutral-800 bg-white dark:bg-black px-2.5 text-xs text-black dark:text-white"
                      >
                        {inspected.availableQualities!.map((q) => (
                          <option key={q} value={q}>
                            {q}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <div className="w-full h-9 rounded-sm border border-neutral-200 dark:border-neutral-800 bg-neutral-100 dark:bg-neutral-950 px-2.5 flex items-center text-xs font-mono font-medium text-black dark:text-white">
                        {selectedQuality}
                      </div>
                    )}
                  </div>

                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-xs text-neutral-500 dark:text-neutral-400">
                      <span>Language</span>
                      <span className="font-mono text-[11px]">
                        {(inspected.availableLanguages?.length ?? 0) > 1
                          ? `${inspected.availableLanguages!.length} tracks in stream`
                          : 'Embedded in file'}
                      </span>
                    </div>
                    {(inspected.availableLanguages?.length ?? 0) > 1 ? (
                      <select
                        value={selectedLanguage}
                        onChange={(e) => setSelectedLanguage(e.target.value)}
                        className="w-full h-9 rounded-sm border border-neutral-300 dark:border-neutral-800 bg-white dark:bg-black px-2.5 text-xs text-black dark:text-white"
                      >
                        {inspected.availableLanguages!.map((lang) => (
                          <option key={lang} value={lang}>
                            {lang}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <div className="w-full h-9 rounded-sm border border-neutral-200 dark:border-neutral-800 bg-neutral-100 dark:bg-neutral-950 px-2.5 flex items-center text-xs font-medium text-black dark:text-white truncate">
                        {selectedLanguage}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {inspected.kind === 'audio' && (
                <div className="space-y-1 max-w-xs">
                  <span className="text-xs text-neutral-500 dark:text-neutral-400">
                    Audio Format (Fixed by link)
                  </span>
                  <div className="w-full h-9 rounded-sm border border-neutral-200 dark:border-neutral-800 bg-neutral-100 dark:bg-neutral-950 px-2.5 flex items-center text-xs font-mono font-medium text-black dark:text-white">
                    {selectedQuality}
                  </div>
                </div>
              )}

              {inspected.kind === 'torrent' && torrentSelection.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs text-neutral-500 dark:text-neutral-400">
                    Select torrent files to download
                  </p>
                  <div className="divide-y divide-neutral-200 dark:divide-neutral-800 border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-black rounded-sm">
                    {torrentSelection.map((tf) => (
                      <label
                        key={tf.id}
                        className="flex items-center justify-between gap-3 px-3 py-2 text-xs cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-900"
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
                            className="h-3.5 w-3.5 accent-black dark:accent-white"
                          />
                          <span className="truncate font-mono text-black dark:text-white">
                            {tf.name}
                          </span>
                        </span>
                        <span className="font-mono tabular-nums text-neutral-500 shrink-0">
                          {tf.sizeMb} MB
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-end gap-2">
                {/^https?:\/\//i.test(inspected.variantUrls?.[selectedQuality] || inspected.url) && (
                  <>
                    <a
                      href={`/api/play/playlist.xspf?url=${encodeURIComponent(
                        inspected.variantUrls?.[selectedQuality] || inspected.resolvedUrl || inspected.url
                      )}&title=${encodeURIComponent(inspected.filename)}`}
                      download
                      onClick={() => onNotify('Downloaded VLC Playlist (.xspf) — double-click to stream in VLC')}
                      className="h-8 px-3 rounded-sm border border-neutral-300 dark:border-neutral-700 text-xs font-medium text-neutral-800 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-900 inline-flex items-center gap-1.5 whitespace-nowrap transition-colors"
                    >
                      <MonitorPlay className="h-3.5 w-3.5" />
                      VLC (.xspf)
                    </a>
                    <button
                      type="button"
                      onClick={() => openOnlinePlayer(inspected, selectedQuality, selectedLanguage)}
                      className="h-8 px-3 rounded-sm border border-neutral-300 dark:border-neutral-700 bg-neutral-100/80 dark:bg-[#141414] text-xs font-semibold text-black dark:text-white hover:bg-neutral-200/80 dark:hover:bg-[#1D1D1D] active:scale-[0.98] transition-all inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                    >
                      <Play className="h-3 w-3 fill-current" />
                      Play Online
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={async () => {
                    const link = inspected.variantUrls?.[selectedQuality] || inspected.url;
                    try {
                      await navigator.clipboard.writeText(link);
                      onNotify('Direct link copied');
                    } catch {
                      onNotify('Clipboard permission denied');
                    }
                  }}
                  className="h-8 px-3 rounded-sm border border-neutral-300 dark:border-neutral-700 text-xs font-medium text-neutral-800 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-900 inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer transition-colors"
                >
                  <Copy className="h-3 w-3" />
                  Copy Link
                </button>
                <button
                  type="button"
                  onClick={handleConfirmInspectedDownload}
                  className="h-8 px-3.5 rounded-sm bg-black text-white dark:bg-white dark:text-black text-xs font-semibold hover:bg-neutral-800 dark:hover:bg-neutral-200 active:scale-[0.98] transition-all inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                >
                  <Download className="h-3.5 w-3.5" />
                  Start Download
                </button>
              </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Batch Multi-Link Inspector */}
          <AnimatePresence>
            {batchItems.length > 0 && (
              <motion.div
                key="batch-inspector"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.2, ease: EASE_LUXURY }}
                className="pt-4 mt-2 border-t border-neutral-200 dark:border-neutral-800 space-y-3"
              >
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold text-black dark:text-white">
                  Batch Queue Ready ({batchItems.filter((b) => b.selected).length}/{batchItems.length} selected)
                </h3>
                <button
                  type="button"
                  onClick={() => setBatchItems([])}
                  aria-label="Close batch preview"
                  className="p-1 text-neutral-500 hover:text-black dark:hover:text-white cursor-pointer"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="divide-y divide-neutral-200 dark:divide-neutral-800 border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-black rounded-sm max-h-64 overflow-y-auto">
                {batchItems.map((b, idx) => (
                  <label
                    key={`${b.url}-${idx}`}
                    className="flex items-center justify-between gap-3 px-3 py-2 text-xs cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-900"
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
                        className="h-3.5 w-3.5 accent-black dark:accent-white"
                      />
                      <span className="text-neutral-500 shrink-0">{renderKindIcon(b.kind)}</span>
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-black dark:text-white">
                          {b.filename}
                        </span>
                        <span className="block truncate font-mono text-[11px] text-neutral-500">
                          {b.protocol} · {b.kind} · {b.domain}
                        </span>
                      </span>
                    </span>
                    <span className="font-mono tabular-nums text-neutral-500 shrink-0">
                      {formatBytes(b.sizeBytes)}
                    </span>
                  </label>
                ))}
              </div>

              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={handleConfirmBatchDownload}
                  className="h-8 px-4 rounded-sm bg-black text-white dark:bg-white dark:text-black text-xs font-semibold hover:bg-neutral-800 dark:hover:bg-neutral-200 active:scale-[0.98] transition-all inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <Download className="h-3.5 w-3.5" />
                  Start {batchItems.filter((b) => b.selected).length} Downloads
                </button>
              </div>
              </motion.div>
            )}
          </AnimatePresence>
        </section>

        {/* Queue Toolbar (only shown when queue has items) */}
        {downloads.length > 0 && (
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
            <div className="flex items-center gap-1 p-0.5 rounded-sm border border-neutral-200 dark:border-neutral-800 bg-neutral-100 dark:bg-[#0A0A0A] overflow-x-auto">
              {(
                [
                  { key: 'all', label: `All (${downloads.length})` },
                  { key: 'active', label: 'Active' },
                  { key: 'video', label: 'Videos' },
                  { key: 'audio', label: 'Audio' },
                  { key: 'files', label: 'Files' },
                  { key: 'torrent', label: 'Torrents' },
                  { key: 'completed', label: 'Done' },
                ] as Array<{ key: FilterKey; label: string }>
              ).map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setFilter(tab.key)}
                  className={`px-2.5 py-1.5 rounded-xs text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    filter === tab.key
                      ? 'bg-black text-white dark:bg-white dark:text-black'
                      : 'text-neutral-600 dark:text-neutral-400 hover:text-black dark:hover:text-white'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-1.5">
              <div className="relative flex-1 sm:w-48">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-neutral-400" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search queue"
                  className="w-full h-8 rounded-sm border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-black pl-8 pr-2.5 text-xs text-black dark:text-white placeholder:text-neutral-400 dark:placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-black dark:focus:ring-white"
                />
              </div>
              <button
                type="button"
                onClick={onResumeAll}
                className="h-8 px-2.5 rounded-sm border border-neutral-200 dark:border-neutral-800 text-xs font-medium text-neutral-800 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-900 whitespace-nowrap shrink-0 cursor-pointer"
              >
                Resume All
              </button>
              <button
                type="button"
                onClick={onPauseAll}
                className="h-8 px-2.5 rounded-sm border border-neutral-200 dark:border-neutral-800 text-xs font-medium text-neutral-800 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-900 whitespace-nowrap shrink-0 cursor-pointer"
              >
                Pause All
              </button>
            </div>
          </div>
        )}

        {/* High-Density Transfer List */}
        <section className="border border-neutral-200/90 dark:border-neutral-800/90 bg-white dark:bg-[#0B0B0B] rounded-md overflow-hidden shadow-[0_1px_2px_rgba(0,0,0,0.03)] dark:shadow-none">
          {filteredDownloads.length === 0 ? (
            <div className="p-14 text-center space-y-3.5">
              <FolderDown className="mx-auto h-7 w-7 text-neutral-400 dark:text-neutral-600" />
              <div className="space-y-1">
                <p className="font-display text-sm font-semibold text-black dark:text-white">
                  {downloads.length === 0 ? 'Queue is empty' : 'No matching downloads'}
                </p>
                <p className="text-xs text-neutral-500 dark:text-neutral-400 max-w-md mx-auto leading-relaxed">
                  {downloads.length === 0
                    ? 'Paste any link above to download directly inside MochiDrop or click Play to stream continuously in the built-in player or VLC.'
                    : 'Clear the search filter to see your queued transfers.'}
                </p>
              </div>
              {downloads.length === 0 ? (
                <button
                  type="button"
                  onClick={handlePasteFromClipboard}
                  className="h-9 px-4 rounded-xs bg-black text-white dark:bg-white dark:text-black text-xs font-semibold hover:bg-neutral-800 dark:hover:bg-neutral-200 active:scale-[0.98] transition-all inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <Clipboard className="h-3.5 w-3.5" />
                  Paste Link from Clipboard
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setFilter('all');
                    setSearch('');
                  }}
                  className="h-9 px-4 rounded-xs bg-black text-white dark:bg-white dark:text-black text-xs font-semibold hover:bg-neutral-800 dark:hover:bg-neutral-200 active:scale-[0.98] transition-all cursor-pointer"
                >
                  Show All Transfers
                </button>
              )}
            </div>
          ) : (
            <div className="divide-y divide-neutral-200/90 dark:divide-neutral-800/85">
              {filteredDownloads.map((item, index) => {
                const pct = item.totalBytes
                  ? Math.min(100, (item.downloadedBytes / item.totalBytes) * 100)
                  : 0;
                const remainingBytes = Math.max(0, item.totalBytes - item.downloadedBytes);
                const isExpanded = expandedId === item.id;
                const totalSplit = Object.values(item.adapterSplit).reduce((a, b) => a + b, 0);

                return (
                  <div key={item.id}>
                    <div className="p-4 sm:p-5 flex flex-col gap-3.5 hover:bg-neutral-50/80 dark:hover:bg-[#101010] transition-colors">
                      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                        <div className="flex items-start gap-3 min-w-0">
                          <div className="mt-0.5 h-8 w-8 shrink-0 rounded-xs border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-black flex items-center justify-center text-black dark:text-white">
                            {renderKindIcon(item.kind)}
                          </div>
                          <div className="min-w-0 space-y-0.5">
                            <button
                              type="button"
                              onClick={() => setExpandedId(isExpanded ? null : item.id)}
                              className="text-left text-sm font-semibold text-black dark:text-white hover:underline underline-offset-4 truncate block max-w-full cursor-pointer"
                            >
                              {item.title}
                            </button>
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                              <span
                                className={`capitalize font-medium ${
                                  item.status === 'error'
                                    ? 'text-red-600 dark:text-red-400'
                                    : 'text-neutral-900 dark:text-neutral-200'
                                }`}
                              >
                                {item.status === 'completed'
                                  ? 'Saved in App'
                                  : item.status === 'connecting'
                                  ? 'Connecting...'
                                  : item.status}
                              </span>
                              {item.protocol && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span className="font-mono">{item.protocol}</span>
                                </>
                              )}
                              <span aria-hidden="true">·</span>
                              <span className="truncate max-w-[220px]">{item.domain}</span>
                              {item.resumable && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span className="font-mono">
                                    {item.parallelStreams}x Range
                                  </span>
                                </>
                              )}
                              {item.retryCount > 0 && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span className="font-mono">
                                    {item.retryCount} auto-{item.retryCount === 1 ? 'recovery' : 'recoveries'}
                                  </span>
                                </>
                              )}
                              {item.quality && item.quality !== 'Original' && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span className="font-mono">{item.quality}</span>
                                </>
                              )}
                              {item.language && item.language !== 'Original Audio' && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span>{item.language}</span>
                                </>
                              )}
                            </div>
                            {item.errorMessage && (
                              <p className="pt-1 text-xs text-red-600 dark:text-red-400 flex items-center gap-1.5">
                                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                                <span>{item.errorMessage}</span>
                              </p>
                            )}
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center justify-between md:justify-end gap-3 shrink-0">
                          <div className="flex items-center gap-4 font-mono text-xs tabular-nums">
                            <div className="text-right">
                              <div className="font-semibold text-black dark:text-white">
                                {item.status === 'downloading'
                                  ? formatSpeedMBps(item.speedBytesPerSec)
                                  : item.status === 'connecting'
                                  ? 'Starting...'
                                  : item.status === 'completed'
                                  ? 'Complete'
                                  : '0.0 MB/s'}
                              </div>
                              <div className="text-neutral-500 dark:text-neutral-400">
                                {formatBytes(item.downloadedBytes)}
                                {item.totalBytes > 0 ? ` / ${formatBytes(item.totalBytes)}` : ''}
                              </div>
                            </div>
                            <div className="text-right min-w-[52px]">
                              <div className="font-semibold text-black dark:text-white">
                                {item.totalBytes > 0 ? `${pct.toFixed(0)}%` : item.status === 'completed' ? '100%' : '-'}
                              </div>
                              <div className="text-neutral-500 dark:text-neutral-400">
                                {item.status === 'downloading' && item.totalBytes > 0
                                  ? formatEta(remainingBytes, item.speedBytesPerSec)
                                  : item.status === 'completed'
                                  ? 'In App'
                                  : item.status === 'error'
                                  ? 'Failed'
                                  : item.status === 'cancelled'
                                  ? 'Stopped'
                                  : item.status === 'paused'
                                  ? 'Paused'
                                  : '-'}
                              </div>
                            </div>
                          </div>

                          <div className="flex flex-wrap items-center gap-1.5">
                            {item.serverTransferId &&
                              !item.directOnly &&
                              (item.status === 'connecting' ||
                                item.status === 'downloading' ||
                                item.status === 'paused' ||
                                item.status === 'completed') &&
                              (item.kind === 'video' ||
                                item.kind === 'audio' ||
                                item.kind === 'image' ||
                                item.kind === 'document' ||
                                item.kind === 'file') && (
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
                                  title={
                                    item.status === 'completed'
                                      ? 'Play inside MochiDrop or open in VLC'
                                      : 'Play continuously while downloading'
                                  }
                                  className="h-8 px-2.5 rounded-xs bg-black text-white dark:bg-white dark:text-black text-xs font-semibold hover:bg-neutral-800 dark:hover:bg-neutral-200 active:scale-[0.98] transition-all inline-flex items-center gap-1 whitespace-nowrap cursor-pointer"
                                >
                                  {item.kind === 'video' || item.kind === 'audio' || item.kind === 'file' ? (
                                    <>
                                      <Play className="h-3 w-3 fill-current" />
                                      Play
                                    </>
                                  ) : (
                                    <>
                                      <Eye className="h-3 w-3" />
                                      Open
                                    </>
                                  )}
                                </button>
                              )}

                            {item.serverTransferId &&
                              !item.directOnly &&
                              (item.kind === 'video' || item.kind === 'audio' || item.kind === 'file') &&
                              (item.status === 'connecting' ||
                                item.status === 'downloading' ||
                                item.status === 'paused' ||
                                item.status === 'completed') && (
                                <a
                                  href={`/api/transfers/${encodeURIComponent(item.serverTransferId)}/playlist.xspf`}
                                  download
                                  onClick={() =>
                                    onNotify(
                                      'Downloaded VLC Playlist (.xspf) — double-click to stream continuously in VLC'
                                    )
                                  }
                                  title="Download VLC Playlist (.xspf) to stream continuously"
                                  className="h-8 px-2.5 rounded-xs border border-neutral-300 dark:border-neutral-700 text-xs font-medium text-neutral-900 dark:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-900 transition-colors inline-flex items-center gap-1 whitespace-nowrap"
                                >
                                  <MonitorPlay className="h-3 w-3" />
                                  VLC
                                </a>
                              )}

                            {(item.status === 'downloading' ||
                              item.status === 'connecting' ||
                              item.status === 'paused') &&
                              !item.directOnly && (
                                <button
                                  type="button"
                                  onClick={() => onTogglePause(item.id)}
                                  className="h-8 px-2.5 rounded-xs border border-neutral-300 dark:border-neutral-700 text-xs font-medium text-neutral-900 dark:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-900 active:scale-[0.98] transition-all inline-flex items-center gap-1 whitespace-nowrap cursor-pointer"
                                >
                                  {item.status === 'paused' ? (
                                    <>
                                      <Play className="h-3 w-3" />
                                      Resume
                                    </>
                                  ) : (
                                    <>
                                      <Pause className="h-3 w-3" />
                                      Pause
                                    </>
                                  )}
                                </button>
                              )}

                            {(item.status === 'error' || item.status === 'cancelled') &&
                              !item.directOnly && (
                                <button
                                  type="button"
                                  onClick={() => onRetryTransfer(item)}
                                  className="h-8 px-2.5 rounded-xs bg-black text-white dark:bg-white dark:text-black text-xs font-semibold hover:bg-neutral-800 dark:hover:bg-neutral-200 active:scale-[0.98] transition-all inline-flex items-center gap-1 whitespace-nowrap cursor-pointer"
                                >
                                  <RotateCcw className="h-3 w-3" />
                                  Retry
                                </button>
                              )}

                            {item.status === 'completed' && item.serverTransferId && !item.directOnly && (
                              <a
                                href={`/api/transfers/${encodeURIComponent(item.serverTransferId)}/file?download=1`}
                                download={item.title}
                                title="Export a copy to your device"
                                className="h-8 px-2 rounded-xs border border-neutral-200 dark:border-neutral-800 text-xs font-medium text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-900 transition-colors inline-flex items-center gap-1 whitespace-nowrap"
                              >
                                <Download className="h-3 w-3" />
                                Export
                              </a>
                            )}

                            {item.directOnly && (
                              <a
                                href={item.url}
                                rel="noopener noreferrer"
                                className="h-8 px-2.5 rounded-xs bg-black text-white dark:bg-white dark:text-black text-xs font-semibold hover:bg-neutral-800 dark:hover:bg-neutral-200 inline-flex items-center gap-1 whitespace-nowrap"
                              >
                                <ExternalLink className="h-3 w-3" />
                                Open Client
                              </a>
                            )}

                            <button
                              type="button"
                              onClick={() => handleCopyLink(item)}
                              title="Copy direct link"
                              className="h-8 px-2 rounded-xs border border-neutral-200 dark:border-neutral-800 text-xs font-medium text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-900 inline-flex items-center gap-1 whitespace-nowrap cursor-pointer"
                            >
                              {copiedId === item.id ? (
                                <>
                                  <Check className="h-3 w-3" />
                                  Copied
                                </>
                              ) : (
                                <>
                                  <Copy className="h-3 w-3" />
                                  Link
                                </>
                              )}
                            </button>

                            <button
                              type="button"
                              onClick={() => onMoveItem(item.id, 'up')}
                              disabled={index === 0}
                              aria-label="Move up"
                              className="h-8 w-7 rounded-xs border border-neutral-200 dark:border-neutral-800 inline-flex items-center justify-center text-neutral-500 hover:text-black dark:hover:text-white disabled:opacity-30 cursor-pointer"
                            >
                              <ArrowUp className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => onMoveItem(item.id, 'down')}
                              disabled={index === filteredDownloads.length - 1}
                              aria-label="Move down"
                              className="h-8 w-7 rounded-xs border border-neutral-200 dark:border-neutral-800 inline-flex items-center justify-center text-neutral-500 hover:text-black dark:hover:text-white disabled:opacity-30 cursor-pointer"
                            >
                              <ArrowDown className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setExpandedId(isExpanded ? null : item.id)}
                              aria-label="Toggle chunk details"
                              className="h-8 w-7 rounded-xs border border-neutral-200 dark:border-neutral-800 inline-flex items-center justify-center text-neutral-500 hover:text-black dark:hover:text-white cursor-pointer"
                            >
                              {isExpanded ? (
                                <ChevronUp className="h-3.5 w-3.5" />
                              ) : (
                                <ChevronDown className="h-3.5 w-3.5" />
                              )}
                            </button>
                            <button
                              type="button"
                              onClick={() => onRemove(item.id)}
                              aria-label="Remove transfer"
                              className="h-8 w-7 rounded-xs border border-neutral-200 dark:border-neutral-800 inline-flex items-center justify-center text-neutral-500 hover:text-red-600 dark:hover:text-red-400 cursor-pointer"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      </div>

                      {/* Segmented Multi-Link Progress Bar */}
                      <div className="h-1.5 w-full bg-neutral-200 dark:bg-neutral-900 overflow-hidden flex">
                        {totalSplit > 0 ? (
                          adapters.map((adapter) => {
                            const shareBytes = item.adapterSplit[adapter.id] || 0;
                            if (shareBytes <= 0) return null;
                            const widthPct = Math.min(100, (shareBytes / item.totalBytes) * 100);
                            return (
                              <div
                                key={adapter.id}
                                style={{ width: `${widthPct}%` }}
                                className={`h-full transition-all duration-300 ${getAdapterShadeClass(adapter.id)} border-r border-white dark:border-black last:border-r-0`}
                                title={`${adapter.deviceCode} ${adapter.name}: ${formatBytes(shareBytes)}`}
                              />
                            );
                          })
                        ) : (
                          <div
                            style={{ width: `${pct}%` }}
                            className="h-full bg-black dark:bg-white transition-all duration-300"
                          />
                        )}
                      </div>
                    </div>

                    {/* Expanded 8 MB Block Map + Track Controls */}
                    <AnimatePresence initial={false}>
                      {isExpanded && (
                        <motion.div
                          key={`details-${item.id}`}
                          initial={{ opacity: 0, y: -4 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -4 }}
                          transition={{ duration: 0.18, ease: EASE_LUXURY }}
                          className="px-4 sm:px-5 py-4 bg-neutral-50/70 dark:bg-[#060606] border-t border-neutral-200/90 dark:border-neutral-800/85 space-y-4"
                        >
                        <div className="space-y-2">
                          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                            <span className="font-semibold text-black dark:text-white">
                              {item.chunkSizeMb} MB Shared Block Map
                            </span>
                            <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono text-neutral-500 dark:text-neutral-400 tabular-nums">
                              {adapters.map((adapter) => (
                                <span key={adapter.id} className="inline-flex items-center gap-1.5">
                                  <span
                                    className={`inline-block h-2 w-2 ${getAdapterShadeClass(adapter.id)}`}
                                  />
                                  <span>{adapter.deviceCode}</span>
                                  <span>{formatBytes(item.adapterSplit[adapter.id] || 0)}</span>
                                </span>
                              ))}
                            </div>
                          </div>

                          <div className="grid grid-cols-12 sm:grid-cols-24 gap-1">
                            {item.chunks.map((chunk) => (
                              <div
                                key={chunk.index}
                                title={`Block ${chunk.index + 1}: ${chunk.progress}%`}
                                className="h-5 border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-[#0A0A0A] overflow-hidden relative"
                              >
                                <div
                                  style={{ height: `${chunk.progress}%` }}
                                  className={`absolute bottom-0 inset-x-0 transition-all duration-300 ${getAdapterShadeClass(chunk.adapterId)}`}
                                />
                              </div>
                            ))}
                          </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
                          {item.kind === 'video' && (
                            <div className="space-y-1.5">
                              <span className="text-[11px] font-medium text-neutral-500 dark:text-neutral-400 inline-flex items-center gap-1">
                                <Languages className="h-3 w-3" />
                                Source Quality & Language
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
                                    className="h-8 rounded-xs border border-neutral-300 dark:border-neutral-800 bg-white dark:bg-[#0A0A0A] px-2 text-xs text-black dark:text-white"
                                  >
                                    {item.availableQualities!.map((q) => (
                                      <option key={q} value={q}>
                                        {q}
                                      </option>
                                    ))}
                                  </select>
                                ) : (
                                  <div className="h-8 rounded-xs border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-[#0A0A0A] px-2 flex items-center text-xs font-mono text-black dark:text-white truncate">
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
                                    className="h-8 rounded-xs border border-neutral-300 dark:border-neutral-800 bg-white dark:bg-[#0A0A0A] px-2 text-xs text-black dark:text-white"
                                  >
                                    {item.availableLanguages!.map((lang) => (
                                      <option key={lang} value={lang}>
                                        {lang}
                                      </option>
                                    ))}
                                  </select>
                                ) : (
                                  <div className="h-8 rounded-xs border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-[#0A0A0A] px-2 flex items-center text-xs text-black dark:text-white truncate">
                                    {item.language || 'Source Audio'}
                                  </div>
                                )}
                              </div>
                            </div>
                          )}

                          {item.kind === 'torrent' && item.torrentFiles && (
                            <div className="space-y-1">
                              <span className="text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
                                Selected Torrent Files ({item.torrentFiles.filter((f) => f.selected).length})
                              </span>
                              <ul className="space-y-0.5 text-[11px] font-mono text-neutral-600 dark:text-neutral-400">
                                {item.torrentFiles
                                  .filter((f) => f.selected)
                                  .map((tf) => (
                                    <li key={tf.id} className="flex justify-between gap-2">
                                      <span className="truncate">{tf.name}</span>
                                      <span className="shrink-0 tabular-nums">{tf.sizeMb} MB</span>
                                    </li>
                                  ))}
                              </ul>
                            </div>
                          )}

                          <div className="space-y-1.5 min-w-0">
                            <span className="text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
                              Direct URL
                            </span>
                            <div className="flex items-center gap-1.5">
                              <input
                                type="text"
                                readOnly
                                value={item.url}
                                className="flex-1 min-w-0 h-8 rounded-xs border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-[#0A0A0A] px-2 text-[11px] font-mono text-neutral-700 dark:text-neutral-300"
                              />
                              <button
                                type="button"
                                onClick={() => handleCopyLink(item)}
                                className="h-8 px-2.5 rounded-xs border border-neutral-300 dark:border-neutral-700 text-xs font-medium text-black dark:text-white hover:bg-neutral-100 dark:hover:bg-neutral-900 shrink-0 cursor-pointer"
                              >
                                Copy
                              </button>
                            </div>
                            <div className="flex flex-wrap items-center gap-x-3 text-[11px] font-mono text-neutral-500 dark:text-neutral-400">
                              <span className="inline-flex items-center gap-1">
                                <HardDrive className="h-3 w-3" />
                                MochiDrop App Storage
                              </span>
                              <span className="inline-flex items-center gap-1">
                                <Globe className="h-3 w-3" />
                                {item.resumable ? `Range OK (${item.parallelStreams} streams)` : 'Single Stream'}
                              </span>
                            </div>
                          </div>
                        </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {/* Right Asymmetric Utility Rail: Real Transfer Speed & Stream Engine */}
      <aside className="border border-neutral-200/90 dark:border-neutral-800/90 bg-white dark:bg-[#0B0B0B] rounded-md divide-y divide-neutral-200/90 dark:divide-neutral-800/85 shadow-[0_1px_2px_rgba(0,0,0,0.03)] dark:shadow-none xl:sticky xl:top-20">
        <div className="p-5 space-y-1.5">
          <div className="flex items-center justify-between text-xs text-neutral-500 dark:text-neutral-400">
            <span>Real Download Speed</span>
            <span className="font-mono tabular-nums">
              {Math.min(6, settings.maxConnectionsPerAdapter)}x streams
            </span>
          </div>
          <div className="font-mono text-3xl font-semibold tracking-tight tabular-nums text-black dark:text-white">
            {formatSpeedMBps(aggregateSpeedBytes)}
          </div>
          <div className="text-xs font-mono tabular-nums text-neutral-500 dark:text-neutral-400">
            {formatBytes(totalTransferredBytes)}
            {totalQueueBytes > 0 ? ` / ${formatBytes(totalQueueBytes)}` : ''} transferred
          </div>
        </div>

        <div className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold text-black dark:text-white">
              Active Network Links ({enabledAdapters.length}/{adapters.length})
            </h2>
            <button
              type="button"
              onClick={onOpenNetworksView}
              className="text-[11px] text-neutral-600 dark:text-neutral-400 underline underline-offset-4 hover:text-black dark:hover:text-white cursor-pointer"
            >
              Caps & Budgets
            </button>
          </div>

          <div className="space-y-2.5">
            {adapters.map((adapter) => {
              const barPct = adapter.enabled
                ? Math.min(100, (adapter.currentSpeedMbps / Math.max(1, adapter.maxCapacityMbps)) * 100)
                : 0;
              return (
                <div key={adapter.id} className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className={`inline-block h-2.5 w-2.5 shrink-0 ${getAdapterShadeClass(adapter.id)}`}
                      />
                      <span className="text-neutral-500 dark:text-neutral-400 shrink-0">
                        {renderAdapterIcon(adapter.interfaceType)}
                      </span>
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-black dark:text-white truncate">
                          {adapter.name}
                        </div>
                        <div className="text-[11px] font-mono tabular-nums text-neutral-500 dark:text-neutral-400">
                          {adapter.deviceCode} ·{' '}
                          {adapter.enabled
                            ? `${(adapter.currentSpeedMbps / 8).toFixed(1)} MB/s`
                            : 'Off'}
                        </div>
                      </div>
                    </div>

                    <button
                      type="button"
                      role="switch"
                      aria-checked={adapter.enabled}
                      aria-label={`Toggle ${adapter.name}`}
                      onClick={() => onToggleAdapter(adapter.id)}
                      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors cursor-pointer ${
                        adapter.enabled
                          ? 'bg-black border-black dark:bg-white dark:border-white'
                          : 'bg-neutral-200 border-neutral-300 dark:bg-neutral-900 dark:border-neutral-700'
                      }`}
                    >
                      <span
                        className={`inline-block h-3.5 w-3.5 rounded-full transition-transform ${
                          adapter.enabled
                            ? 'translate-x-4.5 bg-white dark:bg-black'
                            : 'translate-x-0.5 bg-neutral-500'
                        }`}
                      />
                    </button>
                  </div>

                  <div className="h-1 w-full bg-neutral-200 dark:bg-neutral-900 overflow-hidden">
                    <div
                      style={{ width: `${barPct}%` }}
                      className={`h-full transition-all duration-300 ${getAdapterShadeClass(adapter.id)}`}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </aside>

      {/* Luxury In-App Cinema Player + External VLC / IINA / PotPlayer / MPV Streamer */}
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
