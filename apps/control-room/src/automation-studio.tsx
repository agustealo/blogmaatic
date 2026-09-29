import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router";

import type {
  AutomationDefinition,
  AutomationRegistryEntry,
  PublicationGroupRegistryEntry,
} from "@blogmaatic/operator-client";

import { EmptyState, ErrorBanner, LoadingBlock, Panel, StatusPill } from "./components";

type AutomationStep = AutomationDefinition["steps"][number];
type AutomationCondition = NonNullable<AutomationDefinition["conditions"]>;
type PublicationStatus = NonNullable<AutomationCondition["statuses"]>[number];
type EditableTriggerKind = "manual" | "event";
type DelayUnit = "minutes" | "hours" | "days";

const publicationStatuses: readonly PublicationStatus[] = [
  "idea",
  "draft",
  "ready",
  "approved",
  "queued",
  "publishing",
  "published",
  "archived",
];

const delayUnitMs: Readonly<Record<DelayUnit, number>> = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

const maxDelayMs = 365 * delayUnitMs.days;

function automationId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `automation_${slug || "publication"}_${crypto.randomUUID().slice(0, 8)}`;
}

function stepId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
}

function tagsText(tags: readonly string[] | undefined): string {
  return (tags ?? []).join(", ");
}

function parseTags(value: string): readonly string[] {
  return [...new Set(value.split(",").map((tag) => tag.trim()).filter(Boolean))];
}

function delayParts(durationMs: number): { readonly value: number; readonly unit: DelayUnit } {
  if (durationMs % delayUnitMs.days === 0) return { value: durationMs / delayUnitMs.days, unit: "days" };
  if (durationMs % delayUnitMs.hours === 0) return { value: durationMs / delayUnitMs.hours, unit: "hours" };
  return { value: Math.max(1, Math.round(durationMs / delayUnitMs.minutes)), unit: "minutes" };
}

function replaceStep(steps: readonly AutomationStep[], id: string, replacement: AutomationStep): readonly AutomationStep[] {
  return steps.map((step) => step.id === id ? replacement : step);
}

