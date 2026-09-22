import type { PublicationGroup } from "@blogmaatic/core";

import type {
  AutomationCondition,
  AutomationDefinition,
  AutomationRunRequest,
  AutomationStep,
} from "./types.js";

const MAX_DELAY_MS = 365 * 24 * 60 * 60 * 1000;

function assertNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} is required`);
}

function validateCondition(condition: AutomationCondition | undefined): void {
  if (!condition) return;
  for (const status of condition.statuses ?? []) {
    assertNonEmpty(status, "Automation condition status");
  }
  for (const tag of [...(condition.tagsAll ?? []), ...(condition.tagsAny ?? [])]) {
    assertNonEmpty(tag, "Automation condition tag");
  }
}

function validateStep(step: AutomationStep): void {
  assertNonEmpty(step.id, "Automation step id");
  switch (step.kind) {
    case "publish_group":
      assertNonEmpty(step.groupId, `Automation step ${step.id} groupId`);
      return;
    case "approval":
      assertNonEmpty(step.role, `Automation step ${step.id} approval role`);
      if (step.prompt !== undefined) assertNonEmpty(step.prompt, `Automation step ${step.id} approval prompt`);
      return;
    case "delay":
      if (!Number.isSafeInteger(step.durationMs) || step.durationMs < 1 || step.durationMs > MAX_DELAY_MS) {
        throw new Error(`Automation step ${step.id} durationMs must be an integer between 1 and ${MAX_DELAY_MS}`);
      }
      return;
  }
}

export function validateAutomationDefinition(definition: AutomationDefinition): void {
  assertNonEmpty(definition.id, "Automation id");
  assertNonEmpty(definition.name, "Automation name");
  if (!Number.isSafeInteger(definition.version) || definition.version < 1) {
    throw new Error("Automation version must be a positive integer");
  }
  if (definition.trigger.kind === "event") {
    assertNonEmpty(definition.trigger.eventType, "Automation event trigger type");
  }
  validateCondition(definition.conditions);
  if (definition.steps.length === 0) throw new Error("Automation requires at least one step");

  const stepIds = new Set<string>();
  for (const step of definition.steps) {
    validateStep(step);
    if (stepIds.has(step.id)) throw new Error(`Automation step id is duplicated: ${step.id}`);
    stepIds.add(step.id);
  }
}

function groupsById(groups: readonly PublicationGroup[]): Map<string, PublicationGroup> {
  const result = new Map<string, PublicationGroup>();
  for (const group of groups) {
    if (result.has(group.id)) throw new Error(`Automation run contains duplicate publication group: ${group.id}`);
    result.set(group.id, group);
  }
  return result;
}

export function validateAutomationRunRequest(request: AutomationRunRequest): void {
  assertNonEmpty(request.runId, "Automation run id");
  validateAutomationDefinition(request.definition);
  const groups = groupsById(request.groups);
  for (const step of request.definition.steps) {
    if (step.kind === "publish_group" && !groups.has(step.groupId)) {
      throw new Error(`Automation step ${step.id} references missing publication group ${step.groupId}`);
    }
  }
}

export function publicationGroupsById(groups: readonly PublicationGroup[]): ReadonlyMap<string, PublicationGroup> {
  return groupsById(groups);
}
