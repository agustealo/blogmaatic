import type { PublicationBlock } from "@blogmaatic/core";
import { parse } from "@wordpress/block-serialization-default-parser";

interface ParsedWordPressBlock {
  readonly blockName: string | null;
  readonly attrs: Readonly<Record<string, unknown>> | null;
  readonly innerBlocks: readonly ParsedWordPressBlock[];
  readonly innerHTML: string;
  readonly innerContent?: readonly (string | null)[];
}

const GUTENBERG_DELIMITER = /<!--\s*\/?wp:/i;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const GUTENBERG_COMMENT = /^<!--\s*(\/?)wp:([A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)?)(?:\s+(\{[\s\S]*\}))?\s*(\/?)-->$/;

function validGutenbergCommentStructure(contentHtml: string): boolean {
  const stack: string[] = [];
  let sawGutenberg = false;
  for (const comment of contentHtml.match(HTML_COMMENT) ?? []) {
    if (!/<!--\s*\/?wp:/i.test(comment)) continue;
    sawGutenberg = true;
    const match = comment.match(GUTENBERG_COMMENT);
    if (!match?.[2]) return false;
    const closing = match[1] === "/";
    const name = match[2];
    const rawAttrs = match[3];
    const selfClosing = match[4] === "/";

    if (closing) {
      if (rawAttrs !== undefined || selfClosing) return false;
      if (stack.pop() !== name) return false;
      continue;
    }

    if (rawAttrs !== undefined) {
      try {
        const parsed = JSON.parse(rawAttrs) as unknown;
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
      } catch {
        return false;
      }
    }

    if (!selfClosing) stack.push(name);
  }
  return sawGutenberg && stack.length === 0;
}

function attrsEmpty(attrs: ParsedWordPressBlock["attrs"]): boolean {
  return attrs === null || Object.keys(attrs).length === 0;
}

function attrsOnly(
  attrs: ParsedWordPressBlock["attrs"],
  allowed: readonly string[],
): boolean {
  if (attrs === null) return true;
  return Object.keys(attrs).every((key) => allowed.includes(key));
}

function safePlainText(value: string): boolean {
  return !/[<&\r\n]/u.test(value);
}

function mappedBlock(
  block: ParsedWordPressBlock,
  index: number,
): PublicationBlock | undefined {
  if (block.innerBlocks.length > 0) return undefined;

  if (block.blockName === "core/paragraph" && attrsEmpty(block.attrs)) {
    const match = block.innerHTML.match(/^\s*<p>([^<&\r\n]*)<\/p>\s*$/u);
    if (match?.[1] !== undefined && safePlainText(match[1])) {
      return {
        id: `wordpress-gutenberg-paragraph-${index}`,
        kind: "paragraph",
        data: { text: match[1] },
      };
    }
    return undefined;
  }

  if (block.blockName === "core/heading" && attrsOnly(block.attrs, ["level"])) {
    const match = block.innerHTML.match(/^\s*<h([1-6])>([^<&\r\n]*)<\/h\1>\s*$/u);
    if (!match?.[1] || match[2] === undefined || !safePlainText(match[2])) return undefined;
    const level = Number(match[1]);
    const configuredLevel = block.attrs?.level;
    if (
      configuredLevel !== undefined &&
      (typeof configuredLevel !== "number" || configuredLevel !== level)
    ) {
      return undefined;
    }
    return {
      id: `wordpress-gutenberg-heading-${index}`,
      kind: "heading",
      data: { level, text: match[2] },
    };
  }

  if (block.blockName === "core/quote" && attrsEmpty(block.attrs)) {
    const match = block.innerHTML.match(
      /^\s*<blockquote><p>([^<&\r\n]*)<\/p>(?:<cite>([^<&\r\n]*)<\/cite>)?<\/blockquote>\s*$/u,
    );
    if (
      match?.[1] !== undefined &&
      safePlainText(match[1]) &&
      (match[2] === undefined || safePlainText(match[2]))
    ) {
      return {
        id: `wordpress-gutenberg-quote-${index}`,
        kind: "quote",
        data: {
          text: match[1],
          ...(match[2] ? { attribution: match[2] } : {}),
        },
      };
    }
    return undefined;
  }

  if (block.blockName === "core/code" && attrsEmpty(block.attrs)) {
    const match = block.innerHTML.match(/^\s*<pre><code>([^<&]*)<\/code><\/pre>\s*$/u);
    if (match?.[1] !== undefined && !/[<&]/u.test(match[1])) {
      return {
        id: `wordpress-gutenberg-code-${index}`,
        kind: "code",
        data: { code: match[1] },
      };
    }
  }

  return undefined;
}

