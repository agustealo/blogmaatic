import type {
  ExtensionCapability,
  JsonValue,
  Publication,
  PublicationBlockKind,
  PublicationGroup,
  PublicationStatus,
} from "./types.js";

const publicationStatuses = new Set<PublicationStatus>([
  "idea",
  "draft",
  "ready",
  "approved",
  "queued",
  "publishing",
  "published",
  "archived",
]);

const blockKinds = new Set<PublicationBlockKind>([
  "heading",
  "paragraph",
  "image",
  "gallery",
  "quote",
  "code",
  "embed",
  "table",
  "callout",
]);

const assetKinds = new Set(["image", "video", "audio", "document", "other"] as const);
const capabilities = new Set<ExtensionCapability>([
  "article.create",
  "article.update",
  "article.delete",
  "article.inspect",
  "article.schedule",
  "article.draft",
  "asset.publish",
  "taxonomy.publish",
  "canonical.publish",
]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value;
}

function optionalString(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== "string") throw new Error(`${label} must be a string`);
}

function instant(value: unknown, label: string): void {
  const text = nonEmptyString(value, label);
  if (!Number.isFinite(Date.parse(text)) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(text)) {
    throw new Error(`${label} must be an ISO date-time with an offset or Z suffix`);
  }
}

function jsonValue(value: unknown, label: string): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} must contain only finite JSON numbers`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => jsonValue(entry, `${label}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) throw new Error(`${label}.${key} cannot be undefined`);
      jsonValue(entry, `${label}.${key}`);
    }
    return;
  }
  throw new Error(`${label} must be valid JSON data`);
}

function jsonRecord(value: unknown, label: string): void {
  record(value, label);
  jsonValue(value, label);
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => nonEmptyString(entry, `${label}[${index}]`));
}

export function validatePublication(publication: Publication): void {
  const root = record(publication, "publication");
  nonEmptyString(root.id, "publication.id");
  instant(root.createdAt, "publication.createdAt");
  optionalString(root.slug, "publication.slug");
  optionalString(root.canonicalUrl, "publication.canonicalUrl");
  if (!publicationStatuses.has(root.status as PublicationStatus)) {
    throw new Error("publication.status is invalid");
  }
  jsonRecord(root.provenance, "publication.provenance");

  const revision = record(root.current, "publication.current");
  nonEmptyString(revision.id, "publication.current.id");
  if (!Number.isSafeInteger(revision.ordinal) || (revision.ordinal as number) < 1) {
    throw new Error("publication.current.ordinal must be a positive integer");
  }
  instant(revision.createdAt, "publication.current.createdAt");

  const content = record(revision.content, "publication.current.content");
  if (content.schemaVersion !== 1) throw new Error("publication.current.content.schemaVersion must be 1");
  nonEmptyString(content.title, "publication.current.content.title");
  optionalString(content.summary, "publication.current.content.summary");
  nonEmptyString(content.language, "publication.current.content.language");
  stringArray(content.tags, "publication.current.content.tags");
  jsonRecord(content.attributes, "publication.current.content.attributes");

  if (!Array.isArray(content.blocks)) throw new Error("publication.current.content.blocks must be an array");
  const blockIds = new Set<string>();
  for (const [index, rawBlock] of content.blocks.entries()) {
    const block = record(rawBlock, `publication.current.content.blocks[${index}]`);
    const id = nonEmptyString(block.id, `publication.current.content.blocks[${index}].id`);
    if (blockIds.has(id)) throw new Error(`publication block id is duplicated: ${id}`);
    blockIds.add(id);
    if (!blockKinds.has(block.kind as PublicationBlockKind)) {
      throw new Error(`publication.current.content.blocks[${index}].kind is invalid`);
    }
    jsonRecord(block.data, `publication.current.content.blocks[${index}].data`);
  }

  if (!Array.isArray(content.assets)) throw new Error("publication.current.content.assets must be an array");
  const assetIds = new Set<string>();
  for (const [index, rawAsset] of content.assets.entries()) {
    const asset = record(rawAsset, `publication.current.content.assets[${index}]`);
    const id = nonEmptyString(asset.id, `publication.current.content.assets[${index}].id`);
    if (assetIds.has(id)) throw new Error(`publication asset id is duplicated: ${id}`);
    assetIds.add(id);
    if (!assetKinds.has(asset.kind as (typeof assetKinds extends Set<infer T> ? T : never))) {
      throw new Error(`publication.current.content.assets[${index}].kind is invalid`);
    }
    nonEmptyString(asset.source, `publication.current.content.assets[${index}].source`);
    optionalString(asset.mediaType, `publication.current.content.assets[${index}].mediaType`);
    optionalString(asset.alt, `publication.current.content.assets[${index}].alt`);
    if (asset.attributes !== undefined) {
      jsonRecord(asset.attributes, `publication.current.content.assets[${index}].attributes`);
    }
  }
}

export function validatePublicationGroup(group: PublicationGroup): void {
  const root = record(group, "publication group");
  nonEmptyString(root.id, "publication group.id");
  nonEmptyString(root.name, "publication group.name");
  nonEmptyString(root.policySetId, "publication group.policySetId");
  if (!Array.isArray(root.routes)) throw new Error("publication group.routes must be an array");
  const routeIds = new Set<string>();
  for (const [index, rawRoute] of root.routes.entries()) {
    const route = record(rawRoute, `publication group.routes[${index}]`);
    const id = nonEmptyString(route.id, `publication group.routes[${index}].id`);
    if (routeIds.has(id)) throw new Error(`publication route id is duplicated: ${id}`);
    routeIds.add(id);
    if (typeof route.enabled !== "boolean") throw new Error(`publication group.routes[${index}].enabled must be a boolean`);
    if (route.desiredState !== "present") throw new Error(`publication group.routes[${index}].desiredState must be present`);
    const destination = record(route.destination, `publication group.routes[${index}].destination`);
    nonEmptyString(destination.extensionId, `publication group.routes[${index}].destination.extensionId`);
    nonEmptyString(destination.connectionId, `publication group.routes[${index}].destination.connectionId`);
    nonEmptyString(destination.channel, `publication group.routes[${index}].destination.channel`);
    if (!Array.isArray(route.requiredCapabilities)) {
      throw new Error(`publication group.routes[${index}].requiredCapabilities must be an array`);
    }
    const seenCapabilities = new Set<string>();
    for (const [capabilityIndex, rawCapability] of route.requiredCapabilities.entries()) {
      const capability = nonEmptyString(rawCapability, `publication group.routes[${index}].requiredCapabilities[${capabilityIndex}]`);
      if (!capabilities.has(capability as ExtensionCapability)) {
        throw new Error(`publication group.routes[${index}] has unsupported capability ${capability}`);
      }
      if (seenCapabilities.has(capability)) {
        throw new Error(`publication group.routes[${index}] repeats capability ${capability}`);
      }
      seenCapabilities.add(capability);
    }
    if (route.variant !== undefined) jsonRecord(route.variant, `publication group.routes[${index}].variant`);
  }
}

export function validatePublicationGroups(groups: readonly PublicationGroup[]): void {
  if (!Array.isArray(groups)) throw new Error("publication groups must be an array");
  const groupIds = new Set<string>();
  for (const group of groups) {
    validatePublicationGroup(group);
    if (groupIds.has(group.id)) throw new Error(`publication group id is duplicated: ${group.id}`);
    groupIds.add(group.id);
  }
}