function moveStep(steps: readonly AutomationStep[], index: number, delta: -1 | 1): readonly AutomationStep[] {
  const target = index + delta;
  if (target < 0 || target >= steps.length) return steps;
  const next = [...steps];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

function defaultSteps(groups: readonly PublicationGroupRegistryEntry[]): readonly AutomationStep[] {
  return [{
    id: stepId("publish"),
    kind: "publish_group",
    groupId: groups.find((entry) => entry.enabled)?.group.id ?? "",
    onBusinessFailure: "stop",
  }];
}

function conditionOrUndefined(statuses: ReadonlySet<PublicationStatus>, tagsAll: string, tagsAny: string): AutomationCondition | undefined {
  const all = parseTags(tagsAll);
  const any = parseTags(tagsAny);
  if (statuses.size === 0 && all.length === 0 && any.length === 0) return undefined;
  return {
    ...(statuses.size ? { statuses: publicationStatuses.filter((status) => statuses.has(status)) } : {}),
    ...(all.length ? { tagsAll: all } : {}),
    ...(any.length ? { tagsAny: any } : {}),
  };
}

function groupLabel(entry: PublicationGroupRegistryEntry): string {
  return `${entry.group.name}${entry.enabled ? "" : " · disabled"}`;
}

export function AutomationStudioPanel({
  groups,
  groupsLoading,
  initialEntry,
  busy,
  onSave,
  onCancel,
}: {
  readonly groups: readonly PublicationGroupRegistryEntry[];
  readonly groupsLoading: boolean;
  readonly initialEntry?: AutomationRegistryEntry;
  readonly busy: boolean;
  readonly onSave: (definition: AutomationDefinition) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const initial = initialEntry?.definition;
  const scheduleOwned = initial?.trigger.kind === "schedule";
  const [name, setName] = useState(initial?.name ?? "Publish approved content");
  const [triggerKind, setTriggerKind] = useState<EditableTriggerKind>(
    initial?.trigger.kind === "manual" ? "manual" : "event",
  );
  const [eventType, setEventType] = useState(
    initial?.trigger.kind === "event" ? initial.trigger.eventType : "publication.approved",
  );
  const [statuses, setStatuses] = useState<ReadonlySet<PublicationStatus>>(
    new Set(initial?.conditions?.statuses ?? []),
  );
  const [tagsAll, setTagsAll] = useState(tagsText(initial?.conditions?.tagsAll));
  const [tagsAny, setTagsAny] = useState(tagsText(initial?.conditions?.tagsAny));
  const [steps, setSteps] = useState<readonly AutomationStep[]>(initial?.steps ?? defaultSteps(groups));
  const [activateImmediately, setActivateImmediately] = useState(initialEntry ? initialEntry.enabled : true);
  const [error, setError] = useState<Error | null>(null);

  const enabledGroups = useMemo(() => groups.filter((entry) => entry.enabled), [groups]);
  const groupById = useMemo(() => new Map(groups.map((entry) => [entry.group.id, entry])), [groups]);
  const nextVersion = initial ? initial.version + 1 : 1;

  useEffect(() => {
    if (initial || groupsLoading || enabledGroups.length === 0) return;
    setSteps((current) => current.map((step) => (
      step.kind === "publish_group" && !step.groupId
        ? { ...step, groupId: enabledGroups[0]!.group.id }
        : step
    )));
  }, [enabledGroups, groupsLoading, initial]);

  if (scheduleOwned) {
    return (
      <Panel title={initial?.name ?? "Schedule Automation"} meta="Schedule-owned" className="automation-detail">
        <div className="automation-studio automation-studio--guarded">
          <StatusPill value="managed by schedule" tone="warn" />
          <h3>Timing and publication snapshots stay with Schedules.</h3>
          <p>
            This Automation is bound to schedule <code>{initial?.trigger.kind === "schedule" ? initial.trigger.scheduleId ?? "unbound" : ""}</code>.
            A generic edit could invalidate the schedule&apos;s pinned Automation version, Publication snapshot, or Publication Group snapshot, so the Automation registry keeps this definition inspectable but does not rewrite it here.
          </p>
          <div className="setup-actions">
            <button className="button button--quiet" type="button" onClick={onCancel}>Close</button>
            <Link className="button button--primary" to="/schedules">Open Schedules</Link>
          </div>
        </div>
      </Panel>
    );
  }

  const toggleStatus = (status: PublicationStatus, checked: boolean) => {
    setStatuses((current) => {
      const next = new Set(current);
      if (checked) next.add(status);
      else next.delete(status);
      return next;
    });
  };

  const addStep = (kind: AutomationStep["kind"]) => {
    if (kind === "publish_group") {
      setSteps((current) => [...current, {
        id: stepId("publish"),
        kind,
        groupId: enabledGroups[0]?.group.id ?? "",
        onBusinessFailure: "stop",
      }]);
      return;
    }
    if (kind === "approval") {
      setSteps((current) => [...current, { id: stepId("approval"), kind, role: "editor" }]);
      return;
    }
    setSteps((current) => [...current, { id: stepId("delay"), kind, durationMs: delayUnitMs.minutes }]);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      const cleanName = name.trim();
      if (!cleanName) throw new Error("Automation name is required");
      if (triggerKind === "event" && !eventType.trim()) throw new Error("Event type is required");
      if (steps.length === 0) throw new Error("Automation requires at least one step");
      if (new Set(steps.map((step) => step.id)).size !== steps.length) throw new Error("Automation step IDs must be unique");

      for (const step of steps) {
        if (!step.id.trim()) throw new Error("Every Automation step needs a stable ID");
        if (step.kind === "publish_group") {
          if (!step.groupId.trim()) throw new Error("Every publish step needs a Publication Group");
          const group = groupById.get(step.groupId);
          if (!group) throw new Error(`Publication Group ${step.groupId} is unavailable`);
          if (!group.enabled) throw new Error(`Enable Publication Group ${group.group.name} before activating this Automation version`);
        } else if (step.kind === "approval") {
          if (!step.role.trim()) throw new Error("Every approval step needs a role");
          if (step.prompt !== undefined && !step.prompt.trim()) throw new Error("Approval prompt must be removed or contain text");
        } else if (!Number.isSafeInteger(step.durationMs) || step.durationMs < 1 || step.durationMs > maxDelayMs) {
          throw new Error("Delay must be between 1 millisecond and 365 days");
        }
      }

      const definition: AutomationDefinition = {
        id: initial?.id ?? automationId(cleanName),
        version: nextVersion,
        name: cleanName,
        enabled: activateImmediately,
        trigger: triggerKind === "manual"
          ? { kind: "manual" }
          : { kind: "event", eventType: eventType.trim() },
        ...(conditionOrUndefined(statuses, tagsAll, tagsAny)
          ? { conditions: conditionOrUndefined(statuses, tagsAll, tagsAny) }
          : {}),
        steps,
      };
      await onSave(definition);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("Automation version could not be saved"));
    }
  };

  return (
    <Panel
      title={initial ? `Edit ${initial.name}` : "Create Automation"}
      meta={initial ? `new immutable v${nextVersion}` : "Automation Studio"}
      className="automation-detail automation-detail--studio"
    >
      <form className="automation-studio" onSubmit={submit}>
        <ErrorBanner error={error} />
        <div className="automation-studio__intro">
          <strong>{initial ? `Create version ${nextVersion}` : "Compose a publishing workflow"}</strong>
          <p>
            This editor writes the same canonical Automation definition the runtime executes. Existing versions are immutable; editing creates a new version instead of rewriting history.
          </p>
        </div>

        <label className="field">
          <span>Automation name</span>
          <input autoFocus value={name} onChange={(event) => setName(event.target.value)} required autoComplete="off" />
        </label>

        <fieldset className="automation-studio__section">
          <legend>Trigger</legend>
          <div className="automation-studio__choices">
            <label className="field field--checkbox">
              <input type="radio" name="automation-trigger" checked={triggerKind === "event"} onChange={() => setTriggerKind("event")} />
              <span>Event</span>
            </label>
            <label className="field field--checkbox">
              <input type="radio" name="automation-trigger" checked={triggerKind === "manual"} onChange={() => setTriggerKind("manual")} />
              <span>Manual</span>
            </label>
          </div>
          {triggerKind === "event" ? (
            <label className="field">
              <span>Event type</span>
              <input value={eventType} onChange={(event) => setEventType(event.target.value)} required autoComplete="off" />
              <small>For the normal Workspace approval flow use <code>publication.approved</code>.</small>
            </label>
          ) : (
            <p className="security-note">Manual Automations can be launched with Run now using a durable Publication Workspace snapshot.</p>
          )}
        </fieldset>

        <fieldset className="automation-studio__section">
          <legend>Publication conditions</legend>
          <p className="security-note">Leave these empty to match every Publication accepted by the selected trigger.</p>
          <div className="automation-studio__status-grid">
            {publicationStatuses.map((status) => (
              <label className="field field--checkbox" key={status}>
                <input type="checkbox" checked={statuses.has(status)} onChange={(event) => toggleStatus(status, event.target.checked)} />
                <span>{status}</span>
              </label>
            ))}
          </div>
          <div className="setup-two-column">
            <label className="field">
              <span>Require all tags</span>
              <input value={tagsAll} onChange={(event) => setTagsAll(event.target.value)} placeholder="campaign, launch" />
              <small>Comma-separated. Every listed tag must be present.</small>
            </label>
            <label className="field">
              <span>Require any tag</span>
              <input value={tagsAny} onChange={(event) => setTagsAny(event.target.value)} placeholder="news, update" />
              <small>Comma-separated. At least one listed tag must be present.</small>
            </label>
          </div>
        </fieldset>

        <fieldset className="automation-studio__section">
          <legend>Ordered steps</legend>
          {groupsLoading ? <LoadingBlock /> : null}
          <div className="automation-step-editor">
            {steps.map((step, index) => {
              const delay = step.kind === "delay" ? delayParts(step.durationMs) : null;
              return (
                <article className="automation-step-editor__item" key={step.id}>
                  <header>
                    <div>
                      <span>Step {index + 1}</span>
                      <strong>{step.kind === "publish_group" ? "Publish group" : step.kind === "approval" ? "Approval" : "Delay"}</strong>
                      <small>{step.id}</small>
                    </div>
                    <div className="automation-step-editor__actions">
                      <button className="button button--quiet" type="button" disabled={index === 0} onClick={() => setSteps((current) => moveStep(current, index, -1))}>↑</button>
                      <button className="button button--quiet" type="button" disabled={index === steps.length - 1} onClick={() => setSteps((current) => moveStep(current, index, 1))}>↓</button>
                      <button className="button button--danger" type="button" onClick={() => setSteps((current) => current.filter((candidate) => candidate.id !== step.id))}>Remove</button>
                    </div>
                  </header>

                  {step.kind === "publish_group" ? (
                    <div className="setup-two-column">
                      <label className="field">
                        <span>Publication Group</span>
                        <select
                          value={step.groupId}
                          onChange={(event) => setSteps((current) => replaceStep(current, step.id, { ...step, groupId: event.target.value }))}
                          required
                        >
                          <option value="" disabled>Choose a group</option>
                          {groups.map((group) => (
                            <option key={group.group.id} value={group.group.id} disabled={!group.enabled && group.group.id !== step.groupId}>
                              {groupLabel(group)}
                            </option>
                          ))}
                        </select>
                        {step.groupId && groupById.get(step.groupId)?.enabled === false ? (
                          <small><Link to={`/publication-groups/${encodeURIComponent(step.groupId)}`}>This referenced group is disabled. Repair it before saving an active version.</Link></small>
                        ) : null}
                      </label>
                      <label className="field">
                        <span>On publishing business failure</span>
                        <select
                          value={step.onBusinessFailure ?? "stop"}
                          onChange={(event) => setSteps((current) => replaceStep(current, step.id, {
                            ...step,
                            onBusinessFailure: event.target.value as "stop" | "continue",
                          }))}
                        >
                          <option value="stop">Stop workflow</option>
                          <option value="continue">Continue to next step</option>
                        </select>
                      </label>
                    </div>
                  ) : null}

                  {step.kind === "approval" ? (
                    <div className="setup-two-column">
                      <label className="field">
                        <span>Required role</span>
                        <input
                          value={step.role}
                          onChange={(event) => setSteps((current) => replaceStep(current, step.id, { ...step, role: event.target.value }))}
                          required
                          autoComplete="off"
                        />
                      </label>
                      <label className="field">
                        <span>Prompt</span>
                        <input
                          value={step.prompt ?? ""}
                          onChange={(event) => setSteps((current) => replaceStep(current, step.id, {
                            ...step,
                            ...(event.target.value ? { prompt: event.target.value } : { prompt: undefined }),
                          }))}
                          placeholder="Review this publication before dispatch"
                        />
                      </label>
                    </div>
                  ) : null}

                  {step.kind === "delay" && delay ? (
                    <div className="setup-two-column">
                      <label className="field">
                        <span>Delay</span>
                        <input
                          type="number"
                          min="1"
                          step="1"
                          value={delay.value}
                          onChange={(event) => {
                            const value = Number(event.target.value);
                            if (!Number.isFinite(value)) return;
                            setSteps((current) => replaceStep(current, step.id, {
                              ...step,
                              durationMs: Math.round(value * delayUnitMs[delay.unit]),
                            }));
                          }}
                          required
                        />
                      </label>
                      <label className="field">
                        <span>Unit</span>
                        <select
                          value={delay.unit}
                          onChange={(event) => {
                            const unit = event.target.value as DelayUnit;
                            setSteps((current) => replaceStep(current, step.id, {
                              ...step,
                              durationMs: Math.round(delay.value * delayUnitMs[unit]),
                            }));
                          }}
                        >
                          <option value="minutes">Minutes</option>
                          <option value="hours">Hours</option>
                          <option value="days">Days</option>
                        </select>
                      </label>
                    </div>
                  ) : null}
                </article>
              );
            })}
            {steps.length === 0 ? <EmptyState title="No workflow steps">Add at least one step. The runtime will reject an empty Automation definition.</EmptyState> : null}
          </div>

          <div className="automation-studio__add-steps" aria-label="Add Automation step">
            <button className="button button--quiet" type="button" onClick={() => addStep("publish_group")} disabled={groupsLoading}>+ Publish group</button>
            <button className="button button--quiet" type="button" onClick={() => addStep("approval")}>+ Approval</button>
            <button className="button button--quiet" type="button" onClick={() => addStep("delay")}>+ Delay</button>
          </div>
        </fieldset>

        <label className="automation-studio__activation">
          <input type="checkbox" checked={activateImmediately} onChange={(event) => setActivateImmediately(event.target.checked)} />
          <span>
            <strong>{initial ? `Activate version ${nextVersion} immediately` : "Enable this Automation immediately"}</strong>
            <small>{initial ? "When checked, registration moves the canonical active head to this immutable version." : "When unchecked, the Automation is registered disabled and can be enabled later."}</small>
          </span>
        </label>

        <div className="setup-actions">
          <button className="button button--quiet" type="button" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="button button--primary" type="submit" disabled={busy || groupsLoading || steps.length === 0}>
            {busy ? "Saving…" : initial ? `Save version ${nextVersion}` : "Create Automation"}
          </button>
        </div>
      </form>
    </Panel>
  );
}
