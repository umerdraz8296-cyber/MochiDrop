export type WorkspaceTab = 'downloads' | 'networks' | 'settings';

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
  source: 'direct' | 'extension' | 'magnet' | 'batch';
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
}

export interface NetworkAdapter {
  id: string;
  deviceCode: string;
  name: string;
  interfaceType: 'Wi-Fi' | 'Ethernet' | 'Cellular USB' | 'Virtual';
  enabled: boolean;
  maxCapacityMbps: number;
  currentSpeedMbps: number;
  speedCapMbps: number | null;
  dataBudgetGb: number | null;
  budgetPeriod: 'daily' | 'weekly' | 'monthly';
  usedDataGb: number;
  metered: boolean;
  shade: 'solid' | 'mid' | 'soft' | 'stripe';
  historyMbps: number[];
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
