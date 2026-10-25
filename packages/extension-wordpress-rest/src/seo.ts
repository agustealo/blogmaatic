import type { WordPressRestMetaFieldDefinition } from "./types.js";

export type WordPressSeoSemantic =
  | "title"
  | "description"
  | "canonical"
  | "focus_keyphrase"
  | "robots_index"
  | "robots_follow";

export interface WordPressSeoFieldDefinition {
  readonly semantic: WordPressSeoSemantic;
  readonly key: string;
  readonly label: string;
  readonly provider: "generic-registered-meta" | "yoast-compatible-meta" | "rank-math-compatible-meta";
  readonly valueKind: "text" | "boolean";
  readonly trueValue?: string | boolean;
  readonly falseValue?: string | boolean;
  readonly description?: string;
}

const SEO_ALIASES: Readonly<Record<string, {
  readonly semantic: WordPressSeoSemantic;
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

  seo_robots_index: { semantic: "robots_index", label: "Index this content", provider: "generic-registered-meta" },
  _seo_robots_index: { semantic: "robots_index", label: "Index this content", provider: "generic-registered-meta" },
  robots_index: { semantic: "robots_index", label: "Index this content", provider: "generic-registered-meta" },
  _robots_index: { semantic: "robots_index", label: "Index this content", provider: "generic-registered-meta" },
  seo_index: { semantic: "robots_index", label: "Index this content", provider: "generic-registered-meta" },
  _seo_index: { semantic: "robots_index", label: "Index this content", provider: "generic-registered-meta" },

  seo_robots_follow: { semantic: "robots_follow", label: "Follow links", provider: "generic-registered-meta" },
  _seo_robots_follow: { semantic: "robots_follow", label: "Follow links", provider: "generic-registered-meta" },
  robots_follow: { semantic: "robots_follow", label: "Follow links", provider: "generic-registered-meta" },
  _robots_follow: { semantic: "robots_follow", label: "Follow links", provider: "generic-registered-meta" },
  seo_follow: { semantic: "robots_follow", label: "Follow links", provider: "generic-registered-meta" },
  _seo_follow: { semantic: "robots_follow", label: "Follow links", provider: "generic-registered-meta" },
};

function robotsEncoding(
  semantic: WordPressSeoSemantic,
  field: WordPressRestMetaFieldDefinition,
): { readonly trueValue: string | boolean; readonly falseValue: string | boolean } | undefined {
  if (semantic !== "robots_index" && semantic !== "robots_follow") return undefined;
  if (field.type === "boolean") return { trueValue: true, falseValue: false };
  if (field.type !== "string" || !field.enum) return undefined;

  const strings = field.enum.filter((value): value is string => typeof value === "string");
  if (strings.length !== 2) return undefined;
  const positive = semantic === "robots_index" ? "index" : "follow";
  const negative = semantic === "robots_index" ? "noindex" : "nofollow";
  const trueValue = strings.find((value) => value.toLowerCase() === positive);
  const falseValue = strings.find((value) => value.toLowerCase() === negative);
  return trueValue !== undefined && falseValue !== undefined
    ? { trueValue, falseValue }
    : undefined;
}

export function discoverSeoFields(
  fields: readonly WordPressRestMetaFieldDefinition[],
): readonly WordPressSeoFieldDefinition[] {
  const candidates = new Map<WordPressSeoSemantic, WordPressSeoFieldDefinition[]>();
  for (const field of fields) {
    const alias = SEO_ALIASES[field.key.toLowerCase()];
    if (!alias) continue;

    const isRobots = alias.semantic === "robots_index" || alias.semantic === "robots_follow";
    const encoding = isRobots ? robotsEncoding(alias.semantic, field) : undefined;
    if (isRobots && !encoding) continue;
    if (!isRobots && field.type !== "string") continue;

    const candidate: WordPressSeoFieldDefinition = {
      semantic: alias.semantic,
      key: field.key,
      label: field.title?.trim() || alias.label,
      provider: alias.provider,
      valueKind: isRobots ? "boolean" : "text",
      ...(encoding ? { trueValue: encoding.trueValue, falseValue: encoding.falseValue } : {}),
      ...(field.description?.trim() ? { description: field.description.trim() } : {}),
    };
    candidates.set(alias.semantic, [...(candidates.get(alias.semantic) ?? []), candidate]);
  }

  return [...candidates.entries()]
    .filter(([, values]) => values.length === 1)
    .map(([, values]) => values[0]!)
    .sort((left, right) => left.label.localeCompare(right.label));
}
