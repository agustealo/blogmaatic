import type {
  JsonValue,
  Publication,
  PublicationAsset,
  PublicationBlock,
  PublicationRoute,
} from "@blogmaatic/core";

import { FINGERPRINT_KEY } from "./fingerprint.js";
import { getNumber, getString, isRecord } from "./json.js";
import { safeSegment } from "./path-safety.js";
import type { JekyllGitSettings } from "./types.js";

function blockAsset(block: PublicationBlock, publication: Publication): PublicationAsset | undefined {
  const assetId = getString(block.data, "assetId");
  return assetId
    ? publication.current.content.assets.find((asset) => asset.id === assetId)
    : undefined;
}

function renderTable(block: PublicationBlock): string {
  const headersValue = block.data.headers;
  const rowsValue = block.data.rows;
  const headers = Array.isArray(headersValue)
    ? headersValue.filter((entry): entry is string => typeof entry === "string")
    : [];
  const rows = Array.isArray(rowsValue)
    ? rowsValue
        .filter(Array.isArray)
        .map((row) => row.map((entry) => (typeof entry === "object" ? JSON.stringify(entry) : String(entry ?? ""))))
    : [];
  if (headers.length === 0) return "";
  const escapeCell = (value: string) => value.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const header = `| ${headers.map(escapeCell).join(" | ")} |`;
  const separator = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map(
    (row) => `| ${headers.map((_, index) => escapeCell(row[index] ?? "")).join(" | ")} |`,
  );
  return [header, separator, ...body].join("\n");
}

function renderBlock(
  block: PublicationBlock,
  publication: Publication,
  publishedAssets: ReadonlyMap<string, string>,
): string {
  switch (block.kind) {
    case "heading": {
      const level = Math.min(6, Math.max(1, Math.trunc(getNumber(block.data, "level") ?? 2)));
      return `${"#".repeat(level)} ${getString(block.data, "text") ?? ""}`.trimEnd();
    }
    case "paragraph":
      return getString(block.data, "text") ?? "";
    case "image": {
      const asset = blockAsset(block, publication);
      const source =
        getString(block.data, "src") ??
        (asset ? publishedAssets.get(asset.id) ?? asset.source : "");
      const alt = getString(block.data, "alt") ?? asset?.alt ?? "";
      const title = getString(block.data, "title");
      if (!source) return "";
      return `![${alt.replace(/\]/g, "\\]")}](${source}${title ? ` ${JSON.stringify(title)}` : ""})`;
    }
    case "gallery": {
      const items = block.data.items;
      if (!Array.isArray(items)) return "";
      return items
        .filter(isRecord)
        .map((item) => {
          const assetId = getString(item, "assetId");
          const asset = assetId
            ? publication.current.content.assets.find((candidate) => candidate.id === assetId)
            : undefined;
          const src =
            getString(item, "src") ??
            (asset ? publishedAssets.get(asset.id) ?? asset.source : "");
          const alt = getString(item, "alt") ?? asset?.alt ?? "";
          return src ? `![${alt.replace(/\]/g, "\\]")}](${src})` : "";
        })
        .filter(Boolean)
        .join("\n\n");
    }
    case "quote": {
      const text = getString(block.data, "text") ?? "";
      const attribution = getString(block.data, "attribution");
      const lines = text.split("\n").map((line) => `> ${line}`);
      if (attribution) lines.push(`>\n> — ${attribution}`);
      return lines.join("\n");
    }
    case "code": {
      const language = getString(block.data, "language") ?? "";
      const code = getString(block.data, "code") ?? "";
      return `\`\`\`${language}\n${code}\n\`\`\``;
    }
    case "embed": {
      const html = getString(block.data, "html");
      if (html) return html;
      const url = getString(block.data, "url");
      return url ? `<${url}>` : "";
    }
    case "table":
      return renderTable(block);
    case "callout": {
      const label = (getString(block.data, "label") ?? "Note").toUpperCase();
      const text = getString(block.data, "text") ?? "";
      return text
        .split("\n")
        .map((line, index) => `> ${index === 0 ? `**${label}:** ` : ""}${line}`)
        .join("\n");
    }
  }
}

