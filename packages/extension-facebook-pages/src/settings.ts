import { isAbsolute } from "node:path";

import type { JsonValue } from "@blogmaatic/core";
import type { ConnectionContract, ConnectionRecord } from "@blogmaatic/extension-sdk";

import type { FacebookSettings } from "./types.js";

export const FACEBOOK_PAGES_EXTENSION_ID = "blogmaatic.facebook-pages";
export const DEFAULT_FACEBOOK_GRAPH_VERSION = "v26.0";

export const FACEBOOK_CONNECTION_CONTRACT: ConnectionContract = {
  schemaVersion: 1,
  settingsFields: [
    { key: "pageId", label: "Facebook Page ID", kind: "text", required: true, description: "Numeric Facebook Page ID that Blogmaatic will publish to." },
    { key: "apiRoot", label: "Graph API root", kind: "url", defaultValue: "https://graph.facebook.com" },
    { key: "apiVersion", label: "Graph API version", kind: "text", defaultValue: DEFAULT_FACEBOOK_GRAPH_VERSION },
    { key: "assetSourceRoots", label: "Allowed local asset roots", kind: "string-list", description: "Absolute directories from which managed local media may be uploaded." },
    { key: "timeoutMs", label: "Request timeout (ms)", kind: "integer", defaultValue: 15000, min: 1000, max: 120000 },
  ],
  secretFields: [
    { key: "pageAccessToken", label: "Page access token", required: true, description: "Stored only in the OS credential vault." },
  ],
};

function getString(record: Readonly<Record<string, JsonValue>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function getNumber(record: Readonly<Record<string, JsonValue>>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: JsonValue | undefined): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalizeApiRoot(value: string): string {
  const parsed = new URL(value);
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error("Facebook apiRoot must use HTTPS except for loopback development hosts");
  }
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

export function parseSettings(connection: ConnectionRecord): FacebookSettings {
  if (connection.extensionId !== FACEBOOK_PAGES_EXTENSION_ID) {
    throw new Error(`Connection ${connection.id} does not belong to ${FACEBOOK_PAGES_EXTENSION_ID}`);
  }
  const pageId = getString(connection.settings, "pageId")?.trim();
  if (!pageId || !/^\d+$/.test(pageId)) {
    throw new Error("Facebook connection requires numeric settings.pageId");
  }
  const pageAccessTokenRef = connection.secretRefs.pageAccessToken;
  if (!pageAccessTokenRef) {
    throw new Error("Facebook connection requires secretRefs.pageAccessToken");
  }
  const apiRoot = normalizeApiRoot(getString(connection.settings, "apiRoot") ?? "https://graph.facebook.com");
  const apiVersion = getString(connection.settings, "apiVersion") ?? DEFAULT_FACEBOOK_GRAPH_VERSION;
  if (!/^v\d+\.\d+$/.test(apiVersion)) {
    throw new Error("Facebook apiVersion must use vNN.N format");
  }
  const assetSourceRoots = stringArray(connection.settings.assetSourceRoots);
  if (assetSourceRoots.some((root) => !isAbsolute(root))) {
    throw new Error("Facebook assetSourceRoots must contain only absolute paths");
  }
  const timeoutMs = Math.trunc(getNumber(connection.settings, "timeoutMs") ?? 15000);
  if (timeoutMs < 1000 || timeoutMs > 120000) {
    throw new Error("Facebook timeoutMs must be between 1000 and 120000 milliseconds");
  }
  return { apiRoot, apiVersion, pageId, pageAccessTokenRef, assetSourceRoots, timeoutMs };
}
