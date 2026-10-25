import type { CompiledProjection, JsonValue } from "@blogmaatic/core";
import { parseImageTransformPlan } from "@blogmaatic/media";

import type { LinkedInProjectionPayload } from "./types.js";

function isRecord(value: JsonValue | undefined): value is Readonly<Record<string, JsonValue>> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireString(record: Readonly<Record<string, JsonValue>>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value) throw new Error(`LinkedIn projection payload requires ${key}`);
  return value;
}

export function parsePayload(projection: CompiledProjection): LinkedInProjectionPayload {
  if (!isRecord(projection.payload)) throw new Error("LinkedIn projection payload must be an object");
  const mode = requireString(projection.payload, "mode");
  if (mode !== "text" && mode !== "article" && mode !== "image") throw new Error(`Unsupported LinkedIn projection mode: ${mode}`);
  const commentary = requireString(projection.payload, "commentary");
  const fidelity = projection.payload.fidelity;
  if (!isRecord(fidelity)) throw new Error("LinkedIn projection payload requires fidelity report");
  const destinationId = requireString(fidelity, "destinationId");
  const score = fidelity.score;
  const exact = fidelity.exact;
  const sourceBlockCount = fidelity.sourceBlockCount;
  const representedBlockCount = fidelity.representedBlockCount;
  const issues = fidelity.issues;
  if (
    typeof score !== "number" ||
    typeof exact !== "boolean" ||
    typeof sourceBlockCount !== "number" ||
    typeof representedBlockCount !== "number" ||
    !Array.isArray(issues)
  ) {
    throw new Error("LinkedIn projection fidelity report is invalid");
  }

  let article: LinkedInProjectionPayload["article"];
  if (mode === "article") {
    const value = projection.payload.article;
    if (!isRecord(value)) throw new Error("LinkedIn article projection requires article metadata");
    const source = requireString(value, "source");
    const title = requireString(value, "title");
    const descriptionValue = value.description;
    article = {
      source,
      title,
      ...(typeof descriptionValue === "string" && descriptionValue ? { description: descriptionValue } : {}),
    };
  }

  let image: LinkedInProjectionPayload["image"];
  if (mode === "image") {
    const value = projection.payload.image;
    if (!isRecord(value)) throw new Error("LinkedIn image projection requires image metadata");
    const assetId = requireString(value, "assetId");
    const source = requireString(value, "source");
    const localPath = requireString(value, "localPath");
    const mediaType = requireString(value, "mediaType");
    if (mediaType !== "image/jpeg" && mediaType !== "image/png" && mediaType !== "image/webp") {
      throw new Error(`Unsupported LinkedIn image mediaType: ${mediaType}`);
    }
    const fingerprint = requireString(value, "fingerprint");
    const altValue = value.alt;
    image = {
      assetId,
      source,
      localPath,
      mediaType,
      ...(typeof altValue === "string" && altValue ? { alt: altValue } : {}),
      fingerprint,
      transform: parseImageTransformPlan(value.transform),
    };
  }

  return {
    mode,
    commentary,
    ...(article ? { article } : {}),
    ...(image ? { image } : {}),
    fidelity: {
      destinationId,
      score,
      exact,
      sourceBlockCount,
      representedBlockCount,
      issues: issues as unknown as LinkedInProjectionPayload["fidelity"]["issues"],
    },
  };
}
