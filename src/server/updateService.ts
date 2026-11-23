import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ReleaseAssetDto {
  name: string;
  downloadUrl: string;
  sizeBytes: number;
}

export interface UpdateCheckResultDto {
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
  supportsInAppUpdate: boolean;
  platform: string;
  arch: string;
  inAppUpdateAsset: ReleaseAssetDto | null;
  recommendedAsset: ReleaseAssetDto | null;
  allAssets: ReleaseAssetDto[];
  checkedAt: number;
  error: string | null;
}

export interface UpdateDownloadStatusDto {
  state: 'idle' | 'downloading' | 'extracting' | 'ready' | 'installing' | 'error';
  mode?: 'in-app' | 'silent-installer' | 'manual';
  stageLabel?: string | null;
  version: string | null;
  filename: string | null;
  downloadedBytes: number;
  totalBytes: number;
  percent: number;
  error: string | null;
}

const DEFAULT_GITHUB_REPO = 'umerdraz8296-cyber/MochiDrop';
const VALID_REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const ALLOWED_GITHUB_DOWNLOAD_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
]);

const CHECK_CACHE_MS = 60 * 1000; // 60 seconds for background checks (ETag 304 costs 0 GitHub quota)
const MAX_TAR_UNCOMPRESSED_BYTES = 60 * 1024 * 1024; // 60 MB decompression cap
const UPDATES_BASE_DIR = path.resolve(
  process.env.MOCHIDROP_DATA_DIR
    ? path.join(process.env.MOCHIDROP_DATA_DIR, '.updates')
    : path.join(os.tmpdir(), 'mochidrop-updates')
);

let cachedCheck: UpdateCheckResultDto | null = null;
let cachedEtag: string | null = null;
let checkInFlight: Promise<UpdateCheckResultDto> | null = null;

let downloadState: UpdateDownloadStatusDto = {
  state: 'idle',
  mode: 'in-app',
  stageLabel: null,
  version: null,
  filename: null,
  downloadedBytes: 0,
  totalBytes: 0,
  percent: 0,
  error: null,
};
let readyUpdateFilePath: string | null = null;
let readyUpdateIsInAppBundle = false;
let activeDownloadAbort: AbortController | null = null;

function readPackageJsonMeta(): { version: string; repo: string; depsHash: string } {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    path.resolve(process.cwd(), 'package.json'),
    path.resolve(__dirname, '../../package.json'),
    path.resolve(__dirname, '../package.json'),
    ...(resourcesPath ? [path.resolve(resourcesPath, 'app', 'package.json')] : []),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const pkg = JSON.parse(fs.readFileSync(p, 'utf8')) as {
        version?: string;
        mochidropRepo?: string;
        mochidropDepsHash?: string;
        repository?: string | { url?: string };
      };
      const ver = typeof pkg.version === 'string' && pkg.version.trim() ? pkg.version.trim() : '1.0.0';
      const depsHash = typeof pkg.mochidropDepsHash === 'string' ? pkg.mochidropDepsHash.trim() : '';
      let repo = '';
      if (typeof pkg.mochidropRepo === 'string' && VALID_REPO_RE.test(pkg.mochidropRepo.trim())) {
        repo = pkg.mochidropRepo.trim();
      } else if (typeof pkg.repository === 'string') {
        const m = pkg.repository.match(/github\.com[/:]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/i);
        if (m && VALID_REPO_RE.test(m[1])) repo = m[1];
      } else if (pkg.repository && typeof pkg.repository.url === 'string') {
        const m = pkg.repository.url.match(/github\.com[/:]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/i);
        if (m && VALID_REPO_RE.test(m[1])) repo = m[1];
      }
      return { version: ver, repo: repo || DEFAULT_GITHUB_REPO, depsHash };
    } catch {
      // try next path
    }
  }
  return { version: '1.0.0', repo: DEFAULT_GITHUB_REPO, depsHash: '' };
}

