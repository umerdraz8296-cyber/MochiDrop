import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertCircle,
  ArrowDownToLine,
  CheckSquare,
  Clipboard,
  Clock3,
  Film,
  Layers,
  ListVideo,
  Loader2,
  Music,
  Search,
  Sparkles,
  Square,
  X,
} from 'lucide-react';
import {
  AddDownloadPayload,
  ConcurrentLimit,
  YouTubePlaylistResponse,
  YouTubePlaylistVideo,
  YouTubeResolutionOption,
} from '../types/plexo';

interface YouTubePlaylistModalProps {
  open: boolean;
  initialUrl?: string;
  maxConcurrent: ConcurrentLimit;
  onChangeConcurrent: (limit: ConcurrentLimit) => void;
  onClose: () => void;
  onEnqueuePlaylist: (items: AddDownloadPayload[], concurrency: ConcurrentLimit) => void;
  onNotify: (msg: string) => void;
}

const CONCURRENT_OPTIONS: ConcurrentLimit[] = [1, 2, 3, 4, 5];
const EASE_STUDIO: [number, number, number, number] = [0.16, 1, 0.3, 1];

function formatTotalDuration(totalSec: number): string {
  if (!totalSec || totalSec <= 0) return 'Duration varies';
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = Math.floor(totalSec % 60);
  if (hrs > 0) return `${hrs}h ${mins}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

function sanitizePlaylistFilename(title: string, index: number, isAudio: boolean): string {
  const num = String(index).padStart(2, '0');
  const clean = title
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 96);
  const ext = isAudio ? '.m4a' : '.mp4';
  return `${num} - ${clean || `Video ${num}`}${ext}`;
}

function isSafeHttpsThumb(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

export const YouTubePlaylistModal: React.FC<YouTubePlaylistModalProps> = ({
  open,
  initialUrl,
  maxConcurrent,
  onChangeConcurrent,
  onClose,
  onEnqueuePlaylist,
  onNotify,
}) => {
  const [playlistInput, setPlaylistInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playlistData, setPlaylistData] = useState<YouTubePlaylistResponse | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectedResolutionId, setSelectedResolutionId] = useState<string>('1080p');
  const [localConcurrent, setLocalConcurrent] = useState<ConcurrentLimit>(maxConcurrent);
  const [filterQuery, setFilterQuery] = useState('');
  const [rangeStart, setRangeStart] = useState('1');
  const [rangeEnd, setRangeEnd] = useState('');
  const [failedThumbs, setFailedThumbs] = useState<Set<string>>(new Set());

  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const lastLoadedInitialRef = useRef<string>('');

  useEffect(() => {
    setLocalConcurrent(maxConcurrent);
  }, [maxConcurrent]);

  // Escape key closes modal
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const loadPlaylist = useCallback(async (rawOverride?: string) => {
    const raw = (rawOverride ?? playlistInput).trim();
    if (!raw) {
      setError('Paste one or more YouTube playlist links (e.g. youtube.com/playlist?list=...).');
      return;
    }

    setLoading(true);
    setError(null);
    setFailedThumbs(new Set());

    try {
      const res = await fetch('/api/youtube/playlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: raw }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || 'Could not load YouTube playlist.');
        setPlaylistData(null);
        return;
      }

      const parsed = data as YouTubePlaylistResponse;
      setPlaylistData(parsed);
      setSelectedIds(new Set(parsed.videos.map((v) => v.videoId)));
      setRangeStart('1');
      setRangeEnd(String(parsed.videos.length));
      setFilterQuery('');

      const preferred =
        parsed.availableResolutions.find((r) => r.id === '1080p') ||
        parsed.availableResolutions[0];
      if (preferred) {
        setSelectedResolutionId(preferred.id);
      }
    } catch {
      setError('Network error while reading YouTube playlist. Please try again.');
      setPlaylistData(null);
    } finally {
      setLoading(false);
    }
  }, [playlistInput]);

  // Auto-populate and fetch if opened via pasted/detected playlist link
  useEffect(() => {
    if (!open) {
      lastLoadedInitialRef.current = '';
      return;
    }
    const cleanInit = (initialUrl || '').trim();
    if (cleanInit && cleanInit !== lastLoadedInitialRef.current) {
      lastLoadedInitialRef.current = cleanInit;
      setPlaylistInput(cleanInit);
      void loadPlaylist(cleanInit);
    } else if (!cleanInit) {
      setTimeout(() => inputRef.current?.focus(), 70);
    }
  }, [open, initialUrl, loadPlaylist]);

  const selectedResolution: YouTubeResolutionOption | null = useMemo(() => {
    if (!playlistData) return null;
    return (
      playlistData.availableResolutions.find((r) => r.id === selectedResolutionId) ||
      playlistData.availableResolutions[0] ||
      null
    );
  }, [playlistData, selectedResolutionId]);

  const filteredVideos = useMemo(() => {
    if (!playlistData) return [];
    const q = filterQuery.trim().toLowerCase();
    if (!q) return playlistData.videos;
    return playlistData.videos.filter(
      (v) =>
        v.title.toLowerCase().includes(q) ||
        v.author.toLowerCase().includes(q) ||
        String(v.index).includes(q)
    );
  }, [playlistData, filterQuery]);

  const selectedCount = useMemo(() => {
    if (!playlistData) return 0;
    return playlistData.videos.filter((v) => selectedIds.has(v.videoId)).length;
  }, [playlistData, selectedIds]);

  const selectedDurationSec = useMemo(() => {
    if (!playlistData) return 0;
    return playlistData.videos.reduce(
      (sum, v) => (selectedIds.has(v.videoId) ? sum + (v.durationSec || 0) : sum),
      0
    );
  }, [playlistData, selectedIds]);

  async function handlePasteClick() {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) {
        onNotify('Clipboard is empty');
        return;
      }
      setPlaylistInput(text);
      setError(null);
      void loadPlaylist(text);
    } catch {
      onNotify('Press Ctrl+V / Cmd+V inside the playlist box');
    }
  }

  function handleSelectAll() {
    if (!playlistData) return;
    setSelectedIds(new Set(playlistData.videos.map((v) => v.videoId)));
  }

  function handleSelectNone() {
    setSelectedIds(new Set());
  }

  function handleApplyRange() {
    if (!playlistData) return;
    const total = playlistData.videos.length;
    const from = Math.max(1, Math.min(total, Number(rangeStart) || 1));
    const to = Math.max(from, Math.min(total, Number(rangeEnd) || total));
    setRangeStart(String(from));
    setRangeEnd(String(to));
    const next = new Set<string>();
    for (const v of playlistData.videos) {
      if (v.index >= from && v.index <= to) {
        next.add(v.videoId);
      }
    }
    setSelectedIds(next);
  }

  function toggleVideo(videoId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(videoId)) next.delete(videoId);
      else next.add(videoId);
      return next;
    });
  }

  function handleConcurrentPick(n: ConcurrentLimit) {
    setLocalConcurrent(n);
    onChangeConcurrent(n);
  }

  function handleStartPlaylistDownload() {
    if (!playlistData || !selectedResolution) return;
    const chosen: YouTubePlaylistVideo[] = playlistData.videos.filter((v) =>
      selectedIds.has(v.videoId)
    );
    if (chosen.length === 0) {
      setError('Select at least one video from the playlist to download.');
      return;
    }

    const isAudio = selectedResolution.kind === 'audio';
    const payloads: AddDownloadPayload[] = chosen.map((video) => ({
      title: sanitizePlaylistFilename(video.title, video.index, isAudio),
      url: video.url,
      domain: 'youtube.com',
      kind: isAudio ? 'audio' : 'video',
      protocol: 'HTTPS',
      totalBytes: 0,
      quality: selectedResolution.label,
      availableQualities: playlistData.availableResolutions.map((r) => r.label),
      source: 'playlist',
      resumable: true,
      playlistTitle: video.playlistTitle || playlistData.title,
      playlistIndex: video.index,
      durationText: video.durationText,
      thumbnailUrl: isSafeHttpsThumb(video.thumbnailUrl) ? video.thumbnailUrl : undefined,
    }));

    onEnqueuePlaylist(payloads, localConcurrent);
    onClose();
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="yt-playlist-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          onClick={onClose}
          className="fixed inset-0 z-50 bg-black/65 backdrop-blur-sm flex items-center justify-center p-3 sm:p-5"
        >
          <motion.div
            key="yt-playlist-dialog"
            initial={{ opacity: 0, y: 12, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.97 }}
            transition={{ duration: 0.18, ease: EASE_STUDIO }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-3xl max-h-[90vh] flex flex-col rounded-2xl border border-[#0F241B]/12 dark:border-white/[0.11] bg-white/92 dark:bg-[#090F0D]/92 backdrop-blur-xl shadow-2xl overflow-hidden"
          >
            {/* Header */}
            <div className="px-5 py-3.5 border-b border-[#0F241B]/10 dark:border-white/[0.08] bg-white/50 dark:bg-white/[0.025] flex items-center justify-between gap-3 shrink-0">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="h-7 w-7 rounded-lg bg-[#0D231A] border border-[#2FD48B]/40 text-[#2FD48B] flex items-center justify-center shrink-0">
                  <ListVideo className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <h3 className="font-display text-sm font-semibold text-[#111B16] dark:text-white truncate">
                    YouTube Playlist Batch Downloader
                  </h3>
                  <p className="text-[11px] text-[#52655C] dark:text-[#8E9B95] truncate">
                    Paste one or more playlist links, choose one resolution for the whole session, and queue automatically
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close playlist modal"
                className="p-1.5 rounded-lg text-[#64786E] hover:text-[#111B16] dark:hover:text-white hover:bg-black/[0.05] dark:hover:bg-white/[0.08] cursor-pointer shrink-0"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Scrollable Body */}
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {/* Playlist Link Input */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void loadPlaylist();
                }}
                className="space-y-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <label className="text-xs font-medium text-[#22352C] dark:text-[#D1DCD6]">
                    YouTube Playlist Link(s)
                  </label>
                  <span className="text-[11px] text-[#64786E] dark:text-[#7A8A83]">
                    Supports single or multiple playlist URLs (up to 5 playlists per batch)
                  </span>
                </div>

                <div className="flex flex-col sm:flex-row gap-2">
                  <div className="relative flex-1">
                    <textarea
                      ref={inputRef}
                      rows={2}
                      value={playlistInput}
                      onChange={(e) => {
                        setPlaylistInput(e.target.value);
                        if (error) setError(null);
                      }}
                      onPaste={(e) => {
                        const pasted = e.clipboardData.getData('text').trim();
                        if (pasted && !playlistInput.trim()) {
                          setTimeout(() => void loadPlaylist(pasted), 0);
                        }
                      }}
                      placeholder="https://www.youtube.com/playlist?list=PL...&#10;(Paste another playlist link on a new line to combine batches)"
                      className="w-full rounded-xl border border-[#0F241B]/12 dark:border-white/[0.1] bg-white/80 dark:bg-black/45 px-3 py-2.5 pr-20 text-xs font-mono text-[#111B16] dark:text-white placeholder:text-[#768A80] dark:placeholder:text-[#66756E] focus:bg-white dark:focus:bg-black/60 focus:border-[#1B6B4D] dark:focus:border-[#2FD48B]/60 resize-none transition-colors"
                    />
                    <button
                      type="button"
                      onClick={() => void handlePasteClick()}
                      className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md border border-[#0F241B]/12 dark:border-white/[0.1] bg-white/90 dark:bg-white/[0.06] px-2 py-1 text-[11px] font-medium text-[#22352C] dark:text-[#D5DFDA] hover:border-[#1B6B4D]/40 dark:hover:border-[#2FD48B]/40 cursor-pointer"
                    >
                      <Clipboard className="h-3 w-3" />
                      Paste
                    </button>
                  </div>

                  <button
                    type="submit"
                    disabled={loading || !playlistInput.trim()}
                    className="sm:self-stretch h-10 sm:h-auto px-4 rounded-xl bg-[#1C6B4D] hover:bg-[#16593F] dark:bg-[#1A5E44]/90 dark:hover:bg-[#217455] border border-[#2FD48B]/35 text-white text-xs font-semibold shadow-[0_0_20px_rgba(34,197,126,0.16)] inline-flex items-center justify-center gap-1.5 whitespace-nowrap disabled:opacity-45 cursor-pointer transition-colors shrink-0"
                  >
                    {loading ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Loading...
                      </>
                    ) : (
                      <>
                        <ListVideo className="h-3.5 w-3.5" />
                        Load Playlist
                      </>
                    )}
                  </button>
                </div>

                {error && (
                  <p className="text-xs font-medium text-rose-600 dark:text-rose-400 flex items-center gap-1.5">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                    <span>{error}</span>
                  </p>
                )}
              </form>

              {/* Session Controls: Always visible Concurrency + Resolution once loaded */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                {/* Whole-Session Resolution Selector */}
                <div className="rounded-xl border border-[#0F241B]/10 dark:border-white/[0.08] bg-white/60 dark:bg-white/[0.03] p-3.5 space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-[#111B16] dark:text-white inline-flex items-center gap-1.5">
                      <Sparkles className="h-3.5 w-3.5 text-[#156E4B] dark:text-[#3BE098]" />
                      Session Resolution
                    </span>
                    <span className="text-[11px] text-[#64786E] dark:text-[#7A8A83]">
                      {playlistData
                        ? playlistData.resolutionsSource === 'probed'
                          ? 'Verified on playlist'
                          : 'Applied to all videos'
                        : 'Load playlist first'}
                    </span>
                  </div>

                  {playlistData ? (
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                      {playlistData.availableResolutions.map((res) => {
                        const active = selectedResolution?.id === res.id;
                        return (
                          <button
                            key={res.id}
                            type="button"
                            onClick={() => setSelectedResolutionId(res.id)}
                            className={`h-8 px-2.5 rounded-lg border text-[11px] font-semibold inline-flex items-center justify-center gap-1 transition-all cursor-pointer truncate ${
                              active
                                ? 'bg-[#E2F5EC] border-[#1C6B4D]/35 text-[#126646] dark:bg-[#0F2B20]/90 dark:border-[#2FD48B]/45 dark:text-[#3BE098]'
                                : 'bg-white/75 dark:bg-white/[0.04] border-[#0F241B]/12 dark:border-white/[0.1] text-[#354B41] dark:text-[#C5D1CB] hover:border-[#1B6B4D]/40 dark:hover:border-[#2FD48B]/35'
                            }`}
                          >
                            {res.kind === 'audio' ? (
                              <Music className="h-3 w-3 shrink-0" />
                            ) : (
                              <Film className="h-3 w-3 shrink-0" />
                            )}
                            <span className="truncate">{res.id === 'audio' ? 'Audio M4A' : res.id}</span>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-[11px] text-[#64786E] dark:text-[#7A8A83] leading-relaxed">
                      Available video resolutions (up to 4K / 1080p / 720p / Audio Only) will appear here for the whole playlist session.
                    </p>
                  )}
                </div>

                {/* Simultaneous Downloads Selector (1..5 at a time) */}
                <div className="rounded-xl border border-[#0F241B]/10 dark:border-white/[0.08] bg-white/60 dark:bg-white/[0.03] p-3.5 space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-[#111B16] dark:text-white inline-flex items-center gap-1.5">
                      <Layers className="h-3.5 w-3.5 text-[#156E4B] dark:text-[#3BE098]" />
                      Download at a Time
                    </span>
                    <span className="font-mono text-[11px] font-semibold tabular-nums text-[#156E4B] dark:text-[#3BE098]">
                      {localConcurrent} {localConcurrent === 1 ? 'file' : 'files'} at once
                    </span>
                  </div>

                  <div className="grid grid-cols-5 gap-1.5">
                    {CONCURRENT_OPTIONS.map((num) => {
                      const active = localConcurrent === num;
                      return (
                        <button
                          key={num}
                          type="button"
                          onClick={() => handleConcurrentPick(num)}
                          className={`h-8 rounded-lg border font-mono text-xs font-semibold tabular-nums transition-all cursor-pointer ${
                            active
                              ? 'bg-[#E2F5EC] border-[#1C6B4D]/35 text-[#126646] dark:bg-[#0F2B20]/90 dark:border-[#2FD48B]/45 dark:text-[#3BE098]'
                              : 'bg-white/75 dark:bg-white/[0.04] border-[#0F241B]/12 dark:border-white/[0.1] text-[#354B41] dark:text-[#C5D1CB] hover:border-[#1B6B4D]/40 dark:hover:border-[#2FD48B]/35'
                          }`}
                        >
                          {num}
                        </button>
                      );
                    })}
                  </div>

                  <p className="text-[11px] text-[#52655C] dark:text-[#8E9B95]">
                    Runs {localConcurrent} at a time — as soon as one finishes, the next queued video starts automatically.
                  </p>
                </div>
              </div>

              {/* Loaded Playlist Summary & Selectable Video List */}
              {playlistData && (
                <div className="space-y-3">
                  {/* Playlist Metadata Summary */}
                  <div className="rounded-xl border border-[#1C6B4D]/20 dark:border-[#2FD48B]/25 bg-[#EAF7F1]/80 dark:bg-[#0D211A]/60 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <h4 className="text-xs sm:text-sm font-semibold text-[#111B16] dark:text-white truncate">
                        {playlistData.title}
                      </h4>
                      <p className="text-[11px] text-[#52655C] dark:text-[#8E9B95] flex flex-wrap items-center gap-x-2">
                        <span>{playlistData.author}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums">
                          {playlistData.videoCount} {playlistData.videoCount === 1 ? 'video' : 'videos'}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="inline-flex items-center gap-1 font-mono tabular-nums">
                          <Clock3 className="h-3 w-3" />
                          {formatTotalDuration(selectedDurationSec || playlistData.totalDurationSec)}
                        </span>
                        {playlistData.truncated && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="text-amber-600 dark:text-amber-400">
                              First 200 items loaded
                            </span>
                          </>
                        )}
                      </p>
                    </div>

                    <div className="font-mono text-xs font-semibold tabular-nums text-[#126646] dark:text-[#3BE098] shrink-0">
                      {selectedCount}/{playlistData.videoCount} selected
                    </div>
                  </div>

                  {/* Selection Controls: Select All / None, Range, Search */}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        onClick={handleSelectAll}
                        className="h-8 px-2.5 rounded-lg border border-[#0F241B]/12 dark:border-white/[0.1] bg-white/75 dark:bg-white/[0.04] text-[11px] font-medium text-[#22352C] dark:text-[#D5DFDA] hover:border-[#1B6B4D]/40 dark:hover:border-[#2FD48B]/35 inline-flex items-center gap-1 cursor-pointer"
                      >
                        <CheckSquare className="h-3.5 w-3.5 text-[#156E4B] dark:text-[#3BE098]" />
                        Select All
                      </button>
                      <button
                        type="button"
                        onClick={handleSelectNone}
                        className="h-8 px-2.5 rounded-lg border border-[#0F241B]/12 dark:border-white/[0.1] bg-white/75 dark:bg-white/[0.04] text-[11px] font-medium text-[#4D6157] dark:text-[#96A39D] hover:border-[#1B6B4D]/40 dark:hover:border-[#2FD48B]/35 inline-flex items-center gap-1 cursor-pointer"
                      >
                        <Square className="h-3.5 w-3.5" />
                        None
                      </button>

                      {/* Index Range Selector */}
                      <div className="inline-flex items-center gap-1 pl-1">
                        <span className="text-[11px] text-[#64786E] dark:text-[#7A8A83]">Range</span>
                        <input
                          type="number"
                          min={1}
                          max={playlistData.videoCount}
                          value={rangeStart}
                          onChange={(e) => setRangeStart(e.target.value)}
                          aria-label="Start index"
                          className="w-12 h-8 rounded-lg border border-[#0F241B]/12 dark:border-white/[0.1] bg-white/80 dark:bg-black/40 px-1.5 text-center font-mono text-[11px] tabular-nums text-[#111B16] dark:text-white"
                        />
                        <span className="text-[11px] text-[#64786E]">–</span>
                        <input
                          type="number"
                          min={1}
                          max={playlistData.videoCount}
                          value={rangeEnd}
                          onChange={(e) => setRangeEnd(e.target.value)}
                          aria-label="End index"
                          className="w-12 h-8 rounded-lg border border-[#0F241B]/12 dark:border-white/[0.1] bg-white/80 dark:bg-black/40 px-1.5 text-center font-mono text-[11px] tabular-nums text-[#111B16] dark:text-white"
                        />
                        <button
                          type="button"
                          onClick={handleApplyRange}
                          className="h-8 px-2 rounded-lg border border-[#1C6B4D]/25 dark:border-[#2FD48B]/30 bg-[#E2F5EC] dark:bg-[#0F2B20]/80 text-[11px] font-medium text-[#126646] dark:text-[#3BE098] hover:bg-[#CBEEDB] dark:hover:bg-[#14392B] cursor-pointer"
                        >
                          Apply
                        </button>
                      </div>
                    </div>

                    <div className="relative w-full sm:w-48">
                      <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[#687B72] dark:text-[#76857E]" />
                      <input
                        type="text"
                        value={filterQuery}
                        onChange={(e) => setFilterQuery(e.target.value)}
                        placeholder="Filter videos..."
                        className="w-full h-8 rounded-lg border border-[#0F241B]/12 dark:border-white/[0.1] bg-white/80 dark:bg-black/40 pl-8 pr-2.5 text-xs text-[#111B16] dark:text-white placeholder:text-[#768A80] dark:placeholder:text-[#66756E]"
                      />
                    </div>
                  </div>

                  {/* Video Items List */}
                  <div className="rounded-xl border border-[#0F241B]/10 dark:border-white/[0.09] bg-white/60 dark:bg-black/35 divide-y divide-[#0F241B]/8 dark:divide-white/[0.07] max-h-72 overflow-y-auto">
                    {filteredVideos.length === 0 ? (
                      <p className="p-6 text-center text-xs text-[#64786E] dark:text-[#7A8A83]">
                        No videos match &ldquo;{filterQuery}&rdquo;.
                      </p>
                    ) : (
                      filteredVideos.map((video) => {
                        const checked = selectedIds.has(video.videoId);
                        const thumbOk =
                          isSafeHttpsThumb(video.thumbnailUrl) &&
                          !failedThumbs.has(video.videoId);

                        return (
                          <label
                            key={video.videoId}
                            className={`flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors ${
                              checked
                                ? 'bg-[#EAF7F1]/70 dark:bg-[#0D211A]/50 hover:bg-[#DFF3EA] dark:hover:bg-[#112A21]/70'
                                : 'opacity-60 hover:opacity-90 hover:bg-black/[0.025] dark:hover:bg-white/[0.035]'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleVideo(video.videoId)}
                              className="h-3.5 w-3.5 accent-[#2FD48B] shrink-0"
                            />

                            <span className="w-6 text-right font-mono text-[11px] tabular-nums text-[#687B72] dark:text-[#76857E] shrink-0">
                              {String(video.index).padStart(2, '0')}
                            </span>

                            {/* Compact Thumbnail */}
                            <div className="h-9 w-16 rounded-md overflow-hidden bg-black/10 dark:bg-white/[0.06] shrink-0 flex items-center justify-center relative">
                              {thumbOk ? (
                                <img
                                  src={video.thumbnailUrl}
                                  alt=""
                                  loading="lazy"
                                  referrerPolicy="no-referrer"
                                  onError={() =>
                                    setFailedThumbs((prev) => new Set(prev).add(video.videoId))
                                  }
                                  className="h-full w-full object-cover"
                                />
                              ) : (
                                <Film className="h-4 w-4 text-[#156E4B] dark:text-[#3BE098]" />
                              )}
                            </div>

                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-medium text-[#111B16] dark:text-white truncate">
                                {video.title}
                              </p>
                              <p className="text-[11px] text-[#64786E] dark:text-[#7E8E87] truncate">
                                {video.author}
                                {playlistData.playlistCount > 1 && video.playlistTitle
                                  ? ` · ${video.playlistTitle}`
                                  : ''}
                              </p>
                            </div>

                            <span className="font-mono text-[11px] tabular-nums text-[#52655C] dark:text-[#8A9891] shrink-0">
                              {video.durationText || '--:--'}
                            </span>
                          </label>
                        );
                      })
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-5 py-3.5 border-t border-[#0F241B]/10 dark:border-white/[0.08] bg-white/50 dark:bg-white/[0.025] flex flex-wrap items-center justify-between gap-3 shrink-0">
              <div className="text-[11px] text-[#52655C] dark:text-[#8E9B95] font-mono tabular-nums">
                {playlistData && selectedResolution ? (
                  <span>
                    {selectedResolution.label} · {localConcurrent} at a time · Auto-next queue
                  </span>
                ) : (
                  <span>Paste a YouTube playlist URL to inspect all videos</span>
                )}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="h-9 px-3.5 rounded-xl border border-[#0F241B]/12 dark:border-white/[0.1] bg-white/70 dark:bg-white/[0.04] text-xs font-medium text-[#4D6157] dark:text-[#96A39D] hover:bg-white dark:hover:bg-white/[0.08] cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!playlistData || selectedCount === 0 || loading}
                  onClick={handleStartPlaylistDownload}
                  className="h-9 px-4 rounded-xl bg-[#1C6B4D] hover:bg-[#16593F] dark:bg-[#1A5E44]/90 dark:hover:bg-[#217455] border border-[#2FD48B]/35 text-white text-xs font-semibold shadow-[0_0_22px_rgba(34,197,126,0.18)] inline-flex items-center gap-1.5 disabled:opacity-45 cursor-pointer transition-colors"
                >
                  <ArrowDownToLine className="h-3.5 w-3.5" />
                  {selectedCount > 0
                    ? `Download Playlist (${selectedCount} ${selectedCount === 1 ? 'video' : 'videos'})`
                    : 'Download Playlist'}
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
