import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AudioLines,
  Check,
  Copy,
  Download,
  Film,
  Loader2,
  Maximize2,
  Minimize2,
  MonitorPlay,
  Music,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Terminal,
  Tv,
  X,
} from 'lucide-react';
import { DownloadItem, DownloadKind } from '../types/plexo';
import { formatBytes, formatSpeedMBps } from '../utils/format';

export interface ActivePlayerSession {
  mode: 'transfer' | 'online';
  transferId?: string;
  title: string;
  url: string;
  resolvedUrl?: string;
  kind: DownloadKind;
  quality?: string;
  language?: string;
  sizeBytes?: number;
}

interface ProbedAudioTrack {
  index: number;
  codec: string;
  channels: number;
  language: string;
  title: string;
  label: string;
}

interface MediaProbePayload {
  durationSec: number;
  videoCodec: string;
  videoPixFmt: string;
  width: number;
  height: number;
  audioTracks: ProbedAudioTrack[];
  hasVideo: boolean;
  hasAudio: boolean;
  needsTranscode: boolean;
  filename?: string;
  directStreamUrl?: string;
}

interface MediaPlayerModalProps {
  session: ActivePlayerSession | null;
  liveTransfer?: DownloadItem | null;
  onClose: () => void;
  onTogglePause?: (id: string) => void;
  onDownloadOnlineSession?: (session: ActivePlayerSession) => void;
  onNotify: (msg: string) => void;
}

const EASE_LUXURY: [number, number, number, number] = [0.16, 1, 0.3, 1];
const SKIP_STEP_SECONDS = 10;

