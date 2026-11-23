import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type AdapterInterfaceType = 'Wi-Fi' | 'Ethernet' | 'Cellular USB' | 'Virtual';
export type AdapterShade = 'solid' | 'mid' | 'soft' | 'stripe';
export type ClientNetworkSlotHint = 'wifi' | 'ethernet' | 'usb';

export interface LiveNetworkAdapterDto {
  id: string;
  deviceCode: string;
  name: string;
  ipAddress: string;
  ssid?: string;
  interfaceType: AdapterInterfaceType;
  connected: boolean;
  enabled: boolean;
  maxCapacityMbps: number;
  linkSpeedKnown: boolean;
  currentSpeedBytesPerSec: number;
  currentSpeedMbps: number;
  usedDataGb: number;
  metered: boolean;
  shade: AdapterShade;
  historyMbps: number[];
}

interface DetectedOsInterface {
  id: string;
  osName: string;
  displayName: string;
  ipAddress: string;
  ssid?: string;
  mac: string;
  interfaceType: AdapterInterfaceType;
  linkSpeedMbps: number;
  linkSpeedKnown: boolean;
  metered: boolean;
  shade: AdapterShade;
  routeMetric: number; // Lower = OS preferred primary internet route
  hasDefaultRoute: boolean;
  hasInternetConnectivity?: boolean;
}

interface AdapterTrafficState {
  samples: Array<{ ts: number; bytes: number }>;
  firstByteAt: number | null;
  smoothedBytesPerSec: number;
  totalBytes: number;
  historyMbps: number[];
  lastHistoryPushAt: number;
  bindFailedUntil: number;
}

interface OsEnrichmentEntry {
  description?: string;
  mediaType?: string;
  physicalMediaType?: string;
  ndisPhysicalMedium?: number;
  ndisPhysicalMediumText?: string;
  ifType?: number;
  mac?: string;
  linkSpeedMbps?: number;
  hardwarePort?: string;
  isVirtual?: boolean;
  hardwareInterface?: boolean;
  hasDefaultRoute?: boolean;
  hasInternetConnectivity?: boolean;
  routeMetric?: number;
  ssid?: string;
  isWlanAdapter?: boolean;
  isWlanConnected?: boolean;
}

interface ClientBrowserNetworkHint {
  slot: ClientNetworkSlotHint;
  online: boolean;
  downlinkMbps: number;
}

const SPEED_WINDOW_MS = 3000;
const HISTORY_LEN = 16;
const BIND_FAILURE_COOLDOWN_MS = 30_000;

const VIRTUAL_NAME_EXACT_RE =
  /^(lo\d*|loopback|docker\d*|br-[0-9a-f]+|veth[0-9a-f]*|virbr\d*|vmnet\d*|vboxnet\d*|utun\d*|awdl\d*|llw\d*|anpi\d*|bridge\d*|ap\d*|gif\d*|stf\d*|p2p\d*|tailscale\d*|zt[0-9a-z]+|wg\d*|tun\d*|tap\d*|podman\d*|cni\d*|flannel\.\d*|cali[0-9a-f]+|warp\d*)$/i;

const VIRTUAL_NAME_SUBSTR_RE =
  /(vethernet|wsl|hyper-v|vmware|virtualbox|vbox|bluetooth|personal area network|loopback|teredo|isatap|npcap|local area connection\*\s*\d+|wi-fi direct|microsoft wi-fi direct|nordlynx|wireguard|tailscale|zerotier|openvpn|tap-windows|wintun|radmin|hamachi|ciscovpn|anyconnect|fortinet|checkpoint|km-test|pseudo-interface|cloudflarewarp|warp|protonvpn|mullvad|expressvpn|surfshark|virtual\s+adapter|virtual\s+ethernet|miniport)/i;

const WIFI_HINT_RE =
  /(wi[\s\u2010-\u2015\u2212-]?fi|wireless|wlan|802\.11|native\s*802\.11|airport|wlp\d|wlx[0-9a-f]|iwlwifi|centrino|ath\d|qca\d|mt79\d\d|ax2\d\d|ax1\d\d|ax4\d\d|be2\d\d|ac\s*\d{4}|dual\s*band\s*wireless|realtek\s*(rtl)?8[178]\d\d|mediatek\s*(wi-?fi|mt79)|qualcomm\s*(atheros|fastconnect|qca)|killer(\(r\))?\s*(wi-?fi|wireless)|broadcom\s*802\.11|ralink|marvell\s*avastar|tp-link\s*wireless|asus\s*pce-)/i;

const USB_CELLULAR_HINT_RE =
  /(rndis|remote\s*ndis|android|apple\s*mobile|iphone|ipad|ipheth|usb\s*(tether|modem|cellular|mobile|lte|5g)|cellular|wwan|wwp\d|mobile\s*broadband|wireless\s*wan|lte|5g|tether|qmi_wwan|cdc_mbim|^usb\d|^rmnet)/i;

const ETHERNET_HINT_RE =
  /(ethernet|gigabit|gbe\b|realtek\s*pcie|intel\(r\)\s*ethernet|broadcom\s*netxtreme|killer\s*e\d|thunderbolt\s*ethernet|usb.*(lan|ethernet|10\/100|1000|2\.5g)|^eth\d|^enp\d|^eno\d|^ens\d|^enx[0-9a-f])/i;

const CANONICAL_SLOTS: Array<{
  id: string;
  slotKey: ClientNetworkSlotHint;
  interfaceType: Exclude<AdapterInterfaceType, 'Virtual'>;
  label: string;
  shade: AdapterShade;
  metered: boolean;
}> = [
  { id: 'slot-wifi', slotKey: 'wifi', interfaceType: 'Wi-Fi', label: 'Wi-Fi', shade: 'solid', metered: false },
  { id: 'slot-ethernet', slotKey: 'ethernet', interfaceType: 'Ethernet', label: 'Ethernet', shade: 'mid', metered: false },
  { id: 'slot-usb', slotKey: 'usb', interfaceType: 'Cellular USB', label: 'USB Cellular', shade: 'soft', metered: true },
];

const enabledOverrides = new Map<string, boolean>();
const trafficByAdapter = new Map<string, AdapterTrafficState>();
const enrichmentByNormName = new Map<string, OsEnrichmentEntry>();
const enrichmentByMac = new Map<string, OsEnrichmentEntry>();
const routeMetricByIp = new Map<string, number>();

let cachedInterfaces: DetectedOsInterface[] = [];
let lastOsFingerprint = '';
let lastEnrichmentAt = 0;
let enrichmentInFlight: Promise<void> | null = null;
let lastDetectAt = 0;
let routingTableKnown = false;
let internetProfileKnown = false;

