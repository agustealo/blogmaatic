import { isAbsolute } from "node:path";

import type { ConnectionContract, ConnectionRecord } from "@blogmaatic/extension-sdk";

import { getBoolean, getNumber, getString, stringArray } from "./json.js";
import type { WordPressSettings } from "./types.js";

export const WORDPRESS_REST_EXTENSION_ID = "blogmaatic.wordpress-rest";

export const WORDPRESS_CONNECTION_CONTRACT: ConnectionContract = {
  schemaVersion: 1,
  settingsFields: [
    { key: "siteUrl", label: "Site URL", kind: "url", required: true, placeholder: "https://example.com", description: "Public WordPress site URL." },
    { key: "username", label: "Username", kind: "text", required: true, description: "WordPress user that owns the Application Password." },
    { key: "apiRoot", label: "REST API root", kind: "url", description: "Optional custom wp-json REST root. Leave blank for the standard WordPress REST endpoint." },
    { key: "postTypeRestBase", label: "Post type REST base", kind: "text", defaultValue: "posts", description: "REST base for the post type Blogmaatic should publish." },
    { key: "assetSourceRoots", label: "Allowed local asset roots", kind: "string-list", description: "Absolute directories from which managed local media may be uploaded." },
    { key: "createMissingTerms", label: "Create missing categories and tags", kind: "boolean", defaultValue: true },
    { key: "timeoutMs", label: "Request timeout (ms)", kind: "integer", defaultValue: 15000, min: 1000, max: 120000 },
  ],
  secretFields: [
    { key: "applicationPassword", label: "Application Password", required: true, description: "Stored only in the OS credential vault." },
  ],
  defaultRoute: {
    channel: "posts",
    requiredCapabilities: ["article.create", "article.inspect"],
  },
};

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