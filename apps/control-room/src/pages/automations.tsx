import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { Link, useNavigate, useParams } from "react-router";

import type {
  AutomationDefinition,
  AutomationRegistryEntry,
  PublicationGroupRegistryEntry,
} from "@blogmaatic/operator-client";

import { useConnection } from "../connection";
import {
  CollectionFooter,
  EmptyState,
  ErrorBanner,
  LoadingBlock,
  PageHeader,
  Panel,
  StatusPill,
} from "../components";
import { formatInstant, humanize, triggerLabel } from "../format";
import { usePagedCollection } from "../hooks";
import { consumerSlug } from "../publishing";

type AutomationStep = AutomationDefinition["steps"][number];
type StepKind = AutomationStep["kind"];
type AutomationCondition = NonNullable<AutomationDefinition["conditions"]>;
type ConditionStatus = NonNullable<AutomationCondition["statuses"]>[number];
type TriggerKind = AutomationDefinition["trigger"]["kind"];

const publicationStatuses: readonly ConditionStatus[] = [
  "idea",
  "draft",
  "ready",
  "approved",
  "queued",
  "publishing",
  "published",
  "archived",
];

function tags(value: string): readonly string[] {
  return [...new Set(value.split(",").map((tag) => tag.trim()).filter(Boolean))];
}

function stepId(kind: StepKind): string {
  return `step_${kind}_${crypto.randomUUID().slice(0, 8)}`;
}

function newStep(kind: StepKind, groupId?: string): AutomationStep {
  switch (kind) {
    case "publish_group":
      return { id: stepId(kind), kind, groupId: groupId ?? "" };
    case "approval":
      return { id: stepId(kind), kind, role: "editor", prompt: "Approve this publication before delivery." };
    case "delay":
      return { id: stepId(kind), kind, durationMs: 5 * 60 * 1000 };
  }
}

function stepSummary(step: AutomationStep, groups: ReadonlyMap<string, PublicationGroupRegistryEntry>): string {
  switch (step.kind) {
    case "publish_group":
      return `Publish to ${groups.get(step.groupId)?.group.name ?? step.groupId}`;
    case "approval":
      return `Wait for ${step.role} approval`;
    case "delay":
      return `Wait ${Math.max(1, Math.round(step.durationMs / 60000))} minute${step.durationMs === 60000 ? "" : "s"}`;
  }
}