// Used ONLY when MochiDrop's server is running in a remote cloud container (e.g. Cloud Run preview)
// where the server's container NIC (eth1 / 169.254.x.x) cannot see the user's laptop Wi-Fi/Ethernet NIC.
let clientBrowserHint: ClientBrowserNetworkHint = {
  slot: 'wifi',
  online: true,
  downlinkMbps: 0,
};

export function isCloudHostedEnvironment(): boolean {
  if (process.env.MOCHIDROP_IS_DESKTOP === '1') return false;
  if (process.env.K_SERVICE || process.env.CLOUD_RUN_JOB || process.env.K_REVISION) return true;
  return false;
}

export function updateClientBrowserNetworkHint(patch: {
  slot?: ClientNetworkSlotHint;
  online?: boolean;
  downlinkMbps?: number;
}): void {
  if (!isCloudHostedEnvironment()) return;
  let changed = false;
  if (patch.slot && (patch.slot === 'wifi' || patch.slot === 'ethernet' || patch.slot === 'usb')) {
    if (clientBrowserHint.slot !== patch.slot) {
      clientBrowserHint.slot = patch.slot;
      changed = true;
    }
  }
  if (typeof patch.online === 'boolean' && clientBrowserHint.online !== patch.online) {
    clientBrowserHint.online = patch.online;
    changed = true;
  }
  if (
    typeof patch.downlinkMbps === 'number' &&
    Number.isFinite(patch.downlinkMbps) &&
    patch.downlinkMbps >= 0 &&
    patch.downlinkMbps <= 10_000
  ) {
    const rounded = Math.round(patch.downlinkMbps);
    if (clientBrowserHint.downlinkMbps !== rounded) {
      clientBrowserHint.downlinkMbps = rounded;
      changed = true;
    }
  }
  if (changed) {
    lastDetectAt = 0;
  }
}

function normalizeAdapterName(name: string): string {
  return name
    .trim()
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function normalizeMac(mac?: string | null): string {
  if (!mac) return '';
  const hex = mac.toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12 || hex === '000000000000') return '';
  return hex;
}

function mergeEnrichmentEntry(
  target: Map<string, OsEnrichmentEntry>,
  key: string,
  patch: OsEnrichmentEntry
): void {
  if (!key) return;
  const prev = target.get(key) || {};
  target.set(key, {
    ...prev,
    ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
    // Never downgrade confirmed WLAN or internet flags once set in this enrichment pass
    isWlanAdapter: prev.isWlanAdapter || patch.isWlanAdapter ? true : undefined,
    isWlanConnected:
      patch.isWlanConnected !== undefined ? patch.isWlanConnected : prev.isWlanConnected,
    hasDefaultRoute: prev.hasDefaultRoute || patch.hasDefaultRoute ? true : patch.hasDefaultRoute,
    hasInternetConnectivity:
      prev.hasInternetConnectivity || patch.hasInternetConnectivity
        ? true
        : patch.hasInternetConnectivity,
    routeMetric:
      prev.routeMetric !== undefined && patch.routeMetric !== undefined
        ? Math.min(prev.routeMetric, patch.routeMetric)
        : patch.routeMetric ?? prev.routeMetric,
    linkSpeedMbps:
      Math.max(prev.linkSpeedMbps || 0, patch.linkSpeedMbps || 0) || undefined,
    ssid: patch.ssid || prev.ssid,
    description: patch.description || prev.description,
  });
}

function lookupEnrichment(
  osName: string,
  mac?: string,
  ipAddress?: string
): OsEnrichmentEntry | undefined {
  const byName = enrichmentByNormName.get(normalizeAdapterName(osName));
  const normMac = normalizeMac(mac);
  const byMac = normMac ? enrichmentByMac.get(normMac) : undefined;
  const ipRouteMetric = ipAddress ? routeMetricByIp.get(ipAddress) : undefined;

  if (!byName && !byMac && ipRouteMetric === undefined) return undefined;

  const merged: OsEnrichmentEntry = {
    ...(byName || {}),
    ...(byMac || {}),
    // Prefer specific non-empty values across both maps
    description: byName?.description || byMac?.description,
    hardwarePort: byName?.hardwarePort || byMac?.hardwarePort,
    mediaType: byName?.mediaType || byMac?.mediaType,
    physicalMediaType: byName?.physicalMediaType || byMac?.physicalMediaType,
    ndisPhysicalMedium: byName?.ndisPhysicalMedium ?? byMac?.ndisPhysicalMedium,
    ndisPhysicalMediumText: byName?.ndisPhysicalMediumText || byMac?.ndisPhysicalMediumText,
    ifType: byName?.ifType ?? byMac?.ifType,
    ssid: byMac?.ssid || byName?.ssid,
    isWlanAdapter: Boolean(byName?.isWlanAdapter || byMac?.isWlanAdapter) || undefined,
    isWlanConnected:
      byMac?.isWlanConnected !== undefined
        ? byMac.isWlanConnected
        : byName?.isWlanConnected,
    isVirtual: byName?.isVirtual === true || byMac?.isVirtual === true ? true : undefined,
    hardwareInterface:
      byName?.hardwareInterface === false || byMac?.hardwareInterface === false
        ? false
        : byName?.hardwareInterface ?? byMac?.hardwareInterface,
    linkSpeedMbps: Math.max(byName?.linkSpeedMbps || 0, byMac?.linkSpeedMbps || 0) || undefined,
    hasInternetConnectivity:
      byName?.hasInternetConnectivity || byMac?.hasInternetConnectivity ? true : undefined,
    hasDefaultRoute:
      byName?.hasDefaultRoute || byMac?.hasDefaultRoute || ipRouteMetric !== undefined
        ? true
        : undefined,
  };

  const metrics = [byName?.routeMetric, byMac?.routeMetric, ipRouteMetric].filter(
    (m): m is number => typeof m === 'number' && Number.isFinite(m)
  );
  if (metrics.length > 0) {
    merged.routeMetric = Math.min(...metrics);
  }

  return merged;
}

function slugifyAdapterId(osName: string): string {
  const clean = osName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `net-${clean || 'default'}`;
}

function isInvalidOrApipaIpv4(ip: string, netmask = ''): boolean {
  if (!ip || ip === '0.0.0.0' || ip.startsWith('127.')) return true;
  // Windows/macOS DHCP-failure APIPA uses 169.254.0.0/16 (netmask 255.255.0.0)
  if (ip.startsWith('169.254.') && netmask !== '255.255.255.255') return true;
  return false;
}

