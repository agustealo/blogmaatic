import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

import type { FileSnapshot } from "./types.js";

const execFileAsync = promisify(execFile);

export async function git(
  root: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await execFileAsync("git", [...args], {
    cwd: root,
    env: env ? { ...process.env, ...env } : process.env,
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout.trim();
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function targetDirty(
  root: string,
  relativePaths: readonly string[],
): Promise<boolean> {
  if (relativePaths.length === 0) return false;
  return (await git(root, ["status", "--porcelain", "--", ...relativePaths])).length > 0;
}

export async function remoteContainsProjectionCommits(
  root: string,
  remote: string,
  branch: string,
  relativePaths: readonly string[],
): Promise<{ synced: boolean; remoteSha: string }> {
  await git(root, ["fetch", "--quiet", remote, branch]);
  const remoteRef = `${remote}/${branch}`;
  const remoteSha = await git(root, ["rev-parse", remoteRef]);
  for (const relativePath of relativePaths) {
    let pathCommit = "";
    try {
      pathCommit = await git(root, ["log", "-1", "--format=%H", "--", relativePath]);
    } catch {
      return { synced: false, remoteSha };
    }
    if (!pathCommit) return { synced: false, remoteSha };
    try {
      await git(root, ["merge-base", "--is-ancestor", pathCommit, remoteRef]);
    } catch {
      return { synced: false, remoteSha };
    }
  }
  return { synced: true, remoteSha };
}

export async function snapshot(path: string): Promise<FileSnapshot> {
  if (!(await exists(path))) return { path, existed: false };
  return { path, existed: true, content: await readFile(path) };
}

export async function restoreSnapshots(snapshots: readonly FileSnapshot[]): Promise<void> {
  for (const item of snapshots) {
    if (item.existed && item.content) {
      await mkdir(dirname(item.path), { recursive: true });
      await writeFile(item.path, item.content);
    } else {
      await rm(item.path, { force: true });
    }
  }
}

export async function atomicWrite(path: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(
    dirname(path),
    `.${basename(path)}.blogmaatic-${process.pid}-${Date.now()}`,
  );
  await writeFile(temp, content);
  await rename(temp, path);
}

export async function atomicCopy(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const temp = join(
    dirname(destination),
    `.${basename(destination)}.blogmaatic-${process.pid}-${Date.now()}`,
  );
  await copyFile(source, temp);
  await rename(temp, destination);
}

export async function runJekyllBuild(root: string): Promise<void> {
  await execFileAsync("bundle", ["exec", "jekyll", "build"], {
    cwd: root,
    env: process.env,
    maxBuffer: 8 * 1024 * 1024,
  });
}
