import { createHash } from "node:crypto";

import type { LinkedInPostRecord } from "./types.js";

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Readonly<Record<string, unknown>>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}


export function remoteStateHash(post: LinkedInPostRecord): string {
  return fingerprint({
    author: post.author,
    commentary: post.commentary,
    visibility: post.visibility ?? null,
    lifecycleState: post.lifecycleState ?? null,
    feedDistribution: post.distribution?.feedDistribution ?? null,
    article: post.content?.article
      ? {
          source: post.content.article.source ?? null,
          title: post.content.article.title ?? null,
          description: post.content.article.description ?? null,
        }
      : null,
    media: post.content?.media
      ? {
          id: post.content.media.id ?? null,
          title: post.content.media.title ?? null,
          altText: post.content.media.altText ?? null,
        }
      : null,
  });
}

export interface LinkedInRemoteBaseline {
  readonly desired: string;
  readonly remote: string;
  readonly mediaFingerprint?: string;
  readonly mediaUrn?: string;
}

export function encodeRemoteVersion(
  projectionFingerprint: string,
  remoteHash: string,
  mediaFingerprint?: string,
  mediaUrn?: string,
): string {
  const payload = JSON.stringify({
    desired: projectionFingerprint,
    remote: remoteHash,
    ...(mediaFingerprint ? { mediaFingerprint } : {}),
    ...(mediaUrn ? { mediaUrn } : {}),
  });
  return `li1:${Buffer.from(payload, "utf8").toString("base64url")}`;
}

export function parseRemoteVersion(value: string | undefined): LinkedInRemoteBaseline | undefined {
  if (!value?.startsWith("li1:")) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value.slice(4), "base64url").toString("utf8")) as Record<string, unknown>;
    const desired = parsed.desired;
    const remote = parsed.remote;
    if (
      typeof desired !== "string" || !/^[a-f0-9]{64}$/.test(desired) ||
      typeof remote !== "string" || !/^[a-f0-9]{64}$/.test(remote)
    ) return undefined;
    const mediaFingerprint = typeof parsed.mediaFingerprint === "string" ? parsed.mediaFingerprint : undefined;
    const mediaUrn = typeof parsed.mediaUrn === "string" ? parsed.mediaUrn : undefined;
    return {
      desired,
      remote,
      ...(mediaFingerprint ? { mediaFingerprint } : {}),
      ...(mediaUrn ? { mediaUrn } : {}),
    };
  } catch {
    return undefined;
  }
}
