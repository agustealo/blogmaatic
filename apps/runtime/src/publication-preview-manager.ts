import type { JsonValue } from "@blogmaatic/core";
import type {
  OperatorPublicationPreviewManager,
  PublicationProjectionPreview,
  PublicationProjectionPreviewItem,
  ProjectionPreviewSummary,
} from "@blogmaatic/operator-api";
import type { ExtensionRuntime } from "@blogmaatic/extension-sdk";

import type { PublicationGroupManager } from "./publication-group-manager.js";
import type { PublicationWorkspaceManager } from "./publication-workspace-manager.js";

const REDACTED_KEYS = /(?:secret|token|password|authorization|localPath|sourcePath)$/i;
const SUMMARY_TEXT_KEYS = ["commentary", "message", "bodyTemplate", "content"] as const;

function jsonRecord(value: JsonValue): Readonly<Record<string, JsonValue>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, JsonValue>>
    : undefined;
}

function sanitizeJson(value: JsonValue, depth = 0): JsonValue {
  if (depth > 10) return "[preview depth limit]";
  if (Array.isArray(value)) return value.map((item) => sanitizeJson(item, depth + 1));
  const record = jsonRecord(value);
  if (!record) return value;
  const output: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(record)) {
    if (REDACTED_KEYS.test(key)) continue;
    output[key] = sanitizeJson(item, depth + 1);
  }
  return output;
}