export function getAppUpdateConfig(): {
  currentVersion: string;
  repo: string;
  isDesktopApp: boolean;
  supportsLiveHotUpdate: boolean;
  liveUpdateDir: string;
  appRoot: string;
  depsHash: string;
  platform: string;
  arch: string;
} {
  const pkgMeta = readPackageJsonMeta();
  const envVer = process.env.MOCHIDROP_APP_VERSION?.trim();
  const envRepo = process.env.MOCHIDROP_GITHUB_REPO?.trim();
  const liveUpdateDir = process.env.MOCHIDROP_LIVE_UPDATE_DIR?.trim() || '';
  const appRoot = process.env.MOCHIDROP_APP_ROOT?.trim() || '';
  const depsHash = process.env.MOCHIDROP_DEPS_HASH?.trim() || pkgMeta.depsHash;
  const repo = envRepo && VALID_REPO_RE.test(envRepo) ? envRepo : pkgMeta.repo;
  const currentVersion = normalizeVersion(envVer || pkgMeta.version || '1.0.0');
  const isDesktopApp = process.env.MOCHIDROP_IS_DESKTOP === '1';
  return {
    currentVersion,
    repo,
    isDesktopApp,
    supportsLiveHotUpdate: isDesktopApp && Boolean(liveUpdateDir) && Boolean(appRoot),
    liveUpdateDir,
    appRoot,
    depsHash,
    platform: process.env.MOCHIDROP_PLATFORM || process.platform,
    arch: process.env.MOCHIDROP_ARCH || process.arch,
  };
}

export function normalizeVersion(raw: string): string {
  return raw.trim().replace(/^v/i, '');
}

export function compareSemver(aRaw: string, bRaw: string): number {
  const parse = (v: string): { nums: number[]; pre: string } => {
    const clean = normalizeVersion(v);
    const [core, ...preParts] = clean.split('-');
    const nums = core
      .split('.')
      .map((part) => {
        const m = part.match(/^(\d+)/);
        return m ? Number(m[1]) : 0;
      });
    while (nums.length < 3) nums.push(0);
    return { nums, pre: preParts.join('-') };
  };

  const a = parse(aRaw);
  const b = parse(bRaw);
  const maxLen = Math.max(a.nums.length, b.nums.length);
  for (let i = 0; i < maxLen; i += 1) {
    const av = a.nums[i] ?? 0;
    const bv = b.nums[i] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  if (!a.pre && b.pre) return 1;
  if (a.pre && !b.pre) return -1;
  if (a.pre !== b.pre) return a.pre.localeCompare(b.pre);
  return 0;
}

function isAllowedGithubDownloadUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return ALLOWED_GITHUB_DOWNLOAD_HOSTS.has(host) || host.endsWith('.githubusercontent.com');
  } catch {
    return false;
  }
}

function pickInAppBundleAsset(assets: ReleaseAssetDto[]): ReleaseAssetDto | null {
  return assets.find((a) => /-update\.tar\.gz$/i.test(a.name)) || null;
}

function pickRecommendedAsset(
  assets: ReleaseAssetDto[],
  platform: string,
  arch: string
): ReleaseAssetDto | null {
  const installers = assets.filter((a) => !/-update\.tar\.gz$/i.test(a.name));
  const pool = installers.length > 0 ? installers : assets;
  if (pool.length === 0) return null;

  if (platform === 'win32') {
    return (
      pool.find((a) => /setup\.exe$/i.test(a.name)) ||
      pool.find((a) => /portable\.exe$/i.test(a.name)) ||
      pool.find((a) => /\.exe$/i.test(a.name)) ||
      pool[0]
    );
  }

  if (platform === 'darwin') {
    const archRe = arch === 'arm64' ? /arm64\.dmg$/i : /x64\.dmg$/i;
    return (
      pool.find((a) => archRe.test(a.name)) ||
      pool.find((a) => /\.dmg$/i.test(a.name)) ||
      pool[0]
    );
  }

  // Linux
  return (
    pool.find((a) => /\.appimage$/i.test(a.name)) ||
    pool.find((a) => /\.deb$/i.test(a.name)) ||
    pool[0]
  );
}

/**
 * Rate-limit-free fallback: GitHub's /releases/latest web URL redirects via 302 to /releases/tag/vX.Y.Z
 * without consuming GitHub REST API quota.
 */
