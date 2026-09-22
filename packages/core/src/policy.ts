import type {
  PolicyDecision,
  PolicyMatch,
  PolicyRule,
  PolicySet,
  Publication,
  PublicationRoute,
} from "./types.js";

function intersects(left: readonly string[], right: readonly string[]): boolean {
  const values = new Set(left);
  return right.some((value) => values.has(value));
}

function matches(match: PolicyMatch, publication: Publication, route: PublicationRoute): boolean {
  if (match.statuses && !match.statuses.includes(publication.status)) {
    return false;
  }
  if (match.routeIds && !match.routeIds.includes(route.id)) {
    return false;
  }
  if (match.extensionIds && !match.extensionIds.includes(route.destination.extensionId)) {
    return false;
  }
  if (match.tagsAny && !intersects(publication.current.content.tags, match.tagsAny)) {
    return false;
  }
  return true;
}

function decisionForRule(rule: PolicyRule): PolicyDecision {
  if (rule.effect === "require_approval" && !rule.approvalRole) {
    throw new Error(`Policy rule ${rule.id} requires approval but does not declare approvalRole`);
  }

  return {
    effect: rule.effect,
    ruleId: rule.id,
    ...(rule.approvalRole ? { approvalRole: rule.approvalRole } : {}),
    reason: rule.description,
  };
}

export class PolicyEngine {
  readonly #sets = new Map<string, PolicySet>();

  constructor(policySets: readonly PolicySet[]) {
    for (const set of policySets) {
      if (this.#sets.has(set.id)) {
        throw new Error(`Duplicate policy set: ${set.id}`);
      }
      this.#sets.set(set.id, set);
    }
  }

  evaluate(policySetId: string, publication: Publication, route: PublicationRoute): PolicyDecision {
    const set = this.#sets.get(policySetId);
    if (!set) {
      throw new Error(`Unknown policy set: ${policySetId}`);
    }

    const rule = set.rules.find((candidate) => matches(candidate.match, publication, route));
    if (rule) {
      return decisionForRule(rule);
    }

    return {
      effect: set.defaultEffect,
      reason: `Policy set ${set.id} defaulted to ${set.defaultEffect}`,
    };
  }
}
