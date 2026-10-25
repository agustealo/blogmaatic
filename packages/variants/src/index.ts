import type {
  Publication,
  PublicationAsset,
  PublicationBlock,
  PublicationBlockKind,
  PublicationRoute,
} from "@blogmaatic/core";

export type FidelitySeverity = "info" | "warning" | "loss";

export interface FidelityIssue {
  readonly code: string;
  readonly severity: FidelitySeverity;
  readonly detail: string;
  readonly blockId?: string;
}

export interface FidelityReport {
  readonly destinationId: string;
  readonly score: number;
  readonly exact: boolean;
  readonly sourceBlockCount: number;
  readonly representedBlockCount: number;
  readonly issues: readonly FidelityIssue[];
}

export interface SocialCapabilityProfile {
  readonly id: string;
  readonly maxCommentaryChars: number;
  readonly maxImages: number;
  readonly supportsArticleCard: boolean;
  readonly supportedBlockKinds: readonly PublicationBlockKind[];
}

export interface SocialVariantPolicy {
  readonly mode: "text" | "article";
  readonly includeTitle?: boolean;
  readonly includeSummary?: boolean;
  readonly includeCanonicalUrl?: boolean;
  readonly includeHashtags?: boolean;
  readonly maxHashtags?: number;
  readonly overflow?: "truncate" | "error";
}

export interface SocialArticleVariant {
  readonly source: string;
  readonly title: string;
  readonly description?: string;
}

export interface AdaptedSocialVariant {
  readonly commentary: string;
  readonly imageAssets: readonly PublicationAsset[];
  readonly article?: SocialArticleVariant;
  readonly fidelity: FidelityReport;
}

export interface SocialDestinationVariantOverride {
  readonly commentaryMode: "inherit" | "override";
  readonly commentary?: string;
  readonly mediaMode: "inherit" | "none" | "select";
  readonly imageAssetIds?: readonly string[];
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

export function socialDestinationVariantOverride(
  publication: Publication,
  route: PublicationRoute,
  groupId?: string,
): SocialDestinationVariantOverride | undefined {
  if (!groupId) return undefined;
  const root = recordValue(publication.current.content.attributes.destinationOverrides);
  const groups = recordValue(root?.groups);
  const group = recordValue(groups?.[groupId]);
  const routes = recordValue(group?.routes);
  const scopedRoute = recordValue(routes?.[route.id]);
  if (!scopedRoute) return undefined;
  if (
    scopedRoute.extensionId !== route.destination.extensionId ||
    scopedRoute.connectionId !== route.destination.connectionId ||
    scopedRoute.channel !== route.destination.channel
  ) {
    throw new Error("Canonical destination override identity no longer matches social route");
  }
  const social = recordValue(scopedRoute.socialVariant);
  if (!social) return scopedRoute.socialVariant === undefined
    ? undefined
    : (() => { throw new Error("Canonical social destination variant must be an object"); })();

  if (
    social.extensionId !== route.destination.extensionId ||
    social.connectionId !== route.destination.connectionId ||
    social.channel !== route.destination.channel
  ) {
    throw new Error("Canonical social variant identity no longer matches route");
  }
  const commentaryMode = social.commentaryMode;
  if (commentaryMode !== "inherit" && commentaryMode !== "override") {
    throw new Error("Canonical social commentary mode is invalid");
  }
  let commentary: string | undefined;
  if (commentaryMode === "override") {
    if (typeof social.commentary !== "string") {
      throw new Error("Canonical social commentary override requires commentary");
    }
    commentary = social.commentary;
  } else if (social.commentary !== undefined) {
    throw new Error("Canonical social commentary is only valid in override mode");
  }

  const mediaMode = social.mediaMode;
  if (mediaMode !== "inherit" && mediaMode !== "none" && mediaMode !== "select") {
    throw new Error("Canonical social media mode is invalid");
  }
  let imageAssetIds: readonly string[] | undefined;
  if (mediaMode === "select") {
    if (!Array.isArray(social.imageAssetIds) || social.imageAssetIds.length === 0) {
      throw new Error("Canonical social media select mode requires imageAssetIds");
    }
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const value of social.imageAssetIds) {
      if (typeof value !== "string" || !value.trim()) {
        throw new Error("Canonical social imageAssetIds must contain non-empty strings");
      }
      const assetId = value.trim();
      if (!seen.has(assetId)) {
        seen.add(assetId);
        normalized.push(assetId);
      }
    }
    imageAssetIds = normalized;
  } else if (social.imageAssetIds !== undefined) {
    throw new Error("Canonical social imageAssetIds are only valid in select mode");
  }

