import {
  DownloadItem,
  NetworkAdapter,
  PlexoPlugin,
  PlexoSettings,
} from '../types/plexo';

// Real connected OS network interfaces are populated live from /api/networks
export const INITIAL_ADAPTERS: NetworkAdapter[] = [];

export const INITIAL_DOWNLOADS: DownloadItem[] = [];

export const INITIAL_PLUGINS: PlexoPlugin[] = [
  {
    id: 'plugin-range',
    name: 'HTTP Range Multi-Chunk Engine',
    category: 'Core',
    description: 'Splits downloads into 8 MB blocks across enabled network interfaces.',
    enabled: true,
  },
  {
    id: 'plugin-torrent',
    name: 'BitTorrent & Magnet Engine',
    category: 'P2P',
    description: 'Distributes peers across interfaces with selective file picking.',
    enabled: true,
  },
  {
    id: 'plugin-video-grabber',
    name: 'Browser Video & Language Detector',
    category: 'Extension',
    description: 'Detects all videos on a tab with available audio and subtitle languages.',
    enabled: true,
  },
  {
    id: 'plugin-cookie-bridge',
    name: 'Browser Cookie Bridge',
    category: 'Extension',
    description: 'Passes authenticated browser cookies and referrers over local loopback.',
    enabled: true,
  },
  {
    id: 'plugin-vigilant',
    name: 'Vigilant Backoff & Disk Throttler',
    category: 'Reliability',
    description: 'Handles HTTP 403/429/503 Retry-After and paces disk writes.',
    enabled: true,
  },
];

export const INITIAL_SETTINGS: PlexoSettings = {
  downloadDirectory: '~/Downloads/MochiDrop',
  chunkSizeMb: 8,
  maxConnectionsPerAdapter: 16,
  preferredStreams: 16,
  maxConcurrentDownloads: 2,
  globalSpeedCapMbps: null,
  backupRacing: true,
  diskAwareThrottling: true,
  vigilantMode: true,
  scheduleEnabled: false,
  scheduleStart: '01:00',
  scheduleEnd: '06:00',
  autoCaptureBrowser: true,
  autoDetectClipboard: true,
  skipSmallFilesMb: 5,
  siteExclusions: [],
};
