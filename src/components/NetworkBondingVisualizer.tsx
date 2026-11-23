import React, { useMemo } from 'react';
import { motion } from 'motion/react';
import { Cable, ChevronUp, Globe, Layers, Settings2, Smartphone, Wifi, Zap } from 'lucide-react';
import { NetworkAdapter } from '../types/plexo';
import { formatSpeedMBps } from '../utils/format';

interface NetworkBondingVisualizerProps {
  adapters: NetworkAdapter[];
  totalBytesPerSec: number;
  activeStreams: number;
  isDownloading: boolean;
  onToggleAdapter: (id: string) => void;
  onOpenNetworksView?: () => void;
  onHide?: () => void;
  compact?: boolean;
}

const DEFAULT_FALLBACK_SLOTS: NetworkAdapter[] = [
  {
    id: 'slot-wifi',
    deviceCode: '',
    name: 'Wi-Fi',
    ipAddress: '',
    interfaceType: 'Wi-Fi',
    connected: false,
    enabled: false,
    maxCapacityMbps: 0,
    linkSpeedKnown: false,
    currentSpeedBytesPerSec: 0,
    currentSpeedMbps: 0,
    speedCapMbps: null,
    dataBudgetGb: null,
    budgetPeriod: 'monthly',
    usedDataGb: 0,
    metered: false,
    shade: 'solid',
    historyMbps: Array(16).fill(0),
  },
  {
    id: 'slot-ethernet',
    deviceCode: '',
    name: 'Ethernet',
    ipAddress: '',
    interfaceType: 'Ethernet',
    connected: false,
    enabled: false,
    maxCapacityMbps: 0,
    linkSpeedKnown: false,
    currentSpeedBytesPerSec: 0,
    currentSpeedMbps: 0,
    speedCapMbps: null,
    dataBudgetGb: null,
    budgetPeriod: 'monthly',
    usedDataGb: 0,
    metered: false,
    shade: 'mid',
    historyMbps: Array(16).fill(0),
  },
  {
    id: 'slot-usb',
    deviceCode: '',
    name: 'USB Cellular',
    ipAddress: '',
    interfaceType: 'Cellular USB',
    connected: false,
    enabled: false,
    maxCapacityMbps: 0,
    linkSpeedKnown: false,
    currentSpeedBytesPerSec: 0,
    currentSpeedMbps: 0,
    speedCapMbps: null,
    dataBudgetGb: null,
    budgetPeriod: 'monthly',
    usedDataGb: 0,
    metered: true,
    shade: 'soft',
    historyMbps: Array(16).fill(0),
  },
];

function getAdapterColorHex(shade: NetworkAdapter['shade']): string {
  switch (shade) {
    case 'solid':
      return '#2FD48B';
    case 'mid':
      return '#38BDF8';
    case 'soft':
      return '#A3E635';
    default:
      return '#2DD4BF';
  }
}

function getAdapterBgDot(shade: NetworkAdapter['shade']): string {
  switch (shade) {
    case 'solid':
      return 'bg-[#2FD48B]';
    case 'mid':
      return 'bg-[#38BDF8]';
    case 'soft':
      return 'bg-[#A3E635]';
    default:
      return 'bg-[#2DD4BF]';
  }
}

function renderAdapterIcon(type: NetworkAdapter['interfaceType']) {
  switch (type) {
    case 'Wi-Fi':
      return <Wifi className="h-3.5 w-3.5" />;
    case 'Ethernet':
      return <Cable className="h-3.5 w-3.5" />;
    case 'Cellular USB':
      return <Smartphone className="h-3.5 w-3.5" />;
    default:
      return <Globe className="h-3.5 w-3.5" />;
  }
}

