import zlib from 'node:zlib';

export interface ExtensionFile {
  path: string;
  language: string;
  description: string;
  content: string;
}

export interface ZipEntry {
  path: string;
  content: string | Buffer;
}

export interface ExtensionOptions {
  plexoOrigin: string;
  name?: string;
  description?: string;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/**
 * Generates a crisp pure black-and-white rounded-square PNG icon (Chrome Web Store / Firefox AMO ready).
 */
export function generateMonochromePngIcon(size: number): Buffer {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const radius = Math.max(2, Math.floor(size * 0.22));
  const border = Math.max(1, Math.floor(size * 0.06));
  const cx = size / 2;
  const cy = size / 2;
  const dotR = size * 0.14;

  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const px = rowStart + 1 + x * 4;

      // Check rounded-rect bounds
      const dx = Math.max(radius - x, 0, x - (size - 1 - radius));
      const dy = Math.max(radius - y, 0, y - (size - 1 - radius));
      const distCorner = Math.hypot(dx, dy);

      if (distCorner > radius + 0.5) {
        // Transparent outside rounded corners
        raw[px] = 0;
        raw[px + 1] = 0;
        raw[px + 2] = 0;
        raw[px + 3] = 0;
        continue;
      }

      // Subtle white outline inside edge
      const onBorder =
        x < border || x >= size - border || y < border || y >= size - border;

      // Cozy minimalist drop/cloud emblem in crisp white
      const distCenter = Math.hypot(x - cx, y - (cy + size * 0.06));
      const distLeft = Math.hypot(x - (cx - size * 0.16), y - (cy + size * 0.08));
      const distRight = Math.hypot(x - (cx + size * 0.16), y - (cy + size * 0.08));
      const distTop = Math.hypot(x - cx, y - (cy - size * 0.1));
      const inCloud =
        distCenter <= dotR * 1.45 ||
        distLeft <= dotR * 1.05 ||
        distRight <= dotR * 1.05 ||
        distTop <= dotR * 1.15;

      // Small downward notch/arrow below cloud
      const inStem =
        Math.abs(x - cx) <= Math.max(1, size * 0.045) &&
        y >= cy + size * 0.16 &&
        y <= cy + size * 0.34;

      const isWhite = inCloud || inStem || (onBorder && distCorner <= radius);
      const val = isWhite ? 255 : 0;
      raw[px] = val;
      raw[px + 1] = val;
      raw[px + 2] = val;
      raw[px + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const compressed = zlib.deflateSync(raw);
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function sanitizeExtensionName(raw?: string): string {
  const cleaned = (raw || '')
    .replace(/[\r\n\t<>"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 45);
  return cleaned || 'MochiDrop';
}

export function sanitizeExtensionDescription(raw?: string): string {
  const cleaned = (raw || '')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 132);
  return (
    cleaned ||
    'Cozy black-and-white browser video grabber with language track picker, Copy Link, and multi-network download handoff.'
  );
}

/**
 * Generates a standards-compliant ZIP archive (Store method) supporting both text and binary PNG entries.
 */
export function buildZipBuffer(files: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  const now = new Date();
  const dosTime =
    ((now.getHours() & 0x1f) << 11) |
    ((now.getMinutes() & 0x3f) << 5) |
    ((now.getSeconds() >> 1) & 0x1f);
  const dosDate =
    (((Math.max(1980, now.getFullYear()) - 1980) & 0x7f) << 9) |
    (((now.getMonth() + 1) & 0x0f) << 5) |
    (now.getDate() & 0x1f);

  for (const file of files) {
    const nameBuf = Buffer.from(file.path, 'utf8');
    const dataBuf = Buffer.isBuffer(file.content)
      ? file.content
      : Buffer.from(file.content, 'utf8');
    const checksum = crc32(dataBuf);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(dataBuf.length, 18);
    localHeader.writeUInt32LE(dataBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, dataBuf);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(dataBuf.length, 20);
    centralHeader.writeUInt32LE(dataBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + dataBuf.length;
  }

  const centralSize = centralParts.reduce((sum, b) => sum + b.length, 0);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(files.length, 8);
  endRecord.writeUInt16LE(files.length, 10);
  endRecord.writeUInt32LE(centralSize, 12);
  endRecord.writeUInt32LE(offset, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, endRecord]);
}

export function generateExtensionFiles(options: ExtensionOptions): ExtensionFile[] {
  const safeOrigin = options.plexoOrigin.replace(/\/+$/, '');
  const extName = sanitizeExtensionName(options.name);
  const extDesc = sanitizeExtensionDescription(options.description);
  const slug = extName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'mochidrop';

  const originLiteral = JSON.stringify(safeOrigin);
  const nameLiteral = JSON.stringify(extName);
  const htmlSafeName = escapeHtml(extName);

  const manifestJson = JSON.stringify(
    {
      manifest_version: 3,
      name: extName,
      version: '2.1.0',
      description: extDesc,
      icons: {
        '16': 'icons/icon16.png',
        '48': 'icons/icon48.png',
        '128': 'icons/icon128.png',
      },
      permissions: [
        'activeTab',
        'scripting',
        'storage',
        'downloads',
        'clipboardWrite',
        'tabs',
        'contextMenus',
      ],
      host_permissions: ['<all_urls>'],
      action: {
        default_popup: 'popup.html',
        default_title: `${extName}: Page Videos`,
        default_icon: {
          '16': 'icons/icon16.png',
          '48': 'icons/icon48.png',
        },
      },
      background: {
        service_worker: 'background.js',
      },
      content_scripts: [
        {
          matches: ['http://*/*', 'https://*/*'],
          js: ['content.js'],
          css: ['content.css'],
          run_at: 'document_idle',
          all_frames: true,
        },
      ],
      browser_specific_settings: {
        gecko: {
          id: `${slug}@extension.local`,
          strict_min_version: '109.0',
        },
      },
    },
    null,
    2
  );

  const contentCss = `/* ${extName} Monochrome Video Overlay */
.plexo-overlay-bar {
  position: fixed;
  z-index: 2147483645;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  background: #000000;
  color: #ffffff;
  border: 1px solid #404040;
  border-radius: 4px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 12px;
  line-height: 1;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.7);
  pointer-events: auto;
  transition: opacity 120ms ease;
}

.plexo-overlay-brand {
  font-weight: 700;
  letter-spacing: -0.02em;
  padding: 0 4px;
  color: #ffffff;
  white-space: nowrap;
}

.plexo-overlay-select {
  appearance: none;
  background: #141416;
  color: #ffffff;
  border: 1px solid #404040;
  border-radius: 3px;
  padding: 4px 8px;
  font-size: 11px;
  cursor: pointer;
  max-width: 145px;
}

.plexo-overlay-btn {
  border-radius: 3px;
  padding: 5px 9px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  border: 1px solid transparent;
  transition: background 120ms ease, color 120ms ease;
}

.plexo-overlay-btn-primary {
  background: #ffffff;
  color: #000000;
}

.plexo-overlay-btn-primary:hover {
  background: #e5e5e5;
}

.plexo-overlay-btn-secondary {
  background: #000000;
  color: #ffffff;
  border-color: #525252;
}

.plexo-overlay-btn-secondary:hover {
  background: #171717;
}
`;

  const contentJs = `(() => {
  const APP_ORIGIN = ${originLiteral};
  const BRAND_NAME = ${nameLiteral};
  const trackedVideos = new Map();
  const networkStreams = new Set();

  function safeUrl(raw) {
    try {
      const parsed = new URL(raw, window.location.href);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.href;
      }
    } catch (_) {}
    return '';
  }

  function extractLanguages(videoEl) {
    const langs = [];
    const seen = new Set();

    const addLang = (code, label, kind) => {
      const key = (code || label || 'default').toLowerCase() + ':' + kind;
      if (seen.has(key)) return;
      seen.add(key);
      langs.push({ code: code || 'default', label: label || code || 'Original Audio', kind });
    };

    if (videoEl.audioTracks && videoEl.audioTracks.length > 0) {
      for (let i = 0; i < videoEl.audioTracks.length; i++) {
        const track = videoEl.audioTracks[i];
        addLang(track.language || 'und', track.label || track.language || 'Audio ' + (i + 1), 'audio');
      }
    }

    if (videoEl.textTracks && videoEl.textTracks.length > 0) {
      for (let i = 0; i < videoEl.textTracks.length; i++) {
        const track = videoEl.textTracks[i];
        addLang(track.language || 'sub', (track.label || track.language || 'Subtitles') + ' (Sub)', 'subtitle');
      }
    }

    const trackNodes = videoEl.querySelectorAll('track');
    trackNodes.forEach((node) => {
      const srclang = node.getAttribute('srclang') || 'sub';
      const label = node.getAttribute('label') || srclang.toUpperCase();
      addLang(srclang, label + ' (Sub)', 'subtitle');
    });

    if (langs.length === 0) {
      const docLang = document.documentElement.lang || navigator.language || 'en';
      addLang(docLang, 'Original (' + docLang.toUpperCase() + ')', 'audio');
    }
    return langs;
  }

  function extractQualities(videoEl) {
    const qualities = [];
    const h = videoEl.videoHeight || 0;
    if (h >= 2160) qualities.push('2160p 4K');
    if (h >= 1080 || h === 0) qualities.push('1080p HD');
    if (h >= 720 || h === 0) qualities.push('720p');
    qualities.push('480p', 'Audio Only (M4A)');
    return Array.from(new Set(qualities));
  }

  function resolveVideoUrl(videoEl) {
    const direct = safeUrl(videoEl.currentSrc || videoEl.src || '');
    if (direct && !direct.startsWith('blob:')) return direct;
    const sourceNode = videoEl.querySelector('source[src]');
    if (sourceNode) {
      const fromSource = safeUrl(sourceNode.getAttribute('src') || '');
      if (fromSource) return fromSource;
    }
    const lastStream = Array.from(networkStreams).pop();
    return lastStream || window.location.href;
  }

  function buildDownloadLink(baseUrl, quality, language) {
    try {
      const u = new URL(baseUrl);
      u.searchParams.set('plexo_quality', quality);
      u.searchParams.set('plexo_lang', language);
      return u.href;
    } catch (_) {
      return baseUrl;
    }
  }

  function createOverlay(videoEl, index) {
    const bar = document.createElement('div');
    bar.className = 'plexo-overlay-bar';

    const brand = document.createElement('span');
    brand.className = 'plexo-overlay-brand';
    brand.textContent = BRAND_NAME;
    bar.appendChild(brand);

    const qualitySelect = document.createElement('select');
    qualitySelect.className = 'plexo-overlay-select';
    qualitySelect.title = 'Select video quality';
    extractQualities(videoEl).forEach((q) => {
      const opt = document.createElement('option');
      opt.value = q;
      opt.textContent = q;
      qualitySelect.appendChild(opt);
    });
    bar.appendChild(qualitySelect);

    const langSelect = document.createElement('select');
    langSelect.className = 'plexo-overlay-select';
    langSelect.title = 'Select audio or subtitle language';
    const populateLanguages = () => {
      while (langSelect.firstChild) langSelect.removeChild(langSelect.firstChild);
      extractLanguages(videoEl).forEach((item) => {
        const opt = document.createElement('option');
        opt.value = item.label;
        opt.textContent = item.label;
        langSelect.appendChild(opt);
      });
    };
    populateLanguages();
    bar.appendChild(langSelect);

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'plexo-overlay-btn plexo-overlay-btn-secondary';
    copyBtn.textContent = 'Copy Link';
    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const targetUrl = buildDownloadLink(resolveVideoUrl(videoEl), qualitySelect.value, langSelect.value);
      try {
        await navigator.clipboard.writeText(targetUrl);
        copyBtn.textContent = 'Copied';
        setTimeout(() => { copyBtn.textContent = 'Copy Link'; }, 1500);
      } catch (_) {
        copyBtn.textContent = 'Copy failed';
      }
    });
    bar.appendChild(copyBtn);

    const dlBtn = document.createElement('button');
    dlBtn.type = 'button';
    dlBtn.className = 'plexo-overlay-btn plexo-overlay-btn-primary';
    dlBtn.textContent = 'Download';
    dlBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const payload = {
        title: (document.title || 'Browser Video') + (index > 0 ? ' #' + (index + 1) : ''),
        url: resolveVideoUrl(videoEl),
        quality: qualitySelect.value,
        language: langSelect.value,
        sourcePage: window.location.href,
        origin: APP_ORIGIN,
      };
      dlBtn.textContent = 'Sending...';
      chrome.runtime.sendMessage({ type: 'PLEXO_HANDOFF_DOWNLOAD', payload }, (resp) => {
        dlBtn.textContent = resp && resp.ok ? 'Started' : 'Queued';
        setTimeout(() => { dlBtn.textContent = 'Download'; }, 2000);
      });
    });
    bar.appendChild(dlBtn);

    document.body.appendChild(bar);
    videoEl.addEventListener('loadedmetadata', populateLanguages);

    const reposition = () => {
      const rect = videoEl.getBoundingClientRect();
      const visible = rect.width >= 160 && rect.height >= 90 && rect.bottom > 0 && rect.top < window.innerHeight;
      if (!visible) {
        bar.style.opacity = '0';
        bar.style.pointerEvents = 'none';
        return;
      }
      bar.style.opacity = '1';
      bar.style.pointerEvents = 'auto';
      const top = Math.max(8, rect.top + 10);
      const rightOffset = Math.max(8, window.innerWidth - rect.right + 10);
      bar.style.top = top + 'px';
      bar.style.right = rightOffset + 'px';
    };

    reposition();
    return { bar, reposition, qualitySelect, langSelect };
  }

  function scanVideos() {
    const videos = Array.from(document.querySelectorAll('video'));
    videos.forEach((videoEl, idx) => {
      if (!trackedVideos.has(videoEl)) {
        trackedVideos.set(videoEl, createOverlay(videoEl, idx));
      } else {
        trackedVideos.get(videoEl).reposition();
      }
    });

    for (const [videoEl, state] of trackedVideos.entries()) {
      if (!document.contains(videoEl)) {
        state.bar.remove();
        trackedVideos.delete(videoEl);
      }
    }
  }

  if (typeof PerformanceObserver !== 'undefined') {
    try {
      const perfObs = new PerformanceObserver((list) => {
        list.getEntries().forEach((entry) => {
          const name = entry.name || '';
          if (/\\.(mp4|webm|m3u8|mpd|mkv)(\\?|$)/i.test(name)) {
            const valid = safeUrl(name);
            if (valid) networkStreams.add(valid);
          }
        });
      });
      perfObs.observe({ entryTypes: ['resource'] });
    } catch (_) {}
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'PLEXO_LIST_PAGE_VIDEOS') {
      scanVideos();
      const items = [];
      let idx = 0;
      for (const [videoEl, state] of trackedVideos.entries()) {
        items.push({
          id: 'vid-' + idx,
          title: (document.title || 'Detected Video') + (trackedVideos.size > 1 ? ' #' + (idx + 1) : ''),
          url: resolveVideoUrl(videoEl),
          duration: Number.isFinite(videoEl.duration) ? Math.round(videoEl.duration) : 0,
          resolution: videoEl.videoHeight ? videoEl.videoHeight + 'p' : state.qualitySelect.value,
          qualities: extractQualities(videoEl),
          languages: extractLanguages(videoEl).map((l) => l.label),
          selectedQuality: state.qualitySelect.value,
          selectedLanguage: state.langSelect.value,
          sourcePage: window.location.href,
        });
        idx++;
      }
      sendResponse({ ok: true, videos: items, origin: APP_ORIGIN });
      return true;
    }
    return false;
  });

  const observer = new MutationObserver(() => scanVideos());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('scroll', scanVideos, { passive: true });
  window.addEventListener('resize', scanVideos, { passive: true });
  setInterval(scanVideos, 2000);
  scanVideos();
})();
`;

  const backgroundJs = `const DEFAULT_APP_ORIGIN = ${originLiteral};
const BRAND_NAME = ${nameLiteral};

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'mochidrop-download-any',
      title: 'Download with ' + BRAND_NAME,
      contexts: ['link', 'video', 'audio', 'image'],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'mochidrop-download-any') return;
  const targetUrl = info.linkUrl || info.srcUrl || '';
  if (!targetUrl) return;
  handleHandoff({
    title: (tab && tab.title) || 'Browser Link Download',
    url: targetUrl,
    quality: 'Original',
    language: 'Default',
    sourcePage: info.pageUrl || '',
    origin: DEFAULT_APP_ORIGIN,
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'PLEXO_HANDOFF_DOWNLOAD' && msg.payload) {
    handleHandoff(msg.payload)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  return false;
});

async function handleHandoff(payload) {
  const stored = await chrome.storage.local.get(['plexoEndpoint']);
  const base = (stored.plexoEndpoint || payload.origin || DEFAULT_APP_ORIGIN).replace(/\\/+$/, '');

  try {
    const response = await fetch(base + '/api/extension/handoff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: payload.title,
        url: payload.url,
        quality: payload.quality || '1080p HD',
        language: payload.language || 'Original',
        sourcePage: payload.sourcePage || '',
      }),
    });
    if (response.ok) {
      return { ok: true, mode: 'app-bridge' };
    }
  } catch (_) {}

  if (payload.url && /^https?:\\/\\//i.test(payload.url)) {
    await chrome.downloads.download({ url: payload.url });
    return { ok: true, mode: 'browser-fallback' };
  }
  return { ok: false, error: 'Unsupported URL' };
}
`;

  const popupHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>${htmlSafeName}</title>
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        width: 380px;
        background: #000000;
        color: #ffffff;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        padding: 14px;
      }
      header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding-bottom: 12px;
        border-bottom: 1px solid #262626;
        margin-bottom: 12px;
      }
      h1 { font-size: 15px; font-weight: 700; letter-spacing: -0.02em; }
      .meta { font-size: 11px; color: #a3a3a3; margin-top: 2px; }
      .list { display: flex; flex-direction: column; gap: 10px; max-height: 360px; overflow-y: auto; }
      .item {
        background: #0a0a0a;
        border: 1px solid #262626;
        border-radius: 4px;
        padding: 10px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .title { font-size: 13px; font-weight: 600; color: #ffffff; word-break: break-word; }
      .row { display: flex; gap: 6px; align-items: center; }
      select {
        flex: 1;
        background: #171717;
        color: #ffffff;
        border: 1px solid #404040;
        border-radius: 3px;
        padding: 5px 6px;
        font-size: 11px;
      }
      button {
        padding: 6px 10px;
        border-radius: 3px;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        border: 1px solid #404040;
        background: #000000;
        color: #ffffff;
      }
      button.primary {
        background: #ffffff;
        color: #000000;
        border-color: #ffffff;
      }
      .empty {
        padding: 24px 12px;
        text-align: center;
        color: #a3a3a3;
        font-size: 12px;
        border: 1px dashed #262626;
        border-radius: 4px;
      }
    </style>
  </head>
  <body>
    <header>
      <div>
        <h1>${htmlSafeName}</h1>
        <div id="count-meta" class="meta">Scanning active tab...</div>
      </div>
      <button id="open-app" type="button">Open App</button>
    </header>
    <div id="video-list" class="list"></div>
    <script src="popup.js"></script>
  </body>
</html>
`;

  const popupJs = `const APP_ORIGIN = ${originLiteral};
const BRAND_NAME = ${nameLiteral};

document.getElementById('open-app').addEventListener('click', () => {
  chrome.tabs.create({ url: APP_ORIGIN });
});

async function loadTabVideos() {
  const listEl = document.getElementById('video-list');
  const countEl = document.getElementById('count-meta');
  while (listEl.firstChild) listEl.removeChild(listEl.firstChild);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    countEl.textContent = 'No active tab';
    return;
  }

  chrome.tabs.sendMessage(tab.id, { type: 'PLEXO_LIST_PAGE_VIDEOS' }, (res) => {
    const videos = (res && res.videos) || [];
    countEl.textContent = videos.length + (videos.length === 1 ? ' video on tab' : ' videos on tab');

    if (videos.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Play any video on this page. ' + BRAND_NAME + ' detects all videos and available languages automatically.';
      listEl.appendChild(empty);
      return;
    }

    videos.forEach((v) => {
      const card = document.createElement('div');
      card.className = 'item';

      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = v.title;
      card.appendChild(title);

      const selectsRow = document.createElement('div');
      selectsRow.className = 'row';

      const qSel = document.createElement('select');
      (v.qualities || ['1080p HD', '720p']).forEach((q) => {
        const opt = document.createElement('option');
        opt.value = q;
        opt.textContent = q;
        if (q === v.selectedQuality) opt.selected = true;
        qSel.appendChild(opt);
      });

      const lSel = document.createElement('select');
      (v.languages || ['Original']).forEach((l) => {
        const opt = document.createElement('option');
        opt.value = l;
        opt.textContent = l;
        if (l === v.selectedLanguage) opt.selected = true;
        lSel.appendChild(opt);
      });

      selectsRow.appendChild(qSel);
      selectsRow.appendChild(lSel);
      card.appendChild(selectsRow);

      const actionsRow = document.createElement('div');
      actionsRow.className = 'row';

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.textContent = 'Copy Link';
      copyBtn.addEventListener('click', async () => {
        try {
          const u = new URL(v.url);
          u.searchParams.set('plexo_quality', qSel.value);
          u.searchParams.set('plexo_lang', lSel.value);
          await navigator.clipboard.writeText(u.href);
          copyBtn.textContent = 'Copied';
          setTimeout(() => { copyBtn.textContent = 'Copy Link'; }, 1400);
        } catch (_) {}
      });

      const dlBtn = document.createElement('button');
      dlBtn.type = 'button';
      dlBtn.className = 'primary';
      dlBtn.textContent = 'Download';
      dlBtn.addEventListener('click', () => {
        dlBtn.textContent = 'Starting...';
        chrome.runtime.sendMessage(
          {
            type: 'PLEXO_HANDOFF_DOWNLOAD',
            payload: {
              title: v.title,
              url: v.url,
              quality: qSel.value,
              language: lSel.value,
              sourcePage: v.sourcePage,
              origin: APP_ORIGIN,
            },
          },
          () => {
            dlBtn.textContent = 'Started';
            setTimeout(() => { dlBtn.textContent = 'Download'; }, 1800);
          }
        );
      });

      actionsRow.appendChild(copyBtn);
      actionsRow.appendChild(dlBtn);
      card.appendChild(actionsRow);
      listEl.appendChild(card);
    });
  });
}

loadTabVideos();
`;

  const readmeTxt = `${extName} Browser Extension (Manifest V3)
=========================================

Connected App URL: ${safeOrigin}

1. Install Yourself (Chrome, Edge, Brave, Opera):
   - Unzip this file to a folder on your computer.
   - Open chrome://extensions (or edge://extensions).
   - Turn on "Developer mode" (top right).
   - Click "Load unpacked" and choose the unzipped folder.

2. Install Yourself (Firefox):
   - Unzip this file to a folder.
   - Open about:debugging#/runtime/this-firefox.
   - Click "Load Temporary Add-on..." and pick manifest.json.

3. Publish So Anyone Can Install in 1 Click:
   - Chrome Web Store: https://chrome.google.com/webstore/devconsole
     Upload this exact ZIP file (it already includes 16/48/128 PNG icons and Manifest V3).
   - Firefox Add-ons (Free): https://addons.mozilla.org/developers/
     Upload this exact ZIP file (manifest.json includes browser_specific_settings.gecko).
   - Microsoft Edge Add-ons (Free): https://partner.microsoft.com/dashboard/microsoftedge/
     Upload this exact ZIP file directly.
`;

  return [
    {
      path: 'manifest.json',
      language: 'json',
      description: 'Manifest V3 config with 16/48/128 PNG icons for Chrome, Edge, and Firefox stores',
      content: manifestJson,
    },
    {
      path: 'content.js',
      language: 'javascript',
      description: 'Attaches the monochrome download bar and language selector on every page video',
      content: contentJs,
    },
    {
      path: 'content.css',
      language: 'css',
      description: 'Solid black-and-white styles for the video overlay bar',
      content: contentCss,
    },
    {
      path: 'background.js',
      language: 'javascript',
      description: 'Service worker handing downloads directly to your app',
      content: backgroundJs,
    },
    {
      path: 'popup.html',
      language: 'html',
      description: 'Toolbar popup listing all videos detected on the current tab',
      content: popupHtml,
    },
    {
      path: 'popup.js',
      language: 'javascript',
      description: 'Popup logic for quality, language, Copy Link, and direct Download',
      content: popupJs,
    },
    {
      path: 'README.txt',
      language: 'text',
      description: 'Local install and Chrome/Edge/Firefox Web Store publishing steps',
      content: readmeTxt,
    },
  ];
}

export function buildStoreReadyExtensionZip(options: ExtensionOptions): {
  filename: string;
  buffer: Buffer;
} {
  const extName = sanitizeExtensionName(options.name);
  const slug =
    extName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'mochidrop';

  const textFiles = generateExtensionFiles(options);
  const entries: ZipEntry[] = [
    ...textFiles.map((f) => ({ path: f.path, content: f.content })),
    { path: 'icons/icon16.png', content: generateMonochromePngIcon(16) },
    { path: 'icons/icon48.png', content: generateMonochromePngIcon(48) },
    { path: 'icons/icon128.png', content: generateMonochromePngIcon(128) },
  ];

  return {
    filename: `${slug}-web-extension.zip`,
    buffer: buildZipBuffer(entries),
  };
}
