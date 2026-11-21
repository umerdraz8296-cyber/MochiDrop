import React, { useState } from 'react';
import { Clock, Folder, HardDrive, Plug, Plus, Trash2 } from 'lucide-react';
import { PlexoPlugin, PlexoSettings } from '../types/plexo';

interface SettingsViewProps {
  plugins: PlexoPlugin[];
  settings: PlexoSettings;
  onTogglePlugin: (id: string) => void;
  onUpdateSettings: (patch: Partial<PlexoSettings>) => void;
  onNotify: (msg: string) => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  plugins,
  settings,
  onTogglePlugin,
  onUpdateSettings,
  onNotify,
}) => {
  const [newExclusion, setNewExclusion] = useState('');

  function handleAddExclusion(e: React.FormEvent) {
    e.preventDefault();
    const cleaned = newExclusion.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
    if (!cleaned) return;
    if (settings.siteExclusions.includes(cleaned)) {
      onNotify(`${cleaned} is already excluded`);
      return;
    }
    onUpdateSettings({ siteExclusions: [...settings.siteExclusions, cleaned] });
    setNewExclusion('');
    onNotify(`Excluded ${cleaned}`);
  }

  return (
    <div className="space-y-6">
      {/* Plugins */}
      <section className="border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-[#0A0A0A] rounded-md overflow-hidden">
        <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold text-black dark:text-white">
            <Plug className="h-4 w-4" />
            Plugins
          </div>
          <span className="text-xs font-mono tabular-nums text-neutral-500 dark:text-neutral-400">
            {plugins.filter((p) => p.enabled).length}/{plugins.length} active
          </span>
        </div>

        <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
          {plugins.map((plugin) => (
            <div
              key={plugin.id}
              className="px-4 py-3.5 flex items-start justify-between gap-4 hover:bg-neutral-50 dark:hover:bg-neutral-950"
            >
              <div className="space-y-0.5 min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 text-xs sm:text-sm">
                  <span className="font-semibold text-black dark:text-white">{plugin.name}</span>
                  <span className="text-neutral-400" aria-hidden="true">
                    ·
                  </span>
                  <span className="text-xs text-neutral-500 dark:text-neutral-400">
                    {plugin.category}
                  </span>
                </div>
                <p className="text-xs text-neutral-500 dark:text-neutral-400 max-w-2xl">
                  {plugin.description}
                </p>
              </div>

              <button
                type="button"
                role="switch"
                aria-checked={plugin.enabled}
                onClick={() => onTogglePlugin(plugin.id)}
                className={`relative inline-flex h-5 w-10 shrink-0 items-center rounded-full border transition-colors cursor-pointer ${
                  plugin.enabled
                    ? 'bg-black border-black dark:bg-white dark:border-white'
                    : 'bg-neutral-200 border-neutral-300 dark:bg-neutral-900 dark:border-neutral-700'
                }`}
              >
                <span
                  className={`inline-block h-3.5 w-3.5 rounded-full transition-transform ${
                    plugin.enabled
                      ? 'translate-x-5 bg-white dark:bg-black'
                      : 'translate-x-0.5 bg-neutral-500'
                  }`}
                />
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* Disk & Capture Rules */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <section className="border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-[#0A0A0A] rounded-md p-4 space-y-4">
          <h3 className="text-sm font-semibold text-black dark:text-white">Disk & Schedule</h3>

          <label className="block space-y-1">
            <span className="text-xs text-neutral-500 dark:text-neutral-400 inline-flex items-center gap-1.5">
              <Folder className="h-3.5 w-3.5" />
              Save Folder
            </span>
            <input
              type="text"
              value={settings.downloadDirectory}
              onChange={(e) => onUpdateSettings({ downloadDirectory: e.target.value })}
              className="w-full h-9 rounded-xs border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-black px-2.5 text-xs font-mono text-black dark:text-white"
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1">
              <span className="text-xs text-neutral-500 dark:text-neutral-400">
                Global Speed Cap (Mbps)
              </span>
              <input
                type="number"
                min={0}
                max={5000}
                placeholder="No limit"
                value={settings.globalSpeedCapMbps ?? ''}
                onChange={(e) =>
                  onUpdateSettings({
                    globalSpeedCapMbps:
                      e.target.value === '' ? null : Math.max(10, Number(e.target.value)),
                  })
                }
                className="w-full h-9 rounded-xs border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-black px-2.5 text-xs font-mono tabular-nums text-black dark:text-white"
              />
            </label>

            <label className="block space-y-1">
              <span className="text-xs text-neutral-500 dark:text-neutral-400">
                Connections / Link
              </span>
              <input
                type="number"
                min={1}
                max={16}
                value={settings.maxConnectionsPerAdapter}
                onChange={(e) =>
                  onUpdateSettings({
                    maxConnectionsPerAdapter: Math.max(
                      1,
                      Math.min(16, Number(e.target.value) || 4)
                    ),
                  })
                }
                className="w-full h-9 rounded-xs border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-black px-2.5 text-xs font-mono tabular-nums text-black dark:text-white"
              />
            </label>
          </div>

          <label className="flex items-center justify-between pt-2 border-t border-neutral-200 dark:border-neutral-800 text-xs cursor-pointer">
            <span className="text-black dark:text-white inline-flex items-center gap-1.5">
              <HardDrive className="h-3.5 w-3.5" />
              Disk-aware throttling & sparse staging
            </span>
            <input
              type="checkbox"
              checked={settings.diskAwareThrottling}
              onChange={(e) => onUpdateSettings({ diskAwareThrottling: e.target.checked })}
              className="h-4 w-4 accent-black dark:accent-white"
            />
          </label>

          <div className="pt-2 border-t border-neutral-200 dark:border-neutral-800 space-y-2.5">
            <label className="flex items-center justify-between text-xs cursor-pointer">
              <span className="text-black dark:text-white inline-flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5" />
                Overnight download window
              </span>
              <input
                type="checkbox"
                checked={settings.scheduleEnabled}
                onChange={(e) => onUpdateSettings({ scheduleEnabled: e.target.checked })}
                className="h-4 w-4 accent-black dark:accent-white"
              />
            </label>

            {settings.scheduleEnabled && (
              <div className="grid grid-cols-2 gap-3">
                <label className="space-y-1">
                  <span className="text-[11px] text-neutral-500">Start</span>
                  <input
                    type="time"
                    value={settings.scheduleStart}
                    onChange={(e) => onUpdateSettings({ scheduleStart: e.target.value })}
                    className="w-full h-8 rounded-xs border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-black px-2 text-xs font-mono text-black dark:text-white"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] text-neutral-500">End</span>
                  <input
                    type="time"
                    value={settings.scheduleEnd}
                    onChange={(e) => onUpdateSettings({ scheduleEnd: e.target.value })}
                    className="w-full h-8 rounded-xs border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-black px-2 text-xs font-mono text-black dark:text-white"
                  />
                </label>
              </div>
            )}
          </div>
        </section>

        <section className="border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-[#0A0A0A] rounded-md p-4 space-y-4">
          <h3 className="text-sm font-semibold text-black dark:text-white">
            Extension Capture Rules
          </h3>

          <div className="space-y-3 text-xs">
            <label className="flex items-center justify-between cursor-pointer">
              <span className="text-neutral-800 dark:text-neutral-200">
                Auto-capture browser downloads
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
                className="w-18 h-8 rounded-xs border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-black px-2 text-right font-mono tabular-nums text-xs text-black dark:text-white"
              />
            </div>
          </div>

          <div className="pt-3 border-t border-neutral-200 dark:border-neutral-800 space-y-2">
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              Excluded Domains
            </span>
            <form onSubmit={handleAddExclusion} className="flex gap-1.5">
              <input
                type="text"
                value={newExclusion}
                onChange={(e) => setNewExclusion(e.target.value)}
                placeholder="domain.com"
                className="flex-1 h-8 rounded-xs border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-black px-2.5 text-xs font-mono text-black dark:text-white"
              />
              <button
                type="submit"
                className="h-8 px-3 rounded-xs bg-black text-white dark:bg-white dark:text-black text-xs font-semibold inline-flex items-center gap-1 cursor-pointer"
              >
                <Plus className="h-3.5 w-3.5" />
                Add
              </button>
            </form>

            <div className="divide-y divide-neutral-200 dark:divide-neutral-800 border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-black rounded-xs">
              {settings.siteExclusions.length === 0 ? (
                <p className="p-2.5 text-xs text-neutral-500">
                  No excluded sites. Active on all pages.
                </p>
              ) : (
                settings.siteExclusions.map((domain) => (
                  <div
                    key={domain}
                    className="flex items-center justify-between px-2.5 py-1.5 text-xs font-mono"
                  >
                    <span className="text-neutral-800 dark:text-neutral-200">{domain}</span>
                    <button
                      type="button"
                      onClick={() =>
                        onUpdateSettings({
                          siteExclusions: settings.siteExclusions.filter((d) => d !== domain),
                        })
                      }
                      aria-label={`Remove ${domain}`}
                      className="text-neutral-400 hover:text-red-600 dark:hover:text-red-400 cursor-pointer"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};
