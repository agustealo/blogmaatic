import { isAbsolute } from "node:path";

import type { ConnectionContract, ConnectionRecord } from "@blogmaatic/extension-sdk";

import { booleanSetting, stringArraySetting, stringSetting } from "./json.js";
import type { JekyllGitSettings } from "./types.js";

export const JEKYLL_GIT_EXTENSION_ID = "blogmaatic.jekyll-git";

export const JEKYLL_CONNECTION_CONTRACT: ConnectionContract = {
  schemaVersion: 1,
  settingsFields: [
    { key: "repositoryPath", label: "Repository path", kind: "path", required: true, description: "Absolute path to the local Jekyll Git repository." },
    { key: "branch", label: "Branch", kind: "text", required: true },
    { key: "authorName", label: "Git author name", kind: "text", required: true },
    { key: "authorEmail", label: "Git author email", kind: "email", required: true },
    { key: "postsDirectory", label: "Posts directory", kind: "path", defaultValue: "_posts" },
    { key: "draftsDirectory", label: "Drafts directory", kind: "path", defaultValue: "_drafts" },
    { key: "assetsDirectory", label: "Assets directory", kind: "path", defaultValue: "assets/blogmaatic" },
    { key: "remote", label: "Git remote", kind: "text", defaultValue: "origin" },
    { key: "push", label: "Push commits to remote", kind: "boolean", defaultValue: false },
    { key: "siteBaseUrl", label: "Site base URL", kind: "url", description: "Optional public site URL used for canonical identities." },
    { key: "buildVerification", label: "Build verification", kind: "select", defaultValue: "none", options: [{ value: "none", label: "None" }, { value: "bundle", label: "bundle exec jekyll build" }] },
    { key: "assetSourceRoots", label: "Allowed local asset roots", kind: "string-list", description: "Absolute directories from which managed local assets may be copied." },
  ],
  secretFields: [],
};

export function parseSettings(connection: ConnectionRecord): JekyllGitSettings {
  if (connection.extensionId !== JEKYLL_GIT_EXTENSION_ID) {
    throw new Error(
      `Connection ${connection.id} is not owned by ${JEKYLL_GIT_EXTENSION_ID}`,
    );
  }

  const repositoryPath = stringSetting(connection.settings, "repositoryPath");
  const branch = stringSetting(connection.settings, "branch");
  const authorName = stringSetting(connection.settings, "authorName");
  const authorEmail = stringSetting(connection.settings, "authorEmail");
  if (!repositoryPath || !branch || !authorName || !authorEmail) {
    throw new Error(
      `Connection ${connection.id} requires repositoryPath, branch, authorName, and authorEmail`,
    );
  }
  if (!isAbsolute(repositoryPath)) {
    throw new Error(`Connection ${connection.id} repositoryPath must be absolute`);
  }

  const buildVerification = stringSetting(connection.settings, "buildVerification") ?? "none";
  if (buildVerification !== "none" && buildVerification !== "bundle") {
    throw new Error(`Connection ${connection.id} buildVerification must be none or bundle`);
  }
  const siteBaseUrl = stringSetting(connection.settings, "siteBaseUrl");

  return {
    repositoryPath,
    branch,
    authorName,
    authorEmail,
    postsDirectory: stringSetting(connection.settings, "postsDirectory") ?? "_posts",
    draftsDirectory: stringSetting(connection.settings, "draftsDirectory") ?? "_drafts",
    assetsDirectory: stringSetting(connection.settings, "assetsDirectory") ?? "assets/blogmaatic",
    remote: stringSetting(connection.settings, "remote") ?? "origin",
    push: booleanSetting(connection.settings, "push", false),
    ...(siteBaseUrl ? { siteBaseUrl } : {}),
    buildVerification,
    assetSourceRoots: stringArraySetting(connection.settings, "assetSourceRoots"),
  };
}