function serializedName(blockName: string): string {
  return blockName.startsWith("core/") ? blockName.slice("core/".length) : blockName;
}

function serializeParsedBlock(block: ParsedWordPressBlock): string | undefined {
  if (block.blockName === null) return block.innerHTML;

  let inner = block.innerHTML;
  if (block.innerContent !== undefined) {
    let childIndex = 0;
    const chunks: string[] = [];
    for (const part of block.innerContent) {
      if (part !== null) {
        chunks.push(part);
        continue;
      }
      const child = block.innerBlocks[childIndex++];
      if (!child) return undefined;
      const serializedChild = serializeParsedBlock(child);
      if (serializedChild === undefined) return undefined;
      chunks.push(serializedChild);
    }
    if (childIndex !== block.innerBlocks.length) return undefined;
    inner = chunks.join("");
  } else if (block.innerBlocks.length > 0) {
    return undefined;
  }

  const name = serializedName(block.blockName);
  const attrs = block.attrs && Object.keys(block.attrs).length > 0
    ? ` ${JSON.stringify(block.attrs)}`
    : "";

  if (inner === "") return `<!-- wp:${name}${attrs} /-->`;
  return `<!-- wp:${name}${attrs} -->${inner}<!-- /wp:${name} -->`;
}

function rawEmbed(html: string, index: number): PublicationBlock | undefined {
  if (!html.trim()) return undefined;
  return {
    id: `wordpress-gutenberg-raw-${index}`,
    kind: "embed",
    data: { html },
  };
}

export function importWordPressContentBlocks(contentHtml: string): readonly PublicationBlock[] {
  if (!contentHtml.trim()) return [];

  if (!GUTENBERG_DELIMITER.test(contentHtml)) {
    return [{
      id: "wordpress-source-html",
      kind: "embed",
      data: { html: contentHtml },
    }];
  }

  if (!validGutenbergCommentStructure(contentHtml)) {
    return [{
      id: "wordpress-gutenberg-malformed",
      kind: "embed",
      data: { html: contentHtml },
    }];
  }

  let parsed: readonly ParsedWordPressBlock[];
  try {
    parsed = parse(contentHtml) as readonly ParsedWordPressBlock[];
  } catch {
    return [{
      id: "wordpress-gutenberg-malformed",
      kind: "embed",
      data: { html: contentHtml },
    }];
  }

  if (parsed.length === 0) {
    return [{
      id: "wordpress-gutenberg-malformed",
      kind: "embed",
      data: { html: contentHtml },
    }];
  }

  const blocks: PublicationBlock[] = [];
  for (const block of parsed) {
    const outputIndex = blocks.length;
    if (block.blockName === null) {
      const raw = rawEmbed(block.innerHTML, outputIndex);
      if (raw) blocks.push(raw);
      continue;
    }

    const mapped = mappedBlock(block, outputIndex);
    if (mapped) {
      blocks.push(mapped);
      continue;
    }

    const serialized = serializeParsedBlock(block);
    if (serialized === undefined) {
      return [{
        id: "wordpress-gutenberg-malformed",
        kind: "embed",
        data: { html: contentHtml },
      }];
    }
    const raw = rawEmbed(serialized, outputIndex);
    if (raw) blocks.push(raw);
  }

  if (blocks.length === 0 && contentHtml.trim()) {
    return [{
      id: "wordpress-gutenberg-malformed",
      kind: "embed",
      data: { html: contentHtml },
    }];
  }
  return blocks;
}
