import React, { useState } from 'react';
import {
  Check,
  Code2,
  Copy,
  Download,
  FileCode,
  FolderArchive,
  Globe,
  Languages,
  Link2,
  MousePointerClick,
  Share2,
} from 'lucide-react';
import { PlexoSettings } from '../types/plexo';

interface ExtensionViewProps {
  settings: PlexoSettings;
  onUpdateSettings: (patch: Partial<PlexoSettings>) => void;
  onNotify: (msg: string) => void;
}

interface ExtensionFilePreview {
  name: string;
  size: number;
  content: string;
}

type GuideTab = 'chromium' | 'firefox' | 'publish';

export const ExtensionView: React.FC<ExtensionViewProps> = ({
  settings,
  onUpdateSettings,
  onNotify,
}) => {
  const [guideTab, setGuideTab] = useState<GuideTab>('chromium');
  const [showFiles, setShowFiles] = useState(false);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [files, setFiles] = useState<ExtensionFilePreview[]>([]);
  const [selectedFile, setSelectedFile] = useState<string>('manifest.json');
  const [copiedEndpoint, setCopiedEndpoint] = useState(false);

  const bridgeEndpoint =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/extension/handoff`
      : 'http://localhost:3000/api/extension/handoff';

  async function handleToggleInspectFiles() {
    if (showFiles) {
      setShowFiles(false);
      return;
    }
    setShowFiles(true);
    if (files.length > 0) return;
    setLoadingFiles(true);
    try {
      const res = await fetch('/api/extension/files');
      if (!res.ok) throw new Error('Failed to load extension files');
      const data = await res.json();
      if (Array.isArray(data.files)) {
        setFiles(data.files);
        if (data.files.length > 0) {
          setSelectedFile(data.files[0].name);
        }
      }
    } catch {
      onNotify('Could not load extension source files');
    } finally {
      setLoadingFiles(false);
    }
  }

  async function handleCopyEndpoint() {
    try {
      await navigator.clipboard.writeText(bridgeEndpoint);
      setCopiedEndpoint(true);
      onNotify('Bridge endpoint copied');
      setTimeout(() => setCopiedEndpoint(false), 1600);
    } catch {
      onNotify('Clipboard permission denied');
    }
  }

  const activeFile = files.find((f) => f.name === selectedFile) ?? files[0];

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[1.15fr_0.85fr] gap-6 items-start">
      {/* Left Column: Extension Package + Capabilities + Capture Rules */}
      <div className="min-w-0 space-y-5">
        <section className="border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-[#0A0A0A] rounded-md overflow-hidden">
          <div className="p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-xs font-mono text-neutral-500 dark:text-neutral-400">
                  <span>Manifest V3</span>
                  <span aria-hidden="true">·</span>
                  <span>Chrome / Edge / Brave / Firefox</span>
                </div>
                <h2 className="font-display text-xl font-bold tracking-tight text-black dark:text-white">
                  MochiDrop Browser Extension
                </h2>
                <p className="text-xs sm:text-sm text-neutral-600 dark:text-neutral-400 max-w-xl">
                  Adds a black-and-white download bar onto every video you open in your browser, lists all available languages, copies direct links, and hands off any file straight to MochiDrop.
                </p>
              </div>
            </div>

            {/* Feature Strip */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
              <div className="border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-black rounded-xs p-3 space-y-1">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-black dark:text-white">
                  <Languages className="h-3.5 w-3.5" />
                  All Videos & Languages
                </div>
                <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
                  Attaches to every video element on the page and reads all available audio and subtitle tracks.
                </p>
              </div>

              <div className="border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-black rounded-xs p-3 space-y-1">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-black dark:text-white">
                  <Link2 className="h-3.5 w-3.5" />
                  Copy Link & Direct Start
                </div>
                <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
                  Copy the direct stream link or send it straight into MochiDrop to start multi-link downloading.
                </p>
              </div>

              <div className="border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-black rounded-xs p-3 space-y-1">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-black dark:text-white">
                  <MousePointerClick className="h-3.5 w-3.5" />
                  Right-Click Any Link
                </div>
                <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
                  Right-click any link, video, audio, image, archive, or magnet URL to queue it in one click.
                </p>
              </div>
            </div>

            {/* Download & Inspect Actions */}
            <div className="flex flex-wrap items-center gap-2.5 pt-1">
              <a
                href="/api/extension/download"
                download="mochidrop-web-extension.zip"
                className="h-10 px-4 rounded-sm bg-black text-white dark:bg-white dark:text-black text-xs font-semibold hover:bg-neutral-800 dark:hover:bg-neutral-200 transition-colors inline-flex items-center gap-2 whitespace-nowrap"
              >
                <Download className="h-4 w-4" />
                Download MochiDrop Extension (.zip)
              </a>

              <button
                type="button"
                onClick={() => void handleToggleInspectFiles()}
                className="h-10 px-3.5 rounded-sm border border-neutral-300 dark:border-neutral-700 text-xs font-medium text-neutral-800 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-900 inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Code2 className="h-3.5 w-3.5" />
                {showFiles ? 'Hide ZIP Contents' : 'Inspect ZIP Files'}
              </button>
            </div>
          </div>

          {/* Optional ZIP Source Inspector */}
          {showFiles && (
            <div className="border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-black p-4 space-y-3">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-black dark:text-white inline-flex items-center gap-1.5">
                  <FolderArchive className="h-3.5 w-3.5" />
                  Bundled Package Files (includes 16px, 48px, 128px icons)
                </span>
                <span className="font-mono text-[11px] text-neutral-500">
                  {files.length} source files
                </span>
              </div>

              {loadingFiles ? (
                <p className="text-xs font-mono text-neutral-500">Loading package files...</p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-[190px_1fr] gap-3">
                  <div className="border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-[#0A0A0A] rounded-xs divide-y divide-neutral-200 dark:divide-neutral-800">
                    {files.map((f) => (
                      <button
                        key={f.name}
                        type="button"
                        onClick={() => setSelectedFile(f.name)}
                        className={`w-full px-2.5 py-2 text-left text-xs font-mono flex items-center justify-between gap-2 cursor-pointer ${
                          activeFile?.name === f.name
                            ? 'bg-black text-white dark:bg-white dark:text-black'
                            : 'text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-900'
                        }`}
                      >
                        <span className="truncate inline-flex items-center gap-1.5">
                          <FileCode className="h-3 w-3 shrink-0" />
                          {f.name}
                        </span>
                      </button>
                    ))}
                  </div>

                  <div className="border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-[#0A0A0A] rounded-xs overflow-hidden">
                    <div className="px-3 py-1.5 border-b border-neutral-200 dark:border-neutral-800 flex items-center justify-between text-[11px] font-mono text-neutral-500">
                      <span>{activeFile?.name}</span>
                      <span className="tabular-nums">{activeFile?.size ?? 0} bytes</span>
                    </div>
                    <pre className="p-3 text-[11px] font-mono text-neutral-800 dark:text-neutral-200 overflow-x-auto max-h-72 overflow-y-auto leading-relaxed">
                      {activeFile?.content || ''}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        {/* Capture Settings & Local Bridge */}
        <section className="border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-[#0A0A0A] rounded-md p-4 space-y-4">
          <h3 className="text-sm font-semibold text-black dark:text-white">
            Extension Capture & Handoff
          </h3>

          <div className="space-y-3 text-xs">
            <label className="flex items-center justify-between cursor-pointer">
              <span className="text-neutral-800 dark:text-neutral-200">
                Auto-capture browser downloads into MochiDrop
              </span>
              <input
                type="checkbox"
                checked={settings.autoCaptureBrowser}
                onChange={(e) => onUpdateSettings({ autoCaptureBrowser: e.target.checked })}
                className="h-4 w-4 accent-black dark:accent-white"
              />
            </label>

            <label className="flex items-center justify-between cursor-pointer">
              <span className="text-neutral-800 dark:text-neutral-200">
                Watch clipboard for copied download links
              </span>
              <input
                type="checkbox"
                checked={settings.autoDetectClipboard}
                onChange={(e) => onUpdateSettings({ autoDetectClipboard: e.target.checked })}
                className="h-4 w-4 accent-black dark:accent-white"
              />
            </label>

            <div className="flex items-center justify-between">
              <span className="text-neutral-800 dark:text-neutral-200">
                Skip files smaller than (MB)
              </span>
              <input
                type="number"
                min={0}
                max={500}
                value={settings.skipSmallFilesMb}
                onChange={(e) =>
                  onUpdateSettings({
                    skipSmallFilesMb: Math.max(0, Number(e.target.value) || 0),
                  })
                }
                className="w-20 h-8 rounded-xs border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-black px-2 text-right font-mono tabular-nums text-xs text-black dark:text-white"
              />
            </div>
          </div>

          <div className="pt-3 border-t border-neutral-200 dark:border-neutral-800 space-y-1.5">
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              Extension Handoff Endpoint
            </span>
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                readOnly
                value={bridgeEndpoint}
                className="flex-1 min-w-0 h-8 rounded-xs border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-black px-2.5 text-xs font-mono text-neutral-700 dark:text-neutral-300"
              />
              <button
                type="button"
                onClick={handleCopyEndpoint}
                className="h-8 px-2.5 rounded-xs border border-neutral-300 dark:border-neutral-700 text-xs font-medium text-black dark:text-white hover:bg-neutral-100 dark:hover:bg-neutral-900 inline-flex items-center gap-1 shrink-0 cursor-pointer"
              >
                {copiedEndpoint ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copiedEndpoint ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        </section>
      </div>

      {/* Right Column: Install & Share Guide */}
      <aside className="border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-[#0A0A0A] rounded-md overflow-hidden xl:sticky xl:top-20">
        <div className="p-4 border-b border-neutral-200 dark:border-neutral-800 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-black dark:text-white inline-flex items-center gap-1.5">
              <Globe className="h-4 w-4" />
              How to Add & Share
            </h3>
            <span className="text-[11px] font-mono text-neutral-500">v1.0.0</span>
          </div>

          <div className="grid grid-cols-3 gap-1 p-0.5 rounded-xs border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-black">
            {(
              [
                { id: 'chromium', label: 'Chrome / Edge' },
                { id: 'firefox', label: 'Firefox' },
                { id: 'publish', label: 'Share / Store' },
              ] as Array<{ id: GuideTab; label: string }>
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setGuideTab(tab.id)}
                className={`py-1.5 px-2 rounded-xs text-[11px] font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                  guideTab === tab.id
                    ? 'bg-black text-white dark:bg-white dark:text-black'
                    : 'text-neutral-600 dark:text-neutral-400 hover:text-black dark:hover:text-white'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <div className="p-4 space-y-4 text-xs">
          {guideTab === 'chromium' && (
            <ol className="space-y-3 text-neutral-700 dark:text-neutral-300">
              <li className="flex gap-2.5">
                <span className="font-mono font-bold text-black dark:text-white">01</span>
                <span>
                  Click <strong className="text-black dark:text-white">Download MochiDrop Extension (.zip)</strong> and extract the folder to your computer.
                </span>
              </li>
              <li className="flex gap-2.5">
                <span className="font-mono font-bold text-black dark:text-white">02</span>
                <span>
                  Open <code className="font-mono text-black dark:text-white">chrome://extensions</code>,{' '}
                  <code className="font-mono text-black dark:text-white">edge://extensions</code>, or{' '}
                  <code className="font-mono text-black dark:text-white">brave://extensions</code>.
                </span>
              </li>
              <li className="flex gap-2.5">
                <span className="font-mono font-bold text-black dark:text-white">03</span>
                <span>
                  Turn on <strong className="text-black dark:text-white">Developer mode</strong> in the top-right corner.
                </span>
              </li>
              <li className="flex gap-2.5">
                <span className="font-mono font-bold text-black dark:text-white">04</span>
                <span>
                  Click <strong className="text-black dark:text-white">Load unpacked</strong> and select the extracted <code className="font-mono text-black dark:text-white">mochidrop-web-extension</code> folder.
                </span>
              </li>
              <li className="flex gap-2.5">
                <span className="font-mono font-bold text-black dark:text-white">05</span>
                <span>
                  Open any webpage with videos. Every video shows a black-and-white MochiDrop bar with language selector, Copy Link, and Direct Download.
                </span>
              </li>
            </ol>
          )}

          {guideTab === 'firefox' && (
            <ol className="space-y-3 text-neutral-700 dark:text-neutral-300">
              <li className="flex gap-2.5">
                <span className="font-mono font-bold text-black dark:text-white">01</span>
                <span>
                  Download and unzip <code className="font-mono text-black dark:text-white">mochidrop-web-extension.zip</code>.
                </span>
              </li>
              <li className="flex gap-2.5">
                <span className="font-mono font-bold text-black dark:text-white">02</span>
                <span>
                  In Firefox, visit <code className="font-mono text-black dark:text-white">about:debugging#/runtime/this-firefox</code>.
                </span>
              </li>
              <li className="flex gap-2.5">
                <span className="font-mono font-bold text-black dark:text-white">03</span>
                <span>
                  Click <strong className="text-black dark:text-white">Load Temporary Add-on</strong> and choose <code className="font-mono text-black dark:text-white">manifest.json</code> inside the unzipped folder.
                </span>
              </li>
              <li className="flex gap-2.5">
                <span className="font-mono font-bold text-black dark:text-white">04</span>
                <span>
                  For permanent Firefox installation without Developer mode, upload the ZIP to Firefox Add-on Developer Hub (<code className="font-mono text-black dark:text-white">addons.mozilla.org</code>) to get a signed <code className="font-mono text-black dark:text-white">.xpi</code> file.
                </span>
              </li>
            </ol>
          )}

          {guideTab === 'publish' && (
            <div className="space-y-3 text-neutral-700 dark:text-neutral-300">
              <div className="flex items-center gap-1.5 font-semibold text-black dark:text-white">
                <Share2 className="h-3.5 w-3.5" />
                Let Other People Install MochiDrop
              </div>
              <ol className="space-y-2.5">
                <li className="flex gap-2.5">
                  <span className="font-mono font-bold text-black dark:text-white">01</span>
                  <span>
                    <strong className="text-black dark:text-white">Direct Share:</strong> Send <code className="font-mono text-black dark:text-white">mochidrop-web-extension.zip</code> to friends or host it on GitHub Releases so anyone can add it via Load Unpacked.
                  </span>
                </li>
                <li className="flex gap-2.5">
                  <span className="font-mono font-bold text-black dark:text-white">02</span>
                  <span>
                    <strong className="text-black dark:text-white">Chrome Web Store:</strong> Upload the ZIP directly to the Chrome Web Store Developer Dashboard (Manifest V3 and 16/48/128px PNG icons are already bundled).
                  </span>
                </li>
                <li className="flex gap-2.5">
                  <span className="font-mono font-bold text-black dark:text-white">03</span>
                  <span>
                    <strong className="text-black dark:text-white">Edge & Firefox Stores:</strong> The same ZIP works on Microsoft Edge Add-ons (free submission) and Mozilla AMO.
                  </span>
                </li>
              </ol>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
};
