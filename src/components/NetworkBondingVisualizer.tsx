import React, { useMemo } from 'react';
import { motion } from 'motion/react';
import { Cable, Globe, Layers, Settings2, Smartphone, Wifi, Zap } from 'lucide-react';
import { NetworkAdapter } from '../types/plexo';
import { formatSpeedMBps } from '../utils/format';

interface NetworkBondingVisualizerProps {
  adapters: NetworkAdapter[];
  totalBytesPerSec: number;
  activeStreams: number;
  isDownloading: boolean;
  onToggleAdapter: (id: string) => void;
  onOpenNetworksView?: () => void;
  compact?: boolean;
}

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
  compact = false,
}) => {
  const enabledAdapters = useMemo(() => adapters.filter((a) => a.enabled), [adapters]);
  const totalCapacityMbps = useMemo(
    () => enabledAdapters.reduce((sum, a) => sum + a.maxCapacityMbps, 0),
    [enabledAdapters]
  );

  // Distribute real measured throughput proportionally by each enabled adapter's live speed (or capacity weight when live)
  const perAdapterLiveBytes = useMemo(() => {
    const map: Record<string, number> = {};
    if (!isDownloading || totalBytesPerSec <= 0 || enabledAdapters.length === 0) {
      for (const a of adapters) map[a.id] = 0;
      return map;
    }
    const weightSum = enabledAdapters.reduce((sum, a) => sum + Math.max(10, a.maxCapacityMbps), 0);
    for (const a of adapters) {
      if (!a.enabled) {
        map[a.id] = 0;
      } else {
        const share = Math.max(10, a.maxCapacityMbps) / weightSum;
        map[a.id] = totalBytesPerSec * share;
      }
    }
    return map;
  }, [adapters, enabledAdapters, isDownloading, totalBytesPerSec]);

  // SVG geometry for N adapters converging into 1 bonded core -> 1 output pipe
  const svgHeight = Math.max(132, adapters.length * 42 + 16);
  const centerY = svgHeight / 2;
  const hubX = 212;
  const outEndX = 348;

  const adapterPaths = useMemo(() => {
    const count = adapters.length;
    const topPad = 24;
    const bottomPad = 24;
    const usable = Math.max(1, svgHeight - topPad - bottomPad);
    return adapters.map((adapter, idx) => {
      const y = count === 1 ? centerY : topPad + (usable * idx) / (count - 1);
      const d = `M 8 ${y} C 98 ${y}, 136 ${centerY}, ${hubX} ${centerY}`;
      return {
        adapter,
        y,
        d,
        color: getAdapterColorHex(adapter.shade),
      };
    });
  }, [adapters, centerY, svgHeight]);

  const outputPath = `M ${hubX} ${centerY} L ${outEndX} ${centerY}`;

  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
      className="rounded-2xl border border-[#0F241B]/10 dark:border-white/[0.09] bg-white/65 dark:bg-white/[0.03] backdrop-blur-md overflow-hidden"
    >
      {/* Top strip */}
      <div className="px-4 py-2.5 border-b border-[#0F241B]/10 dark:border-white/[0.07] bg-white/50 dark:bg-white/[0.025] flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs">
          <span className="h-6 w-6 rounded-lg bg-[#E2F5EC] dark:bg-[#0F2B20]/90 border border-[#1C6B4D]/20 dark:border-[#2FD48B]/30 text-[#156E4B] dark:text-[#3BE098] inline-flex items-center justify-center">
            <Zap className="h-3.5 w-3.5" />
          </span>
          <span className="font-display font-semibold text-[#111B16] dark:text-white">
            Multi-Network Speed Bonding
          </span>
          <span className="text-[#9AA8A1] dark:text-white/25" aria-hidden="true">
            ·
          </span>
          <span className="font-mono text-[11px] tabular-nums text-[#52655C] dark:text-[#8A9891]">
            {enabledAdapters.length} of {adapters.length} networks merged into 1 stream
          </span>
        </div>

        <div className="flex items-center gap-3 text-[11px]">
          {activeStreams > 0 && (
            <span className="inline-flex items-center gap-1 font-mono tabular-nums text-[#156E4B] dark:text-[#3BE098] font-medium">
              <Layers className="h-3 w-3" />
              {activeStreams} streams
            </span>
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

      {/* Main 3-Column Convergence Visual: [Network Nodes] ---> [Animated SVG Bond Flow] ---> [Combined Speed] */}
      <div className={`grid grid-cols-1 lg:grid-cols-12 items-center gap-3 ${compact ? 'p-3.5' : 'p-4 sm:p-5'}`}>
        {/* Left: Active Network Nodes (clickable to join/leave bond) */}
        <div className="lg:col-span-4 space-y-2">
          {adapters.map((adapter) => {
            const liveBytes = perAdapterLiveBytes[adapter.id] || 0;
            const dotClass = getAdapterBgDot(adapter.shade);
            return (
              <button
                key={adapter.id}
                type="button"
                onClick={() => onToggleAdapter(adapter.id)}
                title={adapter.enabled ? 'Click to exclude from bonded stream' : 'Click to bond this network'}
                className={`w-full px-3 py-2 rounded-xl border text-left flex items-center justify-between gap-2.5 transition-all cursor-pointer ${
                  adapter.enabled
                    ? 'bg-white/75 dark:bg-white/[0.04] border-[#0F241B]/12 dark:border-white/[0.1] hover:border-[#1B6B4D]/40 dark:hover:border-[#2FD48B]/40'
                    : 'bg-transparent border-dashed border-[#0F241B]/15 dark:border-white/[0.08] opacity-50 hover:opacity-80'
                }`}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <span
                    className={`h-2 w-2 rounded-full shrink-0 ${
                      adapter.enabled ? dotClass : 'bg-[#A6B3AD] dark:bg-white/25'
                    } ${adapter.enabled && isDownloading ? 'animate-pulse' : ''}`}
                  />
                  <span className="text-[#4D6157] dark:text-[#8E9B95] shrink-0">
                    {renderAdapterIcon(adapter.interfaceType)}
                  </span>
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-[#111B16] dark:text-white truncate">
                      {adapter.name}
                    </p>
                    <p className="text-[10px] font-mono text-[#687B72] dark:text-[#76857E] truncate">
                      {adapter.deviceCode} · {adapter.maxCapacityMbps} Mbps
                    </p>
                  </div>
                </div>

                <span className="font-mono text-[11px] font-semibold tabular-nums shrink-0 text-[#1F332A] dark:text-[#DCE6E1]">
                  {!adapter.enabled
                    ? 'Off'
                    : isDownloading && liveBytes > 0
                    ? formatSpeedMBps(liveBytes)
                    : 'Ready'}
                </span>
              </button>
            );
          })}
        </div>

        {/* Center: Live Animated Convergence SVG Pipeline */}
        <div className="lg:col-span-5 flex items-center justify-center py-1">
          <svg
            viewBox={`0 0 360 ${svgHeight}`}
            className="w-full h-auto max-h-44 overflow-visible"
            role="img"
            aria-label={`${enabledAdapters.length} networks combining into one bonded download stream`}
          >
            <defs>
              <linearGradient id="mochi-bond-out-grad" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#1B7A54" />
                <stop offset="55%" stopColor="#2FD48B" />
                <stop offset="100%" stopColor="#38BDF8" />
              </linearGradient>
              <filter id="mochi-glow" x="-40%" y="-40%" width="180%" height="180%">
                <feGaussianBlur stdDeviation="2.5" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            {/* Input Conduits from each Network -> Bonded Core */}
            {adapterPaths.map(({ adapter, y, d, color }, idx) => {
              const pathId = `mochi-net-path-${idx}`;
              const speedDur = isDownloading ? `${1.15 + (idx % 3) * 0.22}s` : `${3.4 + idx * 0.4}s`;
              return (
                <g key={adapter.id}>
                  <path
                    id={pathId}
                    d={d}
                    fill="none"
                    stroke={adapter.enabled ? color : '#94A3B8'}
                    strokeOpacity={adapter.enabled ? (isDownloading ? 0.45 : 0.25) : 0.18}
                    strokeWidth={adapter.enabled ? (isDownloading ? 2.6 : 1.8) : 1.4}
                    strokeDasharray={adapter.enabled ? undefined : '4 5'}
                    strokeLinecap="round"
                  />

                  {/* Source node dot */}
                  <circle
                    cx={8}
                    cy={y}
                    r={adapter.enabled ? 4 : 3}
                    fill={adapter.enabled ? color : '#94A3B8'}
                    fillOpacity={adapter.enabled ? 1 : 0.4}
                  />

                  {/* Moving animated speed orbs when network is enabled */}
                  {adapter.enabled && (
                    <>
                      <circle
                        r={isDownloading ? 3.8 : 2.6}
                        fill={color}
                        filter="url(#mochi-glow)"
                      >
                        <animateMotion
                          dur={speedDur}
                          repeatCount="indefinite"
                          begin={`${idx * 0.28}s`}
                        >
                          <mpath href={`#${pathId}`} />
                        </animateMotion>
                      </circle>
                      {isDownloading && (
                        <circle
                          r={2.8}
                          fill={color}
                          fillOpacity={0.85}
                        >
                          <animateMotion
                            dur={speedDur}
                            repeatCount="indefinite"
                            begin={`${idx * 0.28 + 0.6}s`}
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

            {/* Unified Output Super-Conduit (Core -> Combined Speed) */}
            <path
              id="mochi-bond-output-path"
              d={outputPath}
              fill="none"
              stroke="url(#mochi-bond-out-grad)"
              strokeOpacity={enabledAdapters.length > 0 ? (isDownloading ? 0.85 : 0.35) : 0.15}
              strokeWidth={isDownloading ? 4.5 : 2.8}
              strokeLinecap="round"
            />

            {enabledAdapters.length > 0 && (
              <>
                <circle
                  r={isDownloading ? 4.8 : 3.2}
                  fill="#2FD48B"
                  filter="url(#mochi-glow)"
                >
                  <animateMotion
                    dur={isDownloading ? '0.85s' : '2.6s'}
                    repeatCount="indefinite"
                  >
                    <mpath href="#mochi-bond-output-path" />
                  </animateMotion>
                </circle>
                {isDownloading && (
                  <>
                    <circle r={4} fill="#A3E635" filter="url(#mochi-glow)">
                      <animateMotion dur="0.85s" begin="0.28s" repeatCount="indefinite">
                        <mpath href="#mochi-bond-output-path" />
                      </animateMotion>
                    </circle>
                    <circle r={3.6} fill="#38BDF8" filter="url(#mochi-glow)">
                      <animateMotion dur="0.85s" begin="0.56s" repeatCount="indefinite">
                        <mpath href="#mochi-bond-output-path" />
                      </animateMotion>
                    </circle>
                  </>
                )}
              </>
            )}

            {/* Central Bonded Core Hub */}
            <g transform={`translate(${hubX}, ${centerY})`}>
              {isDownloading && enabledAdapters.length > 0 && (
                <circle
                  r={22}
                  fill="#2FD48B"
                  fillOpacity={0.16}
                  className="animate-ping"
                  style={{ animationDuration: '2.2s' }}
                />
              )}
              <circle
                r={18}
                fill="url(#mochi-bond-out-grad)"
                fillOpacity={enabledAdapters.length > 0 ? 0.18 : 0.08}
                stroke="url(#mochi-bond-out-grad)"
                strokeWidth={2}
              />
              <circle
                r={10}
                fill="url(#mochi-bond-out-grad)"
              />
              <text
                y={3.5}
                textAnchor="middle"
                className="fill-[#04140D] text-[9px] font-mono font-bold select-none"
              >
                {enabledAdapters.length}→1
              </text>
            </g>

            {/* Output Terminal Node */}
            <circle
              cx={outEndX}
              cy={centerY}
              r={5}
              fill={enabledAdapters.length > 0 ? '#2FD48B' : '#94A3B8'}
            />
          </svg>
        </div>

        {/* Right: Combined Total Output Speed Card */}
        <div className="lg:col-span-3 rounded-xl border border-[#1C6B4D]/20 dark:border-[#2FD48B]/25 bg-white/75 dark:bg-[#0D211A]/65 backdrop-blur-md p-3.5 space-y-2.5">
          <div className="flex items-center justify-between text-[11px] text-[#52655C] dark:text-[#8E9B95]">
            <span>Combined Speed</span>
            <span className="font-mono tabular-nums text-[#156E4B] dark:text-[#3BE098] font-semibold">
              {isDownloading ? 'LIVE' : 'STANDBY'}
            </span>
          </div>

          <div className="font-display text-2xl font-bold tracking-tight tabular-nums text-[#111B16] dark:text-white">
            {formatSpeedMBps(totalBytesPerSec)}
          </div>

          {/* Segmented Adapter Share Bar */}
          <div className="h-1.5 w-full rounded-full bg-black/[0.08] dark:bg-white/[0.08] overflow-hidden flex gap-0.5">
            {enabledAdapters.length > 0 ? (
              enabledAdapters.map((a) => {
                const widthPct =
                  totalCapacityMbps > 0
                    ? Math.max(8, (a.maxCapacityMbps / totalCapacityMbps) * 100)
                    : 100 / enabledAdapters.length;
                return (
                  <div
                    key={a.id}
                    style={{ width: `${widthPct}%` }}
                    title={`${a.name} (${a.maxCapacityMbps} Mbps ceiling)`}
                    className={`h-full rounded-full ${getAdapterBgDot(a.shade)} transition-all duration-300`}
                  />
                );
              })
            ) : (
              <div className="h-full w-full bg-black/15 dark:bg-white/15" />
            )}
          </div>

          <p className="text-[11px] font-mono tabular-nums text-[#52655C] dark:text-[#8A9891]">
            {enabledAdapters.length} active {enabledAdapters.length === 1 ? 'link' : 'links'} · {totalCapacityMbps} Mbps ceiling
          </p>
        </div>
      </div>
    </motion.section>
  );
};