function isUsableGlobalIpv6(ip: string): boolean {
  if (!ip) return false;
  const low = ip.toLowerCase();
  if (low === '::1' || low === '::' || low.startsWith('fe80:')) return false;
  return true;
}

function isLikelyVirtualInterface(osName: string, meta?: OsEnrichmentEntry): boolean {
  if (meta?.isVirtual === true) return true;
  if (meta?.hardwareInterface === false) return true;
  if (meta?.ndisPhysicalMedium === 10) return true; // Bluetooth
  const trimmed = osName.trim();
  if (VIRTUAL_NAME_EXACT_RE.test(trimmed)) return true;
  if (VIRTUAL_NAME_SUBSTR_RE.test(trimmed)) return true;
  if (meta?.description && VIRTUAL_NAME_SUBSTR_RE.test(meta.description)) return true;
  if (meta?.hardwarePort && VIRTUAL_NAME_SUBSTR_RE.test(meta.hardwarePort)) return true;
  if (meta?.physicalMediaType && /bluetooth|tunnel|loopback/i.test(meta.physicalMediaType)) {
    return true;
  }
  return false;
}

function parseWindowsLinkSpeedMbps(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return raw > 100_000 ? Math.round(raw / 1_000_000) : Math.round(raw);
  }
  if (typeof raw !== 'string') return 0;
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(gbps|mbps|kbps|bps)/i);
  if (!m) return 0;
  const val = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === 'gbps') return Math.round(val * 1000);
  if (unit === 'mbps') return Math.round(val);
  if (unit === 'kbps') return Math.max(1, Math.round(val / 1000));
  return 0;
}

interface ParsedNetshWlanInterface {
  name?: string;
  description?: string;
  mac?: string;
  connected: boolean;
  ssid?: string;
  linkSpeedMbps?: number;
}

function parseNetshWlanOutput(raw: string): ParsedNetshWlanInterface[] {
  const results: ParsedNetshWlanInterface[] = [];
  if (!raw || typeof raw !== 'string') return results;

  const blocks = raw.split(/\r?\n\s*\r?\n/);
  for (const block of blocks) {
    const lines = block
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length < 2) continue;

    let name: string | undefined;
    let description: string | undefined;
    let mac: string | undefined;
    let stateStr = '';
    let ssid: string | undefined;
    let rxRate = 0;
    let txRate = 0;

    for (const line of lines) {
      const colonIdx = line.indexOf(':');
      if (colonIdx <= 0) continue;
      const key = line.slice(0, colonIdx).trim().toLowerCase();
      const val = line.slice(colonIdx + 1).trim();
      if (!val) continue;

      if (!mac) {
        const macMatch = val.match(/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i);
        if (macMatch) {
          mac = normalizeMac(macMatch[0]);
          continue;
        }
      }

      if (key === 'name' || key === 'nom' || key === 'nombre') {
        name = val;
      } else if (key === 'description' || key === 'beschreibung' || key === 'descripción') {
        description = val;
      } else if (key === 'state' || key === 'status' || key === 'état' || key === 'estado') {
        stateStr = val.toLowerCase();
      } else if (key === 'ssid') {
        if (val.toLowerCase() !== 'none') ssid = val;
      } else if (key.includes('receive rate')) {
        const n = parseFloat(val);
        if (Number.isFinite(n) && n > 0) rxRate = Math.round(n);
      } else if (key.includes('transmit rate')) {
        const n = parseFloat(val);
        if (Number.isFinite(n) && n > 0) txRate = Math.round(n);
      }
    }

    if (!name && !mac) continue;

    // Connected check: handle English ("connected", excluding "disconnected") and SSID presence
    const explicitlyDisconnected = /\bdisconnect/i.test(stateStr);
    const connected =
      !explicitlyDisconnected &&
      (/\bconnected\b/i.test(stateStr) || Boolean(ssid));

    results.push({
      name,
      description,
      mac,
      connected,
      ssid,
      linkSpeedMbps: Math.max(rxRate, txRate) || undefined,
    });
  }
  return results;
}

function parseWindowsRoutePrint4(raw: string): Map<string, number> {
  const routes = new Map<string, number>();
  if (!raw || typeof raw !== 'string') return routes;
  for (const line of raw.split(/\r?\n/)) {
    // Matches: 0.0.0.0   0.0.0.0   192.168.1.1   192.168.1.42   35
    const m = line.match(
      /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d+)/
    );
    if (!m) continue;
    const gateway = m[1];
    const ifaceIp = m[2];
    const metric = Number(m[3]) || 0;
    if (gateway === '0.0.0.0' || ifaceIp === '127.0.0.1') continue;
    const prev = routes.get(ifaceIp);
    if (prev === undefined || metric < prev) {
      routes.set(ifaceIp, metric);
    }
  }
  return routes;
}

function readLinuxDefaultRoutes(): Map<string, number> {
  const routes = new Map<string, number>();
  if (process.platform !== 'linux') return routes;
  try {
    const content = fs.readFileSync('/proc/net/route', 'utf8');
    const lines = content.split('\n').slice(1);
    for (const line of lines) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 7) continue;
      const iface = cols[0];
      const dest = cols[1];
      const flags = parseInt(cols[3], 16);
      const metric = Number(cols[6]) || 0;
      // Destination 00000000 = default route (0.0.0.0/0); flag 0x1 = RTF_UP
      if (dest === '00000000' && (flags & 0x1) !== 0) {
        const prev = routes.get(iface);
        if (prev === undefined || metric < prev) {
          routes.set(iface, metric);
        }
      }
    }
  } catch {
    // ignore if /proc/net/route unavailable
  }
  return routes;
}

function readLinuxInterfaceMeta(osName: string): {
  isWireless: boolean;
  isUsbTether: boolean;
  speedMbps: number;
  operUp: boolean | null;
} {
  let isWireless = false;
  let isUsbTether = false;
  let speedMbps = 0;
  let operUp: boolean | null = null;
  if (process.platform !== 'linux') {
    return { isWireless, isUsbTether, speedMbps, operUp };
  }
  try {
    isWireless =
      fs.existsSync(`/sys/class/net/${osName}/wireless`) ||
      fs.existsSync(`/sys/class/net/${osName}/phy80211`);
  } catch {
    // ignore
  }
  try {
    const ueventPath = `/sys/class/net/${osName}/device/uevent`;
    if (fs.existsSync(ueventPath)) {
      const uevent = fs.readFileSync(ueventPath, 'utf8');
      if (/DRIVER=(rndis_host|ipheth|cdc_ether|cdc_ncm|cdc_mbim|qmi_wwan)/i.test(uevent)) {
        isUsbTether = true;
      }
    }
  } catch {
    // ignore
  }
  try {
    const state = fs
      .readFileSync(`/sys/class/net/${osName}/operstate`, 'utf8')
      .trim()
      .toLowerCase();
    if (state === 'up' || state === 'unknown') operUp = true;
    else if (state === 'down' || state === 'dormant' || state === 'notpresent') operUp = false;
  } catch {
    // ignore
  }
  try {
    const rawSpeed = Number(fs.readFileSync(`/sys/class/net/${osName}/speed`, 'utf8').trim());
    if (Number.isFinite(rawSpeed) && rawSpeed > 0 && rawSpeed <= 100_000) {
      speedMbps = Math.round(rawSpeed);
    }
  } catch {
    // Wi-Fi drivers often return EINVAL on /speed
  }
  return { isWireless, isUsbTether, speedMbps, operUp };
}