export const NetworkBondingVisualizer: React.FC<NetworkBondingVisualizerProps> = ({
  adapters,
  totalBytesPerSec,
  activeStreams,
  isDownloading,
  onToggleAdapter,
  onOpenNetworksView,
  onHide,
  compact = false,
}) => {
  // Always display the 3 core network operators (Wi-Fi, Ethernet, USB Cellular) plus any extra connected links
  const displayAdapters = useMemo(
    () => (adapters.length > 0 ? adapters : DEFAULT_FALLBACK_SLOTS),
    [adapters]
  );

  const connectedAdapters = useMemo(
    () => displayAdapters.filter((a) => a.connected),
    [displayAdapters]
  );

  const activeAdapters = useMemo(
    () => displayAdapters.filter((a) => a.connected && a.enabled),
    [displayAdapters]
  );

  // Real measured throughput per connected & enabled OS adapter (0 for disconnected/disabled)
  const perAdapterLiveBytes = useMemo(() => {
    const map: Record<string, number> = {};
    for (const a of displayAdapters) map[a.id] = 0;

    if (!isDownloading || activeAdapters.length === 0) {
      return map;
    }

    // When exactly 1 real network is connected & enabled, 100% of measured transfer speed belongs to it
    if (activeAdapters.length === 1) {
      const only = activeAdapters[0];
      const measured = only.currentSpeedBytesPerSec ?? (only.currentSpeedMbps * 1024 * 1024) / 8;
      map[only.id] = totalBytesPerSec > 0 ? totalBytesPerSec : Math.max(0, measured);
      return map;
    }

    // When 2+ real networks are connected & enabled, display each adapter's own measured throughput
    let sumMeasured = 0;
    for (const a of activeAdapters) {
      const val = Math.max(0, a.currentSpeedBytesPerSec ?? (a.currentSpeedMbps * 1024 * 1024) / 8);
      map[a.id] = val;
      sumMeasured += val;
    }

    if (totalBytesPerSec > 0 && sumMeasured > 0) {
      const ratio = totalBytesPerSec / sumMeasured;
      for (const a of activeAdapters) {
        map[a.id] = map[a.id] * ratio;
      }
    }
    return map;
  }, [displayAdapters, activeAdapters, isDownloading, totalBytesPerSec]);

  const totalLiveSum = useMemo(
    () => activeAdapters.reduce((sum, a) => sum + (perAdapterLiveBytes[a.id] || 0), 0),
    [activeAdapters, perAdapterLiveBytes]
  );

  const knownCapacitySum = useMemo(
    () =>
      activeAdapters.reduce(
        (sum, a) => sum + (a.linkSpeedKnown ? a.maxCapacityMbps : 0),
        0
      ),
    [activeAdapters]
  );

  // Clean fixed-pitch SVG geometry aligned with the 3 operator cards on the left
  const rowPitch = 56;
  const svgHeight = Math.max(168, displayAdapters.length * rowPitch);
  const centerY = svgHeight / 2;
  const hubX = 212;
  const outEndX = 348;

  const adapterPaths = useMemo(() => {
    const count = displayAdapters.length;
    const topPad = 28;
    const bottomPad = 28;
    const usable = Math.max(1, svgHeight - topPad - bottomPad);
    return displayAdapters.map((adapter, idx) => {
      const y = count === 1 ? centerY : topPad + (usable * idx) / (count - 1);
      const d = `M 8 ${y} C 96 ${y}, 134 ${centerY}, ${hubX} ${centerY}`;
      return {
        adapter,
        y,
        d,
        color: getAdapterColorHex(adapter.shade),
      };
    });
  }, [displayAdapters, centerY, svgHeight]);

  const outputPath = `M ${hubX} ${centerY} L ${outEndX} ${centerY}`;

  // Primary active color for the hub & output conduit (matches the connected operator's color when 1 is active)
  const primaryActiveColor =
    activeAdapters.length === 1 ? getAdapterColorHex(activeAdapters[0].shade) : '#2FD48B';

  const statusHeadline =
    connectedAdapters.length === 0
      ? 'No active internet connection'
      : activeAdapters.length === 0
      ? 'All connected networks paused'
      : activeAdapters.length === 1
      ? `${activeAdapters[0].name} connected · 1 of ${displayAdapters.length} active`
      : `${activeAdapters.length} of ${displayAdapters.length} networks bonded (${activeAdapters
          .map((a) => a.interfaceType === 'Cellular USB' ? 'USB' : a.interfaceType)
          .join(' + ')})`;

  const isOutputFlowing = activeAdapters.length > 0 && isDownloading && totalBytesPerSec > 0;

  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
      className="rounded-2xl border border-[#0F241B]/10 dark:border-white/[0.09] bg-white/65 dark:bg-white/[0.03] backdrop-blur-md overflow-hidden"
    >
      {/* Top strip */}
      <div className="px-4 py-2.5 border-b border-[#0F241B]/10 dark:border-white/[0.07] bg-white/50 dark:bg-white/[0.025] flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs min-w-0">
          <span className="h-6 w-6 rounded-lg bg-[#E2F5EC] dark:bg-[#0F2B20]/90 border border-[#1C6B4D]/20 dark:border-[#2FD48B]/30 text-[#156E4B] dark:text-[#3BE098] inline-flex items-center justify-center shrink-0">
            <Zap className="h-3.5 w-3.5" />
          </span>
          <span className="font-display font-semibold text-[#111B16] dark:text-white truncate">
            Multi-Network Speed Bonding
          </span>
          <span className="text-[#9AA8A1] dark:text-white/25" aria-hidden="true">
            ·
          </span>
          <span className="font-mono text-[11px] tabular-nums text-[#52655C] dark:text-[#8A9891] truncate">
            {statusHeadline}
          </span>
        </div>

        <div className="flex items-center gap-3 text-[11px] shrink-0">
          {activeStreams > 0 && (
            <span className="inline-flex items-center gap-1 font-mono tabular-nums text-[#156E4B] dark:text-[#3BE098] font-medium">
              <Layers className="h-3 w-3" />
              {activeStreams} streams
            </span>
          )}
          {onHide && (
            <button
              type="button"
              onClick={onHide}
              title="Collapse network bonding view"
              className="inline-flex items-center gap-0.5 text-[#52655C] dark:text-[#8E9B95] hover:text-[#111B16] dark:hover:text-white font-medium cursor-pointer transition-colors"
            >
              <ChevronUp className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Hide</span>
            </button>
          )}
          {onOpenNetworksView && (
            <button
              type="button"
              onClick={onOpenNetworksView}
              className="inline-flex items-center gap-1 text-[#4D6157] dark:text-[#8E9B95] hover:text-[#156E4B] dark:hover:text-[#3BE098] font-medium cursor-pointer transition-colors"
            >
              <Settings2 className="h-3.5 w-3.5" />
              <span>Manage</span>
            </button>
          )}
        </div>
      </div>

      {/* Main 3-Column Convergence Visual: [3 Network Operators] ---> [Live Animated Conduit] ---> [Live/Combined Speed] */}
      <div className={`grid grid-cols-1 lg:grid-cols-12 items-center gap-3 ${compact ? 'p-3.5' : 'p-4 sm:p-5'}`}>
        {/* Left: Always-Visible Network Operator Rows (Wi-Fi, Ethernet, USB Cellular) */}
        <div className="lg:col-span-4 space-y-2">
          {displayAdapters.map((adapter) => {
            const isConnected = adapter.connected;
            const isActive = isConnected && adapter.enabled;
            const liveBytes = perAdapterLiveBytes[adapter.id] || 0;
            const dotClass = getAdapterBgDot(adapter.shade);

            const subMeta = !isConnected
              ? 'Not connected'
              : [
                  adapter.ipAddress || adapter.deviceCode,
                  adapter.linkSpeedKnown ? `${adapter.maxCapacityMbps} Mbps` : 'Internet active',
                ]
                  .filter(Boolean)
                  .join(' · ');

            return (
              <button
                key={adapter.id}
                type="button"
                disabled={!isConnected}
                onClick={() => {
                  if (isConnected) onToggleAdapter(adapter.id);
                }}
                title={
                  !isConnected
                    ? `${adapter.name} is not currently connected on this device`
                    : adapter.enabled
                    ? 'Connected — click to exclude from downloads'
                    : 'Connected (paused) — click to enable for downloads'
                }
                className={`w-full h-[50px] px-3 rounded-xl border text-left flex items-center justify-between gap-2.5 transition-all ${
                  isActive
                    ? 'bg-white/80 dark:bg-white/[0.05] border-[#1C6B4D]/25 dark:border-[#2FD48B]/30 hover:border-[#1B6B4D]/50 dark:hover:border-[#2FD48B]/50 cursor-pointer shadow-[0_0_16px_rgba(47,212,139,0.06)]'
                    : isConnected
                    ? 'bg-white/40 dark:bg-white/[0.02] border-dashed border-[#0F241B]/18 dark:border-white/[0.12] opacity-70 hover:opacity-95 cursor-pointer'
                    : 'bg-black/[0.02] dark:bg-white/[0.012] border-dashed border-[#0F241B]/10 dark:border-white/[0.06] opacity-45 cursor-default'
                }`}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <span
                    className={`h-2 w-2 rounded-full shrink-0 ${
                      isActive
                        ? dotClass
                        : isConnected
                        ? 'bg-amber-400/80'
                        : 'bg-[#94A3B8]/50 dark:bg-white/20'
                    } ${isActive && isDownloading && liveBytes > 0 ? 'animate-pulse' : ''}`}
                  />
                  <span
                    className={`shrink-0 ${
                      isActive
                        ? 'text-[#156E4B] dark:text-[#3BE098]'
                        : 'text-[#687B72] dark:text-[#6E7C76]'
                    }`}
                  >
                    {renderAdapterIcon(adapter.interfaceType)}
                  </span>
                  <div className="min-w-0">
                    <p
                      className={`text-xs font-semibold truncate ${
                        isActive
                          ? 'text-[#111B16] dark:text-white'
                          : 'text-[#4D6157] dark:text-[#8A9891]'
                      }`}
                    >
                      {adapter.name}
                    </p>
                    <p className="text-[10px] font-mono text-[#687B72] dark:text-[#76857E] truncate">
                      {subMeta}
                    </p>
                  </div>
                </div>

                <span
                  className={`font-mono text-[11px] font-semibold tabular-nums shrink-0 ${
                    isActive
                      ? 'text-[#126646] dark:text-[#3BE098]'
                      : 'text-[#7A8A83] dark:text-[#64736C]'
                  }`}
                >
                  {!isConnected
                    ? 'Offline'
                    : !adapter.enabled
                    ? 'Paused'
                    : isDownloading
                    ? formatSpeedMBps(liveBytes)
                    : 'Connected'}
                </span>
              </button>
            );
          })}
        </div>

        {/* Center: Live Animated Convergence SVG Pipeline — ONLY Connected & Active Links Animate */}
        <div className="lg:col-span-5 flex items-center justify-center py-1">
          <svg
            viewBox={`0 0 360 ${svgHeight}`}
            className="w-full h-auto max-h-48 overflow-visible"
            role="img"
            aria-label={`${activeAdapters.length} of ${displayAdapters.length} network links actively connected`}
          >
            <defs>
              <linearGradient id="mochi-bond-out-grad" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor={primaryActiveColor} />
                <stop
                  offset="55%"
                  stopColor={activeAdapters.length > 1 ? '#2FD48B' : primaryActiveColor}
                />
                <stop
                  offset="100%"
                  stopColor={activeAdapters.length > 1 ? '#38BDF8' : primaryActiveColor}
                />
              </linearGradient>
              <filter id="mochi-glow" x="-40%" y="-40%" width="180%" height="180%">
                <feGaussianBlur stdDeviation="2.5" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            {/* Input Conduits for All 3 Operator Rows: Dim Static Dashed When Disconnected; Lit + Animated ONLY When Connected & Enabled */}
            {adapterPaths.map(({ adapter, y, d, color }, idx) => {
              const pathId = `mochi-net-path-${idx}`;
              const isConnected = adapter.connected;
              const isActive = isConnected && adapter.enabled;
              const adapterBytes = perAdapterLiveBytes[adapter.id] || 0;
              const isFlowing = isActive && isDownloading && adapterBytes > 0;
              const speedDur = isFlowing ? `${1.05 + (idx % 3) * 0.18}s` : '3.2s';

              return (
                <g key={adapter.id}>
                  <path
                    id={pathId}
                    d={d}
                    fill="none"
                    stroke={isActive ? color : '#64748B'}
                    strokeOpacity={isActive ? (isFlowing ? 0.65 : 0.35) : isConnected ? 0.2 : 0.12}
                    strokeWidth={isActive ? (isFlowing ? 2.8 : 2) : 1.2}
                    strokeDasharray={isActive ? undefined : '3 6'}
                    strokeLinecap="round"
                  />

                  {/* Source node dot */}
                  <circle
                    cx={8}
                    cy={y}
                    r={isActive ? 4.2 : 2.6}
                    fill={isActive ? color : '#64748B'}
                    fillOpacity={isActive ? 1 : 0.3}
                  />

                  {/* Animated speed orbs: STRICTLY ONLY on connected & enabled network(s) */}
                  {isActive && (
                    <>
                      <circle
                        r={isFlowing ? 4 : 2.6}
                        fill={color}
                        filter="url(#mochi-glow)"
                      >
                        <animateMotion
                          dur={speedDur}
                          repeatCount="indefinite"
                          begin={`${idx * 0.25}s`}
                        >
                          <mpath href={`#${pathId}`} />
                        </animateMotion>
                      </circle>
                      {isFlowing && (
                        <circle
                          r={3}
                          fill={color}
                          fillOpacity={0.85}
                        >
                          <animateMotion
                            dur={speedDur}
                            repeatCount="indefinite"
                            begin={`${idx * 0.25 + 0.55}s`}
                          >
                            <mpath href={`#${pathId}`} />
                          </animateMotion>
                        </circle>
                      )}
                    </>
                  )}
                </g>
              );
            })}

            {/* Unified Output Conduit (Hub -> Speed Card) */}
            <path
              id="mochi-bond-output-path"
              d={outputPath}
              fill="none"
              stroke="url(#mochi-bond-out-grad)"
              strokeOpacity={activeAdapters.length > 0 ? (isOutputFlowing ? 0.9 : 0.38) : 0.12}
              strokeWidth={isOutputFlowing ? 4.2 : 2.4}
              strokeDasharray={activeAdapters.length > 0 ? undefined : '3 6'}
              strokeLinecap="round"
            />

            {/* Output orbs ONLY when at least 1 real network is connected & enabled */}
            {activeAdapters.length > 0 && (
              <>
                <circle
                  r={isOutputFlowing ? 4.6 : 3}
                  fill={primaryActiveColor}
                  filter="url(#mochi-glow)"
                >
                  <animateMotion
                    dur={isOutputFlowing ? '0.85s' : '2.8s'}
                    repeatCount="indefinite"
                  >
                    <mpath href="#mochi-bond-output-path" />
                  </animateMotion>
                </circle>
                {isOutputFlowing && (
                  <>
                    <circle
                      r={3.8}
                      fill={
                        activeAdapters.length > 1
                          ? getAdapterColorHex(activeAdapters[1].shade)
                          : primaryActiveColor
                      }
                      filter="url(#mochi-glow)"
                    >
                      <animateMotion dur="0.85s" begin="0.28s" repeatCount="indefinite">
                        <mpath href="#mochi-bond-output-path" />
                      </animateMotion>
                    </circle>
                    {activeAdapters.length > 2 && (
                      <circle
                        r={3.4}
                        fill={getAdapterColorHex(activeAdapters[2].shade)}
                        filter="url(#mochi-glow)"
                      >
                        <animateMotion dur="0.85s" begin="0.56s" repeatCount="indefinite">
                          <mpath href="#mochi-bond-output-path" />
                        </animateMotion>
                      </circle>
                    )}
                  </>
                )}
              </>
            )}

            {/* Central Bonded Core Hub */}
            <g transform={`translate(${hubX}, ${centerY})`}>
              {isOutputFlowing && (
                <circle
                  r={22}
                  fill={primaryActiveColor}
                  fillOpacity={0.18}
                  className="animate-ping"
                  style={{ animationDuration: '2.1s' }}
                />
              )}
              <circle
                r={18}
                fill={activeAdapters.length > 0 ? 'url(#mochi-bond-out-grad)' : '#64748B'}
                fillOpacity={activeAdapters.length > 0 ? 0.18 : 0.08}
                stroke={activeAdapters.length > 0 ? 'url(#mochi-bond-out-grad)' : '#64748B'}
                strokeOpacity={activeAdapters.length > 0 ? 1 : 0.35}
                strokeWidth={2}
              />
              <circle
                r={10.5}
                fill={activeAdapters.length > 0 ? 'url(#mochi-bond-out-grad)' : '#64748B'}
                fillOpacity={activeAdapters.length > 0 ? 1 : 0.35}
              />
              <text
                y={3.5}
                textAnchor="middle"
                className="fill-[#04140D] text-[9px] font-mono font-bold select-none"
              >
                {activeAdapters.length}→1
              </text>
            </g>

            {/* Output Terminal Node */}
            <circle
              cx={outEndX}
              cy={centerY}
              r={5}
              fill={activeAdapters.length > 0 ? primaryActiveColor : '#64748B'}
              fillOpacity={activeAdapters.length > 0 ? 1 : 0.35}
            />
          </svg>
        </div>

        {/* Right: Real Live / Combined Output Speed Card */}
        <div className="lg:col-span-3 rounded-xl border border-[#1C6B4D]/20 dark:border-[#2FD48B]/25 bg-white/75 dark:bg-[#0D211A]/65 backdrop-blur-md p-3.5 space-y-2.5">
          <div className="flex items-center justify-between text-[11px] text-[#52655C] dark:text-[#8E9B95]">
            <span>{activeAdapters.length > 1 ? 'Combined Speed' : 'Live Speed'}</span>
            <span className="font-mono tabular-nums text-[#156E4B] dark:text-[#3BE098] font-semibold">
              {isDownloading ? 'LIVE' : activeAdapters.length > 0 ? 'READY' : 'OFFLINE'}
            </span>
          </div>

          <div className="font-display text-2xl font-bold tracking-tight tabular-nums text-[#111B16] dark:text-white">
            {formatSpeedMBps(totalBytesPerSec)}
          </div>

          {/* Real Throughput Share Bar — ONLY Connected & Active Links */}
          <div className="h-1.5 w-full rounded-full bg-black/[0.08] dark:bg-white/[0.08] overflow-hidden flex gap-0.5">
            {activeAdapters.length > 0 ? (
              activeAdapters.map((a) => {
                const liveVal = perAdapterLiveBytes[a.id] || 0;
                const widthPct =
                  isDownloading && totalLiveSum > 0
                    ? (liveVal / totalLiveSum) * 100
                    : 100 / activeAdapters.length;
                if (isDownloading && totalLiveSum > 0 && liveVal <= 0) return null;
                return (
                  <div
                    key={a.id}
                    style={{ width: `${Math.max(4, widthPct)}%` }}
                    title={`${a.name}: ${formatSpeedMBps(liveVal)}`}
                    className={`h-full rounded-full ${getAdapterBgDot(a.shade)} transition-all duration-300`}
                  />
                );
              })
            ) : (
              <div className="h-full w-full bg-black/15 dark:bg-white/15" />
            )}
          </div>

          <p className="text-[11px] font-mono tabular-nums text-[#52655C] dark:text-[#8A9891] truncate">
            {activeAdapters.length === 0
              ? 'No active link'
              : activeAdapters.length === 1
              ? `${activeAdapters[0].name}${knownCapacitySum > 0 ? ` · ${knownCapacitySum} Mbps` : ''}`
              : `${activeAdapters.length} bonded${knownCapacitySum > 0 ? ` · ${knownCapacitySum} Mbps` : ' · live measured'}`}
          </p>
        </div>
      </div>
    </motion.section>
  );
};
