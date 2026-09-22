import { isAbsolute } from "node:path";

import type { ConnectionRecord } from "@blogmaatic/extension-sdk";

import { getBoolean, getNumber, getString, stringArray } from "./json.js";
import type { WordPressSettings } from "./types.js";

export const WORDPRESS_REST_EXTENSION_ID = "blogmaatic.wordpress-rest";

function normalizeHttpUrl(value: string, label: string): string {
  const parsed = new URL(value);
  const localHost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && localHost)) {
    throw new Error(`WordPress ${label} must use HTTPS except for loopback development hosts`);
  }
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

export function parseSettings(connection: ConnectionRecord): WordPressSettings {
  if (connection.extensionId !== WORDPRESS_REST_EXTENSION_ID) {
    throw new Error(`Connection ${connection.id} does not belong to ${WORDPRESS_REST_EXTENSION_ID}`);
  }
  const siteUrlValue = getString(connection.settings, "siteUrl");
  const username = getString(connection.settings, "username")?.trim();
  if (!siteUrlValue) throw new Error("WordPress connection requires settings.siteUrl");
  if (!username) throw new Error("WordPress connection requires settings.username");
  const applicationPasswordRef = connection.secretRefs.applicationPassword;
  if (!applicationPasswordRef) {
    throw new Error("WordPress connection requires secretRefs.applicationPassword");
  }

  const siteUrl = normalizeHttpUrl(siteUrlValue, "siteUrl");
  const apiRootValue = getString(connection.settings, "apiRoot");
  const apiRoot = apiRootValue
    ? normalizeHttpUrl(apiRootValue, "apiRoot")
    : `${siteUrl}/wp-json/wp/v2`;
  const restBase = getString(connection.settings, "postTypeRestBase") ?? "posts";
  if (!/^[a-z0-9_-]+$/.test(restBase)) {
    throw new Error("postTypeRestBase must contain only lowercase letters, numbers, underscores, or hyphens");
  }
  const sourceRoots = stringArray(connection.settings.assetSourceRoots);
  if (sourceRoots.some((root) => !isAbsolute(root))) {
    throw new Error("assetSourceRoots must contain only absolute paths");
  }
  const timeoutMs = Math.trunc(getNumber(connection.settings, "timeoutMs") ?? 15000);
  if (timeoutMs < 1000 || timeoutMs > 120000) {
    throw new Error("timeoutMs must be between 1000 and 120000 milliseconds");
  }

  return {
    siteUrl,
    apiRoot,
    username,
    applicationPasswordRef,
    postTypeRestBase: restBase,
    assetSourceRoots: sourceRoots,
    createMissingTerms: getBoolean(connection.settings, "createMissingTerms") ?? true,
    timeoutMs,
  };
}