function stringValue(record: Readonly<Record<string, JsonValue>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(record: Readonly<Record<string, JsonValue>>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(record: Readonly<Record<string, JsonValue>>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function previewSummary(payload: JsonValue): ProjectionPreviewSummary {
  const record = jsonRecord(payload);
  if (!record) return {};
  const text = SUMMARY_TEXT_KEYS.map((key) => stringValue(record, key)).find(Boolean);
  const imageItems = Array.isArray(record.images) ? record.images : [];
  const assetItems = Array.isArray(record.assets) ? record.assets : [];
  const singleImage = jsonRecord(record.image ?? null);
  const images = imageItems.length + (singleImage ? 1 : 0);
  const assets = assetItems.length;
  const mediaItems: JsonValue[] = [
    ...imageItems,
    ...assetItems,
    ...(singleImage ? [singleImage as unknown as JsonValue] : []),
  ];
  const media = mediaItems.flatMap((item) => {
    const asset = jsonRecord(item);
    if (!asset) return [];
    const transform = jsonRecord(asset.transform ?? null);
    if (!transform) return [];
    const source = jsonRecord(transform.source ?? null);
    const output = jsonRecord(transform.output ?? null);
    const spec = jsonRecord(transform.spec ?? null);
    return [{
      ...(stringValue(asset, "assetId") ? { assetId: stringValue(asset, "assetId")! } : {}),
      ...(source && numberValue(source, "width") !== undefined ? { sourceWidth: numberValue(source, "width")! } : {}),
      ...(source && numberValue(source, "height") !== undefined ? { sourceHeight: numberValue(source, "height")! } : {}),
      ...(source && stringValue(source, "mediaType") ? { sourceMediaType: stringValue(source, "mediaType")! } : {}),
      ...(output && numberValue(output, "width") !== undefined ? { outputWidth: numberValue(output, "width")! } : {}),
      ...(output && numberValue(output, "height") !== undefined ? { outputHeight: numberValue(output, "height")! } : {}),
      ...(output && stringValue(output, "mediaType") ? { outputMediaType: stringValue(output, "mediaType")! } : {}),
      ...(spec && stringValue(spec, "fit") ? { fit: stringValue(spec, "fit")! } : {}),
      ...(booleanValue(transform, "renderRequired") === undefined ? {} : { renderRequired: booleanValue(transform, "renderRequired")! }),
      ...(stringValue(transform, "transformationFingerprint") ? { transformationFingerprint: stringValue(transform, "transformationFingerprint")! } : {}),
      ...(stringValue(transform, "derivedAssetId") ? { derivedAssetId: stringValue(transform, "derivedAssetId")! } : {}),
    }];
  });
  const fidelity = jsonRecord(record.fidelity ?? null);
  const score = fidelity ? numberValue(fidelity, "score") : undefined;
  const exact = fidelity ? booleanValue(fidelity, "exact") : undefined;
  const issues = fidelity?.issues;

  return {
    ...(stringValue(record, "title") ? { title: stringValue(record, "title")! } : {}),
    ...(text ? { text: text.length > 12000 ? `${text.slice(0, 12000)}…` : text } : {}),
    ...(stringValue(record, "mode") ? { mode: stringValue(record, "mode")! } : {}),
    ...(stringValue(record, "status") ? { status: stringValue(record, "status")! } : {}),
    ...(stringValue(record, "relativePath") ? { path: stringValue(record, "relativePath")! } : {}),
    ...(stringValue(record, "publicUrl") ? { publicUrl: stringValue(record, "publicUrl")! } : {}),
    ...(stringValue(record, "link") ? { publicUrl: stringValue(record, "link")! } : {}),
    ...(stringValue(record, "scheduledAt") ? { scheduledAt: stringValue(record, "scheduledAt")! } : {}),
    ...(images + assets > 0 ? { mediaCount: images + assets } : {}),
    ...(media.length > 0 ? { media } : {}),
    ...(score === undefined ? {} : {
      fidelity: {
        score,
        ...(exact === undefined ? {} : { exact }),
        ...(issues === undefined ? {} : { issues: sanitizeJson(issues) }),
      },
    }),
  };
}

export interface PublicationPreviewManagerOptions {
  readonly publications: PublicationWorkspaceManager;
  readonly publicationGroups: PublicationGroupManager;
  readonly extensions: ExtensionRuntime;
}

export class PublicationPreviewManager implements OperatorPublicationPreviewManager {
  readonly #publications: PublicationWorkspaceManager;
  readonly #publicationGroups: PublicationGroupManager;
  readonly #extensions: ExtensionRuntime;

  constructor(options: PublicationPreviewManagerOptions) {
    this.#publications = options.publications;
    this.#publicationGroups = options.publicationGroups;
    this.#extensions = options.extensions;
  }

  async preview(publicationId: string, groupId: string): Promise<PublicationProjectionPreview> {
    const [publicationEntry, groupEntry] = await Promise.all([
      this.#publications.get(publicationId),
      this.#publicationGroups.get(groupId),
    ]);
    if (!publicationEntry) throw new Error(`Publication is not registered: ${publicationId}`);
    if (!groupEntry) throw new Error(`Publication group is not registered: ${groupId}`);
    if (!groupEntry.enabled) throw new Error(`Publication group is disabled: ${groupId}`);

    const publication = publicationEntry.publication;
    const items: PublicationProjectionPreviewItem[] = [];

    for (const route of groupEntry.group.routes.filter((candidate) => candidate.enabled)) {
      const extension = this.#extensions.getPublisher(route.destination.extensionId);
      const connection = this.#extensions.connections.get(route.destination.connectionId);
      const destination = {
        extensionId: route.destination.extensionId,
        extensionName: extension.manifest.displayName,
        connectionId: route.destination.connectionId,
        connectionName: connection.displayName,
        channel: route.destination.channel,
      } as const;

      try {
        this.#extensions.publishers.assertCapabilities(route.destination.extensionId, route.requiredCapabilities);
        const projection = await extension.compile({ publication, route, groupId: groupEntry.group.id });
        const sanitizedPayload = sanitizeJson(projection.payload);
        items.push({
          status: "ready",
          routeId: route.id,
          destination,
          projectionId: projection.projectionId,
          sourceRevisionId: projection.sourceRevisionId,
          fingerprint: projection.fingerprint,
          payload: sanitizedPayload,
          summary: previewSummary(sanitizedPayload),
        });
      } catch (error) {
        items.push({
          status: "error",
          routeId: route.id,
          destination,
          sourceRevisionId: publication.current.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      publicationId: publication.id,
      revisionId: publication.current.id,
      revisionOrdinal: publication.current.ordinal,
      groupId: groupEntry.group.id,
      groupName: groupEntry.group.name,
      items,
    };
  }
}
