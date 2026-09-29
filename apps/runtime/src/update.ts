import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const RELEASES_API = "https://api.github.com/repos/agustealo/blogmaatic/releases/latest";

interface GithubReleaseAsset {
  readonly name: string;
  readonly browser_download_url: string;
}

interface GithubRelease {
  readonly tag_name: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly html_url: string;
  readonly assets: readonly GithubReleaseAsset[];
}

interface ReleaseManifestAsset {
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
}

interface ReleaseManifest {
  readonly schemaVersion: 1;
  readonly product: "Blogmaatic";
  readonly version: string;
  readonly tag: string;
  readonly sourceSha: string;
  readonly assets: readonly ReleaseManifestAsset[];
}

export interface UpdateCheck {
  readonly currentVersion: string;
  readonly latestVersion: string;
  readonly tag: string;
  readonly releaseUrl: string;
  readonly updateAvailable: boolean;
  readonly packageName?: string;
  readonly packageSha256?: string;
  readonly packageSize?: number;
}

export interface PreparedUpdate extends UpdateCheck {
  readonly updateAvailable: true;
  readonly packageName: string;
  readonly packageSha256: string;
  readonly packageSize: number;
  readonly packagePath: string;
}

export type PrepareUpdateResult = PreparedUpdate | (UpdateCheck & { readonly updateAvailable: false });

function releaseVersion(value: string, label: string): { readonly raw: string; readonly parts: readonly [number, number, number] } {
  const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (!match) throw new Error(`${label} must be a stable semantic version`);
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  if (parts.some((part) => !Number.isSafeInteger(part))) throw new Error(`${label} is invalid`);
  return { raw: `${parts[0]}.${parts[1]}.${parts[2]}`, parts };
}

function compareVersion(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function nativePackageName(version: string): string {
  if (process.platform === "darwin") {
    if (process.arch !== "arm64" && process.arch !== "x64") {
      throw new Error(`Blogmaatic updates are not published for macOS ${process.arch}`);
    }
    return `blogmaatic-${version}-macos-${process.arch}.pkg`;
  }
  if (process.platform === "linux") {
    if (process.arch !== "x64") throw new Error(`Blogmaatic updates are not published for Linux ${process.arch}`);
    return `blogmaatic-${version}-amd64.deb`;
  }
  throw new Error(`Blogmaatic native updates are not supported on ${process.platform}`);
}

function githubHeaders(): Headers {
  return new Headers({
    accept: "application/vnd.github+json",
    "user-agent": "Blogmaatic-Updater",
    "x-github-api-version": "2022-11-28",
  });
}

async function fetchJson<T>(url: string, label: string, headers = githubHeaders()): Promise<T> {
  const response = await fetch(url, { headers, redirect: "follow", referrerPolicy: "no-referrer" });
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}`);
  return await response.json() as T;
}

function parseRelease(value: GithubRelease): GithubRelease {
  if (!value || typeof value !== "object") throw new Error("Latest release response is invalid");
  if (value.draft || value.prerelease) throw new Error("Latest Blogmaatic release is not a stable published release");
  if (typeof value.tag_name !== "string" || typeof value.html_url !== "string" || !Array.isArray(value.assets)) {
    throw new Error("Latest release response is incomplete");
  }
  const releaseUrl = new URL(value.html_url);
  if (releaseUrl.protocol !== "https:" || releaseUrl.hostname !== "github.com") throw new Error("Latest release URL is not trusted");
  return value;
}

function parseManifest(value: ReleaseManifest, expectedTag: string): ReleaseManifest {
  if (!value || typeof value !== "object" || value.schemaVersion !== 1 || value.product !== "Blogmaatic") {
    throw new Error("Release manifest is invalid");
  }
  if (value.tag !== expectedTag) throw new Error("Release manifest tag does not match the published release");
  const version = releaseVersion(value.version, "Release manifest version").raw;
  if (`v${version}` !== expectedTag) throw new Error("Release manifest version does not match its tag");
  if (typeof value.sourceSha !== "string" || !/^[0-9a-f]{40}$/i.test(value.sourceSha)) {
    throw new Error("Release manifest source SHA is invalid");
  }
  if (!Array.isArray(value.assets) || value.assets.length === 0) throw new Error("Release manifest contains no assets");
  for (const asset of value.assets) {
    if (!asset || typeof asset.name !== "string" || !Number.isSafeInteger(asset.size) || asset.size < 1 || typeof asset.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(asset.sha256)) {
      throw new Error("Release manifest contains an invalid asset entry");
    }
  }
  if (new Set(value.assets.map((asset) => asset.name)).size !== value.assets.length) {
    throw new Error("Release manifest contains duplicate asset names");
  }
  return value;
}

async function releaseAuthority(currentVersion: string): Promise<{
  readonly release: GithubRelease;
  readonly manifest: ReleaseManifest;
  readonly current: ReturnType<typeof releaseVersion>;
  readonly latest: ReturnType<typeof releaseVersion>;
}> {
  const current = releaseVersion(currentVersion, "Installed Blogmaatic version");
  const release = parseRelease(await fetchJson<GithubRelease>(RELEASES_API, "Latest release lookup"));
  const latest = releaseVersion(release.tag_name, "Latest release tag");
  const manifestAsset = release.assets.find((asset) => asset.name === "release-manifest.json");
  if (!manifestAsset) throw new Error("Latest Blogmaatic release is missing release-manifest.json");
  const manifestUrl = new URL(manifestAsset.browser_download_url);
  if (manifestUrl.protocol !== "https:" || manifestUrl.hostname !== "github.com") {
    throw new Error("Release manifest download URL is not trusted");
  }
  const manifest = parseManifest(
    await fetchJson<ReleaseManifest>(manifestUrl.toString(), "Release manifest download", new Headers({ "user-agent": "Blogmaatic-Updater" })),
    `v${latest.raw}`,
  );
  return { release, manifest, current, latest };
}

export async function checkForUpdate(currentVersion: string): Promise<UpdateCheck> {
  const authority = await releaseAuthority(currentVersion);
  const updateAvailable = compareVersion(authority.latest.parts, authority.current.parts) > 0;
  const packageName = nativePackageName(authority.latest.raw);
  const manifestAsset = authority.manifest.assets.find((asset) => asset.name === packageName);
  const releaseAsset = authority.release.assets.find((asset) => asset.name === packageName);
  if (!manifestAsset || !releaseAsset) throw new Error(`Latest release does not contain ${packageName}`);
  return {
    currentVersion: authority.current.raw,
    latestVersion: authority.latest.raw,
    tag: authority.release.tag_name,
    releaseUrl: authority.release.html_url,
    updateAvailable,
    packageName,
    packageSha256: manifestAsset.sha256,
    packageSize: manifestAsset.size,
  };
}

async function downloadFile(url: string, destination: string, expectedSize: number, expectedSha256: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") throw new Error("Update package URL is not trusted");
  const response = await fetch(parsed, {
    headers: new Headers({ "user-agent": "Blogmaatic-Updater", accept: "application/octet-stream" }),
    redirect: "follow",
    referrerPolicy: "no-referrer",
  });
  if (!response.ok) throw new Error(`Update package download failed with HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength !== expectedSize) throw new Error("Downloaded update size does not match the trusted release manifest");
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== expectedSha256) throw new Error("Downloaded update checksum does not match the trusted release manifest");
  await writeFile(destination, bytes, { mode: 0o600, flag: "wx" });
}

