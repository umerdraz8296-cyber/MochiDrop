import React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertCircle,
  ArrowUpCircle,
  CheckCircle2,
  Download,
  ExternalLink,
  Loader2,
  RefreshCw,
  Rocket,
  X,
} from 'lucide-react';
import { UpdateCheckInfo, UpdateDownloadStatus } from '../types/plexo';
import { formatBytes } from '../utils/format';

interface UpdateModalProps {
  open: boolean;
  updateInfo: UpdateCheckInfo | null;
  downloadStatus: UpdateDownloadStatus;
  checking: boolean;
  onClose: () => void;
  onRemindLater: () => void;
  onCheckAgain: () => void;
  onStartDownload: (assetName?: string) => void;
  onInstallNow: () => void;
}

export const UpdateModal: React.FC<UpdateModalProps> = ({
  open,
  updateInfo,
  downloadStatus,
  checking,
  onClose,
  onRemindLater,
  onCheckAgain,
  onStartDownload,
  onInstallNow,
}) => {
  const isDownloading = downloadStatus.state === 'downloading';
  const isExtracting = downloadStatus.state === 'extracting';
  const isReady = downloadStatus.state === 'ready';
  const isInstalling = downloadStatus.state === 'installing';
  const isBusy = isDownloading || isExtracting || isInstalling;

  const activeAsset =
    updateInfo?.isDesktopApp && updateInfo?.supportsInAppUpdate && updateInfo?.inAppUpdateAsset
      ? updateInfo.inAppUpdateAsset
      : updateInfo?.recommendedAsset || null;

  const publishedDate = updateInfo?.publishedAt
    ? new Date(updateInfo.publishedAt).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : null;

  return (
    <AnimatePresence>
      {open && updateInfo && (
        <motion.div
          key="mochidrop-update-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onClick={() => {
            if (!isBusy) onClose();
          }}
          className="fixed inset-0 z-50 bg-black/75 backdrop-blur-md flex items-center justify-center p-4"
        >
          <motion.div
            key="mochidrop-update-dialog"
            initial={{ opacity: 0, scale: 0.97, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg rounded-2xl border border-[#1C6B4D]/25 dark:border-[#2FD48B]/30 bg-white/95 dark:bg-[#08110D]/95 backdrop-blur-xl text-[#111B16] dark:text-white shadow-2xl overflow-hidden"
          >
            {/* Header */}
            <div className="px-5 py-4 border-b border-[#0F241B]/10 dark:border-white/[0.08] bg-[#E8F8F0]/60 dark:bg-[#0D211A]/60 flex items-start justify-between gap-3">
              <div className="flex items-start gap-3 min-w-0">
                <span className="h-10 w-10 rounded-xl bg-[#1C6B4D] dark:bg-[#0F2B20] border border-[#2FD48B]/40 text-white dark:text-[#3BE098] flex items-center justify-center shrink-0 shadow-[0_0_18px_rgba(47,212,139,0.2)]">
                  <ArrowUpCircle className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                  <h2 className="font-display text-base font-bold tracking-tight truncate">
                    {updateInfo.updateAvailable
                      ? `Update Available · ${updateInfo.releaseTag}`
                      : 'MochiDrop is Up to Date'}
                  </h2>
                  <p className="text-xs font-mono text-[#52655C] dark:text-[#8E9B95] mt-0.5">
                    v{updateInfo.currentVersion} → v{updateInfo.latestVersion}
                    {publishedDate ? ` · Released ${publishedDate}` : ''}
                  </p>
                </div>
              </div>

              {!isBusy && (
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close update dialog"
                  className="p-1.5 rounded-lg text-[#52655C] dark:text-[#8E9B95] hover:text-[#111B16] dark:hover:text-white hover:bg-black/[0.05] dark:hover:bg-white/[0.08] cursor-pointer"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>

            {/* Body */}
            <div className="p-5 space-y-4">
              {/* Release Notes (plain text, safe React binding) */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-[#1F332A] dark:text-[#DCE6E1]">
                    {updateInfo.releaseName || `Release ${updateInfo.releaseTag}`}
                  </span>
                  <span className="font-mono text-[11px] text-[#64786E] dark:text-[#7A8A83]">
                    {updateInfo.repo}
                  </span>
                </div>
                <div className="rounded-xl border border-[#0F241B]/10 dark:border-white/[0.08] bg-black/[0.03] dark:bg-black/40 p-3 max-h-44 overflow-y-auto text-xs text-[#354B41] dark:text-[#B8C6BF] whitespace-pre-wrap leading-relaxed font-mono">
                  {updateInfo.releaseNotes.trim()
                    ? updateInfo.releaseNotes.trim()
                    : 'Includes the latest MochiDrop improvements, fixes, and multi-network enhancements.'}
                </div>
              </div>

              {/* Active Update Package Info */}
              {activeAsset && (
                <div className="rounded-xl border border-[#0F241B]/10 dark:border-white/[0.08] bg-white/60 dark:bg-white/[0.03] px-3.5 py-2.5 flex items-center justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <p className="font-semibold text-[#111B16] dark:text-white truncate">
                      {updateInfo.supportsInAppUpdate && updateInfo.inAppUpdateAsset
                        ? `In-App Update Package (${updateInfo.releaseTag})`
                        : activeAsset.name}
                    </p>
                    <p className="text-[11px] font-mono text-[#52655C] dark:text-[#8A9891]">
                      {updateInfo.supportsInAppUpdate && updateInfo.inAppUpdateAsset
                        ? 'Updates directly inside MochiDrop — no installer wizard'
                        : updateInfo.isDesktopApp && updateInfo.platform === 'win32'
                        ? 'Silent background update — no setup wizard'
                        : `Matched for ${updateInfo.platform} (${updateInfo.arch})`}
                      {activeAsset.sizeBytes > 0 ? ` · ${formatBytes(activeAsset.sizeBytes)}` : ''}
                    </p>
                  </div>
                  <a
                    href={activeAsset.downloadUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[11px] font-medium text-[#156E4B] dark:text-[#3BE098] hover:underline inline-flex items-center gap-1 shrink-0"
                  >
                    Direct link
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              )}

              {/* Live In-App Download / Extract / Apply Progress */}
              {(isDownloading || isExtracting || isReady || isInstalling) && (
                <div className="rounded-xl border border-[#1C6B4D]/25 dark:border-[#2FD48B]/30 bg-[#E8F8F0]/60 dark:bg-[#0D211A]/60 p-3.5 space-y-2">
                  <div className="flex items-center justify-between text-xs gap-2">
                    <span className="font-semibold text-[#126646] dark:text-[#3BE098] inline-flex items-center gap-1.5 min-w-0 truncate">
                      {isReady ? (
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                      ) : (
                        <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
                      )}
                      <span className="truncate">
                        {downloadStatus.stageLabel ||
                          (isInstalling
                            ? 'Applying update & reloading MochiDrop...'
                            : isExtracting
                            ? 'Extracting & verifying update...'
                            : isReady
                            ? 'Update downloaded & ready to apply'
                            : `Downloading ${downloadStatus.filename || 'update'}...`)}
                      </span>
                    </span>
                    <span className="font-mono text-[11px] font-bold tabular-nums text-[#126646] dark:text-[#3BE098] shrink-0">
                      {downloadStatus.percent}%
                    </span>
                  </div>

                  <div className="h-2 w-full rounded-full bg-black/10 dark:bg-white/[0.1] overflow-hidden">
                    <div
                      style={{ width: `${Math.max(isExtracting || isInstalling ? 100 : 0, downloadStatus.percent)}%` }}
                      className={`h-full rounded-full bg-gradient-to-r from-[#1A6B4D] to-[#3BE098] transition-all duration-300 ${
                        isExtracting || isInstalling ? 'animate-pulse' : ''
                      }`}
                    />
                  </div>

                  {downloadStatus.downloadedBytes > 0 && (
                    <p className="text-[11px] font-mono tabular-nums text-[#52655C] dark:text-[#8E9B95]">
                      {formatBytes(downloadStatus.downloadedBytes)}
                      {downloadStatus.totalBytes > 0
                        ? ` / ${formatBytes(downloadStatus.totalBytes)}`
                        : ''}
                    </p>
                  )}
                </div>
              )}

              {/* Error Message */}
              {(downloadStatus.state === 'error' && downloadStatus.error) || updateInfo.error ? (
                <div className="rounded-xl border border-rose-500/25 bg-rose-500/10 px-3.5 py-2.5 text-xs text-rose-600 dark:text-rose-300 flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>{downloadStatus.error || updateInfo.error}</span>
                </div>
              ) : null}

              {/* All Other Platform Assets */}
              {updateInfo.allAssets.length > 1 && !isBusy && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-[#52655C] dark:text-[#8E9B95] hover:text-[#156E4B] dark:hover:text-[#3BE098] font-medium">
                    All release packages ({updateInfo.allAssets.length})
                  </summary>
                  <div className="mt-2 divide-y divide-[#0F241B]/8 dark:divide-white/[0.07] rounded-xl border border-[#0F241B]/10 dark:border-white/[0.08] bg-white/50 dark:bg-black/30">
                    {updateInfo.allAssets.map((asset) => (
                      <div
                        key={asset.name}
                        className="px-3 py-2 flex items-center justify-between gap-2"
                      >
                        <span className="font-mono text-[11px] truncate text-[#1F332A] dark:text-[#DCE6E1]">
                          {asset.name}
                        </span>
                        <div className="flex items-center gap-2 shrink-0">
                          {asset.sizeBytes > 0 && (
                            <span className="font-mono text-[10px] text-[#64786E] dark:text-[#7A8A83]">
                              {formatBytes(asset.sizeBytes)}
                            </span>
                          )}
                          <a
                            href={asset.downloadUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[11px] font-semibold text-[#156E4B] dark:text-[#3BE098] hover:underline"
                          >
                            Download
                          </a>
                        </div>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>

            {/* Footer Actions */}
            <div className="px-5 py-3.5 border-t border-[#0F241B]/10 dark:border-white/[0.08] bg-black/[0.02] dark:bg-white/[0.02] flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <a
                  href={updateInfo.releaseUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="h-9 px-3 rounded-xl border border-[#0F241B]/12 dark:border-white/[0.1] bg-white/70 dark:bg-white/[0.04] text-xs font-medium text-[#22352C] dark:text-[#DCE6E1] hover:border-[#1B6B4D]/40 dark:hover:border-[#2FD48B]/35 inline-flex items-center gap-1.5 transition-colors"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  GitHub Release
                </a>
                {!updateInfo.updateAvailable && (
                  <button
                    type="button"
                    disabled={checking}
                    onClick={onCheckAgain}
                    className="h-9 px-3 rounded-xl border border-[#0F241B]/12 dark:border-white/[0.1] bg-white/70 dark:bg-white/[0.04] text-xs font-medium text-[#22352C] dark:text-[#DCE6E1] inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${checking ? 'animate-spin' : ''}`} />
                    Check Again
                  </button>
                )}
              </div>

              <div className="flex items-center gap-2">
                {updateInfo.updateAvailable && !isBusy && (
                  <button
                    type="button"
                    onClick={onRemindLater}
                    className="h-9 px-3 rounded-xl text-xs font-medium text-[#52655C] dark:text-[#8E9B95] hover:text-[#111B16] dark:hover:text-white cursor-pointer"
                  >
                    Later
                  </button>
                )}

                {updateInfo.updateAvailable && updateInfo.isDesktopApp && isReady ? (
                  <button
                    type="button"
                    disabled={isInstalling}
                    onClick={onInstallNow}
                    className="h-9 px-4 rounded-xl bg-[#1C6B4D] hover:bg-[#16593F] dark:bg-[#1A5E44]/95 dark:hover:bg-[#217455] border border-[#2FD48B]/45 text-white text-xs font-semibold shadow-[0_0_20px_rgba(34,197,126,0.22)] inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                  >
                    {isInstalling ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Rocket className="h-3.5 w-3.5" />
                    )}
                    Apply &amp; Reload
                  </button>
                ) : updateInfo.updateAvailable && updateInfo.isDesktopApp && activeAsset ? (
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => onStartDownload()}
                    className="h-9 px-4 rounded-xl bg-[#1C6B4D] hover:bg-[#16593F] dark:bg-[#1A5E44]/95 dark:hover:bg-[#217455] border border-[#2FD48B]/45 text-white text-xs font-semibold shadow-[0_0_20px_rgba(34,197,126,0.22)] inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-55"
                  >
                    {isBusy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Rocket className="h-3.5 w-3.5" />
                    )}
                    {isInstalling
                      ? 'Reloading MochiDrop...'
                      : isExtracting
                      ? 'Applying Update...'
                      : isDownloading
                      ? `Downloading (${downloadStatus.percent}%)`
                      : 'Update Now'}
                  </button>
                ) : updateInfo.updateAvailable && activeAsset ? (
                  <a
                    href={activeAsset.downloadUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="h-9 px-4 rounded-xl bg-[#1C6B4D] hover:bg-[#16593F] dark:bg-[#1A5E44]/95 dark:hover:bg-[#217455] border border-[#2FD48B]/45 text-white text-xs font-semibold shadow-[0_0_20px_rgba(34,197,126,0.22)] inline-flex items-center gap-1.5"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Download Update
                  </a>
                ) : null}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
