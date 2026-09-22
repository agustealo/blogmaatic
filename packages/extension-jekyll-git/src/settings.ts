import { isAbsolute } from "node:path";

import type { ConnectionRecord } from "@blogmaatic/extension-sdk";

import { booleanSetting, stringArraySetting, stringSetting } from "./json.js";
import type { JekyllGitSettings } from "./types.js";

export const JEKYLL_GIT_EXTENSION_ID = "blogmaatic.jekyll-git";

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
