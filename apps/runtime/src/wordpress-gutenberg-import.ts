import { parse } from "@wordpress/block-serialization-default-parser";

import type { JsonValue, PublicationBlock } from "@blogmaatic/core";

interface ParsedBlockShape {
  readonly blockName: string | null;
  readonly attrs: Readonly<Record<string, unknown>> | null;
  readonly innerBlocks: readonly ParsedBlockShape[];
  readonly innerHTML: string;
  readonly innerContent: readonly (string | null)[];
}

const GUTENBERG_DELIMITER = /<!--[ \t\f\r\n]+\/?wp:/;

function blockId(index: number): string {
  return `wordpress-gutenberg-${index + 1}`;
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonSafe(value: unknown): JsonValue | undefined {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (const item of value) {
      const safe = jsonSafe(item);
      if (safe === undefined) return undefined;
      items.push(safe);
    }
    return items;
  }
  if (isPlainRecord(value)) {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const safe = jsonSafe(item);
      if (safe === undefined) return undefined;
      result[key] = safe;
    }
    return result;
  }
  return undefined;
}

function serializeBlockAttributes(attrs: Readonly<Record<string, unknown>>): string {
  const encoded = JSON.stringify(attrs);
  return encoded.replace(/\\\"|\\|--|[<>&]/g, (token) => {
    switch (token) {
      case "\\\"":
        return "\\u0022";
      case "\\":
        return "\\u005c";
      case "--":
        return "\\u002d\\u002d";
      case "<":
        return "\\u003c";
      case ">":
        return "\\u003e";
      case "&":
        return "\\u0026";
      default:
        return token;
    }
  });
}

function serializedBlockName(blockName: string): string {
  return blockName.startsWith("core/") ? blockName.slice("core/".length) : blockName;
}

export function serializeParsedWordPressBlock(block: ParsedBlockShape): string {
  if (block.blockName === null) return block.innerHTML;

  let childIndex = 0;
  let inner = "";
  for (const chunk of block.innerContent) {
    if (typeof chunk === "string") {
      inner += chunk;
      continue;
    }
    const child = block.innerBlocks[childIndex++];
    if (child) inner += serializeParsedWordPressBlock(child);
  }

  const name = serializedBlockName(block.blockName);
  const attrs = block.attrs && Object.keys(block.attrs).length > 0
    ? `${serializeBlockAttributes(block.attrs)} `
    : "";

  if (!inner) return `<!-- wp:${name} ${attrs}/-->`;
  return `<!-- wp:${name} ${attrs}-->${inner}<!-- /wp:${name} -->`;
}

function balancedGutenbergDelimiters(html: string): boolean {
  const tokens = html.match(/<!--[ \t\f\r\n]+\/?wp:[^>]*-->/g);
  if (!tokens || tokens.length === 0) return false;
  const stack: string[] = [];
  for (const token of tokens) {
    const match = token.match(
      /^<!--[ \t\f\r\n]+(\/)?wp:([a-z][a-z0-9_-]*\/)?([a-z][a-z0-9_-]*)[^>]*?(\/)?-->$/i,
    );
    if (!match) return false;
    const closing = Boolean(match[1]);
    const selfClosing = Boolean(match[4]);
    const name = `${match[2] ?? "core/"}${match[3]}`.toLowerCase();
    if (selfClosing) {
      if (closing) return false;
      continue;
    }
    if (closing) {
      if (stack.pop() !== name) return false;
    } else {
      stack.push(name);
    }
  }
  return stack.length === 0;
}

function emptyOrLevelOnlyAttrs(
  attrs: Readonly<Record<string, unknown>> | null,
): { readonly safe: boolean; readonly level?: number } {
  const entries = Object.entries(attrs ?? {});
  if (entries.length === 0) return { safe: true };
  if (
    entries.length === 1 &&
    entries[0]?.[0] === "level" &&
    typeof entries[0][1] === "number" &&
    Number.isInteger(entries[0][1]) &&
    entries[0][1] >= 1 &&
    entries[0][1] <= 6
  ) {
    return { safe: true, level: entries[0][1] };
  }
  return { safe: false };
}

