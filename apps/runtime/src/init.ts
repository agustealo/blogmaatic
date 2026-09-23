import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";

import { JEKYLL_GIT_EXTENSION_ID } from "@blogmaatic/extension-jekyll-git";
import type { ConnectionRecord } from "@blogmaatic/extension-sdk";

import { defaultRuntimeConfig, type RuntimeConfig } from "./config.js";

const exec = promisify(execFile);

async function git(repo: string, args: readonly string[]): Promise<string> {
  const result = await exec("git", ["-C", repo, ...args], { encoding: "utf8" });
  return result.stdout.trim();
}

async function optionalGit(repo: string, args: readonly string[]): Promise<string> {
  try {
    return await git(repo, args);
  } catch (error) {
    const code = (error as { readonly code?: unknown }).code;
    if (code === 1) return "";
    throw error;
  }
}

async function requireFile(path: string, label: string): Promise<void> {
  try {
    if (!(await stat(path)).isFile()) throw new Error("not a file");
  } catch {
    throw new Error(`${label} is missing: ${path}`);
  }
}

export async function configForFirstRun(options: {
  readonly jekyllRepository?: string;
  readonly authorName?: string;
  readonly authorEmail?: string;
  readonly push?: boolean;
  readonly buildVerification?: "none" | "bundle";
  readonly siteBaseUrl?: string;
}): Promise<RuntimeConfig> {
  const base = defaultRuntimeConfig();
  if (!options.jekyllRepository) return base;
  const repositoryPath = await realpath(options.jekyllRepository);
  await requireFile(join(repositoryPath, "_config.yml"), "Jekyll _config.yml");
  if (await git(repositoryPath, ["rev-parse", "--is-inside-work-tree"]) !== "true") {
    throw new Error(`${repositoryPath} is not a Git work tree`);
  }
  const branch = await git(repositoryPath, ["branch", "--show-current"]);
  if (!branch) throw new Error("Jekyll repository must be on a named branch");
  const authorName = options.authorName?.trim() || await optionalGit(repositoryPath, ["config", "user.name"]);
  const authorEmail = options.authorEmail?.trim() || await optionalGit(repositoryPath, ["config", "user.email"]);
  if (!authorName || !authorEmail) {
    throw new Error("Jekyll publishing requires author name and email; configure Git or pass --author-name and --author-email");
  }
  const now = new Date().toISOString();
  const connection: ConnectionRecord = {
    id: "jekyll-primary",
    extensionId: JEKYLL_GIT_EXTENSION_ID,
    displayName: "Primary Jekyll site",
    status: "active",
    settings: {
      repositoryPath,
      branch,
      authorName,
      authorEmail,
      push: options.push ?? false,
      buildVerification: options.buildVerification ?? "none",
      ...(options.siteBaseUrl ? { siteBaseUrl: options.siteBaseUrl } : {}),
    },
    secretRefs: {},
    createdAt: now,
    updatedAt: now,
  };
  return { ...base, connections: [connection] };
}