function AutomationBuilder({
  current,
  groups,
  onSaved,
  onCancel,
}: {
  readonly current?: AutomationRegistryEntry;
  readonly groups: readonly PublicationGroupRegistryEntry[];
  readonly onSaved: (entry: AutomationRegistryEntry) => Promise<void> | void;
  readonly onCancel: () => void;
}) {
  const { session } = useConnection();
  const client = session!.client;
  const enabledGroups = useMemo(() => groups.filter((entry) => entry.enabled), [groups]);
  const groupMap = useMemo(() => new Map(groups.map((entry) => [entry.group.id, entry])), [groups]);
  const firstGroupId = enabledGroups[0]?.group.id ?? "";
  const [name, setName] = useState(current?.definition.name ?? "Publish content");
  const [triggerKind, setTriggerKind] = useState<TriggerKind>(current?.definition.trigger.kind ?? "manual");
  const [eventType, setEventType] = useState(
    current?.definition.trigger.kind === "event" ? current.definition.trigger.eventType : "publication.approved",
  );
  const [statuses, setStatuses] = useState<ReadonlySet<ConditionStatus>>(
    () => new Set(current?.definition.conditions?.statuses ?? []),
  );
  const [tagsAll, setTagsAll] = useState((current?.definition.conditions?.tagsAll ?? []).join(", "));
  const [tagsAny, setTagsAny] = useState((current?.definition.conditions?.tagsAny ?? []).join(", "));
  const [steps, setSteps] = useState<readonly AutomationStep[]>(
    () => current?.definition.steps.map((step) => ({ ...step })) ?? [newStep("publish_group", firstGroupId)],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const updateStep = useCallback((index: number, next: AutomationStep) => {
    setSteps((currentSteps) => currentSteps.map((step, stepIndex) => stepIndex === index ? next : step));
  }, []);

  const removeStep = useCallback((index: number) => {
    setSteps((currentSteps) => currentSteps.filter((_, stepIndex) => stepIndex !== index));
  }, []);

  const moveStep = useCallback((index: number, offset: -1 | 1) => {
    setSteps((currentSteps) => {
      const target = index + offset;
      if (target < 0 || target >= currentSteps.length) return currentSteps;
      const next = [...currentSteps];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  }, []);

  const addStep = useCallback((kind: StepKind) => {
    setSteps((currentSteps) => [...currentSteps, newStep(kind, firstGroupId)]);
  }, [firstGroupId]);

  const save = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const trimmedName = name.trim();
      if (!trimmedName) throw new Error("Automation name is required");
      if (steps.length === 0) throw new Error("Add at least one automation step");
      for (const step of steps) {
        if (step.kind === "publish_group" && !groupMap.get(step.groupId)?.enabled) {
          throw new Error("Every publishing step must use an enabled publishing group");
        }
        if (step.kind === "approval" && !step.role.trim()) throw new Error("Approval role is required");
        if (step.kind === "delay" && (!Number.isSafeInteger(step.durationMs) || step.durationMs < 1)) {
          throw new Error("Delay duration must be at least one millisecond");
        }
      }
      if (triggerKind === "event" && !eventType.trim()) throw new Error("Event type is required");

      const statusList = [...statuses];
      const allTags = tags(tagsAll);
      const anyTags = tags(tagsAny);
      const hasConditions = statusList.length > 0 || allTags.length > 0 || anyTags.length > 0;
      const desiredEnabled = current?.enabled ?? true;
      const version = current ? current.definition.version + 1 : 1;
      const id = current?.definition.id ?? `automation_${consumerSlug(trimmedName)}_${crypto.randomUUID().slice(0, 8)}`;
      const trigger: AutomationDefinition["trigger"] = triggerKind === "event"
        ? { kind: "event", eventType: eventType.trim() }
        : triggerKind === "schedule"
          ? { kind: "schedule" }
          : { kind: "manual" };
      const definition: AutomationDefinition = {
        id,
        version,
        name: trimmedName,
        enabled: current && !desiredEnabled ? false : true,
        trigger,
        ...(hasConditions ? {
          conditions: {
            ...(statusList.length ? { statuses: statusList } : {}),
            ...(allTags.length ? { tagsAll: allTags } : {}),
            ...(anyTags.length ? { tagsAny: anyTags } : {}),
          },
        } : {}),
        steps,
      };

      let saved = await client.registerAutomation(definition);
      if (current && !desiredEnabled) {
        saved = await client.activateAutomation(id, version, { enabled: false });
      }
      await onSaved(saved);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("Automation could not be saved"));
    } finally {
      setBusy(false);
    }
  }, [client, current, eventType, groupMap, name, onSaved, statuses, steps, tagsAll, tagsAny, triggerKind]);

  return (
    <form className="automation-builder" onSubmit={save}>
      <ErrorBanner error={error} />
      {enabledGroups.length === 0 ? (
        <div className="automation-builder__warning">
          <strong>No enabled publishing group is available.</strong>
          <span>Enable or create a publishing group before adding a publish step.</span>
          <Link className="button button--quiet" to="/groups">Manage publishing groups</Link>
        </div>
      ) : null}
      <div className="automation-builder__grid">
        <label className="field">
          <span>Automation name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} required autoComplete="off" />
          <small>{current ? `Saving creates immutable version ${current.definition.version + 1}.` : "Give this workflow a task-focused name."}</small>
        </label>
        <label className="field">
          <span>Trigger</span>
          <select value={triggerKind} onChange={(event) => setTriggerKind(event.target.value as TriggerKind)}>
            <option value="manual">Publish on demand</option>
            <option value="event">When an event happens</option>
            <option value="schedule">From a publishing schedule</option>
          </select>
          <small>{triggerKind === "manual" ? "Available from Publish now." : triggerKind === "schedule" ? "Used by scheduled publications." : "Runs when the matching event is ingested."}</small>
        </label>
      </div>
      {triggerKind === "event" ? (
        <label className="field">
          <span>Event type</span>
          <input value={eventType} onChange={(event) => setEventType(event.target.value)} required autoComplete="off" placeholder="publication.approved" />
          <small>`publication.approved` is the standard approval event; integrations may use their own documented event types.</small>
        </label>
      ) : null}

      <fieldset className="automation-conditions">
        <legend>Run conditions <span>optional</span></legend>
        <p>Use conditions to keep this automation focused. Leaving them empty accepts any publication handled by the trigger.</p>
        <div className="automation-statuses">
          {publicationStatuses.map((status) => (
            <label key={status}>
              <input
                type="checkbox"
                checked={statuses.has(status)}
                onChange={(event) => setStatuses((currentStatuses) => {
                  const next = new Set(currentStatuses);
                  if (event.target.checked) next.add(status);
                  else next.delete(status);
                  return next;
                })}
              />
              {humanize(status)}
            </label>
          ))}
        </div>
        <div className="automation-builder__grid">
          <label className="field">
            <span>Require all tags</span>
            <input value={tagsAll} onChange={(event) => setTagsAll(event.target.value)} placeholder="release, approved" />
            <small>Comma-separated. Every tag must be present.</small>
          </label>
          <label className="field">
            <span>Require any tag</span>
            <input value={tagsAny} onChange={(event) => setTagsAny(event.target.value)} placeholder="news, product" />
            <small>Comma-separated. At least one tag must be present.</small>
          </label>
        </div>
      </fieldset>

      <fieldset className="automation-steps-editor">
        <legend>Workflow steps</legend>
        <p>Steps execute in order and remain frozen inside every durable run.</p>
        <div className="automation-step-editor-list">
          {steps.map((step, index) => (
            <article className="automation-step-editor" key={step.id}>
              <div className="automation-step-editor__number">{String(index + 1).padStart(2, "0")}</div>
              <div className="automation-step-editor__body">
                <div className="automation-step-editor__heading">
                  <div><strong>{humanize(step.kind)}</strong><small>{stepSummary(step, groupMap)}</small></div>
                  <div className="automation-step-editor__controls">
                    <button className="icon-button" type="button" disabled={index === 0} onClick={() => moveStep(index, -1)} aria-label={`Move step ${index + 1} up`}>↑</button>
                    <button className="icon-button" type="button" disabled={index === steps.length - 1} onClick={() => moveStep(index, 1)} aria-label={`Move step ${index + 1} down`}>↓</button>
                    <button className="button button--quiet" type="button" disabled={steps.length === 1} onClick={() => removeStep(index)}>Remove</button>
                  </div>
                </div>
                {step.kind === "publish_group" ? (
                  <label className="field">
                    <span>Publishing group</span>
                    <select value={step.groupId} onChange={(event) => updateStep(index, { ...step, groupId: event.target.value })} required>
                      <option value="">Choose a publishing group</option>
                      {groups.map((group) => (
                        <option key={group.group.id} value={group.group.id} disabled={!group.enabled}>{group.group.name}{group.enabled ? "" : " (disabled)"}</option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {step.kind === "approval" ? (
                  <div className="automation-builder__grid">
                    <label className="field">
                      <span>Approval role</span>
                      <input value={step.role} onChange={(event) => updateStep(index, { ...step, role: event.target.value })} required />
                    </label>
                    <label className="field">
                      <span>Approval prompt</span>
                      <input value={step.prompt ?? ""} onChange={(event) => updateStep(index, { ...step, prompt: event.target.value || undefined })} placeholder="Review before publishing" />
                    </label>
                  </div>
                ) : null}
                {step.kind === "delay" ? (
                  <label className="field automation-delay-field">
                    <span>Delay in minutes</span>
                    <input
                      type="number"
                      min="1"
                      max={365 * 24 * 60}
                      value={Math.max(1, Math.round(step.durationMs / 60000))}
                      onChange={(event) => updateStep(index, { ...step, durationMs: Math.max(1, Number(event.target.value) || 1) * 60000 })}
                      required
                    />
                  </label>
                ) : null}
              </div>
            </article>
          ))}
        </div>
        <div className="automation-add-steps">
          <span>Add step</span>
          <button className="button button--quiet" type="button" disabled={enabledGroups.length === 0} onClick={() => addStep("publish_group")}>Publish group</button>
          <button className="button button--quiet" type="button" onClick={() => addStep("approval")}>Approval</button>
          <button className="button button--quiet" type="button" onClick={() => addStep("delay")}>Delay</button>
        </div>
      </fieldset>

      <div className="automation-builder__actions">
        <button className="button button--quiet" type="button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="button button--primary" type="submit" disabled={busy || steps.length === 0}>{busy ? "Saving…" : current ? "Save new version" : "Create automation"}</button>
      </div>
    </form>
  );
}

function VersionsPanel({ automationId, changeNonce, onChanged }: { readonly automationId: string; readonly changeNonce: number; readonly onChanged: () => void }) {
  const { session } = useConnection();
  const [actionError, setActionError] = useState<Error | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [pendingVersion, setPendingVersion] = useState<number | null>(null);
  const loader = useCallback((cursor?: string) => session!.client.listAutomationVersions(automationId, {
    limit: 50,
    ...(cursor ? { cursor } : {}),
  }), [automationId, session]);
  const collection = usePagedCollection(`automation-versions:${automationId}:${changeNonce}`, loader);

  const activate = useCallback(async (entry: AutomationRegistryEntry) => {
    setBusy(entry.definition.version);
    setActionError(null);
    try {
      await session!.client.activateAutomation(automationId, entry.definition.version, { enabled: true });
      setPendingVersion(null);
      onChanged();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause : new Error("Activation failed"));
    } finally {
      setBusy(null);
    }
  }, [automationId, onChanged, session]);

  return (
    <Panel title="Version history" className="automation-version-panel">
      <ErrorBanner error={actionError ?? collection.error} />
      {collection.loading ? <LoadingBlock /> : (
        <div className="version-list">
          {collection.items.map((entry) => (
            <div className="version-row" key={entry.definition.version}>
              <div><strong>v{entry.definition.version}</strong><small>{formatInstant(entry.registeredAt)}</small></div>
              <span>{entry.definition.steps.length} steps · {triggerLabel(entry.definition.trigger.kind)}</span>
              <StatusPill value={entry.isActiveVersion ? (entry.enabled ? "enabled" : "disabled") : "inactive"} />
              {!entry.isActiveVersion ? (
                pendingVersion === entry.definition.version ? (
                  <div className="inline-confirm-actions" aria-label={`Confirm activation of version ${entry.definition.version}`}>
                    <button className="button button--quiet" type="button" disabled={busy === entry.definition.version} onClick={() => setPendingVersion(null)}>Cancel</button>
                    <button className="button button--primary" type="button" disabled={busy === entry.definition.version} onClick={() => void activate(entry)}>{busy === entry.definition.version ? "Activating…" : "Confirm"}</button>
                  </div>
                ) : <button className="button button--quiet" type="button" onClick={() => setPendingVersion(entry.definition.version)}>Activate</button>
              ) : null}
            </div>
          ))}
        </div>
      )}
      <CollectionFooter hasMore={Boolean(collection.nextCursor)} busy={collection.loadingMore} onLoadMore={() => void collection.loadMore()} />
    </Panel>
  );
}

function AutomationDetail({
  automationId,
  groups,
  changeNonce,
  onChanged,
}: {
  readonly automationId: string;
  readonly groups: readonly PublicationGroupRegistryEntry[];
  readonly changeNonce: number;
  readonly onChanged: () => void;
}) {
  const { session } = useConnection();
  const [entry, setEntry] = useState<AutomationRegistryEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setEntry(await session!.client.getAutomation(automationId));
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("Automation could not be loaded"));
      setEntry(null);
    } finally {
      setLoading(false);
    }
  }, [automationId, session]);

  useEffect(() => { void load(); }, [load, changeNonce]);

  if (loading && !entry) return <Panel title="Automation"><LoadingBlock /></Panel>;
  if (!entry) return <Panel title="Automation"><ErrorBanner error={error} /></Panel>;

  if (editing) {
    return (
      <Panel title={`Edit ${entry.definition.name}`} meta={`Current v${entry.definition.version}`} className="automation-editor-panel">
        <AutomationBuilder
          key={`${entry.definition.id}:${entry.definition.version}`}
          current={entry}
          groups={groups}
          onCancel={() => setEditing(false)}
          onSaved={async (saved) => {
            setEntry(saved);
            setEditing(false);
            onChanged();
          }}
        />
      </Panel>
    );
  }

  return (
    <div className="automation-detail-stack">
      <Panel title={entry.definition.name} meta={`v${entry.definition.version}`} className="automation-editor-panel">
        <ErrorBanner error={error} />
        <div className="automation-detail-summary">
          <div><span>Status</span><StatusPill value={entry.enabled ? "enabled" : "disabled"} /></div>
          <div><span>Trigger</span><strong>{triggerLabel(entry.definition.trigger.kind)}</strong></div>
          <div><span>Steps</span><strong>{entry.definition.steps.length}</strong></div>
          <div><span>Registered</span><strong>{formatInstant(entry.registeredAt)}</strong></div>
        </div>
        <div className="automation-detail-steps">
          {entry.definition.steps.map((step, index) => (
            <div key={step.id}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{humanize(step.kind)}</strong><small>{stepSummary(step, new Map(groups.map((group) => [group.group.id, group])))}</small></div></div>
          ))}
        </div>
        <div className="automation-detail-actions">
          <button className="button button--primary" type="button" onClick={() => setEditing(true)}>Edit as new version</button>
        </div>
      </Panel>
      <VersionsPanel automationId={automationId} changeNonce={changeNonce} onChanged={onChanged} />
    </div>
  );
}

