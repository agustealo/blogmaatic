import type { JsonValue } from "@blogmaatic/core";
import type { ConnectionRecord } from "@blogmaatic/extension-sdk";

import type { LinkedInSettings } from "./types.js";

export const LINKEDIN_REST_EXTENSION_ID = "blogmaatic.linkedin-rest";
export const DEFAULT_LINKEDIN_API_VERSION = "202609";

function getString(record: Readonly<Record<string, JsonValue>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function getNumber(record: Readonly<Record<string, JsonValue>>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeApiRoot(value: string): string {
  const parsed = new URL(value);
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error("LinkedIn apiRoot must use HTTPS except for loopback development hosts");
  }
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

export function parseSettings(connection: ConnectionRecord): LinkedInSettings {
  if (connection.extensionId !== LINKEDIN_REST_EXTENSION_ID) {
    throw new Error(`Connection ${connection.id} does not belong to ${LINKEDIN_REST_EXTENSION_ID}`);
  }
  const authorUrn = getString(connection.settings, "authorUrn")?.trim();
  if (!authorUrn || !/^urn:li:organization:\d+$/.test(authorUrn)) {
    throw new Error("LinkedIn v0.1 requires settings.authorUrn as an organization URN");
  }
  const accessTokenRef = connection.secretRefs.accessToken;
  if (!accessTokenRef) throw new Error("LinkedIn connection requires secretRefs.accessToken");

  const apiRoot = normalizeApiRoot(getString(connection.settings, "apiRoot") ?? "https://api.linkedin.com/rest");
  const apiVersion = getString(connection.settings, "apiVersion") ?? DEFAULT_LINKEDIN_API_VERSION;
  if (!/^20\d{4}$/.test(apiVersion)) {
    throw new Error("LinkedIn apiVersion must use YYYYMM format");
  }
  const timeoutMs = Math.trunc(getNumber(connection.settings, "timeoutMs") ?? 15000);
  if (timeoutMs < 1000 || timeoutMs > 120000) {
    throw new Error("LinkedIn timeoutMs must be between 1000 and 120000 milliseconds");
  }

  return { apiRoot, apiVersion, authorUrn, accessTokenRef, timeoutMs };
}