function applyNetshWlanEntries(entries: ParsedNetshWlanInterface[]): void {
  for (const w of entries) {
    const patch: OsEnrichmentEntry = {
      description: w.description,
      mac: w.mac,
      ssid: w.ssid,
      isWlanAdapter: true,
      isWlanConnected: w.connected,
      linkSpeedMbps: w.linkSpeedMbps,
    };
    if (w.name) {
      mergeEnrichmentEntry(enrichmentByNormName, normalizeAdapterName(w.name), patch);
    }
    if (w.mac) {
      mergeEnrichmentEntry(enrichmentByMac, w.mac, patch);
    }
  }
}

function isInternetConnectivityValue(val: unknown): boolean {
  if (typeof val === 'number') return val === 4; // MSFT_NetConnectionProfile IPv4Connectivity::Internet = 4
  if (typeof val === 'string') return /^internet$/i.test(val.trim());
  return false;
}

async function refreshOsEnrichment(force = false): Promise<void> {
  if (isCloudHostedEnvironment()) {
    lastEnrichmentAt = Date.now();
    return;
  }
  const now = Date.now();
  if (!force && lastEnrichmentAt > 0 && now - lastEnrichmentAt < 12_000) return;
  if (enrichmentInFlight) return enrichmentInFlight;

  enrichmentInFlight = (async () => {
    try {
      if (process.platform === 'win32') {
        const psCmd = [
          "$adapters = @(Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' } | Select-Object Name, InterfaceDescription, InterfaceIndex, MacAddress, LinkSpeed, MediaType, PhysicalMediaType, NdisPhysicalMedium, ifType, HardwareInterface, Virtual);",
          "$routes = @(Get-NetRoute -DestinationPrefix '0.0.0.0/0','::/0' -ErrorAction SilentlyContinue | Where-Object { $_.NextHop -ne '0.0.0.0' -and $_.NextHop -ne '::' } | Select-Object InterfaceIndex, RouteMetric, InterfaceMetric);",
          "$profiles = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | Select-Object InterfaceIndex, IPv4Connectivity, IPv6Connectivity, Name);",
          "@{ adapters = $adapters; routes = $routes; profiles = $profiles } | ConvertTo-Json -Depth 4 -Compress",
        ].join(' ');

        // Run fast native Windows commands (~30ms) in parallel with full PowerShell CIM query
        const wlanPromise = execFileAsync('netsh', ['wlan', 'show', 'interfaces'], {
          timeout: 3500,
          windowsHide: true,
        })
          .then((r) => {
            const parsedWlan = parseNetshWlanOutput(r.stdout || '');
            if (parsedWlan.length > 0) {
              applyNetshWlanEntries(parsedWlan);
              lastDetectAt = 0;
            }
            return parsedWlan;
          })
          .catch(() => [] as ParsedNetshWlanInterface[]);

        const routePrintPromise = execFileAsync('route', ['print', '-4'], {
          timeout: 3500,
          windowsHide: true,
        })
          .then((r) => {
            const ipRoutes = parseWindowsRoutePrint4(r.stdout || '');
            if (ipRoutes.size > 0) {
              routeMetricByIp.clear();
              for (const [ip, metric] of ipRoutes.entries()) {
                routeMetricByIp.set(ip, metric);
              }
              routingTableKnown = true;
              lastDetectAt = 0;
            }
            return ipRoutes;
          })
          .catch(() => new Map<string, number>());

        const psPromise = execFileAsync(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', psCmd],
          { timeout: 10_000, windowsHide: true }
        )
          .then((r) => r.stdout.trim())
          .catch(() => '');

        const [wlanEntries, ipRoutes, psText] = await Promise.all([
          wlanPromise,
          routePrintPromise,
          psPromise,
        ]);

        // Rebuild clean maps for this refresh pass
        enrichmentByNormName.clear();
        enrichmentByMac.clear();
        routeMetricByIp.clear();
        for (const [ip, metric] of ipRoutes.entries()) {
          routeMetricByIp.set(ip, metric);
        }

        // Apply netsh wlan entries first (authoritative Wi-Fi + SSID + MAC)
        applyNetshWlanEntries(wlanEntries);

        let hasAnyRoutes = ipRoutes.size > 0;
        let hasAnyInternetProfiles = false;

        if (psText) {
          try {
            const parsed = JSON.parse(psText) as {
              adapters?: unknown;
              routes?: unknown;
              profiles?: unknown;
            };

            const rawAdapters = Array.isArray(parsed.adapters)
              ? parsed.adapters
              : parsed.adapters
              ? [parsed.adapters]
              : [];
            const rawRoutes = Array.isArray(parsed.routes)
              ? parsed.routes
              : parsed.routes
              ? [parsed.routes]
              : [];
            const rawProfiles = Array.isArray(parsed.profiles)
              ? parsed.profiles
              : parsed.profiles
              ? [parsed.profiles]
              : [];

            const routeMetricByIfIndex = new Map<number, number>();
            for (const r of rawRoutes as Array<Record<string, unknown>>) {
              const idx = Number(r?.InterfaceIndex);
              if (!Number.isFinite(idx) || idx <= 0) continue;
              const totalMetric = (Number(r?.RouteMetric) || 0) + (Number(r?.InterfaceMetric) || 0);
              const existing = routeMetricByIfIndex.get(idx);
              if (existing === undefined || totalMetric < existing) {
                routeMetricByIfIndex.set(idx, totalMetric);
              }
            }
            if (routeMetricByIfIndex.size > 0) {
              hasAnyRoutes = true;
            }

            const internetByIfIndex = new Map<number, boolean>();
            for (const p of rawProfiles as Array<Record<string, unknown>>) {
              const idx = Number(p?.InterfaceIndex);
              if (!Number.isFinite(idx) || idx <= 0) continue;
              const hasNet =
                isInternetConnectivityValue(p?.IPv4Connectivity) ||
                isInternetConnectivityValue(p?.IPv6Connectivity);
              if (hasNet) {
                internetByIfIndex.set(idx, true);
                hasAnyInternetProfiles = true;
              }
            }

            for (const entry of rawAdapters as Array<Record<string, unknown>>) {
              if (!entry || typeof entry.Name !== 'string') continue;
              const name = entry.Name;
              const normName = normalizeAdapterName(name);
              const mac = normalizeMac(
                typeof entry.MacAddress === 'string' ? entry.MacAddress : undefined
              );
              const ifIndex = Number(entry.InterfaceIndex);
              const routeMetric = Number.isFinite(ifIndex)
                ? routeMetricByIfIndex.get(ifIndex)
                : undefined;
              const hasInternet = Number.isFinite(ifIndex)
                ? internetByIfIndex.get(ifIndex) === true
                : false;

              const ndisNum =
                typeof entry.NdisPhysicalMedium === 'number'
                  ? entry.NdisPhysicalMedium
                  : typeof entry.NdisPhysicalMedium === 'string' &&
                    /^\d+$/.test(entry.NdisPhysicalMedium)
                  ? Number(entry.NdisPhysicalMedium)
                  : undefined;
              const ndisText =
                typeof entry.NdisPhysicalMedium === 'string'
                  ? entry.NdisPhysicalMedium
                  : undefined;

              const ifTypeVal =
                typeof entry.ifType === 'number'
                  ? entry.ifType
                  : typeof entry.ifType === 'string' && /^\d+$/.test(entry.ifType)
                  ? Number(entry.ifType)
                  : undefined;

              const patch: OsEnrichmentEntry = {
                description:
                  typeof entry.InterfaceDescription === 'string'
                    ? entry.InterfaceDescription
                    : undefined,
                mediaType: typeof entry.MediaType === 'string' ? entry.MediaType : undefined,
                physicalMediaType:
                  typeof entry.PhysicalMediaType === 'string'
                    ? entry.PhysicalMediaType
                    : undefined,
                ndisPhysicalMedium: ndisNum,
                ndisPhysicalMediumText: ndisText,
                ifType: ifTypeVal,
                mac: mac || undefined,
                linkSpeedMbps: parseWindowsLinkSpeedMbps(entry.LinkSpeed) || undefined,
                isVirtual: entry.Virtual === true,
                hardwareInterface:
                  typeof entry.HardwareInterface === 'boolean'
                    ? entry.HardwareInterface
                    : undefined,
                hasDefaultRoute: routeMetric !== undefined ? true : undefined,
                hasInternetConnectivity: hasInternet ? true : undefined,
                routeMetric,
              };

              mergeEnrichmentEntry(enrichmentByNormName, normName, patch);
              if (mac) {
                mergeEnrichmentEntry(enrichmentByMac, mac, patch);
              }
            }
          } catch {
            // Keep netsh wlan + route print results if JSON parsing fails
          }
        }

        routingTableKnown = hasAnyRoutes;
        internetProfileKnown = hasAnyInternetProfiles;
      } else if (process.platform === 'darwin') {
        const [{ stdout: hwOut }, netstatRes] = await Promise.all([
          execFileAsync('networksetup', ['-listallhardwareports'], { timeout: 3000 }),
          execFileAsync('netstat', ['-rn', '-f', 'inet'], { timeout: 3000 }).catch(() => ({
            stdout: '',
          })),
        ]);

        const defaultRouteIfaces = new Map<string, number>();
        let order = 0;
        for (const line of netstatRes.stdout.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('default')) continue;
          const cols = trimmed.split(/\s+/);
          const iface = cols[cols.length - 1];
          if (iface && !defaultRouteIfaces.has(iface)) {
            defaultRouteIfaces.set(iface, order * 10);
            order += 1;
          }
        }
        routingTableKnown = defaultRouteIfaces.size > 0;
        internetProfileKnown = false;

        enrichmentByNormName.clear();
        enrichmentByMac.clear();
        const blocks = hwOut.split(/\n\s*\n/);
        for (const block of blocks) {
          const portMatch = block.match(/Hardware Port:\s*(.+)/i);
          const devMatch = block.match(/Device:\s*(\S+)/i);
          const macMatch = block.match(/Ethernet Address:\s*([0-9a-f:]+)/i);
          if (portMatch && devMatch) {
            const dev = devMatch[1].trim();
            const port = portMatch[1].trim();
            const mac = normalizeMac(macMatch?.[1]);
            const routeMetric = defaultRouteIfaces.get(dev);
            const isWifiPort = /wi-?fi|airport/i.test(port);
            const patch: OsEnrichmentEntry = {
              hardwarePort: port,
              description: port,
              mac: mac || undefined,
              isWlanAdapter: isWifiPort || undefined,
              hasDefaultRoute: routeMetric !== undefined,
              routeMetric,
            };
            mergeEnrichmentEntry(enrichmentByNormName, normalizeAdapterName(dev), patch);
            if (mac) {
              mergeEnrichmentEntry(enrichmentByMac, mac, patch);
            }
          }
        }
      } else if (process.platform === 'linux') {
        const linuxRoutes = readLinuxDefaultRoutes();
        routingTableKnown = linuxRoutes.size > 0;
        internetProfileKnown = false;
        enrichmentByNormName.clear();
        enrichmentByMac.clear();
        for (const [iface, metric] of linuxRoutes.entries()) {
          mergeEnrichmentEntry(enrichmentByNormName, normalizeAdapterName(iface), {
            hasDefaultRoute: true,
            routeMetric: metric,
          });
        }
      }
      lastEnrichmentAt = Date.now();
      lastDetectAt = 0;
    } catch {
      lastEnrichmentAt = Date.now();
    } finally {
      enrichmentInFlight = null;
    }
  })();

  return enrichmentInFlight;
}

