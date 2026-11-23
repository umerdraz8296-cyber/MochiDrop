import React, { useState } from 'react';
import { Cable, Cpu, RefreshCw, Smartphone, Wifi, WifiOff } from 'lucide-react';
import { NetworkAdapter, PlexoSettings } from '../types/plexo';
import { formatSpeedMBps } from '../utils/format';
import { NetworkBondingVisualizer } from './NetworkBondingVisualizer';

interface NetworksViewProps {
  adapters: NetworkAdapter[];
  settings: PlexoSettings;
  totalBytesPerSec: number;
  isDownloading: boolean;
  onToggleAdapter: (id: string) => void;
  onUpdateAdapter: (id: string, patch: Partial<NetworkAdapter>) => void;
  onRescanNetworks: () => Promise<void> | void;
  onUpdateSettings: (patch: Partial<PlexoSettings>) => void;
}

export const NetworksView: React.FC<NetworksViewProps> = ({
  adapters,
  settings,
  totalBytesPerSec,
  isDownloading,
  onToggleAdapter,
  onUpdateAdapter,
  onRescanNetworks,
  onUpdateSettings,
}) => {
  const [rescanning, setRescanning] = useState(false);

  const totalLiveMbps = (totalBytesPerSec * 8) / (1024 * 1024);

  async function handleRescan() {
    setRescanning(true);
    try {
      await onRescanNetworks();
    } finally {
      setRescanning(false);
    }
  }

  function renderIcon(type: NetworkAdapter['interfaceType']) {
    switch (type) {
      case 'Wi-Fi':
        return <Wifi className="h-4 w-4 text-[#156E4B] dark:text-[#3BE098]" />;
      case 'Ethernet':
        return <Cable className="h-4 w-4 text-sky-600 dark:text-sky-400" />;
      case 'Cellular USB':
        return <Smartphone className="h-4 w-4 text-lime-600 dark:text-lime-400" />;
      default:
        return <Cpu className="h-4 w-4 text-teal-600 dark:text-teal-400" />;
    }
  }

  return (
    <div className="space-y-6">
      <NetworkBondingVisualizer
        adapters={adapters}
        totalBytesPerSec={totalBytesPerSec}
        activeStreams={settings.preferredStreams}
        isDownloading={isDownloading}
        onToggleAdapter={onToggleAdapter}
      />

      <div className="grid grid-cols-1 xl:grid-cols-[1.7fr_1fr] gap-6 items-start">
        {/* Left: Real Detected OS Network Interfaces */}
        <div className="space-y-4 min-w-0">
          <div className="flex flex-wrap items-end justify-between gap-3 pb-3.5 border-b border-[#0F241B]/10 dark:border-white/[0.08]">
            <div className="space-y-1">
              <h2 className="font-display text-base font-semibold text-[#111B16] dark:text-white">
                Connected Network Interfaces
              </h2>
              <p className="text-xs text-[#52655C] dark:text-[#8E9B95] max-w-xl">
                Automatically detects only the networks currently connected on this device. Plug in Ethernet or USB tethering to bond multiple links live.
              </p>
            </div>

            <div className="flex items-center gap-4 shrink-0">
              <div className="text-right font-mono tabular-nums">
                <div className="text-lg font-semibold text-[#126646] dark:text-[#3BE098]">
                  {formatSpeedMBps(totalBytesPerSec)}
                </div>
                <div className="text-[11px] text-[#52655C] dark:text-[#8A9891]">
                  {totalLiveMbps.toFixed(1)} Mbps live
                </div>
              </div>
              <button
                type="button"
                disabled={rescanning}
                onClick={() => void handleRescan()}
                className="h-9 px-3.5 rounded-xl bg-[#1C6B4D] hover:bg-[#16593F] dark:bg-[#1A5E44]/90 dark:hover:bg-[#217455] border border-[#2FD48B]/35 text-white text-xs font-semibold shadow-[0_0_18px_rgba(34,197,126,0.16)] inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer disabled:opacity-60 transition-colors"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${rescanning ? 'animate-spin' : ''}`} />
                Rescan
              </button>
            </div>
          </div>

          {/* Real Adapter Cards */}
          <div className="space-y-3">
            {adapters.length === 0 ? (
              <div className="p-6 rounded-2xl border border-dashed border-[#0F241B]/15 dark:border-white/[0.1] bg-white/50 dark:bg-white/[0.02] text-center space-y-2">
                <WifiOff className="h-6 w-6 mx-auto text-[#687B72] dark:text-[#7A8A83]" />
                <p className="text-sm font-semibold text-[#111B16] dark:text-white">
                  No active network connection detected
                </p>
                <p className="text-xs text-[#52655C] dark:text-[#8E9B95]">
                  Connect to Wi-Fi, Ethernet, or USB tethering and click Rescan.
                </p>
              </div>
            ) : (
              adapters.map((adapter) => {
                const isConnected = adapter.connected;
                const isActive = isConnected && adapter.enabled;
                const liveBytesPerSec =
                  isActive && isDownloading
                    ? adapter.currentSpeedBytesPerSec ?? (adapter.currentSpeedMbps * 1024 * 1024) / 8
                    : 0;
                const liveMbps = (liveBytesPerSec * 8) / (1024 * 1024);
                const maxHistory = Math.max(
                  10,
                  ...adapter.historyMbps,
                  liveMbps
                );
                const budgetPct =
                  adapter.dataBudgetGb && adapter.dataBudgetGb > 0
                    ? Math.min(100, (adapter.usedDataGb / adapter.dataBudgetGb) * 100)
                    : 0;
                const budgetExceeded =
                  adapter.dataBudgetGb !== null && adapter.usedDataGb >= adapter.dataBudgetGb;

                return (
                  <article
                    key={adapter.id}
                    className={`p-4 rounded-2xl border backdrop-blur-md transition-all space-y-4 ${
                      isActive
                        ? 'bg-white/65 border-[#0F241B]/10 dark:bg-white/[0.03] dark:border-white/[0.09] opacity-100'
                        : isConnected
                        ? 'bg-white/40 border-[#0F241B]/8 dark:bg-white/[0.018] dark:border-white/[0.06] opacity-75'
                        : 'bg-white/25 border-dashed border-[#0F241B]/10 dark:bg-white/[0.012] dark:border-white/[0.06] opacity-55'
                    }`}
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="h-10 w-10 shrink-0 rounded-xl bg-[#E2F5EC] dark:bg-[#0E241C]/80 border border-[#1C6B4D]/15 dark:border-[#2FD48B]/20 flex items-center justify-center">
                          {renderIcon(adapter.interfaceType)}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            {isConnected && (adapter.ipAddress || adapter.deviceCode) && (
                              <span className="font-mono text-xs text-[#687B72] dark:text-[#7A8A83]">
                                {adapter.ipAddress || adapter.deviceCode}
                              </span>
                            )}
                            {isConnected ? (
                              <input
                                type="text"
                                value={adapter.name}
                                onChange={(e) =>
                                  onUpdateAdapter(adapter.id, {
                                    name: e.target.value,
                                    customNamed: true,
                                  })
                                }
                                aria-label="Rename adapter"
                                className="bg-transparent text-sm font-semibold text-[#111B16] dark:text-white focus:outline-none focus:underline truncate"
                              />
                            ) : (
                              <span className="text-sm font-semibold text-[#4D6157] dark:text-[#8E9B95] truncate">
                                {adapter.name}
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-[#52655C] dark:text-[#8E9B95]">
                            {!isConnected ? (
                              <>Not connected · Plug in or connect {adapter.name} and click Rescan</>
                            ) : (
                              <>
                                {adapter.interfaceType}
                                {adapter.linkSpeedKnown ? ` · ${adapter.maxCapacityMbps} Mbps link` : ''}
                                {' · '}
                                {adapter.metered ? 'Metered' : 'Internet active'} · Session {adapter.usedDataGb.toFixed(2)} GB
                              </>
                            )}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center justify-between sm:justify-end gap-4 shrink-0">
                        <div className="text-right font-mono tabular-nums">
                          <div className="text-sm font-semibold text-[#111B16] dark:text-white">
                            {isActive ? formatSpeedMBps(liveBytesPerSec) : '0 B/s'}
                          </div>
                          <div className="text-[11px] text-[#52655C] dark:text-[#8A9891]">
                            {!isConnected
                              ? 'Offline'
                              : isActive
                              ? `${liveMbps.toFixed(1)} Mbps`
                              : 'Paused'}
                          </div>
                        </div>

                        <button
                          type="button"
                          role="switch"
                          disabled={!isConnected}
                          aria-checked={isActive}
                          onClick={() => {
                            if (isConnected) onToggleAdapter(adapter.id);
                          }}
                          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors ${
                            !isConnected
                              ? 'bg-black/5 border-black/10 dark:bg-white/[0.04] dark:border-white/[0.08] cursor-not-allowed'
                              : isActive
                              ? 'bg-[#1D7452] border-[#2FD48B]/50 cursor-pointer'
                              : 'bg-black/10 border-black/15 dark:bg-white/[0.07] dark:border-white/[0.12] cursor-pointer'
                          }`}
                        >
                          <span
                            className={`inline-block h-4 w-4 rounded-full bg-white shadow-xs transition-transform ${
                              isActive ? 'translate-x-5.5' : 'translate-x-1'
                            }`}
                          />
                        </button>
                      </div>
                    </div>

                    {/* Live Sparkline + Inline Cap / Budget Controls (shown for connected interfaces) */}
                    {isConnected && (
                    <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-4 items-end">
                      <div className="h-9 flex items-end gap-1">
                        {adapter.historyMbps.map((val, i) => {
                          const heightPct = Math.max(
                            12,
                            Math.min(100, (val / Math.max(1, maxHistory)) * 100)
                          );
                          return (
                            <div
                              key={i}
                              style={{ height: `${adapter.enabled ? heightPct : 12}%` }}
                              className={`flex-1 rounded-t-xs transition-all duration-300 ${
                                adapter.enabled
                                  ? 'bg-gradient-to-t from-[#1A6B4D] to-[#3BE098]'
                                  : 'bg-black/10 dark:bg-white/[0.08]'
                              }`}
                            />
                          );
                        })}
                      </div>

                      <div className="flex flex-wrap items-center gap-3 text-xs">
                        <label className="inline-flex items-center gap-1.5">
                          <span className="text-[#52655C] dark:text-[#8E9B95]">Cap Mbps</span>
                          <input
                            type="number"
                            min={0}
                            max={2000}
                            placeholder="Max"
                            value={adapter.speedCapMbps ?? ''}
                            onChange={(e) => {
                              const raw = e.target.value;
                              onUpdateAdapter(adapter.id, {
                                speedCapMbps: raw === '' ? null : Math.max(5, Number(raw)),
                              });
                            }}
                            className="w-18 h-8 rounded-lg border border-[#0F241B]/12 dark:border-white/[0.1] bg-white/80 dark:bg-black/40 px-2 text-right font-mono tabular-nums text-xs text-[#111B16] dark:text-white"
                          />
                        </label>

                        <label className="inline-flex items-center gap-1.5">
                          <span className="text-[#52655C] dark:text-[#8E9B95]">Budget</span>
                          <select
                            value={adapter.budgetPeriod}
                            onChange={(e) =>
                              onUpdateAdapter(adapter.id, {
                                budgetPeriod: e.target.value as NetworkAdapter['budgetPeriod'],
                              })
                            }
                            className="h-8 rounded-lg border border-[#0F241B]/12 dark:border-white/[0.1] bg-white/80 dark:bg-[#0B120F] px-2 text-xs text-[#1E3128] dark:text-[#DCE6E1]"
                          >
                            <option value="daily">Daily</option>
                            <option value="weekly">Weekly</option>
                            <option value="monthly">Monthly</option>
                          </select>
                          <input
                            type="number"
                            min={0}
                            max={5000}
                            placeholder="GB"
                            value={adapter.dataBudgetGb ?? ''}
                            onChange={(e) => {
                              const raw = e.target.value;
                              onUpdateAdapter(adapter.id, {
                                dataBudgetGb: raw === '' ? null : Math.max(1, Number(raw)),
                              });
                            }}
                            className="w-16 h-8 rounded-lg border border-[#0F241B]/12 dark:border-white/[0.1] bg-white/80 dark:bg-black/40 px-2 text-right font-mono tabular-nums text-xs text-[#111B16] dark:text-white"
                          />
                        </label>
                      </div>
                    </div>
                    )}

                    {isConnected && adapter.dataBudgetGb !== null && (
                      <div className="space-y-1">
                        <div className="flex justify-between text-[11px] font-mono tabular-nums text-[#52655C] dark:text-[#8E9B95]">
                          <span>
                            Session usage: {adapter.usedDataGb.toFixed(2)} GB / {adapter.dataBudgetGb} GB ({adapter.budgetPeriod})
                          </span>
                          <span>{budgetExceeded ? 'Cap reached (paused)' : `${budgetPct.toFixed(0)}%`}</span>
                        </div>
                        <div className="h-1.5 w-full rounded-full bg-black/10 dark:bg-white/[0.08] overflow-hidden">
                          <div
                            style={{ width: `${budgetPct}%` }}
                            className={`h-full rounded-full ${
                              budgetExceeded
                                ? 'bg-rose-500'
                                : 'bg-gradient-to-r from-[#1A6B4D] to-[#3BE098]'
                            }`}
                          />
                        </div>
                      </div>
                    )}
                  </article>
                );
              })
            )}
          </div>
        </div>

        {/* Right Column: Chunk Engine Controls */}
        <aside className="border border-[#0F241B]/10 dark:border-white/[0.09] bg-white/65 dark:bg-white/[0.03] backdrop-blur-md rounded-2xl p-5 space-y-5">
          <div>
            <h3 className="font-display text-sm font-semibold text-[#111B16] dark:text-white">
              Chunk Engine
            </h3>
            <p className="mt-1 text-xs text-[#52655C] dark:text-[#8E9B95] leading-relaxed">
              Controls how MochiDrop splits byte ranges across parallel streams and handles slow hosts.
            </p>
          </div>

          <div className="space-y-4 pt-3 border-t border-[#0F241B]/10 dark:border-white/[0.08]">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-xs font-semibold text-[#111B16] dark:text-white">Block Size</p>
                <p className="text-[11px] text-[#52655C] dark:text-[#8E9B95]">
                  Shared chunk size per range request.
                </p>
              </div>
              <div className="inline-flex border border-[#0F241B]/12 dark:border-white/[0.1] rounded-lg p-0.5 bg-white/75 dark:bg-black/40">
                {([4, 8, 16] as const).map((sz) => (
                  <button
                    key={sz}
                    type="button"
                    onClick={() => onUpdateSettings({ chunkSizeMb: sz })}
                    className={`px-2.5 py-1 rounded-md text-xs font-mono cursor-pointer transition-colors ${
                      settings.chunkSizeMb === sz
                        ? 'bg-[#1C6B4D] dark:bg-[#0F2B20] text-white dark:text-[#3BE098] border border-[#2FD48B]/30'
                        : 'text-[#52655C] dark:text-[#8E9B95] hover:text-[#111B16] dark:hover:text-white'
                    }`}
                  >
                    {sz}M
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-start justify-between gap-3 pt-3 border-t border-[#0F241B]/10 dark:border-white/[0.08]">
              <div>
                <p className="text-xs font-semibold text-[#111B16] dark:text-white">Backup Racing</p>
                <p className="text-[11px] text-[#52655C] dark:text-[#8E9B95] mt-0.5">
                  Races slow tail blocks on faster links so one weak adapter never stalls completion.
                </p>
              </div>
              <input
                type="checkbox"
                checked={settings.backupRacing}
                onChange={(e) => onUpdateSettings({ backupRacing: e.target.checked })}
                className="mt-0.5 h-4 w-4 accent-[#2FD48B] cursor-pointer"
              />
            </div>

            <div className="flex items-start justify-between gap-3 pt-3 border-t border-[#0F241B]/10 dark:border-white/[0.08]">
              <div>
                <p className="text-xs font-semibold text-[#111B16] dark:text-white">Vigilant Backoff</p>
                <p className="text-[11px] text-[#52655C] dark:text-[#8E9B95] mt-0.5">
                  Backs off automatically on HTTP 403, 429, or 503 Retry-After responses.
                </p>
              </div>
              <input
                type="checkbox"
                checked={settings.vigilantMode}
                onChange={(e) => onUpdateSettings({ vigilantMode: e.target.checked })}
                className="mt-0.5 h-4 w-4 accent-[#2FD48B] cursor-pointer"
              />
            </div>

            <div className="flex items-start justify-between gap-3 pt-3 border-t border-[#0F241B]/10 dark:border-white/[0.08]">
              <div>
                <p className="text-xs font-semibold text-[#111B16] dark:text-white">
                  Disk-Aware Throttling
                </p>
                <p className="text-[11px] text-[#52655C] dark:text-[#8E9B95] mt-0.5">
                  Stages sparse files and caps network pull if drive writes fall behind.
                </p>
              </div>
              <input
                type="checkbox"
                checked={settings.diskAwareThrottling}
                onChange={(e) => onUpdateSettings({ diskAwareThrottling: e.target.checked })}
                className="mt-0.5 h-4 w-4 accent-[#2FD48B] cursor-pointer"
              />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
};
