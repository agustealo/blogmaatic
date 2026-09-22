import { createHash } from "node:crypto";

export interface OwnershipMarker {
  readonly version: 1;
  readonly publicationId: string;
  readonly routeId: string;
  readonly projectionFingerprint: string;
  readonly renderedHash: string;
}

const MARKER_PATTERN = /<!--\s*blogmaatic:([A-Za-z0-9_-]+)\s*-->/;

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function projectionFingerprint(value: unknown): string {
  return sha256(stableJson(value));
}

export function encodeMarker(marker: OwnershipMarker): string {
  const encoded = Buffer.from(JSON.stringify(marker), "utf8").toString("base64url");
  return `<!-- blogmaatic:${encoded} -->`;
}

export function parseMarker(content: string): OwnershipMarker | undefined {
  const match = MARKER_PATTERN.exec(content);
  if (!match?.[1]) return undefined;
  try {
    const value = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")) as Partial<OwnershipMarker>;
    if (
      value.version !== 1 ||
      typeof value.publicationId !== "string" ||
      typeof value.routeId !== "string" ||
      typeof value.projectionFingerprint !== "string" ||
      typeof value.renderedHash !== "string"
    ) {
      return undefined;
    }
    return value as OwnershipMarker;
  } catch {
    return undefined;
  }
}

export function stripMarker(content: string): string {
  return content.replace(MARKER_PATTERN, "").replace(/^\s*\n/, "");
}

export function documentWithMarker(body: string, marker: OwnershipMarker): string {
  return `${encodeMarker(marker)}\n${body}`;
}