function classifyInterface(
  osName: string,
  meta?: OsEnrichmentEntry
): {
  interfaceType: AdapterInterfaceType;
  displayName: string;
  linkSpeedMbps: number;
  linkSpeedKnown: boolean;
  metered: boolean;
  shade: AdapterShade;
} {
  const linuxMeta = readLinuxInterfaceMeta(osName);
  const desc = [
    osName,
    meta?.hardwarePort || '',
    meta?.description || '',
    meta?.physicalMediaType || '',
    meta?.ndisPhysicalMediumText || '',
    meta?.mediaType || '',
  ].join(' ');

  let interfaceType: AdapterInterfaceType = 'Ethernet';

  // 1. Check USB Cellular / Phone Tethering first (Android RNDIS & iPhone USB emulate 802.3 Ethernet framing)
  if (
    linuxMeta.isUsbTether ||
    meta?.ndisPhysicalMedium === 8 ||
    meta?.ifType === 243 ||
    meta?.ifType === 244 ||
    (meta?.physicalMediaType && /wireless\s*wan|wwan|mobile/i.test(meta.physicalMediaType)) ||
    USB_CELLULAR_HINT_RE.test(desc)
  ) {
    interfaceType = 'Cellular USB';
  }
  // 2. Check Wi-Fi (authoritative netsh wlan, IANA ifType 71, NDIS PhysicalMedium 9/1, Linux /wireless, hardware descriptions)
  else if (
    linuxMeta.isWireless ||
    meta?.isWlanAdapter === true ||
    meta?.isWlanConnected === true ||
    Boolean(meta?.ssid) ||
    meta?.ifType === 71 ||
    meta?.ndisPhysicalMedium === 9 ||
    meta?.ndisPhysicalMedium === 1 ||
    (meta?.ndisPhysicalMediumText && /802\.11|wireless|wi-?fi|wlan/i.test(meta.ndisPhysicalMediumText)) ||
    (meta?.physicalMediaType && /802\.11|wireless|wi-?fi|wlan/i.test(meta.physicalMediaType)) ||
    (meta?.mediaType && /802\.11|wireless|wi-?fi|wlan/i.test(meta.mediaType)) ||
    WIFI_HINT_RE.test(desc)
  ) {
    interfaceType = 'Wi-Fi';
  }
  // 3. Check Virtual
  else if (isLikelyVirtualInterface(osName, meta)) {
    interfaceType = 'Virtual';
  }
  // 4. Check Ethernet (or macOS en0 default Wi-Fi fallback)
  else if (process.platform === 'darwin' && osName === 'en0' && !ETHERNET_HINT_RE.test(desc)) {
    interfaceType = 'Wi-Fi';
  } else if (
    meta?.ndisPhysicalMedium === 14 ||
    meta?.ifType === 6 ||
    (meta?.physicalMediaType && /802\.3|ethernet/i.test(meta.physicalMediaType)) ||
    ETHERNET_HINT_RE.test(desc)
  ) {
    interfaceType = 'Ethernet';
  }

  let displayName = osName;
  if (interfaceType === 'Wi-Fi') {
    displayName = meta?.ssid ? `Wi-Fi (${meta.ssid})` : 'Wi-Fi';
  } else if (interfaceType === 'Cellular USB') {
    displayName = 'USB Cellular';
  } else if (interfaceType === 'Ethernet') {
    displayName = process.platform === 'linux' ? `Ethernet (${osName})` : 'Ethernet';
  } else if (meta?.hardwarePort) {
    displayName = meta.hardwarePort;
  }

  const rawSpeed = meta?.linkSpeedMbps || linuxMeta.speedMbps || 0;
  const linkSpeedKnown = rawSpeed > 0;
  const linkSpeedMbps = linkSpeedKnown
    ? rawSpeed
    : interfaceType === 'Ethernet'
    ? 1000
    : interfaceType === 'Wi-Fi'
    ? 300
    : interfaceType === 'Cellular USB'
    ? 150
    : 100;

  const shade: AdapterShade =
    interfaceType === 'Wi-Fi'
      ? 'solid'
      : interfaceType === 'Ethernet'
      ? 'mid'
      : interfaceType === 'Cellular USB'
      ? 'soft'
      : 'stripe';

  return {
    interfaceType,
    displayName,
    linkSpeedMbps,
    linkSpeedKnown,
    metered: interfaceType === 'Cellular USB',
    shade,
  };
}