function markdownBody(
  publication: Publication,
  publishedAssets: ReadonlyMap<string, string>,
): string {
  return `${publication.current.content.blocks
    .map((block) => renderBlock(block, publication, publishedAssets).trim())
    .filter(Boolean)
    .join("\n\n")}\n`;
}

function routeVariant(route: PublicationRoute): Readonly<Record<string, JsonValue>> {
  return route.variant ?? {};
}

function protectedFrontMatterKey(key: string): boolean {
  return new Set([
    "layout",
    "title",
    "date",
    "tags",
    "slug",
    "permalink",
    "canonical_url",
    "blogmaatic_publication_id",
    "blogmaatic_revision_id",
    FINGERPRINT_KEY,
  ]).has(key);
}

function extraFrontMatter(route: PublicationRoute): readonly [string, JsonValue][] {
  const candidate = routeVariant(route).frontMatter;
  if (!isRecord(candidate)) return [];
  return Object.entries(candidate)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) {
        throw new Error(`Invalid front matter key: ${key}`);
      }
      if (protectedFrontMatterKey(key)) {
        throw new Error(`Front matter key is managed by Blogmaatic: ${key}`);
      }
      return [key, value] as const;
    });
}

function publicationDate(publication: Publication): string {
  const date = new Date(publication.createdAt);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Publication has invalid createdAt: ${publication.createdAt}`);
  }
  return date.toISOString();
}

export function relativeDocumentPath(
  publication: Publication,
  route: PublicationRoute,
  settings: JekyllGitSettings,
): string {
  const slug = safeSegment(publication.id);
  if (route.destination.channel === "posts") {
    return `${settings.postsDirectory}/${publicationDate(publication).slice(0, 10)}-${slug}.md`;
  }
  if (route.destination.channel === "drafts") {
    return `${settings.draftsDirectory}/${slug}.md`;
  }
  throw new Error(`Jekyll/Git channel must be posts or drafts, got: ${route.destination.channel}`);
}

export function projectionPublicUrl(
  route: PublicationRoute,
  settings: JekyllGitSettings,
): string | undefined {
  if (!settings.siteBaseUrl) return undefined;
  const permalink = getString(routeVariant(route), "permalink");
  if (!permalink) return undefined;
  return `${settings.siteBaseUrl.replace(/\/+$/, "")}/${permalink.replace(/^\/+/, "")}`;
}

export function canonicalDocument(
  publication: Publication,
  route: PublicationRoute,
  publishedAssets: ReadonlyMap<string, string>,
): string {
  const variant = routeVariant(route);
  const layout = getString(variant, "layout") ?? "post";
  const slug = getString(variant, "slug") ?? safeSegment(publication.slug ?? publication.id);
  const permalink = getString(variant, "permalink");
  const lines = [
    "---",
    `layout: ${JSON.stringify(layout)}`,
    `title: ${JSON.stringify(publication.current.content.title)}`,
    `date: ${JSON.stringify(publicationDate(publication))}`,
    `tags: ${JSON.stringify(publication.current.content.tags)}`,
    `slug: ${JSON.stringify(slug)}`,
    `blogmaatic_publication_id: ${JSON.stringify(publication.id)}`,
    `blogmaatic_revision_id: ${JSON.stringify(publication.current.id)}`,
  ];
  if (permalink) lines.push(`permalink: ${JSON.stringify(permalink)}`);
  if (publication.canonicalUrl) {
    lines.push(`canonical_url: ${JSON.stringify(publication.canonicalUrl)}`);
  }
  for (const [key, value] of extraFrontMatter(route)) {
    lines.push(`${key}: ${JSON.stringify(value)}`);
  }
  lines.push("---", "", markdownBody(publication, publishedAssets));
  return lines.join("\n");
}
