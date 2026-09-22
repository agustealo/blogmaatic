import { createHash } from "node:crypto";

import type { FacebookAttachment, FacebookPostRecord } from "./types.js";

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Readonly<Record<string, unknown>>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function attachmentIds(attachment: FacebookAttachment, output: string[]): void {
  if (attachment.target?.id) output.push(attachment.target.id);
  for (const child of attachment.subattachments?.data ?? []) attachmentIds(child, output);
}

export function remoteStateHash(post: FacebookPostRecord): string {
  const mediaIds: string[] = [];
  for (const attachment of post.attachments?.data ?? []) attachmentIds(attachment, mediaIds);
  return sha256(stableJson({
    message: post.message ?? "",
    link: post.link ?? null,
    mediaIds: [...new Set(mediaIds)].sort(),
    isPublished: post.is_published ?? null,
    scheduledPublishTime: post.scheduled_publish_time ?? null,
  }));
}

export function encodeRemoteVersion(projectionFingerprint: string, remoteHash: string): string {
  return `bm1:${projectionFingerprint}:${remoteHash}`;
}

export function parseRemoteVersion(value: string | undefined): { desired: string; remote: string } | undefined {
  if (!value) return undefined;
  const match = /^bm1:([a-f0-9]{64}):([a-f0-9]{64})$/.exec(value);
  return match ? { desired: match[1], remote: match[2] } : undefined;
}