async function checkGithubLatestViaRedirect(
  cfg: ReturnType<typeof getAppUpdateConfig>
): Promise<UpdateCheckResultDto | null> {
  try {
    const res = await fetch(`https://github.com/${cfg.repo}/releases/latest`, {
      redirect: 'manual',
      headers: {
        'User-Agent': `MochiDrop/${cfg.currentVersion}`,
      },
      signal: AbortSignal.timeout(6000),
    });
    const loc = res.headers.get('location') || '';
    const m = loc.match(/\/releases\/tag\/([^/?#]+)/i);
    if (!m) return null;

    const releaseTag = decodeURIComponent(m[1]).trim();
    const latestVersion = normalizeVersion(releaseTag);
    if (!latestVersion) return null;

    const baseDl = `https://github.com/${cfg.repo}/releases/download/${encodeURIComponent(releaseTag)}`;
    const inferredAssets: ReleaseAssetDto[] = [
      {
        name: `MochiDrop-${latestVersion}-update.tar.gz`,
        downloadUrl: `${baseDl}/MochiDrop-${latestVersion}-update.tar.gz`,
        sizeBytes: 0,
      },
      {
        name: `MochiDrop-${latestVersion}-Setup.exe`,
        downloadUrl: `${baseDl}/MochiDrop-${latestVersion}-Setup.exe`,
        sizeBytes: 0,
      },
      {
        name: `MochiDrop-${latestVersion}-Portable.exe`,
        downloadUrl: `${baseDl}/MochiDrop-${latestVersion}-Portable.exe`,
        sizeBytes: 0,
      },
      {
        name: `MochiDrop-${latestVersion}-arm64.dmg`,
        downloadUrl: `${baseDl}/MochiDrop-${latestVersion}-arm64.dmg`,
        sizeBytes: 0,
      },
      {
        name: `MochiDrop-${latestVersion}-x64.dmg`,
        downloadUrl: `${baseDl}/MochiDrop-${latestVersion}-x64.dmg`,
        sizeBytes: 0,
      },
      {
        name: `MochiDrop-${latestVersion}.AppImage`,
        downloadUrl: `${baseDl}/MochiDrop-${latestVersion}.AppImage`,
        sizeBytes: 0,
      },
    ];

    const inAppUpdateAsset = pickInAppBundleAsset(inferredAssets);
    const recommendedAsset = pickRecommendedAsset(inferredAssets, cfg.platform, cfg.arch);
    const updateAvailable = compareSemver(latestVersion, cfg.currentVersion) > 0;

    return {
      currentVersion: cfg.currentVersion,
      latestVersion,
      updateAvailable,
      repo: cfg.repo,
      releaseName: `MochiDrop Desktop ${releaseTag}`,
      releaseTag,
      releaseNotes: '',
      publishedAt: null,
      releaseUrl: `https://github.com/${cfg.repo}/releases/tag/${encodeURIComponent(releaseTag)}`,
      isDesktopApp: cfg.isDesktopApp,
      supportsInAppUpdate: cfg.supportsLiveHotUpdate && Boolean(inAppUpdateAsset),
      platform: cfg.platform,
      arch: cfg.arch,
      inAppUpdateAsset,
      recommendedAsset,
      allAssets: inferredAssets,
      checkedAt: Date.now(),
      error: null,
    };
  } catch {
    return null;
  }
}

export async function checkForGithubUpdate(force = false): Promise<UpdateCheckResultDto> {
  const now = Date.now();
  if (!force && cachedCheck && now - cachedCheck.checkedAt < CHECK_CACHE_MS) {
    return cachedCheck;
  }
  if (checkInFlight) return checkInFlight;

  const cfg = getAppUpdateConfig();

  checkInFlight = (async (): Promise<UpdateCheckResultDto> => {
    const fallback: UpdateCheckResultDto = {
      currentVersion: cfg.currentVersion,
      latestVersion: cfg.currentVersion,
      updateAvailable: false,
      repo: cfg.repo,
      releaseName: `MochiDrop v${cfg.currentVersion}`,
      releaseTag: `v${cfg.currentVersion}`,
      releaseNotes: '',
      publishedAt: null,
      releaseUrl: `https://github.com/${cfg.repo}/releases`,
      isDesktopApp: cfg.isDesktopApp,
      supportsInAppUpdate: false,
      platform: cfg.platform,
      arch: cfg.arch,
      inAppUpdateAsset: null,
      recommendedAsset: null,
      allAssets: [],
      checkedAt: Date.now(),
      error: null,
    };

    if (!VALID_REPO_RE.test(cfg.repo)) {
      return { ...fallback, error: 'Invalid GitHub repository configuration.' };
    }

    try {
      const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        'User-Agent': `MochiDrop/${cfg.currentVersion}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Cache-Control': 'no-cache',
      };
      if (cachedEtag && cachedCheck) {
        headers['If-None-Match'] = cachedEtag;
      }
      const token = process.env.GITHUB_TOKEN?.trim();
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const apiUrl = `https://api.github.com/repos/${cfg.repo}/releases/latest`;
      const res = await fetch(apiUrl, {
        headers,
        signal: AbortSignal.timeout(8000),
      });

      // 304 Not Modified: GitHub confirmed latest release hasn't changed (costs 0 API rate limit!)
      if (res.status === 304 && cachedCheck) {
        cachedCheck = {
          ...cachedCheck,
          currentVersion: cfg.currentVersion,
          updateAvailable:
            Boolean(cachedCheck.latestVersion) &&
            compareSemver(cachedCheck.latestVersion, cfg.currentVersion) > 0,
          supportsInAppUpdate: cfg.supportsLiveHotUpdate && Boolean(cachedCheck.inAppUpdateAsset),
          checkedAt: Date.now(),
          error: null,
        };
        return cachedCheck;
      }

      if (res.status === 404) {
        cachedCheck = {
          ...fallback,
          checkedAt: Date.now(),
          error: null,
        };
        return cachedCheck;
      }

      if (res.status === 403 || res.status === 429) {
        const redirectResult = await checkGithubLatestViaRedirect(cfg);
        if (redirectResult) {
          cachedCheck = redirectResult;
          return redirectResult;
        }
      }

      if (!res.ok) {
        return {
          ...fallback,
          checkedAt: Date.now(),
          error: `GitHub Releases check returned HTTP ${res.status}.`,
        };
      }

      const newEtag = res.headers.get('etag');
      if (newEtag) {
        cachedEtag = newEtag;
      }

      const data = (await res.json()) as {
        tag_name?: string;
        name?: string;
        body?: string;
        html_url?: string;
        published_at?: string;
        assets?: Array<{
          name?: string;
          browser_download_url?: string;
          size?: number;
        }>;
      };

      const releaseTag = typeof data.tag_name === 'string' ? data.tag_name.trim() : '';
      const latestVersion = releaseTag ? normalizeVersion(releaseTag) : cfg.currentVersion;
      const releaseUrl =
        typeof data.html_url === 'string' && /^https:\/\/github\.com\//i.test(data.html_url)
          ? data.html_url
          : `https://github.com/${cfg.repo}/releases`;

      const allAssets: ReleaseAssetDto[] = (Array.isArray(data.assets) ? data.assets : [])
        .filter(
          (a): a is { name: string; browser_download_url: string; size?: number } =>
            typeof a?.name === 'string' &&
            typeof a?.browser_download_url === 'string' &&
            isAllowedGithubDownloadUrl(a.browser_download_url)
        )
        .map((a) => ({
          name: a.name.trim(),
          downloadUrl: a.browser_download_url.trim(),
          sizeBytes: typeof a.size === 'number' && Number.isFinite(a.size) ? a.size : 0,
        }));

      const inAppUpdateAsset = pickInAppBundleAsset(allAssets);
      const recommendedAsset = pickRecommendedAsset(allAssets, cfg.platform, cfg.arch);
      const updateAvailable =
        Boolean(latestVersion) && compareSemver(latestVersion, cfg.currentVersion) > 0;

      const result: UpdateCheckResultDto = {
        currentVersion: cfg.currentVersion,
        latestVersion,
        updateAvailable,
        repo: cfg.repo,
        releaseName:
          typeof data.name === 'string' && data.name.trim()
            ? data.name.trim()
            : `MochiDrop ${releaseTag || `v${latestVersion}`}`,
        releaseTag: releaseTag || `v${latestVersion}`,
        releaseNotes: typeof data.body === 'string' ? data.body.slice(0, 4000) : '',
        publishedAt: typeof data.published_at === 'string' ? data.published_at : null,
        releaseUrl,
        isDesktopApp: cfg.isDesktopApp,
        supportsInAppUpdate: cfg.supportsLiveHotUpdate && Boolean(inAppUpdateAsset),
        platform: cfg.platform,
        arch: cfg.arch,
        inAppUpdateAsset,
        recommendedAsset,
        allAssets,
        checkedAt: Date.now(),
        error: null,
      };

      cachedCheck = result;
      return result;
    } catch (err) {
      const redirectResult = await checkGithubLatestViaRedirect(cfg);
      if (redirectResult) {
        cachedCheck = redirectResult;
        return redirectResult;
      }
      return {
        ...fallback,
        checkedAt: Date.now(),
        error: err instanceof Error ? err.message : 'Could not reach GitHub Releases.',
      };
    } finally {
      checkInFlight = null;
    }
  })();

  return checkInFlight;
}

export function getUpdateDownloadStatus(): UpdateDownloadStatusDto {
  return { ...downloadState };
}

function sanitizeInstallerFilename(rawName: string): string {
  const base = path.basename(rawName).replace(/[^a-zA-Z0-9._-]+/g, '_');
  return base.slice(0, 120) || 'MochiDrop-Update.bin';
}

function resolveConfinedUpdatePath(filename: string): string {
  const safeName = sanitizeInstallerFilename(filename);
  const resolved = path.resolve(UPDATES_BASE_DIR, safeName);
  if (!resolved.startsWith(UPDATES_BASE_DIR + path.sep)) {
    throw new Error('Invalid update file path.');
  }
  return resolved;
}

function readTarString(buf: Buffer, offset: number, len: number): string {
  const slice = buf.subarray(offset, offset + len);
  const nul = slice.indexOf(0);
  return (nul >= 0 ? slice.subarray(0, nul) : slice).toString('utf8');
}

function isAllowedInAppArchivePath(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (!norm || norm.includes('..') || norm.includes('\0')) return false;
  return norm === 'package.json' || norm === 'dist' || norm.startsWith('dist/');
}

/**
 * Pure-Node, zero-dependency safe .tar.gz extractor with strict path confinement,
 * symlink/hardlink rejection, allowlisted paths (dist/ + package.json), and max size cap.
 */
export function extractSafeInAppTarGz(tarGzPath: string, stagingDir: string): void {
  const compressed = fs.readFileSync(tarGzPath);
  const tarBuf = zlib.gunzipSync(compressed, { maxOutputLength: MAX_TAR_UNCOMPRESSED_BYTES });

  const resolvedStaging = path.resolve(stagingDir);
  fs.rmSync(resolvedStaging, { recursive: true, force: true });
  fs.mkdirSync(resolvedStaging, { recursive: true });

  let offset = 0;
  let pendingLongName: string | null = null;
  let extractedFiles = 0;

  while (offset + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + 512);
    offset += 512;

    // Two consecutive zero blocks mark end of tar archive
    let allZero = true;
    for (let i = 0; i < 512; i += 1) {
      if (header[i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) break;

    const namePart = readTarString(header, 0, 100);
    const prefixPart = readTarString(header, 345, 155);
    const sizeOctal = readTarString(header, 124, 12).trim();
    const size = sizeOctal ? parseInt(sizeOctal, 8) : 0;
    const typeFlag = String.fromCharCode(header[156] || 0);

    if (!Number.isFinite(size) || size < 0 || offset + size > tarBuf.length) {
      throw new Error('Corrupted update archive entry size.');
    }

    const fileData = tarBuf.subarray(offset, offset + size);
    const paddedSize = Math.ceil(size / 512) * 512;
    offset += paddedSize;

    // GNU LongName extension ('L')
    if (typeFlag === 'L') {
      pendingLongName = fileData.toString('utf8').replace(/\0+$/, '');
      continue;
    }

    // Ignore PAX extended headers ('x' / 'g')
    if (typeFlag === 'x' || typeFlag === 'g') {
      continue;
    }

    const rawName = pendingLongName ?? (prefixPart ? `${prefixPart}/${namePart}` : namePart);
    pendingLongName = null;

    const cleanRel = rawName.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (!cleanRel) continue;

    if (!isAllowedInAppArchivePath(cleanRel)) {
      continue;
    }

    const targetPath = path.resolve(resolvedStaging, cleanRel);
    if (!targetPath.startsWith(resolvedStaging + path.sep)) {
      throw new Error('Blocked unsafe path traversal in update archive.');
    }

    if (typeFlag === '5') {
      fs.mkdirSync(targetPath, { recursive: true });
    } else if (typeFlag === '0' || typeFlag === '\0' || typeFlag === '') {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, fileData);
      extractedFiles += 1;
    } else {
      // Reject symlinks, hardlinks, FIFOs, devices
      continue;
    }
  }

  if (extractedFiles === 0) {
    throw new Error('Update archive did not contain valid MochiDrop files.');
  }
}

async function downloadVerifiedGithubFile(
  url: string,
  tempPath: string,
  userAgent: string,
  controller: AbortController
): Promise<number> {
  let writeStream: fs.WriteStream | null = null;
  try {
    let currentUrl = url;
    let response: Response | null = null;

    for (let hop = 0; hop < 6; hop += 1) {
      if (!isAllowedGithubDownloadUrl(currentUrl)) {
        throw new Error('Blocked redirect to non-GitHub host.');
      }
      const res = await fetch(currentUrl, {
        redirect: 'manual',
        headers: { 'User-Agent': userAgent },
        signal: controller.signal,
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) throw new Error('Update redirect missing Location header.');
        currentUrl = new URL(loc, currentUrl).toString();
        continue;
      }
      response = res;
      break;
    }

    if (!response || !response.ok || !response.body) {
      throw new Error(`Update download failed (HTTP ${response?.status ?? 0}).`);
    }

    const contentLen = Number(response.headers.get('content-length') || 0);
    if (contentLen > 0) {
      downloadState.totalBytes = contentLen;
    }

    writeStream = fs.createWriteStream(tempPath);
    const reader = response.body.getReader();
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        received += value.byteLength;
        downloadState.downloadedBytes = received;
        if (downloadState.totalBytes > 0) {
          downloadState.percent = Math.min(
            99,
            Math.round((received / downloadState.totalBytes) * 100)
          );
        }
        if (!writeStream.write(Buffer.from(value))) {
          await new Promise<void>((resolve, reject) => {
            writeStream!.once('drain', resolve);
            writeStream!.once('error', reject);
          });
        }
      }
    }

    await new Promise<void>((resolve, reject) => {
      writeStream!.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
    writeStream = null;
    return received;
  } catch (err) {
    if (writeStream) {
      try {
        writeStream.destroy();
      } catch {
        // ignore
      }
    }
    throw err;
  }
}

function applyExtractedInAppUpdate(
  tarGzPath: string,
  targetVersion: string,
  cfg: ReturnType<typeof getAppUpdateConfig>
): { compatible: boolean; reason?: string } {
  const liveRoot = path.resolve(cfg.liveUpdateDir);
  const versionsDir = path.resolve(liveRoot, 'versions');
  const safeVersionSlug = normalizeVersion(targetVersion).replace(/[^a-zA-Z0-9._-]+/g, '_') || 'latest';
  const stagingDir = path.resolve(liveRoot, 'staging', `${safeVersionSlug}-${Date.now()}`);
  const finalDir = path.resolve(versionsDir, safeVersionSlug);

  if (
    !stagingDir.startsWith(liveRoot + path.sep) ||
    !finalDir.startsWith(versionsDir + path.sep)
  ) {
    throw new Error('Invalid live-update directory path.');
  }

  fs.mkdirSync(versionsDir, { recursive: true });
  extractSafeInAppTarGz(tarGzPath, stagingDir);

  const serverEntry = path.join(stagingDir, 'dist', 'server.mjs');
  const indexHtml = path.join(stagingDir, 'dist', 'index.html');
  const stagedPkgPath = path.join(stagingDir, 'package.json');

  if (!fs.existsSync(serverEntry) || !fs.existsSync(indexHtml) || !fs.existsSync(stagedPkgPath)) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw new Error('In-app update bundle is incomplete.');
  }

  let stagedDepsHash = '';
  try {
    const stagedPkg = JSON.parse(fs.readFileSync(stagedPkgPath, 'utf8')) as {
      mochidropDepsHash?: string;
    };
    stagedDepsHash = typeof stagedPkg.mochidropDepsHash === 'string' ? stagedPkg.mochidropDepsHash.trim() : '';
  } catch {
    // ignore
  }

  // If npm dependencies changed compared to the installed binary, fall back cleanly to silent installer
  if (cfg.depsHash && stagedDepsHash && cfg.depsHash !== stagedDepsHash) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    return {
      compatible: false,
      reason: 'Native dependencies changed — switching to silent background installer.',
    };
  }

  // Link appRoot/node_modules into the live-update folder via Windows directory junction / POSIX symlink
  const appNodeModules = path.join(cfg.appRoot, 'node_modules');
  const stagedNodeModules = path.join(stagingDir, 'node_modules');
  if (fs.existsSync(appNodeModules) && !fs.existsSync(stagedNodeModules)) {
    fs.symlinkSync(appNodeModules, stagedNodeModules, 'junction');
  }

  // Replace destination version directory atomically
  fs.rmSync(finalDir, { recursive: true, force: true });
  fs.renameSync(stagingDir, finalDir);

  // Write active.json atomically via temp file + rename
  const activeTmp = path.join(liveRoot, 'active.json.tmp');
  const activeFile = path.join(liveRoot, 'active.json');
  fs.writeFileSync(
    activeTmp,
    JSON.stringify(
      {
        version: normalizeVersion(targetVersion),
        dir: finalDir,
        depsHash: stagedDepsHash || cfg.depsHash,
        appliedAt: Date.now(),
      },
      null,
      2
    )
  );
  fs.renameSync(activeTmp, activeFile);

  // Prune older live-update versions to keep disk usage tidy (keep latest 2)
  try {
    const entries = fs
      .readdirSync(versionsDir)
      .filter((name) => name !== safeVersionSlug)
      .map((name) => ({
        name,
        full: path.join(versionsDir, name),
        mtime: fs.statSync(path.join(versionsDir, name)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const stale of entries.slice(1)) {
      fs.rmSync(stale.full, { recursive: true, force: true });
    }
  } catch {
    // non-fatal cleanup
  }

  return { compatible: true };
}

export async function startUpdateDownload(assetName?: string): Promise<UpdateDownloadStatusDto> {
  if (downloadState.state === 'downloading' || downloadState.state === 'extracting') {
    return getUpdateDownloadStatus();
  }

  const cfg = getAppUpdateConfig();
  const latest = await checkForGithubUpdate(false);
  if (!latest.updateAvailable && !latest.recommendedAsset && !latest.inAppUpdateAsset) {
    throw new Error('No update is currently available.');
  }

  // On Desktop, prefer the lightweight ~350 KB in-app hot-update bundle when available
  const explicitAsset = assetName ? latest.allAssets.find((a) => a.name === assetName) : null;
  const preferInApp =
    !explicitAsset && cfg.supportsLiveHotUpdate && Boolean(latest.inAppUpdateAsset);
  const initialAsset = preferInApp
    ? latest.inAppUpdateAsset!
    : explicitAsset || latest.recommendedAsset;

  if (!initialAsset || !isAllowedGithubDownloadUrl(initialAsset.downloadUrl)) {
    throw new Error('No verified GitHub Release update asset found for this platform.');
  }

  fs.mkdirSync(UPDATES_BASE_DIR, { recursive: true });

  if (activeDownloadAbort) {
    activeDownloadAbort.abort();
  }
  const controller = new AbortController();
  activeDownloadAbort = controller;
  readyUpdateFilePath = null;
  readyUpdateIsInAppBundle = false;

  const isInAppBundle = /-update\.tar\.gz$/i.test(initialAsset.name) && cfg.supportsLiveHotUpdate;

  downloadState = {
    state: 'downloading',
    mode: isInAppBundle
      ? 'in-app'
      : cfg.isDesktopApp && process.platform === 'win32'
      ? 'silent-installer'
      : 'manual',
    stageLabel: isInAppBundle
      ? `Downloading in-app update v${latest.latestVersion}...`
      : `Downloading ${initialAsset.name}...`,
    version: latest.latestVersion,
    filename: initialAsset.name,
    downloadedBytes: 0,
    totalBytes: initialAsset.sizeBytes || 0,
    percent: 0,
    error: null,
  };

  void (async () => {
    const runAssetDownload = async (asset: ReleaseAssetDto, asInApp: boolean) => {
      const targetPath = resolveConfinedUpdatePath(asset.name);
      const tempPath = resolveConfinedUpdatePath(`${asset.name}.part`);
      try {
        const received = await downloadVerifiedGithubFile(
          asset.downloadUrl,
          tempPath,
          `MochiDrop/${latest.currentVersion}`,
          controller
        );
        fs.renameSync(tempPath, targetPath);

        if (asInApp) {
          downloadState = {
            ...downloadState,
            state: 'extracting',
            mode: 'in-app',
            stageLabel: 'Extracting & verifying in-app update...',
            downloadedBytes: received,
            totalBytes: downloadState.totalBytes || received,
            percent: 100,
            error: null,
          };

          const applyRes = applyExtractedInAppUpdate(targetPath, latest.latestVersion, cfg);
          if (!applyRes.compatible && latest.recommendedAsset) {
            // Native deps changed — transparently switch to silent background installer
            downloadState = {
              state: 'downloading',
              mode: process.platform === 'win32' ? 'silent-installer' : 'manual',
              stageLabel: 'Updating core runtime in background...',
              version: latest.latestVersion,
              filename: latest.recommendedAsset.name,
              downloadedBytes: 0,
              totalBytes: latest.recommendedAsset.sizeBytes || 0,
              percent: 0,
              error: null,
            };
            await runAssetDownload(latest.recommendedAsset, false);
            return;
          }

          readyUpdateFilePath = targetPath;
          readyUpdateIsInAppBundle = true;
          downloadState = {
            ...downloadState,
            state: 'installing',
            mode: 'in-app',
            stageLabel: `Reloading MochiDrop v${latest.latestVersion}...`,
            downloadedBytes: received,
            totalBytes: downloadState.totalBytes || received,
            percent: 100,
            error: null,
          };

          // Signal Electron main.cjs (exit code 43) to seamlessly hot-swap server & reload window in-place!
          setTimeout(() => {
            process.exit(43);
          }, 450);
          return;
        }

        // Standard installer fallback (or silent /S on Windows)
        if (process.platform === 'linux' && /\.appimage$/i.test(targetPath)) {
          try {
            fs.chmodSync(targetPath, 0o755);
          } catch {
            // ignore
          }
        }
        readyUpdateFilePath = targetPath;
        readyUpdateIsInAppBundle = false;

        // On Windows Desktop, automatically trigger silent background update (no Setup Wizard!)
        if (cfg.isDesktopApp && process.platform === 'win32' && /setup\.exe$/i.test(targetPath)) {
          downloadState = {
            ...downloadState,
            state: 'installing',
            mode: 'silent-installer',
            stageLabel: 'Applying update silently & restarting MochiDrop...',
            downloadedBytes: received,
            totalBytes: downloadState.totalBytes || received,
            percent: 100,
            error: null,
          };
          launchSilentWindowsInstaller(targetPath);
          return;
        }

        downloadState = {
          ...downloadState,
          state: 'ready',
          stageLabel: 'Update downloaded & ready to apply',
          downloadedBytes: received,
          totalBytes: downloadState.totalBytes || received,
          percent: 100,
          error: null,
        };
      } catch (err) {
        try {
          if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        } catch {
          // ignore
        }
        throw err;
      }
    };

    try {
      await runAssetDownload(initialAsset, isInAppBundle);
    } catch (err) {
      downloadState = {
        ...downloadState,
        state: 'error',
        stageLabel: null,
        error: err instanceof Error ? err.message : 'Update failed.',
      };
    } finally {
      if (activeDownloadAbort === controller) {
        activeDownloadAbort = null;
      }
    }
  })();

  return getUpdateDownloadStatus();
}

function launchSilentWindowsInstaller(resolvedPath: string): void {
  const args = /setup\.exe$/i.test(resolvedPath) ? ['/S'] : [];
  const child = spawn(resolvedPath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    shell: false,
  });
  child.unref();

  // Exit Electron cleanly (code 42) so NSIS /S can replace files silently and relaunch MochiDrop
  setTimeout(() => {
    process.exit(42);
  }, 600);
}

export function launchDownloadedUpdate(): { ok: boolean; message: string; quitting: boolean } {
  const cfg = getAppUpdateConfig();
  if (!cfg.isDesktopApp) {
    throw new Error('Automatic in-app updates are available in the MochiDrop Desktop app.');
  }

  if (readyUpdateIsInAppBundle) {
    downloadState = {
      ...downloadState,
      state: 'installing',
      mode: 'in-app',
      stageLabel: 'Reloading MochiDrop...',
    };
    setTimeout(() => {
      process.exit(43);
    }, 350);
    return {
      ok: true,
      message: 'Applying in-app update and reloading MochiDrop...',
      quitting: false,
    };
  }

  if (downloadState.state !== 'ready' || !readyUpdateFilePath) {
    throw new Error('No downloaded update is ready yet.');
  }

  const resolved = path.resolve(readyUpdateFilePath);
  if (!resolved.startsWith(UPDATES_BASE_DIR + path.sep) || !fs.existsSync(resolved)) {
    throw new Error('Downloaded update file is missing or invalid.');
  }

  downloadState = { ...downloadState, state: 'installing' };

  if (process.platform === 'win32') {
    launchSilentWindowsInstaller(resolved);
    return {
      ok: true,
      message: 'Applying update silently in the background and restarting MochiDrop...',
      quitting: true,
    };
  }

  if (process.platform === 'darwin') {
    execFile('open', [resolved], (err) => {
      if (err) {
        console.error('[updater] Failed to mount DMG:', err.message);
      }
    });
    return {
      ok: true,
      message: 'Opened MochiDrop update disk image (.dmg) — drag MochiDrop into Applications.',
      quitting: false,
    };
  }

  // Linux AppImage
  execFile('xdg-open', [path.dirname(resolved)], () => {
    // ignore
  });
  return {
    ok: true,
    message: `Downloaded ${path.basename(resolved)} — run the new AppImage to complete the update.`,
    quitting: false,
  };
}
