import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type express from 'express';

const execFileAsync = promisify(execFile);

export interface ProbedAudioTrack {
  index: number; // audio-stream ordinal (0, 1, 2...) for -map 0:a:<index>
  codec: string;
  channels: number;
  language: string;
  title: string;
  label: string;
}

export interface MediaProbeInfo {
  durationSec: number;
  videoCodec: string;
  videoPixFmt: string;
  width: number;
  height: number;
  audioTracks: ProbedAudioTrack[];
  hasVideo: boolean;
  hasAudio: boolean;
  needsTranscode: boolean;
}

const MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.avi': 'video/x-msvideo',
  '.flv': 'video/x-flv',
  '.wmv': 'video/x-ms-wmv',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

const BROWSER_NATIVE_VIDEO_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1']);
const BROWSER_NATIVE_AUDIO_CODECS = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le']);

export function inferPlayableMimeType(filename: string, rawContentType?: string | null): string {
  const ct = (rawContentType || '').split(';')[0].trim().toLowerCase();
  const cleanName = filename.split('?')[0].toLowerCase();
  const dotIdx = cleanName.lastIndexOf('.');
  const ext = dotIdx >= 0 ? cleanName.slice(dotIdx) : '';

  // Never serve application/octet-stream for known playable media extensions
  if (ext && MIME_BY_EXT[ext]) {
    if (
      !ct ||
      ct === 'application/octet-stream' ||
      ct === 'binary/octet-stream' ||
      ct === 'application/force-download' ||
      ct === 'application/x-download'
    ) {
      return MIME_BY_EXT[ext];
    }
  }

  if (ct && ct !== 'application/octet-stream' && ct !== 'binary/octet-stream') {
    return ct;
  }

  if (ext && MIME_BY_EXT[ext]) {
    return MIME_BY_EXT[ext];
  }

  return 'video/mp4';
}

export function filenameSuggestsTranscode(filename: string, rawContentType?: string | null): boolean {
  const lower = filename.split('?')[0].toLowerCase();
  const ct = (rawContentType || '').toLowerCase();
  if (/\.(mkv|avi|ts|m2ts|flv|wmv|vob|mpg|mpeg|m3u8|mov)$/i.test(lower)) {
    return true;
  }
  if (
    ct.includes('matroska') ||
    ct.includes('mp2t') ||
    ct.includes('msvideo') ||
    ct.includes('mpegurl') ||
    ct.includes('x-flv')
  ) {
    return true;
  }
  return false;
}

function buildFfmpegHeaderString(headers?: Record<string, string>): string | null {
  if (!headers) return null;
  const lines: string[] = [];
  for (const [k, v] of Object.entries(headers)) {
    if (!v) continue;
    const cleanKey = k.replace(/[\r\n:]/g, '').trim();
    const cleanVal = v.replace(/[\r\n]/g, '').trim();
    if (cleanKey && cleanVal) {
      lines.push(`${cleanKey}: ${cleanVal}`);
    }
  }
  return lines.length > 0 ? `${lines.join('\r\n')}\r\n` : null;
}

function formatLanguageCode(code?: string): string {
  if (!code) return '';
  const map: Record<string, string> = {
    hin: 'Hindi',
    hi: 'Hindi',
    eng: 'English',
    en: 'English',
    urd: 'Urdu',
    ur: 'Urdu',
    tam: 'Tamil',
    ta: 'Tamil',
    tel: 'Telugu',
    te: 'Telugu',
    mal: 'Malayalam',
    kan: 'Kannada',
    pun: 'Punjabi',
    jpn: 'Japanese',
    ja: 'Japanese',
    kor: 'Korean',
    ko: 'Korean',
    spa: 'Spanish',
    es: 'Spanish',
    fre: 'French',
    fra: 'French',
    fr: 'French',
    ger: 'German',
    deu: 'German',
    de: 'German',
    ara: 'Arabic',
    ar: 'Arabic',
    rus: 'Russian',
    ru: 'Russian',
    chi: 'Chinese',
    zho: 'Chinese',
    und: 'Default',
  };
  const low = code.trim().toLowerCase();
  return map[low] || code.toUpperCase();
}

