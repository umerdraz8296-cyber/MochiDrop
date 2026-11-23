export type WorkspaceTab = 'downloads' | 'networks' | 'settings';

export type CategoryFilter =
  | 'all'
  | 'compressed'
  | 'documents'
  | 'music'
  | 'video'
  | 'programs'
  | 'torrent'
  | 'completed'
  | 'incomplete';

export type ConcurrentLimit = 1 | 2 | 3 | 4 | 5;
export type StreamCountOption = 4 | 8 | 16 | 32;

export type DownloadStatus =
  | 'connecting'
  | 'downloading'
  | 'paused'
  | 'queued'
  | 'completed'
  | 'error'
  | 'cancelled';

export type DownloadKind =
  | 'video'
  | 'audio'
  | 'archive'
  | 'software'
  | 'document'
  | 'image'
  | 'torrent'
  | 'file';

export type TransferProtocol =
  | 'HTTPS'
  | 'HTTP'
  | 'HLS/DASH'
  | 'MAGNET'
  | 'TORRENT'
  | 'FTP'
  | 'SFTP'
  | 'CLOUD';

export interface TorrentFileItem {
  id: string;
  name: string;
  sizeMb: number;
  selected: boolean;
}

export interface ChunkBlock {
  index: number;
  progress: number; // 0..100
  adapterId: string;
  raced?: boolean;
}

export interface DownloadItem {
  id: string;
  serverTransferId?: string;
  title: string;
  url: string;
  domain: string;
  kind: DownloadKind;
  protocol?: TransferProtocol;
  status: DownloadStatus;
  totalBytes: number; // 0 means unknown size until server reports it
  downloadedBytes: number;
  speedBytesPerSec: number;
  quality?: string;
  language?: string;
  availableLanguages?: string[];
  availableQualities?: string[];
  variantUrls?: Record<string, string>;
  source: 'direct' | 'extension' | 'magnet' | 'batch' | 'playlist';
  createdAt: number;
  chunkSizeMb: number;
  parallelStreams: number;
  chunks: ChunkBlock[];
  adapterSplit: Record<string, number>;
  torrentFiles?: TorrentFileItem[];
  resumable: boolean;
  retryCount: number;
  redirectHops?: number;
  streamType?: 'hls' | 'dash' | 'progressive' | 'unknown';
  streamInitialized?: boolean;
  savedOnDisk?: boolean;
  errorMessage?: string | null;
  httpStatus?: number | null;
  directOnly?: boolean;
  playlistTitle?: string;
  playlistIndex?: number;
  durationText?: string;
  thumbnailUrl?: string;
  autoQueue?: boolean;
}

export interface NetworkAdapter {
  id: string;
  deviceCode: string;
  name: string;
  ipAddress?: string;
  ssid?: string;
  customNamed?: boolean;
  interfaceType: 'Wi-Fi' | 'Ethernet' | 'Cellular USB' | 'Virtual';
  connected: boolean;
  enabled: boolean;
  maxCapacityMbps: number;
  linkSpeedKnown?: boolean;
  currentSpeedBytesPerSec?: number;
  currentSpeedMbps: number;
  speedCapMbps: number | null;
  dataBudgetGb: number | null;
  budgetPeriod: 'daily' | 'weekly' | 'monthly';
  usedDataGb: number;
  metered: boolean;
  shade: 'solid' | 'mid' | 'soft' | 'stripe';
  historyMbps: number[];
}

export interface ReleaseAssetInfo {
  name: string;
  downloadUrl: string;
  sizeBytes: number;
}

export interface UpdateCheckInfo {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  repo: string;
  releaseName: string;
  releaseTag: string;
  releaseNotes: string;
  publishedAt: string | null;
  releaseUrl: string;
  isDesktopApp: boolean;
  platform: string;
  arch: string;
  recommendedAsset: ReleaseAssetInfo | null;
  allAssets: ReleaseAssetInfo[];
  checkedAt: number;
  error: string | null;
}

export interface UpdateDownloadStatus {
  state: 'idle' | 'downloading' | 'ready' | 'installing' | 'error';
  version: string | null;
  filename: string | null;
  downloadedBytes: number;
  totalBytes: number;
  percent: number;
  error: string | null;
}

export interface PlexoPlugin {
  id: string;
  name: string;
  category: string;
  description: string;
  enabled: boolean;
}

export interface PlexoSettings {
  downloadDirectory: string;
  chunkSizeMb: 4 | 8 | 16;
  maxConnectionsPerAdapter: number;
  preferredStreams: StreamCountOption;
  maxConcurrentDownloads: ConcurrentLimit;
  globalSpeedCapMbps: number | null;
  backupRacing: boolean;
  diskAwareThrottling: boolean;
  vigilantMode: boolean;
  scheduleEnabled: boolean;
  scheduleStart: string;
  scheduleEnd: string;
  autoCaptureBrowser: boolean;
  autoDetectClipboard: boolean;
  skipSmallFilesMb: number;
  siteExclusions: string[];
}

export interface YouTubeResolutionOption {
  id: string;
  label: string;
  height: number;
  kind: 'video' | 'audio';
  badge?: string;
}

export interface YouTubePlaylistVideo {
  videoId: string;
  url: string;
  title: string;
  author: string;
  durationText: string;
  durationSec: number;
  thumbnailUrl: string;
  index: number;
  playlistTitle: string;
}

export interface YouTubePlaylistResponse {
  title: string;
  author: string;
  playlistCount: number;
  videoCount: number;
  totalDurationSec: number;
  videos: YouTubePlaylistVideo[];
  availableResolutions: YouTubeResolutionOption[];
  resolutionsSource: 'probed' | 'standard';
  truncated?: boolean;
  errors?: Array<{ playlistId: string; error: string }>;
}

export interface AddDownloadPayload {
  title: string;
  url: string;
  domain: string;
  kind: DownloadKind;
  protocol?: TransferProtocol;
  totalBytes: number;
  quality?: string;
  language?: string;
  availableLanguages?: string[];
  availableQualities?: string[];
  variantUrls?: Record<string, string>;
  source: 'direct' | 'extension' | 'magnet' | 'batch' | 'playlist';
  torrentFiles?: TorrentFileItem[];
  resumable?: boolean;
  parallelStreams?: StreamCountOption;
  playlistTitle?: string;
  playlistIndex?: number;
  durationText?: string;
  thumbnailUrl?: string;
}

export interface InspectResponse {
  kind: DownloadKind;
  protocol: TransferProtocol;
  url: string;
  resolvedUrl?: string;
  filename: string;
  domain: string;
  sizeBytes: number; // 0 when host did not report Content-Length
  acceptRanges: boolean;
  contentType: string;
  verifiedLive: boolean;
  httpStatus?: number;
  probeError?: string | null;
  streamType?: 'hls' | 'dash' | 'progressive' | 'unknown';
  redirectHops?: number;
  hlsSegmentCount?: number;
  hlsDurationSec?: number;
  quality?: string;
  language?: string;
  availableLanguages?: string[];
  availableQualities?: string[];
  variantUrls?: Record<string, string>;
  torrentFiles?: TorrentFileItem[];
}
