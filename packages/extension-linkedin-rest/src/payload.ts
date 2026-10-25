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
  if (mode !== "text" && mode !== "article") throw new Error(`Unsupported LinkedIn projection mode: ${mode}`);
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
  const imageValue = projection.payload.image;
  if (imageValue !== undefined) {
    if (!isRecord(imageValue)) throw new Error("LinkedIn projection image must be an object");
    const assetId = requireString(imageValue, "assetId");
    const localPath = requireString(imageValue, "localPath");
    const mediaType = requireString(imageValue, "mediaType");
    if (mediaType !== "image/jpeg" && mediaType !== "image/png") {
      throw new Error(`LinkedIn projection image mediaType is unsupported: ${mediaType}`);
    }
    const fingerprint = requireString(imageValue, "fingerprint");
    const transformValue = imageValue.transform;
    if (transformValue === undefined) throw new Error("LinkedIn projection image requires transform plan");
    const transform = parseImageTransformPlan(transformValue);
    const altValue = imageValue.alt;
    image = {
      assetId,
      localPath,
      mediaType,
      ...(typeof altValue === "string" && altValue ? { alt: altValue } : {}),
      fingerprint,
      transform,
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
