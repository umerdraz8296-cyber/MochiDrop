import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AudioLines,
  Check,
  Copy,
  Download,
  Film,
  Loader2,
  MonitorPlay,
  Music,
  Pause,
  Play,
  RefreshCw,
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
  const [buffering, setBuffering] = useState(true);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<'url' | 'cmd' | null>(null);

  const triedModesRef = useRef<Set<'direct' | 'compat' | 'client'>>(new Set());
  const videoRef = useRef<HTMLVideoElement | null>(null);

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
    setCopiedKey(null);
    setBuffering(true);

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

  useEffect(() => {
    if (!session) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [session, onClose]);

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

  const totalDurationSec = probe?.durationSec || 0;
  const effectiveCurrentSec = engineMode === 'compat' ? seekOffsetSec + localTimeSec : localTimeSec;

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

  function handleCompatSeek(targetSec: number) {
    const clamped = Math.max(0, Math.min(totalDurationSec > 0 ? totalDurationSec - 1 : targetSec, targetSec));
    setBuffering(true);
    setStreamError(null);
    setLocalTimeSec(0);
    setSeekOffsetSec(clamped);
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
          className="fixed inset-0 z-50 bg-black/88 backdrop-blur-xs flex items-center justify-center p-2 sm:p-5"
          onClick={onClose}
        >
          <motion.div
            key="mochidrop-player-dialog"
            initial={{ opacity: 0, scale: 0.985, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.985, y: 8 }}
            transition={{ duration: 0.22, ease: EASE_LUXURY }}
            className="w-full max-w-5xl border border-neutral-800 bg-[#070707] text-white rounded-md overflow-hidden shadow-2xl flex flex-col max-h-[94vh]"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Top Cinema Header */}
            <div className="px-4 sm:px-5 py-3.5 border-b border-neutral-800/90 flex flex-wrap items-center justify-between gap-3 bg-[#0B0B0B]">
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] font-mono text-neutral-400 tabular-nums">
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
                      <span className="text-white">{formatSpeedMBps(liveTransfer.speedBytesPerSec)}</span>
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
                {session.mode === 'online' && onDownloadOnlineSession && (
                  <button
                    type="button"
                    onClick={() => onDownloadOnlineSession(session)}
                    className="h-8 sm:h-9 px-3 sm:px-3.5 rounded-xs bg-white text-black text-xs font-semibold hover:bg-neutral-200 active:scale-[0.98] transition-all inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
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
                      className="h-8 sm:h-9 px-3 rounded-xs border border-neutral-700 text-xs font-medium text-neutral-200 hover:bg-neutral-900 active:scale-[0.98] transition-all inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
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
                    className="h-8 sm:h-9 px-3 rounded-xs border border-neutral-700 text-xs font-medium text-neutral-200 hover:bg-neutral-900 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Save File
                  </a>
                )}

                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close player"
                  className="h-8 w-8 sm:h-9 sm:w-9 rounded-xs border border-neutral-800 inline-flex items-center justify-center text-neutral-400 hover:text-white hover:bg-neutral-900 transition-colors cursor-pointer"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            {/* Live Download Buffer Bar inside Player when still downloading */}
            {isTransferMode && liveTransfer && liveTransfer.status !== 'completed' && (
              <div className="h-1 w-full bg-neutral-900 overflow-hidden">
                <motion.div
                  className="h-full bg-white"
                  initial={false}
                  animate={{ width: `${progressPct}%` }}
                  transition={{ duration: 0.35, ease: EASE_LUXURY }}
                />
              </div>
            )}

            {/* Main Cinema Playback Stage */}
            <div className="relative bg-black flex-1 flex items-center justify-center min-h-[260px] sm:min-h-[380px] max-h-[58vh] overflow-hidden">
              {showVideoPlayer && !probing && !streamError && (
                <video
                  ref={videoRef}
                  key={inAppMediaSrc}
                  controls
                  autoPlay
                  playsInline
                  src={inAppMediaSrc}
                  onLoadStart={() => setBuffering(true)}
                  onCanPlay={() => setBuffering(false)}
                  onPlaying={() => setBuffering(false)}
                  onWaiting={() => setBuffering(true)}
                  onTimeUpdate={(e) => setLocalTimeSec(e.currentTarget.currentTime)}
                  onError={handleVideoError}
                  className="w-full h-full max-h-[58vh] bg-black"
                />
              )}

              {showAudioPlayer && !probing && !streamError && (
                <div className="w-full p-10 flex flex-col items-center gap-5">
                  <div className="h-16 w-16 rounded-xs border border-neutral-800 bg-[#0F0F0F] flex items-center justify-center text-white">
                    <Music className="h-7 w-7" />
                  </div>
                  <audio
                    key={inAppMediaSrc}
                    controls
                    autoPlay
                    src={inAppMediaSrc}
                    onCanPlay={() => setBuffering(false)}
                    onPlaying={() => setBuffering(false)}
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
                  <div className="mx-auto h-12 w-12 rounded-xs border border-neutral-800 bg-[#0F0F0F] flex items-center justify-center text-neutral-300">
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
                      className="h-9 px-4 rounded-xs bg-white text-black text-xs font-semibold hover:bg-neutral-200 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap"
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
                      className="h-9 px-3.5 rounded-xs border border-neutral-700 text-xs font-medium text-neutral-200 hover:bg-neutral-900 transition-colors inline-flex items-center gap-1.5 cursor-pointer"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      Retry ({engineMode === 'direct' ? 'Universal' : 'Direct'} Engine)
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Universal Engine Timeline & Audio Track Strip (for MKV / Dual Audio / HEVC) */}
            {isMediaKind && (
              <div className="px-4 sm:px-5 py-2.5 border-t border-neutral-800/80 bg-[#090909] flex flex-wrap items-center justify-between gap-3">
                <div className="flex-1 min-w-[200px] flex items-center gap-3">
                  {engineMode === 'compat' && totalDurationSec > 0 ? (
                    <>
                      <span className="font-mono text-[11px] tabular-nums text-neutral-400 shrink-0">
                        {formatClock(effectiveCurrentSec)} / {formatClock(totalDurationSec)}
                      </span>
                      <input
                        type="range"
                        min={0}
                        max={Math.floor(totalDurationSec)}
                        value={Math.min(Math.floor(totalDurationSec), Math.floor(effectiveCurrentSec))}
                        onChange={(e) => handleCompatSeek(Number(e.target.value))}
                        aria-label="Seek timeline"
                        className="w-full h-1 accent-white bg-neutral-800 rounded-xs cursor-pointer"
                      />
                    </>
                  ) : (
                    <span className="text-[11px] font-mono text-neutral-500">
                      {engineMode === 'direct'
                        ? 'No sound or black screen? Switch to Universal Engine ->'
                        : 'Universal Engine active (real-time browser-compatible MP4 + stereo AAC audio)'}
                    </span>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  {probe && probe.audioTracks.length > 1 && (
                    <label className="inline-flex items-center gap-1.5 text-xs text-neutral-300">
                      <AudioLines className="h-3.5 w-3.5 text-neutral-400" />
                      <select
                        value={audioTrackIdx}
                        onChange={(e) => handleAudioTrackSwitch(Number(e.target.value))}
                        aria-label="Audio Track"
                        className="h-7 rounded-xs border border-neutral-700 bg-black px-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-white cursor-pointer"
                      >
                        {probe.audioTracks.map((t) => (
                          <option key={t.index} value={t.index}>
                            {t.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

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
                    className="h-7 px-2.5 rounded-xs border border-neutral-700 text-[11px] font-medium text-neutral-200 hover:bg-neutral-900 transition-colors whitespace-nowrap cursor-pointer"
                  >
                    {engineMode === 'direct'
                      ? 'Fix Audio / MKV Mode'
                      : engineMode === 'compat'
                      ? 'Try Browser Direct'
                      : 'Switch to Direct'}
                  </button>
                </div>
              </div>
            )}

            {/* External Desktop Player Bar — VLC (.xspf), Universal (.m3u), Copy Direct Stream URL */}
            <div className="px-4 sm:px-5 py-3.5 border-t border-neutral-800/90 bg-[#0B0B0B] flex flex-col lg:flex-row lg:items-center justify-between gap-3">
              <div className="space-y-0.5 min-w-0">
                <div className="flex items-center gap-2 text-xs font-medium text-white">
                  <Tv className="h-3.5 w-3.5 text-neutral-400 shrink-0" />
                  <span>Stream in VLC, PotPlayer, IINA, or MPV</span>
                </div>
                <p className="text-[11px] text-neutral-500">
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
                  className="h-8 px-3 rounded-xs bg-white text-black text-xs font-semibold hover:bg-neutral-200 active:scale-[0.98] transition-all inline-flex items-center gap-1.5 whitespace-nowrap"
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
                  className="h-8 px-2.5 rounded-xs border border-neutral-700 text-xs font-medium text-neutral-200 hover:bg-neutral-900 transition-colors inline-flex items-center gap-1 whitespace-nowrap"
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
                  className="h-8 px-2.5 rounded-xs border border-neutral-700 text-xs font-medium text-neutral-200 hover:bg-neutral-900 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                >
                  {copiedKey === 'url' ? (
                    <>
                      <Check className="h-3 w-3" />
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
                  className="h-8 px-2.5 rounded-xs border border-neutral-800 text-xs font-medium text-neutral-300 hover:bg-neutral-900 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                >
                  {copiedKey === 'cmd' ? (
                    <>
                      <Check className="h-3 w-3" />
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
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