  return {
    commentaryMode,
    ...(commentary === undefined ? {} : { commentary }),
    mediaMode,
    ...(imageAssetIds === undefined ? {} : { imageAssetIds }),
  };
}

export function selectedSocialImageAssets(
  publication: Publication,
  imageAssetIds: readonly string[],
): readonly PublicationAsset[] {
  return imageAssetIds.map((assetId) => {
    const asset = publication.current.content.assets.find((candidate) => candidate.id === assetId);
    if (!asset) throw new Error(`Canonical social image asset does not exist: ${assetId}`);
    if (asset.kind !== "image") throw new Error(`Canonical social media selection must contain only images: ${assetId}`);
    return asset;
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function imageAssetForBlock(block: PublicationBlock, publication: Publication): PublicationAsset | undefined {
  const assetId = stringValue(block.data.assetId);
  if (!assetId) return undefined;
  return publication.current.content.assets.find((asset) => asset.id === assetId && asset.kind === "image");
}

function imageAssetsForGallery(block: PublicationBlock, publication: Publication): readonly PublicationAsset[] {
  if (!Array.isArray(block.data.items)) return [];
  const seen = new Set<string>();
  const assets: PublicationAsset[] = [];
  for (const item of block.data.items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const assetId = stringValue((item as Readonly<Record<string, unknown>>).assetId);
    if (!assetId || seen.has(assetId)) continue;
    const asset = publication.current.content.assets.find((candidate) => candidate.id === assetId && candidate.kind === "image");
    if (asset) {
      seen.add(asset.id);
      assets.push(asset);
    }
  }
  return assets;
}

function tableText(block: PublicationBlock): string {
  const headers = Array.isArray(block.data.headers)
    ? block.data.headers.filter((value): value is string => typeof value === "string")
    : [];
  const rows = Array.isArray(block.data.rows) ? block.data.rows.filter(Array.isArray) : [];
  return rows
    .map((row) =>
      headers
        .map((header, index) => `${header}: ${String(row[index] ?? "")}`)
        .join(" | "),
    )
    .join("\n");
}

function blockText(block: PublicationBlock): { text: string; lossy: boolean } {
  switch (block.kind) {
    case "heading":
    case "paragraph":
      return { text: stringValue(block.data.text) ?? "", lossy: block.kind === "heading" };
    case "quote": {
      const text = stringValue(block.data.text) ?? "";
      const attribution = stringValue(block.data.attribution);
      return { text: attribution ? `${text}\n— ${attribution}` : text, lossy: true };
    }
    case "code":
      return { text: stringValue(block.data.code) ?? "", lossy: true };
    case "embed":
      return { text: stringValue(block.data.url) ?? "", lossy: true };
    case "table":
      return { text: tableText(block), lossy: true };
    case "callout": {
      const label = stringValue(block.data.label) ?? "Note";
      const text = stringValue(block.data.text) ?? "";
      return { text: text ? `${label}: ${text}` : "", lossy: true };
    }
    case "image":
    case "gallery":
      return { text: "", lossy: false };
  }
}

function hashtag(tag: string): string | undefined {
  const normalized = tag.normalize("NFKD").replace(/[^\p{L}\p{N}_]+/gu, "");
  return normalized ? `#${normalized}` : undefined;
}

function truncateWithSuffix(body: string, suffix: string, limit: number): string {
  if (body.length + suffix.length <= limit) return `${body}${suffix}`;
  if (suffix.length >= limit) return suffix.slice(0, limit);
  const available = Math.max(0, limit - suffix.length - 1);
  const clipped = body.slice(0, available).trimEnd();
  return `${clipped}…${suffix}`.slice(0, limit);
}

export function adaptPublicationForSocial(
  publication: Publication,
  profile: SocialCapabilityProfile,
  policy: SocialVariantPolicy,
): AdaptedSocialVariant {
  if (profile.maxCommentaryChars <= 0) throw new Error("Destination maxCommentaryChars must be positive");
  if (profile.maxImages < 0) throw new Error("Destination maxImages cannot be negative");

  const issues: FidelityIssue[] = [];
  const supported = new Set(profile.supportedBlockKinds);
  const paragraphs: string[] = [];
  const imageAssets: PublicationAsset[] = [];
  const seenAssets = new Set<string>();
  let represented = 0;

  for (const block of publication.current.content.blocks) {
    const text = blockText(block);
    const blockSupported = supported.has(block.kind);
    if (!blockSupported) {
      issues.push({
        code: "block.unsupported",
        severity: "loss",
        blockId: block.id,
        detail: `Destination ${profile.id} does not natively support ${block.kind}`,
      });
    } else if (text.lossy) {
      issues.push({
        code: "block.flattened",
        severity: "warning",
        blockId: block.id,
        detail: `${block.kind} formatting is flattened into social commentary`,
      });
    }

    if (text.text.trim()) {
      paragraphs.push(text.text.trim());
      represented += 1;
    }

    const candidates = block.kind === "image"
      ? [imageAssetForBlock(block, publication)].filter((asset): asset is PublicationAsset => Boolean(asset))
      : block.kind === "gallery"
        ? imageAssetsForGallery(block, publication)
        : [];
    for (const asset of candidates) {
      if (!seenAssets.has(asset.id)) {
        seenAssets.add(asset.id);
        imageAssets.push(asset);
      }
    }
    if ((block.kind === "image" || block.kind === "gallery") && candidates.length > 0) represented += 1;
  }

  const selectedImages = imageAssets.slice(0, profile.maxImages);
  if (imageAssets.length > profile.maxImages) {
    issues.push({
      code: "media.images_dropped",
      severity: "loss",
      detail: `${imageAssets.length - profile.maxImages} image(s) exceed the destination media limit`,
    });
  }

  const prefix: string[] = [];
  if (policy.includeTitle !== false) prefix.push(publication.current.content.title);
  if (policy.includeSummary && publication.current.content.summary) prefix.push(publication.current.content.summary);
  const bodyParts = [...prefix, ...paragraphs].filter(Boolean);
  let body = bodyParts.join("\n\n").trim();

  let article: SocialArticleVariant | undefined;
  if (policy.mode === "article") {
    if (!profile.supportsArticleCard) {
      issues.push({
        code: "article.unsupported",
        severity: "loss",
        detail: `Destination ${profile.id} does not support article cards`,
      });
    } else if (!publication.canonicalUrl) {
      issues.push({
        code: "article.missing_canonical",
        severity: "loss",
        detail: "Article mode requires publication.canonicalUrl",
      });
    } else {
      article = {
        source: publication.canonicalUrl,
        title: publication.current.content.title,
        ...(publication.current.content.summary ? { description: publication.current.content.summary } : {}),
      };
    }
  }

  const suffixParts: string[] = [];
  if (policy.includeCanonicalUrl && publication.canonicalUrl) suffixParts.push(publication.canonicalUrl);
  if (policy.includeHashtags) {
    const maxHashtags = Math.max(0, Math.trunc(policy.maxHashtags ?? 5));
    const tags = publication.current.content.tags
      .map(hashtag)
      .filter((value): value is string => Boolean(value))
      .slice(0, maxHashtags);
    if (tags.length > 0) suffixParts.push(tags.join(" "));
  }
  const suffix = suffixParts.length > 0 ? `\n\n${suffixParts.join("\n")}` : "";

  if (body.length + suffix.length > profile.maxCommentaryChars) {
    if ((policy.overflow ?? "truncate") === "error") {
      throw new Error(`Social commentary exceeds ${profile.maxCommentaryChars} characters for ${profile.id}`);
    }
    body = truncateWithSuffix(body, suffix, profile.maxCommentaryChars);
    issues.push({
      code: "commentary.truncated",
      severity: "loss",
      detail: `Commentary was truncated to ${profile.maxCommentaryChars} characters`,
    });
  } else {
    body = `${body}${suffix}`;
  }

  const lossCount = issues.filter((issue) => issue.severity === "loss").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  const score = Math.max(0, 100 - lossCount * 12 - warningCount * 4);
  const fidelity: FidelityReport = {
    destinationId: profile.id,
    score,
    exact: issues.length === 0,
    sourceBlockCount: publication.current.content.blocks.length,
    representedBlockCount: Math.min(represented, publication.current.content.blocks.length),
    issues,
  };

  return {
    commentary: body,
    imageAssets: selectedImages,
    ...(article ? { article } : {}),
    fidelity,
  };
}