function gutenbergMetadata(block: ParsedBlockShape): JsonValue | undefined {
  if (!block.blockName) return undefined;
  const attrs = jsonSafe(block.attrs ?? {});
  if (attrs === undefined || Array.isArray(attrs) || attrs === null || typeof attrs !== "object") {
    return undefined;
  }
  return {
    blockName: block.blockName,
    attrs,
  };
}

function mapParagraph(block: ParsedBlockShape, id: string): PublicationBlock | undefined {
  if (block.blockName !== "core/paragraph" || block.innerBlocks.length !== 0) return undefined;
  if (Object.keys(block.attrs ?? {}).length !== 0) return undefined;
  const match = block.innerHTML.match(/^<p>([^<&\r\n]*)<\/p>$/);
  if (!match) return undefined;
  const wordpressGutenberg = gutenbergMetadata(block);
  if (!wordpressGutenberg) return undefined;
  return {
    id,
    kind: "paragraph",
    data: { text: match[1] ?? "", wordpressGutenberg },
  };
}

function mapHeading(block: ParsedBlockShape, id: string): PublicationBlock | undefined {
  if (block.blockName !== "core/heading" || block.innerBlocks.length !== 0) return undefined;
  const attrs = emptyOrLevelOnlyAttrs(block.attrs);
  if (!attrs.safe) return undefined;
  const match = block.innerHTML.match(/^<h([1-6])>([^<&\r\n]*)<\/h\1>$/);
  if (!match) return undefined;
  const level = Number(match[1]);
  if (attrs.level !== undefined && attrs.level !== level) return undefined;
  const wordpressGutenberg = gutenbergMetadata(block);
  if (!wordpressGutenberg) return undefined;
  return {
    id,
    kind: "heading",
    data: { level, text: match[2] ?? "", wordpressGutenberg },
  };
}

function decodeCodeText(value: string): string | undefined {
  if (/&(?!(?:amp|lt|gt|quot|#039);)/.test(value)) return undefined;
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, "&");
}

function mapCode(block: ParsedBlockShape, id: string): PublicationBlock | undefined {
  if (block.blockName !== "core/code" || block.innerBlocks.length !== 0) return undefined;
  if (Object.keys(block.attrs ?? {}).length !== 0) return undefined;
  const match = block.innerHTML.match(/^<pre class="wp-block-code"><code>([\s\S]*?)<\/code><\/pre>$/);
  if (!match) return undefined;
  const code = decodeCodeText(match[1] ?? "");
  if (code === undefined) return undefined;
  const wordpressGutenberg = gutenbergMetadata(block);
  if (!wordpressGutenberg) return undefined;
  return {
    id,
    kind: "code",
    data: { code, language: "", wordpressGutenberg },
  };
}

function mapSafeBlock(block: ParsedBlockShape, id: string): PublicationBlock | undefined {
  return mapParagraph(block, id) ?? mapHeading(block, id) ?? mapCode(block, id);
}

export function wordpressHtmlToCanonicalBlocks(html: string): readonly PublicationBlock[] {
  if (!html.trim()) return [];
  if (!GUTENBERG_DELIMITER.test(html) || !balancedGutenbergDelimiters(html)) {
    return [{
      id: "wordpress-source-html",
      kind: "embed",
      data: { html },
    }];
  }

  let parsed: readonly ParsedBlockShape[];
  try {
    parsed = parse(html) as readonly ParsedBlockShape[];
  } catch {
    return [{
      id: "wordpress-source-html",
      kind: "embed",
      data: { html },
    }];
  }

  if (parsed.length === 0) {
    return [{
      id: "wordpress-source-html",
      kind: "embed",
      data: { html },
    }];
  }

  const blocks: PublicationBlock[] = [];
  let index = 0;
  for (const parsedBlock of parsed) {
    if (parsedBlock.blockName === null && !parsedBlock.innerHTML.trim()) continue;
    const id = blockId(index++);
    const editable = mapSafeBlock(parsedBlock, id);
    if (editable) {
      blocks.push(editable);
      continue;
    }
    const serialized = serializeParsedWordPressBlock(parsedBlock);
    if (!serialized) continue;
    blocks.push({
      id,
      kind: "embed",
      data: {
        html: serialized,
        wordpressGutenberg: {
          preserved: true,
          blockName: parsedBlock.blockName,
        },
      },
    });
  }

  return blocks.length > 0 ? blocks : [{
    id: "wordpress-source-html",
    kind: "embed",
    data: { html },
  }];
}