export function AutomationsPage() {
  const { automationId } = useParams();
  const navigate = useNavigate();
  const { session } = useConnection();
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingToggle, setPendingToggle] = useState<string | null>(null);
  const [actionError, setActionError] = useState<Error | null>(null);
  const [changeNonce, setChangeNonce] = useState(0);
  const [creating, setCreating] = useState(false);
  const [groups, setGroups] = useState<readonly PublicationGroupRegistryEntry[]>([]);
  const [groupsError, setGroupsError] = useState<Error | null>(null);
  const loader = useCallback((cursor?: string) => session!.client.listAutomations({ limit: 30, ...(cursor ? { cursor } : {}) }), [session]);
  const collection = usePagedCollection(`automations:${changeNonce}`, loader);

  const loadGroups = useCallback(async () => {
    try {
      const page = await session!.client.listPublicationGroups({ limit: 100 });
      setGroups(page.items);
      setGroupsError(null);
    } catch (cause) {
      setGroupsError(cause instanceof Error ? cause : new Error("Publishing groups could not be loaded"));
    }
  }, [session]);

  useEffect(() => { void loadGroups(); }, [changeNonce, loadGroups]);

  const changed = useCallback(() => setChangeNonce((value) => value + 1), []);

  const toggle = useCallback(async (entry: AutomationRegistryEntry) => {
    setBusy(entry.definition.id);
    setActionError(null);
    try {
      await session!.client.activateAutomation(entry.definition.id, entry.definition.version, { enabled: !entry.enabled });
      setPendingToggle(null);
      changed();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause : new Error("Automation update failed"));
    } finally {
      setBusy(null);
    }
  }, [changed, session]);

  const openCreate = useCallback(() => {
    setCreating(true);
    navigate("/automations");
  }, [navigate]);

  return (
    <>
      <PageHeader
        eyebrow="Publishing workflow"
        title="Automations"
        description="Build durable publishing workflows, choose what starts them, and evolve them through immutable versions without rewriting run history."
        actions={<button className="button button--primary" type="button" onClick={openCreate}>New automation</button>}
      />
      <ErrorBanner error={actionError ?? groupsError ?? collection.error} />
      <div className={`automation-layout ${(automationId || creating) ? "automation-layout--open automation-layout--builder" : ""}`}>
        <Panel className="table-panel">
          {collection.loading ? <LoadingBlock /> : (
            <div className="automation-list">
              {collection.items.map((entry) => (
                <article className={`automation-row ${automationId === entry.definition.id ? "is-selected" : ""}`} key={entry.definition.id}>
                  <Link className="automation-row__identity" to={`/automations/${encodeURIComponent(entry.definition.id)}`} onClick={() => setCreating(false)}>
                    <strong>{entry.definition.name}</strong>
                    <small>{entry.definition.id}</small>
                  </Link>
                  <div><small>Trigger</small><span>{triggerLabel(entry.definition.trigger.kind)}</span></div>
                  <div><small>Version</small><span>v{entry.definition.version}</span></div>
                  <div><small>Steps</small><span>{entry.definition.steps.length}</span></div>
                  <StatusPill value={entry.enabled ? "enabled" : "disabled"} />
                  {pendingToggle === entry.definition.id ? (
                    <div className="inline-confirm-actions" aria-label={`Confirm ${entry.enabled ? "disable" : "enable"} ${entry.definition.name}`}>
                      <button className="button button--quiet" type="button" disabled={busy === entry.definition.id} onClick={() => setPendingToggle(null)}>Cancel</button>
                      <button className={entry.enabled ? "button button--danger" : "button button--primary"} type="button" disabled={busy === entry.definition.id} onClick={() => void toggle(entry)}>{busy === entry.definition.id ? "Saving…" : `Confirm ${entry.enabled ? "disable" : "enable"}`}</button>
                    </div>
                  ) : <button className="button button--quiet" type="button" disabled={busy === entry.definition.id} onClick={() => setPendingToggle(entry.definition.id)}>{entry.enabled ? "Disable" : "Enable"}</button>}
                </article>
              ))}
              {collection.items.length === 0 ? (
                <div className="automation-empty-action">
                  <EmptyState title="Create your first automation">Build a real publishing workflow here. No API registration or configuration-file editing is required.</EmptyState>
                  <button className="button button--primary" type="button" onClick={openCreate}>Create automation</button>
                </div>
              ) : null}
            </div>
          )}
          <CollectionFooter hasMore={Boolean(collection.nextCursor)} busy={collection.loadingMore} onLoadMore={() => void collection.loadMore()} />
        </Panel>
        {creating ? (
          <Panel title="New automation" className="automation-editor-panel">
            <AutomationBuilder
              groups={groups}
              onCancel={() => setCreating(false)}
              onSaved={async (saved) => {
                setCreating(false);
                changed();
                navigate(`/automations/${encodeURIComponent(saved.definition.id)}`);
              }}
            />
          </Panel>
        ) : automationId ? <AutomationDetail automationId={automationId} groups={groups} changeNonce={changeNonce} onChanged={changed} /> : null}
      </div>
    </>
  );
}
