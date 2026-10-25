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

export function encodeRemoteVersion(projectionFingerprint: string, remoteHash: string): string {
  return `bm1:${projectionFingerprint}:${remoteHash}`;
}

export function parseRemoteVersion(value: string | undefined): { desired: string; remote: string } | undefined {
  if (!value) return undefined;
  const match = /^bm1:([a-f0-9]{64}):([a-f0-9]{64})$/.exec(value);
  if (!match?.[1] || !match[2]) return undefined;
  return { desired: match[1], remote: match[2] };
}
