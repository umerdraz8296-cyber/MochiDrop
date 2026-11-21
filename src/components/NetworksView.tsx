import React, { useState } from 'react';
import { Cable, Cpu, Plus, Smartphone, Wifi } from 'lucide-react';
import { NetworkAdapter, PlexoSettings } from '../types/plexo';

interface NetworksViewProps {
  adapters: NetworkAdapter[];
  settings: PlexoSettings;
  onToggleAdapter: (id: string) => void;
  onUpdateAdapter: (id: string, patch: Partial<NetworkAdapter>) => void;
  onAddAdapter: (
    name: string,
    interfaceType: NetworkAdapter['interfaceType'],
    maxCapacityMbps: number
  ) => void;
  onUpdateSettings: (patch: Partial<PlexoSettings>) => void;
}

export const NetworksView: React.FC<NetworksViewProps> = ({
  adapters,
  settings,
  onToggleAdapter,
  onUpdateAdapter,
  onAddAdapter,
  onUpdateSettings,
}) => {
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<NetworkAdapter['interfaceType']>('Wi-Fi');
  const [newCap, setNewCap] = useState('180');
  const [showAddForm, setShowAddForm] = useState(false);

  const totalCombinedMbps = adapters
    .filter((a) => a.enabled)
    .reduce((sum, a) => sum + a.currentSpeedMbps, 0);

  function handleCreateAdapter(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed) return;
    const cap = Math.max(20, Math.min(2000, Number(newCap) || 150));
    onAddAdapter(trimmed, newType, cap);
    setNewName('');
    setShowAddForm(false);
  }

  function renderIcon(type: NetworkAdapter['interfaceType']) {
    switch (type) {
      case 'Wi-Fi':
        return <Wifi className="h-4 w-4" />;
      case 'Ethernet':
        return <Cable className="h-4 w-4" />;
      case 'Cellular USB':
        return <Smartphone className="h-4 w-4" />;
      default:
        return <Cpu className="h-4 w-4" />;
    }
  }

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[1.7fr_1fr] gap-6 items-start">
      {/* Left: Horizontal Hardware Rack Strips (breaks 3-equal-cards template) */}
      <div className="space-y-4 min-w-0">
        <div className="flex flex-wrap items-end justify-between gap-3 pb-3 border-b border-neutral-200 dark:border-neutral-800">
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-black dark:text-white">
              Network Interfaces
            </h2>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Split one file across Wi-Fi, wired LAN, and phone tethering without a VPN. Turn any link off mid-download or cap metered mobile data.
            </p>
          </div>

          <div className="flex items-center gap-4 shrink-0">
            <div className="text-right font-mono tabular-nums">
              <div className="text-lg font-semibold text-black dark:text-white">
                {(totalCombinedMbps / 8).toFixed(1)} MB/s
              </div>
              <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
                {totalCombinedMbps.toFixed(0)} Mbps live
              </div>
            </div>
            <button
              type="button"
              onClick={() => setShowAddForm((prev) => !prev)}
              className="h-9 px-3.5 rounded-sm bg-black text-white dark:bg-white dark:text-black text-xs font-semibold hover:bg-neutral-800 dark:hover:bg-neutral-200 inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
            >
              <Plus className="h-3.5 w-3.5" />
              Add Interface
            </button>
          </div>
        </div>

        {showAddForm && (
          <form
            onSubmit={handleCreateAdapter}
            className="border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-[#0A0A0A] p-4 rounded-md grid grid-cols-1 sm:grid-cols-4 gap-3 items-end"
          >
            <label className="space-y-1 sm:col-span-2">
              <span className="text-xs text-neutral-500 dark:text-neutral-400">Name</span>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. USB Wi-Fi Dongle"
                className="w-full h-9 rounded-sm border border-neutral-300 dark:border-neutral-800 bg-white dark:bg-black px-2.5 text-xs text-black dark:text-white"
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-neutral-500 dark:text-neutral-400">Type</span>
              <select
                value={newType}
                onChange={(e) => setNewType(e.target.value as NetworkAdapter['interfaceType'])}
                className="w-full h-9 rounded-sm border border-neutral-300 dark:border-neutral-800 bg-white dark:bg-black px-2.5 text-xs text-black dark:text-white"
              >
                <option value="Wi-Fi">Wi-Fi</option>
                <option value="Ethernet">Ethernet</option>
                <option value="Cellular USB">Cellular USB</option>
                <option value="Virtual">Virtual</option>
              </select>
            </label>
            <div className="flex gap-2">
              <label className="space-y-1 flex-1">
                <span className="text-xs text-neutral-500 dark:text-neutral-400">Mbps</span>
                <input
                  type="number"
                  min={20}
                  max={2000}
                  value={newCap}
                  onChange={(e) => setNewCap(e.target.value)}
                  className="w-full h-9 rounded-sm border border-neutral-300 dark:border-neutral-800 bg-white dark:bg-black px-2 text-xs font-mono tabular-nums text-black dark:text-white"
                />
              </label>
              <button
                type="submit"
                className="h-9 px-3.5 rounded-sm bg-black text-white dark:bg-white dark:text-black text-xs font-semibold cursor-pointer"
              >
                Add
              </button>
            </div>
          </form>
        )}

        {/* Horizontal Rack Rows */}
        <div className="border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-[#0A0A0A] rounded-md divide-y divide-neutral-200 dark:divide-neutral-800">
          {adapters.map((adapter) => {
            const budgetPct =
              adapter.dataBudgetGb && adapter.dataBudgetGb > 0
                ? Math.min(100, (adapter.usedDataGb / adapter.dataBudgetGb) * 100)
                : 0;
            const budgetExceeded =
              adapter.dataBudgetGb !== null && adapter.usedDataGb >= adapter.dataBudgetGb;

            return (
              <article
                key={adapter.id}
                className={`p-4 space-y-4 transition-opacity ${
                  adapter.enabled ? 'opacity-100' : 'opacity-65'
                }`}
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="h-9 w-9 shrink-0 rounded-xs border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-black flex items-center justify-center text-black dark:text-white">
                      {renderIcon(adapter.interfaceType)}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-neutral-500 dark:text-neutral-400">
                          {adapter.deviceCode}
                        </span>
                        <input
                          type="text"
                          value={adapter.name}
                          onChange={(e) => onUpdateAdapter(adapter.id, { name: e.target.value })}
                          aria-label="Rename adapter"
                          className="bg-transparent text-sm font-semibold text-black dark:text-white focus:outline-none focus:underline truncate"
                        />
                      </div>
                      <p className="text-xs text-neutral-500 dark:text-neutral-400">
                        {adapter.interfaceType} · {adapter.metered ? 'Metered cellular' : 'Unmetered'} · Session {adapter.usedDataGb.toFixed(2)} GB
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center justify-between sm:justify-end gap-4 shrink-0">
                    <div className="text-right font-mono tabular-nums">
                      <div className="text-sm font-semibold text-black dark:text-white">
                        {adapter.enabled ? (adapter.currentSpeedMbps / 8).toFixed(1) : '0.0'} MB/s
                      </div>
                      <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
                        {adapter.enabled ? `${adapter.currentSpeedMbps.toFixed(0)} Mbps` : 'Disabled'}
                      </div>
                    </div>

                    <button
                      type="button"
                      role="switch"
                      aria-checked={adapter.enabled}
                      onClick={() => onToggleAdapter(adapter.id)}
                      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors cursor-pointer ${
                        adapter.enabled
                          ? 'bg-black border-black dark:bg-white dark:border-white'
                          : 'bg-neutral-200 border-neutral-300 dark:bg-neutral-900 dark:border-neutral-700'
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 rounded-full transition-transform ${
                          adapter.enabled
                            ? 'translate-x-5.5 bg-white dark:bg-black'
                            : 'translate-x-1 bg-neutral-500'
                        }`}
                      />
                    </button>
                  </div>
                </div>

                {/* Live Monochrome Sparkline + Inline Cap / Budget Controls */}
                <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-4 items-end">
                  <div className="h-9 flex items-end gap-1">
                    {adapter.historyMbps.map((val, i) => {
                      const heightPct = Math.max(
                        10,
                        Math.min(100, (val / Math.max(1, adapter.maxCapacityMbps)) * 100)
                      );
                      return (
                        <div
                          key={i}
                          style={{ height: `${adapter.enabled ? heightPct : 10}%` }}
                          className={`flex-1 transition-all duration-300 ${
                            adapter.enabled
                              ? 'bg-black dark:bg-white'
                              : 'bg-neutral-200 dark:bg-neutral-800'
                          }`}
                        />
                      );
                    })}
                  </div>

                  <div className="flex flex-wrap items-center gap-3 text-xs">
                    <label className="inline-flex items-center gap-1.5">
                      <span className="text-neutral-500 dark:text-neutral-400">Cap Mbps</span>
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
                        className="w-18 h-8 rounded-xs border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-black px-2 text-right font-mono tabular-nums text-xs text-black dark:text-white"
                      />
                    </label>

                    <label className="inline-flex items-center gap-1.5">
                      <span className="text-neutral-500 dark:text-neutral-400">Budget</span>
                      <select
                        value={adapter.budgetPeriod}
                        onChange={(e) =>
                          onUpdateAdapter(adapter.id, {
                            budgetPeriod: e.target.value as NetworkAdapter['budgetPeriod'],
                          })
                        }
                        className="h-8 rounded-xs border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-black px-1.5 text-xs text-neutral-700 dark:text-neutral-300"
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
                        className="w-16 h-8 rounded-xs border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-black px-2 text-right font-mono tabular-nums text-xs text-black dark:text-white"
                      />
                    </label>
                  </div>
                </div>

                {adapter.dataBudgetGb !== null && (
                  <div className="space-y-1">
                    <div className="flex justify-between text-[11px] font-mono tabular-nums text-neutral-500 dark:text-neutral-400">
                      <span>
                        Session usage: {adapter.usedDataGb.toFixed(2)} GB / {adapter.dataBudgetGb} GB ({adapter.budgetPeriod})
                      </span>
                      <span>{budgetExceeded ? 'Cap reached (paused)' : `${budgetPct.toFixed(0)}%`}</span>
                    </div>
                    <div className="h-1 w-full bg-neutral-200 dark:bg-neutral-900 overflow-hidden">
                      <div
                        style={{ width: `${budgetPct}%` }}
                        className={`h-full ${
                          budgetExceeded
                            ? 'bg-red-600 dark:bg-red-400'
                            : 'bg-black dark:bg-white'
                        }`}
                      />
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </div>

      {/* Right Column: Chunk Engine Controls */}
      <aside className="border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-[#0A0A0A] rounded-md p-5 space-y-5">
        <div>
          <h3 className="text-sm font-semibold text-black dark:text-white">Chunk Engine</h3>
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            Controls how Plexo splits byte ranges across interfaces and reacts to slow servers.
          </p>
        </div>

        <div className="space-y-4 pt-3 border-t border-neutral-200 dark:border-neutral-800">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-xs font-semibold text-black dark:text-white">Block Size</p>
              <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
                Shared queue chunk size per range request.
              </p>
            </div>
            <div className="inline-flex border border-neutral-200 dark:border-neutral-800 rounded-xs p-0.5 bg-white dark:bg-black">
              {([4, 8, 16] as const).map((sz) => (
                <button
                  key={sz}
                  type="button"
                  onClick={() => onUpdateSettings({ chunkSizeMb: sz })}
                  className={`px-2 py-1 text-xs font-mono cursor-pointer ${
                    settings.chunkSizeMb === sz
                      ? 'bg-black text-white dark:bg-white dark:text-black'
                      : 'text-neutral-600 dark:text-neutral-400'
                  }`}
                >
                  {sz}M
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-start justify-between gap-3 pt-3 border-t border-neutral-200 dark:border-neutral-800">
            <div>
              <p className="text-xs font-semibold text-black dark:text-white">Backup Racing</p>
              <p className="text-[11px] text-neutral-500 dark:text-neutral-400 mt-0.5">
                Races slow tail blocks on faster links so one weak adapter never stalls the end of a file.
              </p>
            </div>
            <input
              type="checkbox"
              checked={settings.backupRacing}
              onChange={(e) => onUpdateSettings({ backupRacing: e.target.checked })}
              className="mt-0.5 h-4 w-4 accent-black dark:accent-white cursor-pointer"
            />
          </div>

          <div className="flex items-start justify-between gap-3 pt-3 border-t border-neutral-200 dark:border-neutral-800">
            <div>
              <p className="text-xs font-semibold text-black dark:text-white">Vigilant Backoff</p>
              <p className="text-[11px] text-neutral-500 dark:text-neutral-400 mt-0.5">
                Backs off automatically on HTTP 403, 429, or 503 Retry-After responses.
              </p>
            </div>
            <input
              type="checkbox"
              checked={settings.vigilantMode}
              onChange={(e) => onUpdateSettings({ vigilantMode: e.target.checked })}
              className="mt-0.5 h-4 w-4 accent-black dark:accent-white cursor-pointer"
            />
          </div>

          <div className="flex items-start justify-between gap-3 pt-3 border-t border-neutral-200 dark:border-neutral-800">
            <div>
              <p className="text-xs font-semibold text-black dark:text-white">
                Disk-Aware Throttling
              </p>
              <p className="text-[11px] text-neutral-500 dark:text-neutral-400 mt-0.5">
                Stages sparse files and caps network pull if drive writes fall behind.
              </p>
            </div>
            <input
              type="checkbox"
              checked={settings.diskAwareThrottling}
              onChange={(e) => onUpdateSettings({ diskAwareThrottling: e.target.checked })}
              className="mt-0.5 h-4 w-4 accent-black dark:accent-white cursor-pointer"
            />
          </div>
        </div>
      </aside>
    </div>
  );
};
