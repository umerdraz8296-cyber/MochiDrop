import React, { useState } from 'react';
import { Clock, Folder, HardDrive, Layers, Plug, Plus, Trash2, Zap } from 'lucide-react';
import { ConcurrentLimit, PlexoPlugin, PlexoSettings, StreamCountOption } from '../types/plexo';

const CONCURRENT_CHOICES: ConcurrentLimit[] = [1, 2, 3, 4, 5];
const STREAM_CHOICES: StreamCountOption[] = [4, 8, 16, 32];

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
      <section className="border border-[#0F241B]/10 dark:border-white/[0.09] bg-white/65 dark:bg-white/[0.03] backdrop-blur-md rounded-2xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-[#0F241B]/10 dark:border-white/[0.08] bg-white/50 dark:bg-white/[0.025] flex items-center justify-between">
          <div className="flex items-center gap-2 font-display text-sm font-semibold text-[#111B16] dark:text-white">
            <Plug className="h-4 w-4 text-[#156E4B] dark:text-[#3BE098]" />
            Engine Plugins
          </div>
          <span className="text-xs font-mono tabular-nums text-[#52655C] dark:text-[#8A9891]">
            {plugins.filter((p) => p.enabled).length}/{plugins.length} active
          </span>
        </div>

        <div className="divide-y divide-[#0F241B]/8 dark:divide-white/[0.07]">
          {plugins.map((plugin) => (
            <div
              key={plugin.id}
              className="px-5 py-3.5 flex items-start justify-between gap-4 hover:bg-black/[0.025] dark:hover:bg-white/[0.03] transition-colors"
            >
              <div className="space-y-0.5 min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 text-xs sm:text-sm">
                  <span className="font-semibold text-[#111B16] dark:text-white">{plugin.name}</span>
                  <span className="text-[#9AA8A1] dark:text-white/25" aria-hidden="true">
                    ·
                  </span>
                  <span className="text-xs text-[#52655C] dark:text-[#8E9B95]">
                    {plugin.category}
                  </span>
                </div>
                <p className="text-xs text-[#52655C] dark:text-[#8E9B95] max-w-2xl">
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
                    ? 'bg-[#1D7452] border-[#2FD48B]/50'
                    : 'bg-black/10 border-black/15 dark:bg-white/[0.07] dark:border-white/[0.12]'
                }`}
              >
                <span
                  className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-xs transition-transform ${
                    plugin.enabled ? 'translate-x-5' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* Disk & Clipboard Rules */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <section className="border border-[#0F241B]/10 dark:border-white/[0.09] bg-white/65 dark:bg-white/[0.03] backdrop-blur-md rounded-2xl p-5 space-y-4">
          <h3 className="font-display text-sm font-semibold text-[#111B16] dark:text-white">
            Disk & Schedule
          </h3>

          <label className="block space-y-1">
            <span className="text-xs text-[#52655C] dark:text-[#8E9B95] inline-flex items-center gap-1.5">
              <Folder className="h-3.5 w-3.5 text-[#156E4B] dark:text-[#3BE098]" />
              Save Folder
            </span>
            <input
              type="text"
              value={settings.downloadDirectory}
              onChange={(e) => onUpdateSettings({ downloadDirectory: e.target.value })}
              className="w-full h-9 rounded-xl border border-[#0F241B]/12 dark:border-white/[0.1] bg-white/80 dark:bg-black/40 px-3 text-xs font-mono text-[#111B16] dark:text-white"
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1">
              <span className="text-xs text-[#52655C] dark:text-[#8E9B95]">
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
                className="w-full h-9 rounded-xl border border-[#0F241B]/12 dark:border-white/[0.1] bg-white/80 dark:bg-black/40 px-3 text-xs font-mono tabular-nums text-[#111B16] dark:text-white"
              />
            </label>

            <label className="block space-y-1">
              <span className="text-xs text-[#52655C] dark:text-[#8E9B95]">
                Connections / Link
              </span>
              <input
                type="number"
                min={1}
                max={32}
                value={settings.maxConnectionsPerAdapter}
                onChange={(e) =>
                  onUpdateSettings({
                    maxConnectionsPerAdapter: Math.max(
                      1,
                      Math.min(32, Number(e.target.value) || 16)
                    ),
                  })
                }
                className="w-full h-9 rounded-xl border border-[#0F241B]/12 dark:border-white/[0.1] bg-white/80 dark:bg-black/40 px-3 text-xs font-mono tabular-nums text-[#111B16] dark:text-white"
              />
            </label>
          </div>

          <div className="pt-3 border-t border-[#0F241B]/10 dark:border-white/[0.08] space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-[#1F332A] dark:text-[#DCE6E1] inline-flex items-center gap-1.5">
                <Zap className="h-3.5 w-3.5 text-[#156E4B] dark:text-[#3BE098]" />
                Default parallel streams
              </span>
              <span className="font-mono text-[11px] tabular-nums text-[#156E4B] dark:text-[#3BE098]">
                {settings.preferredStreams} / 32 segments
              </span>
            </div>
            <div className="grid grid-cols-4 gap-1.5">
              {STREAM_CHOICES.map((count) => {
                const active = settings.preferredStreams === count;
                return (
                  <button
                    key={count}
                    type="button"
                    onClick={() => {
                      onUpdateSettings({ preferredStreams: count });
                      try {
                        localStorage.setItem('mochidrop_streams', String(count));
                      } catch {
                        // ignore
                      }
                      onNotify(`Default parallel streams set to ${count}`);
                    }}
                    className={`h-8 rounded-lg border font-mono text-xs font-semibold tabular-nums transition-colors cursor-pointer ${
                      active
                        ? 'bg-[#E2F5EC] border-[#1C6B4D]/30 text-[#126646] dark:bg-[#0F2B20]/90 dark:border-[#2FD48B]/40 dark:text-[#3BE098]'
                        : 'bg-white/75 dark:bg-white/[0.03] border-[#0F241B]/12 dark:border-white/[0.1] text-[#354B41] dark:text-[#C5D1CB] hover:border-[#1B6B4D]/40 dark:hover:border-[#2FD48B]/35'
                    }`}
                  >
                    {count}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="pt-3 border-t border-[#0F241B]/10 dark:border-white/[0.08] space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-[#1F332A] dark:text-[#DCE6E1] inline-flex items-center gap-1.5">
                <Layers className="h-3.5 w-3.5 text-[#156E4B] dark:text-[#3BE098]" />
                Downloads at a time
              </span>
              <span className="font-mono text-[11px] tabular-nums text-[#156E4B] dark:text-[#3BE098]">
                {settings.maxConcurrentDownloads} simultaneous · auto-next
              </span>
            </div>
            <div className="grid grid-cols-5 gap-1.5">
              {CONCURRENT_CHOICES.map((n) => {
                const active = settings.maxConcurrentDownloads === n;
                return (
                  <button
                    key={n}
                    type="button"
                    onClick={() => {
                      onUpdateSettings({ maxConcurrentDownloads: n });
                      try {
                        localStorage.setItem('mochidrop_concurrent', String(n));
                      } catch {
                        // ignore
                      }
                      onNotify(`Simultaneous downloads set to ${n} at a time`);
                    }}
                    className={`h-8 rounded-lg border font-mono text-xs font-semibold tabular-nums transition-colors cursor-pointer ${
                      active
                        ? 'bg-[#E2F5EC] border-[#1C6B4D]/30 text-[#126646] dark:bg-[#0F2B20]/90 dark:border-[#2FD48B]/40 dark:text-[#3BE098]'
                        : 'bg-white/75 dark:bg-white/[0.03] border-[#0F241B]/12 dark:border-white/[0.1] text-[#354B41] dark:text-[#C5D1CB] hover:border-[#1B6B4D]/40 dark:hover:border-[#2FD48B]/35'
                    }`}
                  >
                    {n}
                  </button>
                );
              })}
            </div>
          </div>

          <label className="flex items-center justify-between pt-3 border-t border-[#0F241B]/10 dark:border-white/[0.08] text-xs cursor-pointer">
            <span className="text-[#1F332A] dark:text-[#DCE6E1] inline-flex items-center gap-1.5">
              <HardDrive className="h-3.5 w-3.5 text-[#156E4B] dark:text-[#3BE098]" />
              Disk-aware throttling & sparse staging
            </span>
            <input
              type="checkbox"
              checked={settings.diskAwareThrottling}
              onChange={(e) => onUpdateSettings({ diskAwareThrottling: e.target.checked })}
              className="h-4 w-4 accent-[#2FD48B]"
            />
          </label>

          <div className="pt-3 border-t border-[#0F241B]/10 dark:border-white/[0.08] space-y-2.5">
            <label className="flex items-center justify-between text-xs cursor-pointer">
              <span className="text-[#1F332A] dark:text-[#DCE6E1] inline-flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5 text-[#156E4B] dark:text-[#3BE098]" />
                Overnight download window
              </span>
              <input
                type="checkbox"
                checked={settings.scheduleEnabled}
                onChange={(e) => onUpdateSettings({ scheduleEnabled: e.target.checked })}
                className="h-4 w-4 accent-[#2FD48B]"
              />
            </label>

            {settings.scheduleEnabled && (
              <div className="grid grid-cols-2 gap-3">
                <label className="space-y-1">
                  <span className="text-[11px] text-[#52655C] dark:text-[#8E9B95]">Start</span>
                  <input
                    type="time"
                    value={settings.scheduleStart}
                    onChange={(e) => onUpdateSettings({ scheduleStart: e.target.value })}
                    className="w-full h-8 rounded-lg border border-[#0F241B]/12 dark:border-white/[0.1] bg-white/80 dark:bg-black/40 px-2 text-xs font-mono text-[#111B16] dark:text-white"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] text-[#52655C] dark:text-[#8E9B95]">End</span>
                  <input
                    type="time"
                    value={settings.scheduleEnd}
                    onChange={(e) => onUpdateSettings({ scheduleEnd: e.target.value })}
                    className="w-full h-8 rounded-lg border border-[#0F241B]/12 dark:border-white/[0.1] bg-white/80 dark:bg-black/40 px-2 text-xs font-mono text-[#111B16] dark:text-white"
                  />
                </label>
              </div>
            )}
          </div>
        </section>

        <section className="border border-[#0F241B]/10 dark:border-white/[0.09] bg-white/65 dark:bg-white/[0.03] backdrop-blur-md rounded-2xl p-5 space-y-4">
          <h3 className="font-display text-sm font-semibold text-[#111B16] dark:text-white">
            Clipboard & Capture Rules
          </h3>

          <div className="space-y-3 text-xs">
            <label className="flex items-center justify-between cursor-pointer">
              <span className="text-[#1F332A] dark:text-[#DCE6E1]">
                Watch clipboard for copied download links
              </span>
              <input
                type="checkbox"
                checked={settings.autoDetectClipboard}
                onChange={(e) => onUpdateSettings({ autoDetectClipboard: e.target.checked })}
                className="h-4 w-4 accent-[#2FD48B]"
              />
            </label>

            <div className="flex items-center justify-between">
              <span className="text-[#1F332A] dark:text-[#DCE6E1]">
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
                className="w-18 h-8 rounded-lg border border-[#0F241B]/12 dark:border-white/[0.1] bg-white/80 dark:bg-black/40 px-2 text-right font-mono tabular-nums text-xs text-[#111B16] dark:text-white"
              />
            </div>
          </div>

          <div className="pt-3 border-t border-[#0F241B]/10 dark:border-white/[0.08] space-y-2">
            <span className="text-xs text-[#52655C] dark:text-[#8E9B95]">
              Excluded Domains
            </span>
            <form onSubmit={handleAddExclusion} className="flex gap-2">
              <input
                type="text"
                value={newExclusion}
                onChange={(e) => setNewExclusion(e.target.value)}
                placeholder="domain.com"
                className="flex-1 h-9 rounded-xl border border-[#0F241B]/12 dark:border-white/[0.1] bg-white/80 dark:bg-black/40 px-3 text-xs font-mono text-[#111B16] dark:text-white"
              />
              <button
                type="submit"
                className="h-9 px-3.5 rounded-xl bg-[#1C6B4D] hover:bg-[#16593F] dark:bg-[#1A5E44]/90 dark:hover:bg-[#217455] border border-[#2FD48B]/35 text-white text-xs font-semibold inline-flex items-center gap-1 cursor-pointer transition-colors"
              >
                <Plus className="h-3.5 w-3.5" />
                Add
              </button>
            </form>

            <div className="divide-y divide-[#0F241B]/8 dark:divide-white/[0.07] border border-[#0F241B]/10 dark:border-white/[0.09] bg-white/60 dark:bg-black/30 rounded-xl">
              {settings.siteExclusions.length === 0 ? (
                <p className="p-3 text-xs text-[#64786E] dark:text-[#7A8A83]">
                  No excluded sites. Clipboard capture is active for all links.
                </p>
              ) : (
                settings.siteExclusions.map((domain) => (
                  <div
                    key={domain}
                    className="flex items-center justify-between px-3 py-2 text-xs font-mono"
                  >
                    <span className="text-[#1F332A] dark:text-[#DCE6E1]">{domain}</span>
                    <button
                      type="button"
                      onClick={() =>
                        onUpdateSettings({
                          siteExclusions: settings.siteExclusions.filter((d) => d !== domain),
                        })
                      }
                      aria-label={`Remove ${domain}`}
                      className="text-[#687B72] hover:text-rose-600 dark:hover:text-rose-400 cursor-pointer"
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
