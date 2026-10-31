import type { JsonValue } from "@blogmaatic/core";

import type { WordPressRestMetaFieldDefinition } from "./types.js";

export type WordPressSeoSemantic =
  | "title"
  | "description"
  | "canonical"
  | "focus_keyphrase"
  | "robots_index"
  | "robots_follow";

export type WordPressSeoValue = string | boolean;

export interface WordPressSeoFieldDefinition {
  readonly semantic: WordPressSeoSemantic;
  readonly key: string;
  readonly label: string;
  readonly provider: "generic-registered-meta" | "yoast-compatible-meta" | "rank-math-compatible-meta";
  readonly valueType: "text" | "boolean";
  readonly description?: string;
  readonly booleanEncoding?: {
    readonly trueValue: boolean | string;
    readonly falseValue: boolean | string;
  };
}

const SEO_ALIASES: Readonly<Record<string, {
  readonly semantic: Extract<WordPressSeoSemantic, "title" | "description" | "canonical" | "focus_keyphrase">;
  readonly label: string;
  readonly provider: WordPressSeoFieldDefinition["provider"];
}>> = {
  seo_title: { semantic: "title", label: "SEO title", provider: "generic-registered-meta" },
  _seo_title: { semantic: "title", label: "SEO title", provider: "generic-registered-meta" },
  meta_title: { semantic: "title", label: "SEO title", provider: "generic-registered-meta" },
  _meta_title: { semantic: "title", label: "SEO title", provider: "generic-registered-meta" },

  seo_description: { semantic: "description", label: "Meta description", provider: "generic-registered-meta" },
  _seo_description: { semantic: "description", label: "Meta description", provider: "generic-registered-meta" },
  meta_description: { semantic: "description", label: "Meta description", provider: "generic-registered-meta" },
  _meta_description: { semantic: "description", label: "Meta description", provider: "generic-registered-meta" },

  seo_canonical: { semantic: "canonical", label: "Canonical URL", provider: "generic-registered-meta" },
  _seo_canonical: { semantic: "canonical", label: "Canonical URL", provider: "generic-registered-meta" },
  seo_canonical_url: { semantic: "canonical", label: "Canonical URL", provider: "generic-registered-meta" },
  _seo_canonical_url: { semantic: "canonical", label: "Canonical URL", provider: "generic-registered-meta" },
  canonical_url: { semantic: "canonical", label: "Canonical URL", provider: "generic-registered-meta" },
  _canonical_url: { semantic: "canonical", label: "Canonical URL", provider: "generic-registered-meta" },

  seo_focus_keyphrase: { semantic: "focus_keyphrase", label: "Focus keyphrase", provider: "generic-registered-meta" },
  _seo_focus_keyphrase: { semantic: "focus_keyphrase", label: "Focus keyphrase", provider: "generic-registered-meta" },
  focus_keyphrase: { semantic: "focus_keyphrase", label: "Focus keyphrase", provider: "generic-registered-meta" },
  _focus_keyphrase: { semantic: "focus_keyphrase", label: "Focus keyphrase", provider: "generic-registered-meta" },

  _yoast_wpseo_title: { semantic: "title", label: "SEO title", provider: "yoast-compatible-meta" },
  _yoast_wpseo_metadesc: { semantic: "description", label: "Meta description", provider: "yoast-compatible-meta" },
  _yoast_wpseo_canonical: { semantic: "canonical", label: "Canonical URL", provider: "yoast-compatible-meta" },
  _yoast_wpseo_focuskw: { semantic: "focus_keyphrase", label: "Focus keyphrase", provider: "yoast-compatible-meta" },

  rank_math_title: { semantic: "title", label: "SEO title", provider: "rank-math-compatible-meta" },
  rank_math_description: { semantic: "description", label: "Meta description", provider: "rank-math-compatible-meta" },
  rank_math_canonical_url: { semantic: "canonical", label: "Canonical URL", provider: "rank-math-compatible-meta" },
  rank_math_focus_keyword: { semantic: "focus_keyphrase", label: "Focus keyphrase", provider: "rank-math-compatible-meta" },
};