function getOrCreateTrafficState(id: string): AdapterTrafficState {
  let st = trafficByAdapter.get(id);
  if (!st) {
    st = {
      samples: [],
      firstByteAt: null,
      smoothedBytesPerSec: 0,
      totalBytes: 0,
      historyMbps: Array(HISTORY_LEN).fill(0),
      lastHistoryPushAt: 0,
      bindFailedUntil: 0,
    };
    trafficByAdapter.set(id, st);
  }
  return st;
}

function computeAdapterLiveSpeedBytesPerSec(st: AdapterTrafficState, now: number): number {
  const cutoff = now - SPEED_WINDOW_MS;
  while (st.samples.length > 0 && st.samples[0].ts < cutoff) {
    st.samples.shift();
  }
  if (st.samples.length === 0) {
    st.smoothedBytesPerSec = 0;
    st.firstByteAt = null;
    return 0;
  }

  const windowBytes = st.samples.reduce((sum, s) => sum + s.bytes, 0);
  const sinceStartSec = st.firstByteAt ? (now - st.firstByteAt) / 1000 : SPEED_WINDOW_MS / 1000;
  const effectiveWindowSec = Math.min(SPEED_WINDOW_MS / 1000, Math.max(1.0, sinceStartSec));
  const instantBytesPerSec = windowBytes / effectiveWindowSec;

  if (st.smoothedBytesPerSec <= 0) {
    st.smoothedBytesPerSec = instantBytesPerSec;
  } else {
    st.smoothedBytesPerSec = st.smoothedBytesPerSec * 0.5 + instantBytesPerSec * 0.5;
  }
  return st.smoothedBytesPerSec;
}