export async function prepareUpdate(currentVersion: string, dataDir: string): Promise<PrepareUpdateResult> {
  const authority = await releaseAuthority(currentVersion);
  const updateAvailable = compareVersion(authority.latest.parts, authority.current.parts) > 0;
  const packageName = nativePackageName(authority.latest.raw);
  const manifestAsset = authority.manifest.assets.find((asset) => asset.name === packageName);
  const releaseAsset = authority.release.assets.find((asset) => asset.name === packageName);
  if (!manifestAsset || !releaseAsset) throw new Error(`Latest release does not contain ${packageName}`);
  const common = {
    currentVersion: authority.current.raw,
    latestVersion: authority.latest.raw,
    tag: authority.release.tag_name,
    releaseUrl: authority.release.html_url,
    packageName,
    packageSha256: manifestAsset.sha256,
    packageSize: manifestAsset.size,
  };
  if (!updateAvailable) return { ...common, updateAvailable: false };

  const updateDir = resolve(dataDir, "updates", authority.latest.raw);
  await mkdir(updateDir, { recursive: true, mode: 0o700 });
  const destination = join(updateDir, packageName);
  const temp = `${destination}.part-${process.pid}`;
  await rm(temp, { force: true });
  await rm(destination, { force: true });
  try {
    await downloadFile(releaseAsset.browser_download_url, temp, manifestAsset.size, manifestAsset.sha256);
    await rename(temp, destination);
    if (process.platform !== "win32") await chmod(destination, 0o600);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }

  return { ...common, updateAvailable: true, packagePath: destination };
}

export function openPreparedInstaller(update: PreparedUpdate): void {
  const path = resolve(update.packagePath);
  if (basename(path) !== update.packageName) throw new Error("Prepared update package path is invalid");
  let command: string;
  let args: string[];
  if (process.platform === "darwin") {
    command = "open";
    args = [path];
  } else if (process.platform === "linux") {
    command = "xdg-open";
    args = [path];
  } else {
    throw new Error(`Blogmaatic native updates are not supported on ${process.platform}`);
  }
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.once("error", () => undefined);
  child.unref();
}

export async function verifyPreparedUpdate(update: PreparedUpdate): Promise<void> {
  const bytes = await readFile(update.packagePath);
  if (bytes.byteLength !== update.packageSize) throw new Error("Prepared update size no longer matches the trusted release manifest");
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== update.packageSha256) throw new Error("Prepared update checksum no longer matches the trusted release manifest");
}
