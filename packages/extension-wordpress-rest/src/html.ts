import type { Publication, PublicationAsset, PublicationBlock } from "@blogmaatic/core";

import { getNumber, getString, isRecord } from "./json.js";

export const ASSET_TOKEN_PREFIX = "__BLOGMAATIC_ASSET__";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function paragraphText(value: string): string {
  return escapeHtml(value).replace(/\n/g, "<br>\n");
}

function blockAsset(block: PublicationBlock, publication: Publication): PublicationAsset | undefined {
  const assetId = getString(block.data, "assetId");
  return assetId
    ? publication.current.content.assets.find((asset) => asset.id === assetId)
    : undefined;
}

function assetSource(asset: PublicationAsset | undefined, explicit?: string): string {
  if (explicit) return explicit;
  if (!asset) return "";
  if (/^https?:\/\//i.test(asset.source)) return asset.source;
  return `${ASSET_TOKEN_PREFIX}${asset.id}__`;
}

function renderTable(block: PublicationBlock): string {
  const headers = Array.isArray(block.data.headers)
    ? block.data.headers.filter((entry): entry is string => typeof entry === "string")
    : [];
  const rows = Array.isArray(block.data.rows)
    ? block.data.rows.filter(Array.isArray)
    : [];
  if (headers.length === 0) return "";
  const head = `<thead><tr>${headers.map((value) => `<th>${escapeHtml(value)}</th>`).join("")}</tr></thead>`;
  const body = `<tbody>${rows
    .map(
      (row) =>
        `<tr>${headers
          .map((_, index) => {
            const entry = row[index];
            const value =
              typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean"
                ? String(entry)
                : entry === null || entry === undefined
                  ? ""
                  : JSON.stringify(entry);
            return `<td>${escapeHtml(value)}</td>`;
          })
          .join("")}</tr>`,
    )
    .join("")}</tbody>`;
  return `<table>${head}${body}</table>`;
}

function renderBlock(block: PublicationBlock, publication: Publication): string {
  switch (block.kind) {
    case "heading": {
      const level = Math.min(6, Math.max(1, Math.trunc(getNumber(block.data, "level") ?? 2)));
      return `<h${level}>${escapeHtml(getString(block.data, "text") ?? "")}</h${level}>`;
    }
    case "paragraph":
      return `<p>${paragraphText(getString(block.data, "text") ?? "")}</p>`;
    case "image": {
      const asset = blockAsset(block, publication);
      const src = assetSource(asset, getString(block.data, "src"));
      if (!src) return "";
      const alt = getString(block.data, "alt") ?? asset?.alt ?? "";
      const caption = getString(block.data, "caption");
      const image = `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}">`;
      const assetAttr = asset ? ` data-blogmaatic-asset-id="${escapeHtml(asset.id)}"` : "";
      return `<figure${assetAttr}>${image}${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ""}</figure>`;
    }
    case "gallery": {
      const items = block.data.items;
      if (!Array.isArray(items)) return "";
      const rendered = items
        .filter(isRecord)
        .map((item) => {
          const assetId = getString(item, "assetId");
          const asset = assetId
            ? publication.current.content.assets.find((candidate) => candidate.id === assetId)
            : undefined;
          const src = assetSource(asset, getString(item, "src"));
          if (!src) return "";
          const alt = getString(item, "alt") ?? asset?.alt ?? "";
          const assetAttr = asset ? ` data-blogmaatic-asset-id="${escapeHtml(asset.id)}"` : "";
          return `<figure${assetAttr}><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"></figure>`;
        })
        .filter(Boolean)
        .join("\n");
      return rendered ? `<div class="blogmaatic-gallery">${rendered}</div>` : "";
    }
    case "quote": {
      const text = getString(block.data, "text") ?? "";
      const attribution = getString(block.data, "attribution");
      return `<blockquote><p>${paragraphText(text)}</p>${attribution ? `<cite>${escapeHtml(attribution)}</cite>` : ""}</blockquote>`;
    }
    case "code": {
      const language = getString(block.data, "language");
      const code = getString(block.data, "code") ?? "";
      return `<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ""}>${escapeHtml(code)}</code></pre>`;
    }
    case "embed": {
      const html = getString(block.data, "html");
      if (html) return html;
      const url = getString(block.data, "url");
      return url ? `<p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>` : "";
    }
    case "table":
      return renderTable(block);
    case "callout": {
      const label = getString(block.data, "label") ?? "Note";
      const text = getString(block.data, "text") ?? "";
      return `<aside class="blogmaatic-callout"><strong>${escapeHtml(label)}:</strong> ${paragraphText(text)}</aside>`;
    }
  }
}

export function htmlBody(publication: Publication): string {
  return `${publication.current.content.blocks
    .map((block) => renderBlock(block, publication).trim())
    .filter(Boolean)
    .join("\n\n")}\n`;
}

export function injectAssetUrls(
  template: string,
  urls: ReadonlyMap<string, string>,
): string {
  return template.replace(/__BLOGMAATIC_ASSET__([A-Za-z0-9._:-]+)__/g, (match, assetId: string) => {
    const url = urls.get(assetId);
    if (!url) throw new Error(`Published URL is unavailable for asset: ${assetId}`);
    return escapeHtml(url);
  });
}