export function detectConnectedInterfaces(force = false): DetectedOsInterface[] {
  const now = Date.now();
  if (!force && cachedInterfaces.length > 0 && now - lastDetectAt < 1500) {
    return cachedInterfaces;
  }
  lastDetectAt = now;

  // In remote cloud preview (e.g. Cloud Run container), the server's container NIC (eth1 / 169.254.x.x)
  // is a cloud sandbox interface and NOT the user's local Ethernet cable. Reflect the user's browser connection.
  if (isCloudHostedEnvironment()) {
    if (!clientBrowserHint.online) {
      cachedInterfaces = [];
      return [];
    }
    const targetSlot =
      CANONICAL_SLOTS.find((s) => s.slotKey === clientBrowserHint.slot) || CANONICAL_SLOTS[0];
    getOrCreateTrafficState(targetSlot.id);
    const downlinkKnown = clientBrowserHint.downlinkMbps > 0;
    const mappedCloud: DetectedOsInterface[] = [
      {
        id: targetSlot.id,
        osName: targetSlot.slotKey === 'wifi' ? 'Wi-Fi' : targetSlot.slotKey === 'ethernet' ? 'Ethernet' : 'USB',
        displayName: targetSlot.label,
        ipAddress: '',
        mac: '',
        interfaceType: targetSlot.interfaceType,
        linkSpeedMbps: downlinkKnown
          ? clientBrowserHint.downlinkMbps
          : targetSlot.interfaceType === 'Ethernet'
          ? 1000
          : targetSlot.interfaceType === 'Wi-Fi'
          ? 300
          : 150,
        linkSpeedKnown: downlinkKnown,
        metered: targetSlot.metered,
        shade: targetSlot.shade,
        routeMetric: 10,
        hasDefaultRoute: true,
        hasInternetConnectivity: true,
      },
    ];
    cachedInterfaces = mappedCloud;
    return mappedCloud;
  }

  // On Linux desktop/local, /proc/net/route is instant to read synchronously so keep route table fresh
  if (process.platform === 'linux') {
    const linuxRoutes = readLinuxDefaultRoutes();
    if (linuxRoutes.size > 0) {
      routingTableKnown = true;
      for (const [iface, metric] of linuxRoutes.entries()) {
        mergeEnrichmentEntry(enrichmentByNormName, normalizeAdapterName(iface), {
          hasDefaultRoute: true,
          routeMetric: metric,
        });
      }
    }
  }

  const raw = os.networkInterfaces();
  const candidates: Array<{
    osName: string;
    ipAddress: string;
    mac: string;
    isPointToPoint169: boolean;
  }> = [];

  for (const [osName, entries] of Object.entries(raw)) {
    if (!entries || entries.length === 0) continue;
    if (process.platform === 'linux') {
      const linuxMeta = readLinuxInterfaceMeta(osName);
      if (linuxMeta.operUp === false) continue;
    }

    const ipv4 = entries.find(
      (entry) =>
        !entry.internal &&
        (entry.family === 'IPv4' || (entry.family as unknown) === 4) &&
        !isInvalidOrApipaIpv4(entry.address, entry.netmask)
    );
    const ipv6 = !ipv4
      ? entries.find(
          (entry) =>
            !entry.internal &&
            (entry.family === 'IPv6' || (entry.family as unknown) === 6) &&
            isUsableGlobalIpv6(entry.address)
        )
      : undefined;

    const chosenAddr = ipv4 || ipv6;
    if (!chosenAddr) continue;

    candidates.push({
      osName,
      ipAddress: chosenAddr.address,
      mac: chosenAddr.mac || '',
      isPointToPoint169: chosenAddr.address.startsWith('169.254.'),
    });
  }

  const fingerprint = candidates
    .map((c) => `${c.osName}:${c.ipAddress}`)
    .sort()
    .join('|');

  if (fingerprint !== lastOsFingerprint) {
    lastOsFingerprint = fingerprint;
    void refreshOsEnrichment(true);
  } else if (now - lastEnrichmentAt > 20_000) {
    void refreshOsEnrichment(false);
  }

  // Prefer real non-169.254 physical/tethered adapters (standard desktop Wi-Fi/Ethernet/USB)
  const regular = candidates.filter((c) => !c.isPointToPoint169);
  const pool = regular.length > 0 ? regular : candidates;

  // Exclude virtual/VPN/Bluetooth/hypervisor adapters & explicitly disconnected WLAN adapters
  let chosen = pool.filter((c) => {
    const meta = lookupEnrichment(c.osName, c.mac, c.ipAddress);
    if (isLikelyVirtualInterface(c.osName, meta)) return false;
    if (meta?.isWlanAdapter && meta.isWlanConnected === false) return false;
    return true;
  });

  // On Windows, if Get-NetConnectionProfile reported explicit Internet connectivity, prefer those interfaces
  if (internetProfileKnown) {
    const withInternet = chosen.filter(
      (c) => lookupEnrichment(c.osName, c.mac, c.ipAddress)?.hasInternetConnectivity === true
    );
    if (withInternet.length > 0) {
      chosen = withInternet;
    }
  }

  // If the OS routing table is known, keep ONLY interfaces with a real default internet route (0.0.0.0/0 or ::/0)
  // so disconnected/LAN-only/static-IP Ethernet ports never falsely appear as active internet connections!
  if (routingTableKnown) {
    const withDefaultRoute = chosen.filter(
      (c) => lookupEnrichment(c.osName, c.mac, c.ipAddress)?.hasDefaultRoute === true
    );
    if (withDefaultRoute.length > 0) {
      chosen = withDefaultRoute;
    }
  }

  if (chosen.length === 0) {
    // Fallback if all interfaces are virtual (e.g. full-tunnel VPN or container)
    const fallbackRouted = routingTableKnown
      ? pool.filter((c) => lookupEnrichment(c.osName, c.mac, c.ipAddress)?.hasDefaultRoute === true)
      : [];
    chosen = fallbackRouted.length > 0 ? fallbackRouted : pool;
  }

  // Map candidates and assign canonical slot IDs for the primary Wi-Fi / Ethernet / Cellular USB links
  const usedSlotIds = new Set<string>();
  const rawMapped = chosen.map((c) => {
    const meta = lookupEnrichment(c.osName, c.mac, c.ipAddress);
    const classified = classifyInterface(c.osName, meta);
    const routeMetric = meta?.routeMetric ?? 500;
    const hasDefaultRoute = meta?.hasDefaultRoute ?? !routingTableKnown;
    const hasInternetConnectivity = meta?.hasInternetConnectivity;
    return { c, meta, classified, routeMetric, hasDefaultRoute, hasInternetConnectivity };
  });

  // Sort by Windows NCSI internet status, then default route, then OS route metric (lowest = active primary)
  rawMapped.sort((a, b) => {
    if (Boolean(a.hasInternetConnectivity) !== Boolean(b.hasInternetConnectivity)) {
      return a.hasInternetConnectivity ? -1 : 1;
    }
    if (a.hasDefaultRoute !== b.hasDefaultRoute) return a.hasDefaultRoute ? -1 : 1;
    if (a.routeMetric !== b.routeMetric) return a.routeMetric - b.routeMetric;
    return a.classified.displayName.localeCompare(b.classified.displayName);
  });

  const mapped: DetectedOsInterface[] = rawMapped.map(
    ({ c, meta, classified, routeMetric, hasDefaultRoute, hasInternetConnectivity }) => {
      const canonical = CANONICAL_SLOTS.find((s) => s.interfaceType === classified.interfaceType);
      let id: string;
      if (canonical && !usedSlotIds.has(canonical.id)) {
        id = canonical.id;
        usedSlotIds.add(canonical.id);
      } else {
        id = slugifyAdapterId(c.osName);
      }
      getOrCreateTrafficState(id);
      return {
        id,
        osName: c.osName,
        displayName: classified.displayName,
        ipAddress: c.ipAddress,
        ssid: meta?.ssid,
        mac: c.mac,
        interfaceType: classified.interfaceType,
        linkSpeedMbps: classified.linkSpeedMbps,
        linkSpeedKnown: classified.linkSpeedKnown,
        metered: classified.metered,
        shade: classified.shade,
        routeMetric,
        hasDefaultRoute,
        hasInternetConnectivity,
      };
    }
  );

  cachedInterfaces = mapped;
  return mapped;
}