const ROBOTS_ALIASES: Readonly<Record<string, {
  readonly semantic: Extract<WordPressSeoSemantic, "robots_index" | "robots_follow">;
  readonly label: string;
}>> = {
  seo_robots_index: { semantic: "robots_index", label: "Index this content" },
  _seo_robots_index: { semantic: "robots_index", label: "Index this content" },
  robots_index: { semantic: "robots_index", label: "Index this content" },
  _robots_index: { semantic: "robots_index", label: "Index this content" },
  seo_index: { semantic: "robots_index", label: "Index this content" },
  _seo_index: { semantic: "robots_index", label: "Index this content" },

  seo_robots_follow: { semantic: "robots_follow", label: "Follow links" },
  _seo_robots_follow: { semantic: "robots_follow", label: "Follow links" },
  robots_follow: { semantic: "robots_follow", label: "Follow links" },
  _robots_follow: { semantic: "robots_follow", label: "Follow links" },
  seo_follow: { semantic: "robots_follow", label: "Follow links" },
  _seo_follow: { semantic: "robots_follow", label: "Follow links" },
};

function safeBooleanEncoding(
  field: WordPressRestMetaFieldDefinition,
  semantic: Extract<WordPressSeoSemantic, "robots_index" | "robots_follow">,
): WordPressSeoFieldDefinition["booleanEncoding"] | undefined {
  if (field.type === "boolean") {
    return { trueValue: true, falseValue: false };
  }
  if (field.type !== "string" || !field.enum || field.enum.length !== 2) return undefined;
  const strings = field.enum.filter((value): value is string => typeof value === "string");
  if (strings.length !== 2) return undefined;

  const expected = semantic === "robots_index"
    ? { trueToken: "index", falseToken: "noindex" }
    : { trueToken: "follow", falseToken: "nofollow" };
  const byNormalized = new Map(strings.map((value) => [value.trim().toLowerCase(), value] as const));
  if (
    byNormalized.size !== 2 ||
    !byNormalized.has(expected.trueToken) ||
    !byNormalized.has(expected.falseToken)
  ) {
    return undefined;
  }
  return {
    trueValue: byNormalized.get(expected.trueToken)!,
    falseValue: byNormalized.get(expected.falseToken)!,
  };
}

export function encodeSeoValue(
  field: WordPressSeoFieldDefinition,
  value: WordPressSeoValue,
): JsonValue {
  if (field.valueType === "text") {
    if (typeof value !== "string") {
      throw new Error(`WordPress SEO value must be a string: ${field.semantic}`);
    }
    return value;
  }
  if (typeof value !== "boolean" || !field.booleanEncoding) {
    throw new Error(`WordPress SEO value must be a boolean: ${field.semantic}`);
  }
  return value ? field.booleanEncoding.trueValue : field.booleanEncoding.falseValue;
}

export function decodeSeoValue(
  field: WordPressSeoFieldDefinition,
  value: JsonValue | undefined,
): WordPressSeoValue | undefined {
  if (value === undefined) return undefined;
  if (field.valueType === "text") return typeof value === "string" ? value : undefined;
  const encoding = field.booleanEncoding;
  if (!encoding) return undefined;
  if (JSON.stringify(value) === JSON.stringify(encoding.trueValue)) return true;
  if (JSON.stringify(value) === JSON.stringify(encoding.falseValue)) return false;
  return undefined;
}

export function discoverSeoFields(
  fields: readonly WordPressRestMetaFieldDefinition[],
): readonly WordPressSeoFieldDefinition[] {
  const candidates = new Map<WordPressSeoSemantic, WordPressSeoFieldDefinition[]>();
  for (const field of fields) {
    const alias = SEO_ALIASES[field.key.toLowerCase()];
    if (alias && field.type === "string") {
      const candidate: WordPressSeoFieldDefinition = {
        semantic: alias.semantic,
        key: field.key,
        label: field.title?.trim() || alias.label,
        provider: alias.provider,
        valueType: "text",
        ...(field.description?.trim() ? { description: field.description.trim() } : {}),
      };
      candidates.set(alias.semantic, [...(candidates.get(alias.semantic) ?? []), candidate]);
      continue;
    }

    const robots = ROBOTS_ALIASES[field.key.toLowerCase()];
    if (!robots) continue;
    const booleanEncoding = safeBooleanEncoding(field, robots.semantic);
    if (!booleanEncoding) continue;
    const candidate: WordPressSeoFieldDefinition = {
      semantic: robots.semantic,
      key: field.key,
      label: field.title?.trim() || robots.label,
      provider: "generic-registered-meta",
      valueType: "boolean",
      booleanEncoding,
      ...(field.description?.trim() ? { description: field.description.trim() } : {}),
    };
    candidates.set(robots.semantic, [...(candidates.get(robots.semantic) ?? []), candidate]);
  }

  return [...candidates.entries()]
    .filter(([, values]) => values.length === 1)
    .map(([, values]) => values[0]!)
    .sort((left, right) => left.label.localeCompare(right.label));
}
