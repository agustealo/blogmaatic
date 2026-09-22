import type { Publication } from "@blogmaatic/core";

import type { AutomationDefinition, AutomationRunTrigger } from "./types.js";

function triggerMatches(definition: AutomationDefinition, trigger: AutomationRunTrigger): boolean {
  if (definition.trigger.kind !== trigger.kind) return false;
  if (definition.trigger.kind === "manual") return true;
  return trigger.kind === "event" && definition.trigger.eventType === trigger.eventType;
}

export function automationMatchesPublication(
  definition: AutomationDefinition,
  publication: Publication,
  trigger: AutomationRunTrigger,
): boolean {
  if (!definition.enabled || !triggerMatches(definition, trigger)) return false;
  const condition = definition.conditions;
  if (!condition) return true;

  if (condition.statuses && !condition.statuses.includes(publication.status)) return false;

  const tags = new Set(publication.current.content.tags);
  if (condition.tagsAll && !condition.tagsAll.every((tag) => tags.has(tag))) return false;
  if (condition.tagsAny && condition.tagsAny.length > 0 && !condition.tagsAny.some((tag) => tags.has(tag))) {
    return false;
  }

  return true;
}