export async function probeMediaStreams(
  input: string,
  headers?: Record<string, string>
): Promise<MediaProbeInfo> {
  const args: string[] = [
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
  ];

  const isRemote = /^https?:\/\//i.test(input);
  if (isRemote) {
    const headerStr = buildFfmpegHeaderString({
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
      ...headers,
    });
    if (headerStr) {
      args.push('-headers', headerStr);
    }
    args.push('-rw_timeout', '10000000'); // 10s microseconds
  }

  args.push('-i', input);

  const { stdout } = await execFileAsync('ffprobe', args, {
    timeout: 12000,
    maxBuffer: 2 * 1024 * 1024,
  });

  const parsed = JSON.parse(stdout || '{}') as {
    format?: { duration?: string; format_name?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      pix_fmt?: string;
      width?: number;
      height?: number;
      channels?: number;
      tags?: Record<string, string>;
    }>;
  };

  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStreams = streams.filter((s) => s.codec_type === 'audio');

  const durationSec = Math.max(0, Number(parsed.format?.duration || 0) || 0);
  const videoCodec = (videoStream?.codec_name || '').toLowerCase();
  const videoPixFmt = (videoStream?.pix_fmt || '').toLowerCase();
  const width = Number(videoStream?.width || 0);
  const height = Number(videoStream?.height || 0);
  const formatName = (parsed.format?.format_name || '').toLowerCase();

  const audioTracks: ProbedAudioTrack[] = audioStreams.map((s, idx) => {
    const codec = (s.codec_name || 'unknown').toLowerCase();
    const channels = Number(s.channels || 2);
    const rawLang = s.tags?.language || s.tags?.LANGUAGE || '';
    const rawTitle = s.tags?.title || s.tags?.TITLE || '';
    const langPretty = formatLanguageCode(rawLang);
    const chLabel = channels >= 6 ? '5.1' : channels === 2 ? 'Stereo' : `${channels}ch`;
    const baseName = rawTitle || langPretty || `Track ${idx + 1}`;
    const label = `${baseName} (${codec.toUpperCase()} ${chLabel})`;
    return {
      index: idx,
      codec,
      channels,
      language: langPretty || rawLang || `Track ${idx + 1}`,
      title: rawTitle,
      label,
    };
  });

  const containerNative =
    (formatName.includes('mp4') || formatName.includes('webm')) &&
    !formatName.includes('matroska');
  const videoNative =
    !videoStream ||
    (BROWSER_NATIVE_VIDEO_CODECS.has(videoCodec) && !videoPixFmt.includes('10'));
  const firstAudioNative =
    audioTracks.length === 0 || BROWSER_NATIVE_AUDIO_CODECS.has(audioTracks[0].codec);

  const needsTranscode = !(containerNative && videoNative && firstAudioNative);

  return {
    durationSec,
    videoCodec,
    videoPixFmt,
    width,
    height,
    audioTracks,
    hasVideo: Boolean(videoStream),
    hasAudio: audioTracks.length > 0,
    needsTranscode,
  };
}