function formatClock(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00';
  const secs = Math.floor(totalSeconds);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

export const MediaPlayerModal: React.FC<MediaPlayerModalProps> = ({
  session,
  liveTransfer,
  onClose,
  onTogglePause,
  onDownloadOnlineSession,
  onNotify,
}) => {
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<MediaProbePayload | null>(null);
  const [engineMode, setEngineMode] = useState<'direct' | 'compat' | 'client'>('direct');
  const [audioTrackIdx, setAudioTrackIdx] = useState(0);
  const [seekOffsetSec, setSeekOffsetSec] = useState(0);
  const [localTimeSec, setLocalTimeSec] = useState(0);
  const [mediaDurationSec, setMediaDurationSec] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);
  const [buffering, setBuffering] = useState(true);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<'url' | 'cmd' | null>(null);
  const [clearMode, setClearMode] = useState(false);
  const [hudVisible, setHudVisible] = useState(true);
  const [skipFeedback, setSkipFeedback] = useState<{
    delta: number;
    seq: number;
  } | null>(null);

  const triedModesRef = useRef<Set<'direct' | 'compat' | 'client'>>(new Set());
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const hudTimerRef = useRef<number | null>(null);
  const skipTimerRef = useRef<number | null>(null);

  const isTransferMode =
    session?.mode === 'transfer' && Boolean(liveTransfer?.serverTransferId || session.transferId);
  const serverId = liveTransfer?.serverTransferId || session?.transferId || '';
  const isMediaKind =
    session?.kind === 'video' || session?.kind === 'audio' || session?.kind === 'file';

  // Probe the media stream via ffprobe when session opens so we pick the right engine & audio tracks
  useEffect(() => {
    if (!session) return;

    triedModesRef.current = new Set();
    setProbe(null);
    setStreamError(null);
    setAudioTrackIdx(0);
    setSeekOffsetSec(0);
    setLocalTimeSec(0);
    setMediaDurationSec(0);
    setIsPlaying(true);
    setCopiedKey(null);
    setBuffering(true);
    setClearMode(false);
    setHudVisible(true);
    setSkipFeedback(null);

    if (!isMediaKind) {
      setProbing(false);
      setEngineMode('direct');
      return;
    }

    const controller = new AbortController();
    setProbing(true);

    const probeUrl = isTransferMode
      ? `/api/play/probe?transferId=${encodeURIComponent(serverId)}`
      : `/api/play/probe?url=${encodeURIComponent(session.resolvedUrl || session.url)}`;

    fetch(probeUrl, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: MediaProbePayload | null) => {
        if (controller.signal.aborted) return;
        if (data) {
          setProbe(data);
          setEngineMode(data.needsTranscode ? 'compat' : 'direct');
        } else {
          const looksNonNative = /\.(mkv|avi|ts|m2ts|flv|wmv|m3u8|mov)(\?|$)/i.test(
            `${session.title} ${session.url}`
          );
          setEngineMode(looksNonNative ? 'compat' : 'direct');
        }
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        const looksNonNative = /\.(mkv|avi|ts|m2ts|flv|wmv|m3u8|mov)(\?|$)/i.test(
          `${session.title} ${session.url}`
        );
        setEngineMode(looksNonNative ? 'compat' : 'direct');
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setProbing(false);
        }
      });

    return () => controller.abort();
  }, [session?.url, session?.resolvedUrl, session?.transferId, session?.mode, isMediaKind, isTransferMode, serverId]);

  const totalDurationSec = probe?.durationSec || mediaDurationSec || 0;
  const effectiveCurrentSec = engineMode === 'compat' ? seekOffsetSec + localTimeSec : localTimeSec;

  const revealHudTemporarily = useCallback(() => {
    setHudVisible(true);
    if (hudTimerRef.current) {
      window.clearTimeout(hudTimerRef.current);
    }
    hudTimerRef.current = window.setTimeout(() => {
      setHudVisible(false);
    }, 2800);
  }, []);

  useEffect(() => {
    return () => {
      if (hudTimerRef.current) window.clearTimeout(hudTimerRef.current);
      if (skipTimerRef.current) window.clearTimeout(skipTimerRef.current);
    };
  }, []);

  const handleCompatSeek = useCallback(
    (targetSec: number) => {
      const maxBound = totalDurationSec > 0 ? Math.max(0, totalDurationSec - 1) : targetSec;
      const clamped = Math.max(0, Math.min(maxBound, targetSec));
      setBuffering(true);
      setStreamError(null);
      setLocalTimeSec(0);
      setSeekOffsetSec(clamped);
    },
    [totalDurationSec]
  );

  const handleSkipSeconds = useCallback(
    (deltaSec: number) => {
      if (!isMediaKind || streamError) return;

      if (engineMode === 'compat') {
        const target = Math.max(0, effectiveCurrentSec + deltaSec);
        handleCompatSeek(target);
      } else {
        const media = videoRef.current || audioRef.current;
        if (!media) return;
        const knownDur =
          Number.isFinite(media.duration) && media.duration > 0
            ? media.duration
            : totalDurationSec > 0
            ? totalDurationSec
            : Number.POSITIVE_INFINITY;
        const base = Number.isFinite(media.currentTime) ? media.currentTime : localTimeSec;
        const nextTime = Math.max(0, Math.min(knownDur, base + deltaSec));
        try {
          media.currentTime = nextTime;
          setLocalTimeSec(nextTime);
        } catch {
          // ignore if stream not yet seekable
        }
      }

      setSkipFeedback((prev) => ({ delta: deltaSec, seq: (prev?.seq ?? 0) + 1 }));
      if (skipTimerRef.current) window.clearTimeout(skipTimerRef.current);
      skipTimerRef.current = window.setTimeout(() => {
        setSkipFeedback(null);
      }, 750);
      revealHudTemporarily();
    },
    [
      effectiveCurrentSec,
      engineMode,
      handleCompatSeek,
      isMediaKind,
      localTimeSec,
      revealHudTemporarily,
      streamError,
      totalDurationSec,
    ]
  );

  const handleTogglePlayPlayback = useCallback(() => {
    const media = videoRef.current || audioRef.current;
    if (!media) return;
    if (media.paused) {
      void media.play().catch(() => {});
    } else {
      media.pause();
    }
    revealHudTemporarily();
  }, [revealHudTemporarily]);

  // Keyboard controls: Escape, ArrowLeft/J (-10s), ArrowRight/L (+10s), Space/K (Play/Pause), C (Clear Mode)
  useEffect(() => {
    if (!session) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isFormField =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);

      if (e.key === 'Escape') {
        if (clearMode) {
          setClearMode(false);
        } else {
          onClose();
        }
        return;
      }

      if (isFormField || !isMediaKind) return;

      if (e.key === 'ArrowLeft' || e.key === 'j' || e.key === 'J') {
        e.preventDefault();
        handleSkipSeconds(-SKIP_STEP_SECONDS);
      } else if (e.key === 'ArrowRight' || e.key === 'l' || e.key === 'L') {
        e.preventDefault();
        handleSkipSeconds(SKIP_STEP_SECONDS);
      } else if (e.key === ' ' || e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        handleTogglePlayPlayback();
      } else if (e.key === 'c' || e.key === 'C') {
        e.preventDefault();
        setClearMode((prev) => !prev);
        revealHudTemporarily();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    session,
    clearMode,
    onClose,
    isMediaKind,
    handleSkipSeconds,
    handleTogglePlayPlayback,
    revealHudTemporarily,
  ]);

  const inAppMediaSrc = useMemo(() => {
    if (!session) return '';
    if (session.kind === 'image' || session.kind === 'document') {
      return isTransferMode
        ? `/api/transfers/${encodeURIComponent(serverId)}/file`
        : `/api/play/proxy?url=${encodeURIComponent(session.resolvedUrl || session.url)}`;
    }

    // Client-direct mode streams straight from the user's browser IP (works for IP-locked / Cloudflare tokens)
    if (engineMode === 'client') {
      return probe?.directStreamUrl || session.resolvedUrl || session.url;
    }

    const params = new URLSearchParams();
    if (isTransferMode) {
      params.set('transferId', serverId);
    } else {
      params.set('url', session.resolvedUrl || session.url);
    }
    params.set('mode', engineMode);
    if (engineMode === 'compat') {
      if (seekOffsetSec > 0) params.set('start', seekOffsetSec.toFixed(2));
      params.set('audioTrack', String(audioTrackIdx));
      if (probe?.videoCodec) params.set('vcodec', probe.videoCodec);
      if (probe?.videoPixFmt) params.set('pixfmt', probe.videoPixFmt);
      if (session.kind === 'audio' || (probe && !probe.hasVideo)) {
        params.set('hasVideo', '0');
      }
    }
    return `/api/play/stream?${params.toString()}`;
  }, [
    session,
    isTransferMode,
    serverId,
    engineMode,
    seekOffsetSec,
    audioTrackIdx,
    probe,
  ]);

  // Direct public stream URL for VLC / MPV / IINA / PotPlayer (never blocked by cloud auth!)
  const directExternalStreamUrl = useMemo(() => {
    if (!session) return '';
    if (probe?.directStreamUrl) return probe.directStreamUrl;
    return session.resolvedUrl || session.url;
  }, [probe?.directStreamUrl, session]);

  const xspfPlaylistHref = useMemo(() => {
    if (!session) return '';
    if (isTransferMode) {
      return `/api/transfers/${encodeURIComponent(serverId)}/playlist.xspf`;
    }
    return `/api/play/playlist.xspf?url=${encodeURIComponent(
      directExternalStreamUrl
    )}&title=${encodeURIComponent(session.title)}`;
  }, [directExternalStreamUrl, isTransferMode, serverId, session]);

  const m3uPlaylistHref = useMemo(() => {
    if (!session) return '';
    if (isTransferMode) {
      return `/api/transfers/${encodeURIComponent(serverId)}/playlist.m3u`;
    }
    return `/api/play/playlist.m3u?url=${encodeURIComponent(
      directExternalStreamUrl
    )}&title=${encodeURIComponent(session.title)}`;
  }, [directExternalStreamUrl, isTransferMode, serverId, session]);

  const exportFileHref =
    isTransferMode && liveTransfer?.status === 'completed'
      ? `/api/transfers/${encodeURIComponent(serverId)}/file?download=1`
      : null;

  const progressPct =
    liveTransfer && liveTransfer.totalBytes > 0
      ? Math.min(100, (liveTransfer.downloadedBytes / liveTransfer.totalBytes) * 100)
      : liveTransfer?.status === 'completed'
      ? 100
      : 0;

  function handleVideoError() {
    triedModesRef.current.add(engineMode);

    // Stage 1 fallback: Direct Proxy -> Universal FFmpeg Engine (fixes MKV, AC3, HEVC, AVI, TS)
    if (!triedModesRef.current.has('compat')) {
      setStreamError(null);
      setBuffering(true);
      setEngineMode('compat');
      onNotify('Switched to Universal Engine for full MKV / audio compatibility');
      return;
    }

    // Stage 2 fallback: Server proxy blocked (e.g. IP-locked token) -> Direct from your browser IP
    if (
      !triedModesRef.current.has('client') &&
      directExternalStreamUrl &&
      /^https?:\/\//i.test(directExternalStreamUrl)
    ) {
      setStreamError(null);
      setBuffering(true);
      setEngineMode('client');
      onNotify('Streaming directly from your browser connection');
      return;
    }

    setBuffering(false);
    setStreamError(
      'This stream could not be decoded in the browser (the remote link may have expired or requires VLC codecs). Download the VLC Playlist (.xspf) or copy the Stream URL below.'
    );
  }

  function handleAudioTrackSwitch(newIdx: number) {
    const currentAbsolute = Math.max(0, effectiveCurrentSec);
    setAudioTrackIdx(newIdx);
    setBuffering(true);
    setStreamError(null);
    setLocalTimeSec(0);
    setSeekOffsetSec(currentAbsolute);
    setEngineMode('compat');
    const track = probe?.audioTracks.find((t) => t.index === newIdx);
    if (track) {
      onNotify(`Switched audio to ${track.label}`);
    }
  }

  async function handleCopyText(text: string, key: 'url' | 'cmd', msg: string) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      onNotify(msg);
      setTimeout(() => setCopiedKey((prev) => (prev === key ? null : prev)), 1800);
    } catch {
      onNotify('Clipboard permission denied');
    }
  }

  const showVideoPlayer =
    session && (session.kind === 'video' || session.kind === 'file') && (!probe || probe.hasVideo);
  const showAudioPlayer =
    session && (session.kind === 'audio' || (probe && !probe.hasVideo && probe.hasAudio));

  return (
    <AnimatePresence>
      {session && (
        <motion.div
          key="mochidrop-player-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2, ease: EASE_LUXURY }}
          className={`fixed inset-0 z-50 bg-black/88 backdrop-blur-md flex items-center justify-center ${
            clearMode ? 'p-1 sm:p-2.5' : 'p-2 sm:p-5'
          }`}
          onClick={onClose}
        >
          <motion.div
            key="mochidrop-player-dialog"
            initial={{ opacity: 0, scale: 0.985, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.985, y: 8 }}
            transition={{ duration: 0.22, ease: EASE_LUXURY }}
            className={`w-full border border-white/[0.1] bg-[#070B09]/95 backdrop-blur-xl text-white rounded-2xl overflow-hidden shadow-2xl flex flex-col ${
              clearMode ? 'max-w-[96vw] max-h-[96vh]' : 'max-w-5xl max-h-[94vh]'
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Top Cinema Header (hidden in Clear Mode for distraction-free viewing) */}
            {!clearMode && (
              <div className="px-4 sm:px-5 py-3.5 border-b border-white/[0.08] flex flex-wrap items-center justify-between gap-3 bg-white/[0.025]">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] font-mono text-[#8A9891] tabular-nums">
                    <span>
                      {session.mode === 'online'
                        ? 'Online Stream'
                        : liveTransfer?.status === 'completed'
                        ? 'Saved in MochiDrop'
                        : liveTransfer?.status === 'paused'
                        ? `Paused at ${progressPct.toFixed(0)}%`
                        : `Playing While Downloading · ${progressPct.toFixed(0)}%`}
                    </span>
                    {liveTransfer?.status === 'downloading' && liveTransfer.speedBytesPerSec > 0 && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="text-[#3BE098]">
                          {formatSpeedMBps(liveTransfer.speedBytesPerSec)}
                        </span>
                      </>
                    )}
                    {probe && probe.height > 0 && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>
                          {probe.width}x{probe.height} {probe.videoCodec.toUpperCase()}
                        </span>
                      </>
                    )}
                    {(liveTransfer?.totalBytes || session.sizeBytes || 0) > 0 && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{formatBytes(liveTransfer?.totalBytes || session.sizeBytes || 0)}</span>
                      </>
                    )}
                    {isMediaKind && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>
                          {engineMode === 'compat'
                            ? 'Universal Engine'
                            : engineMode === 'client'
                            ? 'Browser Direct'
                            : 'Direct Engine'}
                        </span>
                      </>
                    )}
                  </div>
                  <h2 className="font-display text-sm sm:text-base font-semibold tracking-tight text-white truncate">
                    {liveTransfer?.title || session.title}
                  </h2>
                </div>

                <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
                  {isMediaKind && (
                    <button
                      type="button"
                      onClick={() => {
                        setClearMode(true);
                        revealHudTemporarily();
                      }}
                      title="Clear Mode (C) — distraction-free player with -10s / +10s controls"
                      className="h-8 sm:h-9 px-2.5 sm:px-3 rounded-xl border border-white/[0.12] bg-white/[0.04] text-xs font-medium text-[#DCE6E1] hover:border-[#2FD48B]/40 hover:text-[#3BE098] hover:bg-white/[0.08] transition-all inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                    >
                      <Maximize2 className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">Clear Mode</span>
                    </button>
                  )}

                  {session.mode === 'online' && onDownloadOnlineSession && (
                    <button
                      type="button"
                      onClick={() => onDownloadOnlineSession(session)}
                      className="h-8 sm:h-9 px-3 sm:px-3.5 rounded-xl bg-[#1A5E44]/90 hover:bg-[#217455] border border-[#2FD48B]/40 text-white text-xs font-semibold active:scale-[0.98] transition-all inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                    >
                      <Download className="h-3.5 w-3.5" />
                      Download While Watching
                    </button>
                  )}

                  {isTransferMode &&
                    liveTransfer &&
                    (liveTransfer.status === 'downloading' || liveTransfer.status === 'paused') &&
                    onTogglePause && (
                      <button
                        type="button"
                        onClick={() => onTogglePause(liveTransfer.id)}
                        className="h-8 sm:h-9 px-3 rounded-xl border border-white/[0.12] bg-white/[0.04] text-xs font-medium text-[#DCE6E1] hover:bg-white/[0.08] active:scale-[0.98] transition-all inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                      >
                        {liveTransfer.status === 'paused' ? (
                          <>
                            <Play className="h-3.5 w-3.5" />
                            Resume
                          </>
                        ) : (
                          <>
                            <Pause className="h-3.5 w-3.5" />
                            Pause
                          </>
                        )}
                      </button>
                    )}

                  {exportFileHref && (
                    <a
                      href={exportFileHref}
                      download={liveTransfer?.title || session.title}
                      className="h-8 sm:h-9 px-3 rounded-xl border border-white/[0.12] bg-white/[0.04] text-xs font-medium text-[#DCE6E1] hover:bg-white/[0.08] transition-colors inline-flex items-center gap-1.5 whitespace-nowrap"
                    >
                      <Download className="h-3.5 w-3.5" />
                      Save File
                    </a>
                  )}

                  <button
                    type="button"
                    onClick={onClose}
                    aria-label="Close player"
                    className="h-8 w-8 sm:h-9 sm:w-9 rounded-xl border border-white/[0.1] bg-white/[0.03] inline-flex items-center justify-center text-[#8A9891] hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>
            )}

            {/* Live Download Buffer Bar inside Player when still downloading */}
            {!clearMode && isTransferMode && liveTransfer && liveTransfer.status !== 'completed' && (
              <div className="h-1 w-full bg-white/[0.07] overflow-hidden">
                <motion.div
                  className="h-full bg-gradient-to-r from-[#1A6B4D] to-[#3BE098]"
                  initial={false}
                  animate={{ width: `${progressPct}%` }}
                  transition={{ duration: 0.35, ease: EASE_LUXURY }}
                />
              </div>
            )}

            {/* Main Cinema Playback Stage */}
            <div
              onMouseMove={revealHudTemporarily}
              onClick={revealHudTemporarily}
              className={`relative bg-black flex-1 flex items-center justify-center overflow-hidden group ${
                clearMode ? 'min-h-[65vh] max-h-[85vh]' : 'min-h-[260px] sm:min-h-[380px] max-h-[58vh]'
              }`}
            >
              {showVideoPlayer && !probing && !streamError && (
                <video
                  ref={videoRef}
                  key={inAppMediaSrc}
                  controls
                  autoPlay
                  playsInline
                  src={inAppMediaSrc}
                  onLoadStart={() => setBuffering(true)}
                  onLoadedMetadata={(e) => {
                    const dur = e.currentTarget.duration;
                    if (Number.isFinite(dur) && dur > 0) {
                      setMediaDurationSec(dur);
                    }
                  }}
                  onCanPlay={() => setBuffering(false)}
                  onPlaying={() => {
                    setBuffering(false);
                    setIsPlaying(true);
                  }}
                  onPause={() => setIsPlaying(false)}
                  onWaiting={() => setBuffering(true)}
                  onTimeUpdate={(e) => setLocalTimeSec(e.currentTarget.currentTime)}
                  onError={handleVideoError}
                  className={`w-full h-full bg-black ${clearMode ? 'max-h-[85vh]' : 'max-h-[58vh]'}`}
                />
              )}

              {showAudioPlayer && !probing && !streamError && (
                <div className="w-full p-10 flex flex-col items-center gap-5">
                  <div className="h-16 w-16 rounded-xl border border-white/[0.1] bg-[#0B1712] flex items-center justify-center text-[#3BE098]">
                    <Music className="h-7 w-7" />
                  </div>
                  <audio
                    ref={audioRef}
                    key={inAppMediaSrc}
                    controls
                    autoPlay
                    src={inAppMediaSrc}
                    onLoadedMetadata={(e) => {
                      const dur = e.currentTarget.duration;
                      if (Number.isFinite(dur) && dur > 0) {
                        setMediaDurationSec(dur);
                      }
                    }}
                    onCanPlay={() => setBuffering(false)}
                    onPlaying={() => {
                      setBuffering(false);
                      setIsPlaying(true);
                    }}
                    onPause={() => setIsPlaying(false)}
                    onTimeUpdate={(e) => setLocalTimeSec(e.currentTarget.currentTime)}
                    onError={handleVideoError}
                    className="w-full max-w-xl"
                  />
                </div>
              )}

              {session.kind === 'image' && (
                <img
                  src={inAppMediaSrc}
                  alt={session.title}
                  onLoad={() => setBuffering(false)}
                  className="max-w-full max-h-[58vh] object-contain"
                />
              )}

              {session.kind === 'document' && (
                <iframe
                  src={inAppMediaSrc}
                  title={session.title}
                  onLoad={() => setBuffering(false)}
                  className="w-full h-[58vh] bg-white"
                />
              )}

              {/* Clear Mode Floating Top Bar (Title + Exit Clear Mode + Close) */}
              {clearMode && (
                <div
                  className={`absolute top-0 inset-x-0 px-4 py-3 bg-gradient-to-b from-black/80 via-black/40 to-transparent flex items-center justify-between gap-3 transition-opacity duration-200 ${
                    hudVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
                  }`}
                >
                  <div className="min-w-0">
                    <p className="text-xs sm:text-sm font-display font-semibold text-white truncate">
                      {liveTransfer?.title || session.title}
                    </p>
                    <p className="text-[11px] font-mono text-[#9BB0A5] tabular-nums">
                      {formatClock(effectiveCurrentSec)}
                      {totalDurationSec > 0 ? ` / ${formatClock(totalDurationSec)}` : ''} · Clear Mode
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setClearMode(false);
                      }}
                      className="h-8 px-2.5 rounded-lg border border-white/[0.16] bg-black/60 backdrop-blur-md text-xs font-medium text-white hover:border-[#2FD48B]/50 hover:text-[#3BE098] inline-flex items-center gap-1.5 cursor-pointer transition-colors"
                    >
                      <Minimize2 className="h-3.5 w-3.5" />
                      Exit Clear Mode
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onClose();
                      }}
                      aria-label="Close player"
                      className="h-8 w-8 rounded-lg border border-white/[0.16] bg-black/60 backdrop-blur-md text-neutral-300 hover:text-white inline-flex items-center justify-center cursor-pointer"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              )}

              {/* Floating Translucent -10s / Play / +10s Quick-Seek Overlay (Always accessible on hover & in Clear Mode!) */}
              {showVideoPlayer && !probing && !streamError && (
                <div
                  className={`pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 px-5 sm:px-10 flex items-center justify-between transition-opacity duration-200 ${
                    hudVisible || clearMode ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                  }`}
                >
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSkipSeconds(-SKIP_STEP_SECONDS);
                    }}
                    title="Rewind 10 seconds (Left Arrow / J)"
                    aria-label="Rewind 10 seconds"
                    className="pointer-events-auto h-11 px-3.5 rounded-full border border-white/[0.18] bg-black/60 hover:bg-[#0D231A]/85 hover:border-[#2FD48B]/55 backdrop-blur-md text-white hover:text-[#3BE098] active:scale-95 transition-all inline-flex items-center gap-1.5 text-xs font-mono font-semibold shadow-lg cursor-pointer"
                  >
                    <RotateCcw className="h-4 w-4" />
                    <span>-10s</span>
                  </button>

                  {clearMode && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleTogglePlayPlayback();
                      }}
                      title="Play / Pause (Space)"
                      aria-label={isPlaying ? 'Pause' : 'Play'}
                      className="pointer-events-auto h-12 w-12 rounded-full border border-[#2FD48B]/45 bg-[#0D231A]/80 hover:bg-[#143729] backdrop-blur-md text-[#3BE098] active:scale-95 transition-all inline-flex items-center justify-center shadow-lg cursor-pointer"
                    >
                      {isPlaying ? (
                        <Pause className="h-5 w-5" />
                      ) : (
                        <Play className="h-5 w-5 fill-current ml-0.5" />
                      )}
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSkipSeconds(SKIP_STEP_SECONDS);
                    }}
                    title="Forward 10 seconds (Right Arrow / L)"
                    aria-label="Forward 10 seconds"
                    className="pointer-events-auto h-11 px-3.5 rounded-full border border-white/[0.18] bg-black/60 hover:bg-[#0D231A]/85 hover:border-[#2FD48B]/55 backdrop-blur-md text-white hover:text-[#3BE098] active:scale-95 transition-all inline-flex items-center gap-1.5 text-xs font-mono font-semibold shadow-lg cursor-pointer"
                  >
                    <span>+10s</span>
                    <RotateCw className="h-4 w-4" />
                  </button>
                </div>
              )}

              {/* Animated -10s / +10s Skip Confirmation Pill */}
              <AnimatePresence>
                {skipFeedback && (
                  <motion.div
                    key={skipFeedback.seq}
                    initial={{ opacity: 0, scale: 0.9, y: 6 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95, y: -6 }}
                    transition={{ duration: 0.18 }}
                    className="pointer-events-none absolute top-14 left-1/2 -translate-x-1/2 px-3.5 py-1.5 rounded-full border border-[#2FD48B]/45 bg-[#0A1C14]/90 backdrop-blur-md text-[#3BE098] font-mono text-xs font-bold shadow-xl inline-flex items-center gap-1.5"
                  >
                    {skipFeedback.delta < 0 ? (
                      <RotateCcw className="h-3.5 w-3.5" />
                    ) : (
                      <RotateCw className="h-3.5 w-3.5" />
                    )}
                    <span>
                      {skipFeedback.delta > 0 ? `+${skipFeedback.delta}s` : `${skipFeedback.delta}s`}
                    </span>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Subtle Buffering / Probing Overlay */}
              {(probing || (buffering && isMediaKind && !streamError)) && (
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2.5 bg-black/55">
                  <Loader2 className="h-6 w-6 animate-spin text-white" />
                  <p className="text-xs font-mono text-neutral-300">
                    {probing
                      ? 'Detecting codecs & audio tracks...'
                      : engineMode === 'compat'
                      ? 'Streaming via Universal Engine (MKV / Audio compatible)...'
                      : 'Buffering stream...'}
                  </p>
                </div>
              )}

              {/* Graceful Error Recovery Overlay */}
              {streamError && (
                <div className="p-8 max-w-lg text-center space-y-4">
                  <div className="mx-auto h-12 w-12 rounded-xl border border-white/[0.1] bg-[#0B120F] flex items-center justify-center text-neutral-300">
                    <Film className="h-5 w-5" />
                  </div>
                  <div className="space-y-1.5">
                    <h3 className="font-display text-base font-semibold text-white">
                      Browser playback unavailable for this link
                    </h3>
                    <p className="text-xs text-neutral-400 leading-relaxed">{streamError}</p>
                  </div>
                  <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                    <a
                      href={xspfPlaylistHref}
                      download
                      className="h-9 px-4 rounded-xl bg-white text-black text-xs font-semibold hover:bg-neutral-200 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap"
                    >
                      <MonitorPlay className="h-3.5 w-3.5" />
                      Download VLC Playlist (.xspf)
                    </a>
                    <button
                      type="button"
                      onClick={() => {
                        setStreamError(null);
                        setBuffering(true);
                        setEngineMode(engineMode === 'direct' ? 'compat' : 'direct');
                      }}
                      className="h-9 px-3.5 rounded-xl border border-white/[0.14] text-xs font-medium text-neutral-200 hover:bg-white/[0.08] transition-colors inline-flex items-center gap-1.5 cursor-pointer"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      Retry ({engineMode === 'direct' ? 'Universal' : 'Direct'} Engine)
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Playback Control Strip: Always Includes -10s / +10s Seek Buttons + Timeline + Audio Track + Clear Mode */}
            {isMediaKind && (
              <div className="px-4 sm:px-5 py-2.5 border-t border-white/[0.08] bg-white/[0.025] flex flex-wrap items-center justify-between gap-3">
                {/* Left: Dedicated -10s / +10s Skip Controls + Clock / Seek Bar */}
                <div className="flex-1 min-w-[220px] flex items-center gap-2.5">
                  <div className="inline-flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      disabled={probing || Boolean(streamError)}
                      onClick={() => handleSkipSeconds(-SKIP_STEP_SECONDS)}
                      title="Rewind 10 seconds (Left Arrow / J)"
                      className="h-7 px-2.5 rounded-lg border border-white/[0.14] bg-white/[0.05] hover:bg-[#0F2B20] hover:border-[#2FD48B]/45 text-[11px] font-mono font-semibold text-[#DCE6E1] hover:text-[#3BE098] disabled:opacity-40 transition-colors inline-flex items-center gap-1 cursor-pointer"
                    >
                      <RotateCcw className="h-3 w-3" />
                      <span>-10s</span>
                    </button>
                    <button
                      type="button"
                      disabled={probing || Boolean(streamError)}
                      onClick={() => handleSkipSeconds(SKIP_STEP_SECONDS)}
                      title="Forward 10 seconds (Right Arrow / L)"
                      className="h-7 px-2.5 rounded-lg border border-white/[0.14] bg-white/[0.05] hover:bg-[#0F2B20] hover:border-[#2FD48B]/45 text-[11px] font-mono font-semibold text-[#DCE6E1] hover:text-[#3BE098] disabled:opacity-40 transition-colors inline-flex items-center gap-1 cursor-pointer"
                    >
                      <span>+10s</span>
                      <RotateCw className="h-3 w-3" />
                    </button>
                  </div>

                  {engineMode === 'compat' && totalDurationSec > 0 ? (
                    <>
                      <span className="font-mono text-[11px] tabular-nums text-[#8A9891] shrink-0">
                        {formatClock(effectiveCurrentSec)} / {formatClock(totalDurationSec)}
                      </span>
                      <input
                        type="range"
                        min={0}
                        max={Math.floor(totalDurationSec)}
                        value={Math.min(Math.floor(totalDurationSec), Math.floor(effectiveCurrentSec))}
                        onChange={(e) => handleCompatSeek(Number(e.target.value))}
                        aria-label="Seek timeline"
                        className="w-full h-1 accent-[#2FD48B] bg-white/[0.12] rounded-full cursor-pointer"
                      />
                    </>
                  ) : (
                    <span className="font-mono text-[11px] tabular-nums text-[#8A9891] truncate">
                      {formatClock(effectiveCurrentSec)}
                      {totalDurationSec > 0 ? ` / ${formatClock(totalDurationSec)}` : ''}
                      {!clearMode && engineMode === 'direct' ? ' · ← / → keys skip 10s' : ''}
                    </span>
                  )}
                </div>

                {/* Right: Audio Track Selector + Clear Mode Toggle + Engine Switcher */}
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  {probe && probe.audioTracks.length > 1 && (
                    <label className="inline-flex items-center gap-1.5 text-xs text-[#C5D1CB]">
                      <AudioLines className="h-3.5 w-3.5 text-[#3BE098]" />
                      <select
                        value={audioTrackIdx}
                        onChange={(e) => handleAudioTrackSwitch(Number(e.target.value))}
                        aria-label="Audio Track"
                        className="h-7 rounded-lg border border-white/[0.12] bg-[#0B120F] px-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-[#2FD48B] cursor-pointer"
                      >
                        {probe.audioTracks.map((t) => (
                          <option key={t.index} value={t.index}>
                            {t.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

                  {!clearMode && (
                    <button
                      type="button"
                      onClick={() => {
                        const currentAbs = Math.max(0, effectiveCurrentSec);
                        setStreamError(null);
                        setBuffering(true);
                        if (engineMode === 'direct') {
                          setSeekOffsetSec(currentAbs);
                          setLocalTimeSec(0);
                          setEngineMode('compat');
                          onNotify('Switched to Universal Engine (fixes MKV / AC3 / HEVC audio & video)');
                        } else if (engineMode === 'compat') {
                          setSeekOffsetSec(0);
                          setLocalTimeSec(0);
                          setEngineMode('client');
                          onNotify('Switched to Browser Direct stream (uses your local IP)');
                        } else {
                          setSeekOffsetSec(0);
                          setLocalTimeSec(0);
                          setEngineMode('direct');
                          onNotify('Switched to Direct Proxy Engine');
                        }
                      }}
                      className="h-7 px-2.5 rounded-lg border border-white/[0.12] bg-white/[0.04] text-[11px] font-medium text-[#DCE6E1] hover:bg-white/[0.09] transition-colors whitespace-nowrap cursor-pointer"
                    >
                      {engineMode === 'direct'
                        ? 'Fix Audio / MKV Mode'
                        : engineMode === 'compat'
                        ? 'Try Browser Direct'
                        : 'Switch to Direct'}
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* External Desktop Player Bar (hidden in Clear Mode) */}
            {!clearMode && (
              <div className="px-4 sm:px-5 py-3.5 border-t border-white/[0.08] bg-white/[0.025] flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                <div className="space-y-0.5 min-w-0">
                  <div className="flex items-center gap-2 text-xs font-medium text-white">
                    <Tv className="h-3.5 w-3.5 text-[#3BE098] shrink-0" />
                    <span>Stream in VLC, PotPlayer, IINA, or MPV</span>
                  </div>
                  <p className="text-[11px] text-[#7E8E87]">
                    Double-click the downloaded .xspf / .m3u playlist, or press Ctrl+N in VLC and paste the Direct Stream URL.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                  <a
                    href={xspfPlaylistHref}
                    download
                    onClick={() =>
                      onNotify('Downloaded VLC Playlist (.xspf) — double-click to stream in VLC')
                    }
                    className="h-8 px-3 rounded-lg bg-[#1A5E44]/90 hover:bg-[#217455] border border-[#2FD48B]/40 text-white text-xs font-semibold active:scale-[0.98] transition-all inline-flex items-center gap-1.5 whitespace-nowrap"
                  >
                    <MonitorPlay className="h-3.5 w-3.5" />
                    VLC Playlist (.xspf)
                  </a>

                  <a
                    href={m3uPlaylistHref}
                    download
                    onClick={() =>
                      onNotify('Downloaded .m3u playlist — open with VLC, IINA, PotPlayer, or MPV')
                    }
                    className="h-8 px-2.5 rounded-lg border border-white/[0.12] bg-white/[0.04] text-xs font-medium text-[#DCE6E1] hover:bg-white/[0.08] transition-colors inline-flex items-center gap-1 whitespace-nowrap"
                  >
                    Playlist (.m3u)
                  </a>

                  <button
                    type="button"
                    onClick={() =>
                      handleCopyText(
                        directExternalStreamUrl,
                        'url',
                        'Direct Stream URL copied — in VLC press Ctrl+N, paste & Play'
                      )
                    }
                    className="h-8 px-2.5 rounded-lg border border-white/[0.12] bg-white/[0.04] text-xs font-medium text-[#DCE6E1] hover:bg-white/[0.08] transition-colors inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                  >
                    {copiedKey === 'url' ? (
                      <>
                        <Check className="h-3 w-3 text-[#3BE098]" />
                        Copied URL
                      </>
                    ) : (
                      <>
                        <Copy className="h-3 w-3" />
                        Copy Stream URL
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      handleCopyText(
                        `vlc "${directExternalStreamUrl}"`,
                        'cmd',
                        'VLC command copied — paste into Terminal or Win+R'
                      )
                    }
                    className="h-8 px-2.5 rounded-lg border border-white/[0.1] bg-white/[0.03] text-xs font-medium text-[#B8C6BF] hover:bg-white/[0.08] transition-colors inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                  >
                    {copiedKey === 'cmd' ? (
                      <>
                        <Check className="h-3 w-3 text-[#3BE098]" />
                        Copied Cmd
                      </>
                    ) : (
                      <>
                        <Terminal className="h-3 w-3" />
                        VLC Cmd
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