export async function rescanNetworkAdapters(): Promise<LiveNetworkAdapterDto[]> {
  await refreshOsEnrichment(true);
  detectConnectedInterfaces(true);
  return getLiveNetworkSnapshot();
}

export async function getLiveNetworkSnapshotAsync(): Promise<LiveNetworkAdapterDto[]> {
  if (lastEnrichmentAt === 0 && !isCloudHostedEnvironment()) {
    await Promise.race([
      refreshOsEnrichment(true),
      new Promise<void>((resolve) => setTimeout(resolve, 4500)),
    ]);
    detectConnectedInterfaces(true);
  }
  return getLiveNetworkSnapshot();
}

export function isAdapterEnabled(id: string): boolean {
  const override = enabledOverrides.get(id);
  return override !== undefined ? override : true;
}

export function setNetworkAdapterEnabled(id: string, enabled: boolean): LiveNetworkAdapterDto[] {
  enabledOverrides.set(id, enabled);
  if (!enabled) {
    const st = trafficByAdapter.get(id);
    if (st) {
      st.samples = [];
      st.smoothedBytesPerSec = 0;
      st.firstByteAt = null;
    }
  }
  return getLiveNetworkSnapshot();
}

export function toggleNetworkAdapter(id: string): LiveNetworkAdapterDto[] {
  const connected = detectConnectedInterfaces();
  const isConnected = connected.some((iface) => iface.id === id);
  if (!isConnected) {
    // Disconnected operators cannot be toggled on until physically connected
    return getLiveNetworkSnapshot();
  }
  const current = isAdapterEnabled(id);
  return setNetworkAdapterEnabled(id, !current);
}

export function getEnabledAdaptersForTransfer(): DetectedOsInterface[] {
  const all = detectConnectedInterfaces();
  const now = Date.now();
  const enabled = all.filter((iface) => isAdapterEnabled(iface.id));
  const healthy = enabled.filter((iface) => {
    const st = trafficByAdapter.get(iface.id);
    return !st || st.bindFailedUntil <= now;
  });
  if (healthy.length > 0) return healthy;
  if (enabled.length > 0) return enabled;
  return all;
}

export function getPrimaryEnabledAdapter(): DetectedOsInterface | null {
  const enabled = getEnabledAdaptersForTransfer();
  return enabled[0] || null;
}

export function markAdapterBindFailed(adapterId: string): void {
  const st = getOrCreateTrafficState(adapterId);
  st.bindFailedUntil = Date.now() + BIND_FAILURE_COOLDOWN_MS;
}

export function recordAdapterNetworkBytes(adapterId: string | null | undefined, bytes: number): void {
  if (bytes <= 0) return;
  let targetId = adapterId;
  if (!targetId) {
    targetId = getPrimaryEnabledAdapter()?.id;
  }
  if (!targetId) return;

  const now = Date.now();
  const st = getOrCreateTrafficState(targetId);
  if (st.firstByteAt === null) {
    st.firstByteAt = now;
  }
  st.totalBytes += bytes;
  st.samples.push({ ts: now, bytes });
  computeAdapterLiveSpeedBytesPerSec(st, now);
}

export function getLiveNetworkSnapshot(): LiveNetworkAdapterDto[] {
  const connectedInterfaces = detectConnectedInterfaces();
  const connectedById = new Map(connectedInterfaces.map((iface) => [iface.id, iface]));
  const now = Date.now();

  const buildConnectedDto = (iface: DetectedOsInterface): LiveNetworkAdapterDto => {
    const enabled = isAdapterEnabled(iface.id);
    const st = getOrCreateTrafficState(iface.id);
    const liveBytesPerSec = enabled ? computeAdapterLiveSpeedBytesPerSec(st, now) : 0;
    const liveMbps = (liveBytesPerSec * 8) / (1024 * 1024);

    if (now - st.lastHistoryPushAt >= 1000) {
      st.historyMbps = [...st.historyMbps.slice(1), Number(liveMbps.toFixed(2))];
      st.lastHistoryPushAt = now;
    }

    return {
      id: iface.id,
      deviceCode: iface.osName,
      name: iface.displayName,
      ipAddress: iface.ipAddress,
      ssid: iface.ssid,
      interfaceType: iface.interfaceType,
      connected: true,
      enabled,
      maxCapacityMbps: iface.linkSpeedMbps,
      linkSpeedKnown: iface.linkSpeedKnown,
      currentSpeedBytesPerSec: liveBytesPerSec,
      currentSpeedMbps: liveMbps,
      usedDataGb: st.totalBytes / (1024 * 1024 * 1024),
      metered: iface.metered,
      shade: iface.shade,
      historyMbps: st.historyMbps,
    };
  };

  // Always return the 3 canonical network operator slots in stable order: Wi-Fi, Ethernet, USB Cellular
  const result: LiveNetworkAdapterDto[] = CANONICAL_SLOTS.map((slot) => {
    const live = connectedById.get(slot.id);
    if (live) {
      return buildConnectedDto(live);
    }

    // Disconnected slot: zero live speed, zero animation, clearly marked not connected
    const st = trafficByAdapter.get(slot.id);
    if (st) {
      st.samples = [];
      st.smoothedBytesPerSec = 0;
      st.firstByteAt = null;
    }
    return {
      id: slot.id,
      deviceCode: '',
      name: slot.label,
      ipAddress: '',
      interfaceType: slot.interfaceType,
      connected: false,
      enabled: false,
      maxCapacityMbps: 0,
      linkSpeedKnown: false,
      currentSpeedBytesPerSec: 0,
      currentSpeedMbps: 0,
      usedDataGb: st ? st.totalBytes / (1024 * 1024 * 1024) : 0,
      metered: slot.metered,
      shade: slot.shade,
      historyMbps: Array(HISTORY_LEN).fill(0),
    };
  });

  // Append any additional physically connected interfaces (e.g. a 2nd Ethernet or 2nd USB tether)
  for (const iface of connectedInterfaces) {
    if (!CANONICAL_SLOTS.some((s) => s.id === iface.id)) {
      result.push(buildConnectedDto(iface));
    }
  }

  return result;
}

// Kick off initial background enrichment on server boot
void refreshOsEnrichment(true);