export function streamCompatibleMp4WithFfmpeg(options: {
  input: string;
  req: express.Request;
  res: express.Response;
  startSec?: number;
  audioTrackIndex?: number;
  videoCodec?: string;
  videoPixFmt?: string;
  hasVideo?: boolean;
  headers?: Record<string, string>;
}): void {
  const {
    input,
    req,
    res,
    startSec = 0,
    audioTrackIndex = 0,
    videoCodec = '',
    videoPixFmt = '',
    hasVideo = true,
    headers,
  } = options;

  const isRemote = /^https?:\/\//i.test(input);
  const args: string[] = ['-hide_banner', '-loglevel', 'error'];

  if (isRemote) {
    const headerStr = buildFfmpegHeaderString({
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
      ...headers,
    });
    if (headerStr) {
      args.push('-headers', headerStr);
    }
    args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '4');
  }

  const safeStart = Math.max(0, Number.isFinite(startSec) ? startSec : 0);
  if (safeStart > 0) {
    args.push('-ss', safeStart.toFixed(2));
  }

  args.push('-i', input);

  const safeAudioIdx = Math.max(0, Math.min(16, Math.floor(audioTrackIndex || 0)));

  if (hasVideo) {
    args.push('-map', '0:v:0?');
    args.push('-map', `0:a:${safeAudioIdx}?`);

    // Copy H.264 8-bit video with zero CPU cost; transcode HEVC/10-bit/MPEG4/etc. in real time
    const canCopyVideo =
      videoCodec === 'h264' &&
      !videoPixFmt.includes('10') &&
      !videoPixFmt.includes('12');

    if (canCopyVideo) {
      args.push('-c:v', 'copy');
    } else {
      args.push(
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-tune',
        'zerolatency',
        '-crf',
        '23',
        '-pix_fmt',
        'yuv420p',
        '-maxrate',
        '5500k',
        '-bufsize',
        '11000k'
      );
    }

    // Always convert audio to universal browser-playable stereo AAC (fixes AC3/EAC3/DTS MKV silence!)
    args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000');
    args.push(
      '-f',
      'mp4',
      '-movflags',
      'frag_keyframe+empty_moov+default_base_moof',
      'pipe:1'
    );
  } else {
    // Pure audio stream
    args.push('-map', `0:a:${safeAudioIdx}?`);
    args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');
    args.push('-f', 'adts', 'pipe:1');
  }

  const child = spawn('ffmpeg', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrTail = '';
  let sentHeaders = false;
  let cleanedUp = false;

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    req.off('close', cleanup);
    res.off('close', cleanup);
    res.off('error', cleanup);
    try {
      if (!child.killed) {
        child.kill('SIGTERM');
        setTimeout(() => {
          try {
            if (child.exitCode === null) child.kill('SIGKILL');
          } catch {
            // ignore
          }
        }, 1200);
      }
    } catch {
      // ignore
    }
  };

  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);

  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-600);
  });

  child.stdout.once('data', (firstChunk: Buffer) => {
    if (cleanedUp || res.destroyed || res.writableEnded) {
      cleanup();
      return;
    }
    sentHeaders = true;
    res.status(200);
    res.setHeader('Content-Type', hasVideo ? 'video/mp4' : 'audio/aac');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }
    res.write(firstChunk);
    child.stdout.pipe(res);
  });

  child.on('error', (err) => {
    cleanup();
    if (!sentHeaders && !res.headersSent) {
      res.status(500).json({ error: `Media player engine failed: ${err.message}` });
    } else if (!res.writableEnded) {
      res.end();
    }
  });

  child.on('close', (code) => {
    cleanup();
    if (!sentHeaders && !res.headersSent) {
      res.status(502).json({
        error:
          stderrTail.trim() ||
          `Could not decode this media stream (ffmpeg exited with code ${code ?? 'unknown'}).`,
      });
    } else if (!res.writableEnded) {
      res.end();
    }
  });
}

function escapeXml(val: string): string {
  return val
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildM3uPlaylist(title: string, streamUrl: string): string {
  const safeTitle = title.replace(/[\r\n]+/g, ' ').trim() || 'MochiDrop Stream';
  return `#EXTM3U\n#EXTINF:-1,${safeTitle}\n${streamUrl}\n`;
}

export function buildVlcXspfPlaylist(title: string, streamUrl: string): string {
  const safeTitle = escapeXml(title.replace(/[\r\n]+/g, ' ').trim() || 'MochiDrop Stream');
  const safeLocation = escapeXml(streamUrl.trim());
  return `<?xml version="1.0" encoding="UTF-8"?>
<playlist xmlns="http://xspf.org/ns/0/" xmlns:vlc="http://www.videolan.org/vlc/playlist/ns/0/" version="1">
  <title>${safeTitle}</title>
  <trackList>
    <track>
      <location>${safeLocation}</location>
      <title>${safeTitle}</title>
      <extension application="http://www.videolan.org/vlc/playlist/0">
        <vlc:option>network-caching=2500</vlc:option>
      </extension>
    </track>
  </trackList>
</playlist>
`;
}

export function isLocalOriginUrl(origin: string): boolean {
  try {
    const u = new URL(origin);
    return (
      u.hostname === 'localhost' ||
      u.hostname === '127.0.0.1' ||
      u.hostname === '::1' ||
      u.hostname === '0.0.0.0'
    );
  } catch {
    return false;
  }
}
