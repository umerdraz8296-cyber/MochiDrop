import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  platform: string;
  arch: string;
  recommendedAsset: ReleaseAssetDto | null;
  allAssets: ReleaseAssetDto[];
  checkedAt: number;
  error: string | null;
}

export interface UpdateDownloadStatusDto {
  state: 'idle' | 'downloading' | 'ready' | 'installing' | 'error';
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
  version: null,
  filename: null,
  downloadedBytes: 0,
  totalBytes: 0,
  percent: 0,
  error: null,
};
let readyUpdateFilePath: string | null = null;
let activeDownloadAbort: AbortController | null = null;

function readPackageJsonMeta(): { version: string; repo: string } {
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
        repository?: string | { url?: string };
      };
      const ver = typeof pkg.version === 'string' && pkg.version.trim() ? pkg.version.trim() : '1.0.0';
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
      return { version: ver, repo: repo || DEFAULT_GITHUB_REPO };
    } catch {
      // try next path
    }
  }
  return { version: '1.0.0', repo: DEFAULT_GITHUB_REPO };
}

export function getAppUpdateConfig(): {
  currentVersion: string;
  repo: string;
  isDesktopApp: boolean;
  platform: string;
  arch: string;
} {
  const pkgMeta = readPackageJsonMeta();
  const envVer = process.env.MOCHIDROP_APP_VERSION?.trim();
  const envRepo = process.env.MOCHIDROP_GITHUB_REPO?.trim();
  const repo = envRepo && VALID_REPO_RE.test(envRepo) ? envRepo : pkgMeta.repo;
  const currentVersion = normalizeVersion(envVer || pkgMeta.version || '1.0.0');
  return {
    currentVersion,
    repo,
    isDesktopApp: process.env.MOCHIDROP_IS_DESKTOP === '1',
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

function pickRecommendedAsset(
  assets: ReleaseAssetDto[],
  platform: string,
  arch: string
): ReleaseAssetDto | null {
  if (assets.length === 0) return null;

  if (platform === 'win32') {
    return (
      assets.find((a) => /setup\.exe$/i.test(a.name)) ||
      assets.find((a) => /portable\.exe$/i.test(a.name)) ||
      assets.find((a) => /\.exe$/i.test(a.name)) ||
      assets[0]
    );
  }

  if (platform === 'darwin') {
    const archRe = arch === 'arm64' ? /arm64\.dmg$/i : /x64\.dmg$/i;
    return (
      assets.find((a) => archRe.test(a.name)) ||
      assets.find((a) => /\.dmg$/i.test(a.name)) ||
      assets[0]
    );
  }

  // Linux
  return (
    assets.find((a) => /\.appimage$/i.test(a.name)) ||
    assets.find((a) => /\.deb$/i.test(a.name)) ||
    assets[0]
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
      platform: cfg.platform,
      arch: cfg.arch,
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
      platform: cfg.platform,
      arch: cfg.arch,
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

      // If GitHub REST API is rate-limited (403/429), fall back to /releases/latest redirect check
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
        platform: cfg.platform,
        arch: cfg.arch,
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

export async function startUpdateDownload(assetName?: string): Promise<UpdateDownloadStatusDto> {
  if (downloadState.state === 'downloading') {
    return getUpdateDownloadStatus();
  }

  const latest = await checkForGithubUpdate(false);
  if (!latest.updateAvailable && !latest.recommendedAsset) {
    throw new Error('No update installer is currently available.');
  }

  const targetAsset =
    (assetName ? latest.allAssets.find((a) => a.name === assetName) : null) ||
    latest.recommendedAsset;

  if (!targetAsset || !isAllowedGithubDownloadUrl(targetAsset.downloadUrl)) {
    throw new Error('No verified GitHub Release installer found for this platform.');
  }

  fs.mkdirSync(UPDATES_BASE_DIR, { recursive: true });
  const targetPath = resolveConfinedUpdatePath(targetAsset.name);
  const tempPath = resolveConfinedUpdatePath(`${targetAsset.name}.part`);

  if (activeDownloadAbort) {
    activeDownloadAbort.abort();
  }
  const controller = new AbortController();
  activeDownloadAbort = controller;
  readyUpdateFilePath = null;

  downloadState = {
    state: 'downloading',
    version: latest.latestVersion,
    filename: targetAsset.name,
    downloadedBytes: 0,
    totalBytes: targetAsset.sizeBytes || 0,
    percent: 0,
    error: null,
  };

  void (async () => {
    let writeStream: fs.WriteStream | null = null;
    try {
      // Manually follow GitHub -> objects.githubusercontent.com redirects with strict host validation
      let currentUrl = targetAsset.downloadUrl;
      let response: Response | null = null;

      for (let hop = 0; hop < 6; hop += 1) {
        if (!isAllowedGithubDownloadUrl(currentUrl)) {
          throw new Error('Blocked redirect to non-GitHub host.');
        }
        const res = await fetch(currentUrl, {
          redirect: 'manual',
          headers: {
            'User-Agent': `MochiDrop/${latest.currentVersion}`,
          },
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
              100,
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

      fs.renameSync(tempPath, targetPath);
      if (process.platform === 'linux' && /\.appimage$/i.test(targetPath)) {
        try {
          fs.chmodSync(targetPath, 0o755);
        } catch {
          // ignore chmod error
        }
      }

      readyUpdateFilePath = targetPath;
      downloadState = {
        ...downloadState,
        state: 'ready',
        downloadedBytes: received,
        totalBytes: downloadState.totalBytes || received,
        percent: 100,
        error: null,
      };
    } catch (err) {
      if (writeStream) {
        try {
          writeStream.destroy();
        } catch {
          // ignore
        }
      }
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {
        // ignore
      }
      downloadState = {
        ...downloadState,
        state: 'error',
        error: err instanceof Error ? err.message : 'Update download failed.',
      };
    } finally {
      if (activeDownloadAbort === controller) {
        activeDownloadAbort = null;
      }
    }
  })();

  return getUpdateDownloadStatus();
}

export function launchDownloadedUpdate(): { ok: boolean; message: string; quitting: boolean } {
  const cfg = getAppUpdateConfig();
  if (!cfg.isDesktopApp) {
    throw new Error('Automatic installation is only available in the MochiDrop Desktop app.');
  }
  if (downloadState.state !== 'ready' || !readyUpdateFilePath) {
    throw new Error('No downloaded update installer is ready yet.');
  }

  const resolved = path.resolve(readyUpdateFilePath);
  if (!resolved.startsWith(UPDATES_BASE_DIR + path.sep) || !fs.existsSync(resolved)) {
    throw new Error('Downloaded update file is missing or invalid.');
  }

  downloadState = { ...downloadState, state: 'installing' };

  if (process.platform === 'win32') {
    const child = spawn(resolved, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();

    // Signal Electron main process (exit code 42) to close cleanly so the Windows installer can update files
    setTimeout(() => {
      process.exit(42);
    }, 650);

    return {
      ok: true,
      message: 'Launching MochiDrop installer and closing app to apply update...',
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
