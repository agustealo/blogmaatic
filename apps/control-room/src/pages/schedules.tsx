import { useCallback, useState, type FormEvent } from "react";
import { Link } from "react-router";

import type {
  AutomationSchedule,
  PublicationGroupRegistryEntry,
  PublicationWorkspaceEntry,
  ScheduleListQuery,
  ScheduleRegistrationBody,
} from "@blogmaatic/operator-client";

import { useConnection } from "../connection";
import { CollectionFooter, EmptyState, ErrorBanner, LoadingBlock, PageHeader, Panel, StatusPill } from "../components";
import { formatInstant, recurrenceLabel } from "../format";
import { usePagedCollection } from "../hooks";

interface PendingSchedulePlan {
  readonly scheduleId: string;
  readonly automationId: string;
  readonly groupId: string;
}

function futureLocalDate(): string {
  const date = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function CreateSchedulePanel({
  groups,
  publications,
  loading,
  onCreated,
  onCancel,
}: {
  readonly groups: readonly PublicationGroupRegistryEntry[];
  readonly publications: readonly PublicationWorkspaceEntry[];
  readonly loading: boolean;
  readonly onCreated: (schedule: AutomationSchedule) => void;
  readonly onCancel: () => void;
}) {
  const { session } = useConnection();
  const [name, setName] = useState("Scheduled publication");
  const [groupId, setGroupId] = useState(groups[0]?.group.id ?? "");
  const [publicationId, setPublicationId] = useState(publications[0]?.publication.id ?? "");
  const [timezone, setTimezone] = useState(localTimezone);
  const [localDate, setLocalDate] = useState(futureLocalDate);
  const [localTime, setLocalTime] = useState("09:00");
  const [recurrenceKind, setRecurrenceKind] = useState<"once" | "daily" | "weekly">("once");
  const [weekdays, setWeekdays] = useState<ReadonlySet<number>>(new Set([1]));
  const [missedRunPolicy, setMissedRunPolicy] = useState<"catch_up_once" | "skip">("skip");
  const [pendingPlan, setPendingPlan] = useState<PendingSchedulePlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const toggleWeekday = (day: number, checked: boolean) => {
    setWeekdays((current) => {
      const next = new Set(current);
      if (checked) next.add(day);
      else next.delete(day);
      return next;
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      if (!name.trim()) throw new Error("Schedule name is required");
      const selectedGroupId = pendingPlan?.groupId ?? (groupId || groups[0]?.group.id);
      const selectedPublicationId = publicationId || publications[0]?.publication.id;
      if (!selectedGroupId) throw new Error("Create and enable a Publication Group first");
      if (!selectedPublicationId) throw new Error("Approve a Publication in the Workspace before scheduling it");
      if (!timezone.trim()) throw new Error("Timezone is required");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) throw new Error("Choose a valid local date");
      if (!/^\d{2}:\d{2}$/.test(localTime)) throw new Error("Choose a valid local time");
      if (recurrenceKind === "weekly" && weekdays.size === 0) throw new Error("Choose at least one weekday for a weekly schedule");

      const [group, publication] = await Promise.all([
        session.client.getPublicationGroup(selectedGroupId),
        session.client.getPublication(selectedPublicationId),
      ]);
      if (!group.enabled) throw new Error("The selected Publication Group is disabled. Enable it before scheduling publication.");
      if (publication.publication.status !== "approved") {
        throw new Error("The selected Publication changed and is no longer approved. Review it in Publications before scheduling.");
      }

      const plan = pendingPlan ?? {
        scheduleId: `schedule_${crypto.randomUUID()}`,
        automationId: `automation_schedule_${crypto.randomUUID()}`,
        groupId: group.group.id,
      };

      if (!pendingPlan) {
        await session.client.registerAutomation({
          id: plan.automationId,
          version: 1,
          name: name.trim(),
          enabled: true,
          trigger: { kind: "schedule", scheduleId: plan.scheduleId },
          steps: [{ id: "publish", kind: "publish_group", groupId: group.group.id }],
        });
        setPendingPlan(plan);
      } else {
        await session.client.activateAutomation(plan.automationId, 1, { enabled: true });
      }

      const recurrence: ScheduleRegistrationBody["recurrence"] = recurrenceKind === "weekly"
        ? { kind: "weekly", weekdays: [...weekdays].sort((a, b) => a - b) }
        : { kind: recurrenceKind };

      let schedule: AutomationSchedule;
      try {
        schedule = await session.client.createSchedule({
          id: plan.scheduleId,
          automationId: plan.automationId,
          automationVersion: 1,
          publication: publication.publication,
          groups: [group.group],
          timezone: timezone.trim(),
          localDate,
          localTime,
          recurrence,
          missedRunPolicy,
          enabled: true,
        });
      } catch (scheduleCause) {
        let rollbackError: Error | null = null;
        try {
          await session.client.activateAutomation(plan.automationId, 1, { enabled: false });
        } catch (rollbackCause) {
          rollbackError = rollbackCause instanceof Error ? rollbackCause : new Error("Automation rollback failed");
        }
        const scheduleError = scheduleCause instanceof Error ? scheduleCause : new Error("Schedule could not be created");
        if (rollbackError) {
          throw new Error(`${scheduleError.message}. The paired Automation could not be disabled automatically; review ${plan.automationId} in Automations.`);
        }
        throw new Error(`${scheduleError.message}. The paired Automation was disabled safely; fix the schedule and retry.`);
      }

      setPendingPlan(null);
      onCreated(schedule);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("Schedule could not be created"));
    } finally {
      setBusy(false);
    }
  };

  const effectiveGroupId = pendingPlan?.groupId ?? (groupId || groups[0]?.group.id || "");

  return (
    <Panel title="Create Schedule" meta="Immutable publication snapshot">
      <form className="setup-step setup-form" onSubmit={submit}>
        <ErrorBanner error={error} />
        <p>Schedule an approved Workspace Publication through one enabled Publication Group. Blogmaatic creates a dedicated schedule-trigger Automation, freezes the current publication and group snapshots, and lets the durable scheduler own future dispatch.</p>
        {pendingPlan ? (
          <div className="warning-banner" role="status">
            <strong>Retrying a partially created schedule.</strong>
            <span>The paired Automation is currently disabled. Timing and publication can be corrected here; the original schedule and Automation identities stay fixed.</span>
          </div>
        ) : null}
        <label className="field">
          <span>Schedule name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} disabled={Boolean(pendingPlan)} required autoComplete="off" />
        </label>
        <label className="field">
          <span>Publication Group</span>
          <select value={effectiveGroupId} onChange={(event) => setGroupId(event.target.value)} disabled={loading || groups.length === 0 || Boolean(pendingPlan)} required>
            {groups.map((entry) => <option key={entry.group.id} value={entry.group.id}>{entry.group.name}</option>)}
          </select>
          <small>Only enabled Publication Groups are offered.</small>
        </label>
        <label className="field">
          <span>Approved Publication</span>
          <select value={publicationId || publications[0]?.publication.id || ""} onChange={(event) => setPublicationId(event.target.value)} disabled={loading || publications.length === 0} required>
            {publications.map((entry) => <option key={entry.publication.id} value={entry.publication.id}>{entry.publication.current.content.title}</option>)}
          </select>
          <small>The current approved revision is frozen into this schedule. Later edits do not silently change a future dispatch.</small>
        </label>
        <div className="setup-two-column">
          <label className="field"><span>Timezone</span><input value={timezone} onChange={(event) => setTimezone(event.target.value)} required /></label>
          <label className="field"><span>Start date</span><input type="date" value={localDate} onChange={(event) => setLocalDate(event.target.value)} required /></label>
          <label className="field"><span>Local time</span><input type="time" value={localTime} onChange={(event) => setLocalTime(event.target.value)} required /></label>
          <label className="field">
            <span>Recurrence</span>
            <select value={recurrenceKind} onChange={(event) => setRecurrenceKind(event.target.value as typeof recurrenceKind)}>
              <option value="once">Once</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </label>
        </div>
        {recurrenceKind === "weekly" ? (
          <fieldset className="setup-step">
            <legend>Weekdays</legend>
            <div className="setup-checks">
              {[
                [1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [7, "Sun"],
              ].map(([day, label]) => (
                <label className="field field--checkbox" key={day}>
                  <input type="checkbox" checked={weekdays.has(day as number)} onChange={(event) => toggleWeekday(day as number, event.target.checked)} />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        <label className="field">
          <span>If the runtime was offline at fire time</span>
          <select value={missedRunPolicy} onChange={(event) => setMissedRunPolicy(event.target.value as typeof missedRunPolicy)}>
            <option value="skip">Skip a stale fire</option>
            <option value="catch_up_once">Catch up once</option>
          </select>
        </label>
        {loading ? <LoadingBlock /> : null}
        {!loading && groups.length === 0 ? (
          <div className="automation-create-empty">
            <EmptyState title="No enabled Publication Group">A schedule needs a real publishing destination.</EmptyState>
            <Link className="button button--primary" to="/publication-groups">Manage Publication Groups</Link>
          </div>
        ) : null}
        {!loading && publications.length === 0 ? (
          <div className="automation-create-empty">
            <EmptyState title="No approved Publication">Approve a Workspace Publication before scheduling it.</EmptyState>
            <Link className="button button--primary" to="/publications">Open Publications</Link>
          </div>
        ) : null}
        <div className="setup-actions">
          <button className="button button--quiet" type="button" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="button button--primary" type="submit" disabled={busy || loading || groups.length === 0 || publications.length === 0}>{busy ? "Creating…" : pendingPlan ? "Retry Schedule" : "Create Schedule"}</button>
        </div>
      </form>
    </Panel>
  );
}

export function SchedulesPage() {
  const { session } = useConnection();
  const [enabled, setEnabled] = useState<"" | "true" | "false">("");
  const [createOpen, setCreateOpen] = useState(false);
  const [supportLoading, setSupportLoading] = useState(false);
  const [groups, setGroups] = useState<readonly PublicationGroupRegistryEntry[]>([]);
  const [publications, setPublications] = useState<readonly PublicationWorkspaceEntry[]>([]);
  const [busyScheduleId, setBusyScheduleId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<Error | null>(null);
  const [createdScheduleId, setCreatedScheduleId] = useState<string | null>(null);
  const loader = useCallback((cursor?: string) => {
    if (!session) return Promise.resolve({ items: [] });
    const query: ScheduleListQuery = {
      limit: 30,
      ...(enabled ? { enabled: enabled === "true" } : {}),
      ...(cursor ? { cursor } : {}),
    };
    return session.client.listSchedules(query);
  }, [enabled, session]);
  const collection = usePagedCollection(`schedules:${enabled}`, loader);

  const openCreate = useCallback(async () => {
    if (!session) return;
    setCreateOpen(true);
    setSupportLoading(true);
    setActionError(null);
    setCreatedScheduleId(null);
    try {
      const groupItems: PublicationGroupRegistryEntry[] = [];
      let groupCursor: string | undefined;
      do {
        const page = await session.client.listPublicationGroups({ enabled: true, limit: 200, ...(groupCursor ? { cursor: groupCursor } : {}) });
        groupItems.push(...page.items);
        groupCursor = page.nextCursor;
      } while (groupCursor);

      const publicationItems: PublicationWorkspaceEntry[] = [];
      let publicationCursor: string | undefined;
      do {
        const page = await session.client.listPublications({ status: "approved", limit: 200, ...(publicationCursor ? { cursor: publicationCursor } : {}) });
        publicationItems.push(...page.items);
        publicationCursor = page.nextCursor;
      } while (publicationCursor);

      setGroups(groupItems);
      setPublications(publicationItems);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause : new Error("Schedule support data could not be loaded"));
    } finally {
      setSupportLoading(false);
    }
  }, [session]);

  const toggleSchedule = useCallback(async (schedule: AutomationSchedule) => {
    if (!session) return;
    const nextEnabled = !schedule.enabled;
    if (!window.confirm(`${nextEnabled ? "Enable" : "Disable"} schedule ${schedule.id}?`)) return;
    setBusyScheduleId(schedule.id);
    setActionError(null);
    try {
      await session.client.setScheduleEnabled(schedule.id, {
        expectedUpdatedAt: schedule.updatedAt,
        enabled: nextEnabled,
      });
      await collection.reload();
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error("Schedule state could not be changed");
      setActionError(error);
      if ("status" in error && error.status === 409) await collection.reload();
    } finally {
      setBusyScheduleId(null);
    }
  }, [collection, session]);

  const created = useCallback((schedule: AutomationSchedule) => {
    setCreatedScheduleId(schedule.id);
    setCreateOpen(false);
    void collection.reload();
  }, [collection]);

  return (
    <>
      <PageHeader
        eyebrow="Runtime scheduling"
        title="Schedules"
        description="Create, inspect, enable, and disable durable publication schedules. Each schedule freezes an approved Publication Workspace revision and current Publication Group snapshot, while the runtime owns timezone-aware future dispatch."
        actions={<button className="button button--primary" type="button" onClick={() => void openCreate()} disabled={supportLoading}>New Schedule</button>}
      />
      <ErrorBanner error={actionError ?? collection.error} />
      {createdScheduleId ? (
        <div className="success-banner" role="status"><strong>Schedule created.</strong><span>{createdScheduleId}</span></div>
      ) : null}
      {createOpen ? (
        <CreateSchedulePanel
          groups={groups}
          publications={publications}
          loading={supportLoading}
          onCreated={created}
          onCancel={() => setCreateOpen(false)}
        />
      ) : null}
      <div className="toolbar">
        <label className="field field--inline">
          <span>State</span>
          <select value={enabled} onChange={(event) => setEnabled(event.target.value as typeof enabled)}>
            <option value="">All schedules</option>
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </select>
        </label>
        <button className="button button--quiet" type="button" onClick={() => void collection.reload()} disabled={collection.loading}>Refresh</button>
      </div>
      {collection.loading ? <LoadingBlock /> : (
        <Panel className="table-panel" title="Durable schedules" meta="Automatic dispatch">
          <div className="data-table data-table--schedules">
            <div className="data-table__head"><span>Schedule</span><span>Automation</span><span>Local time</span><span>Next fire</span><span>State</span></div>
            {collection.items.map((schedule) => (
              <div className="data-table__row" key={schedule.id}>
                <span><strong>{schedule.id}</strong><small>{recurrenceLabel(schedule)}</small></span>
                <span>
                  <Link to={`/automations/${encodeURIComponent(schedule.automationId)}`}><strong>{schedule.automationId}</strong></Link>
                  <small>v{schedule.automationVersion}</small>
                </span>
                <span><strong>{schedule.localDate} · {schedule.localTime}</strong><small>{schedule.timezone}</small></span>
                <span><strong>{formatInstant(schedule.nextFireAt)}</strong>{schedule.lastFireAt ? <small>Last {formatInstant(schedule.lastFireAt)}</small> : null}</span>
                <span>
                  <StatusPill value={schedule.enabled ? "enabled" : "disabled"} />
                  <button
                    className={schedule.enabled ? "button button--danger" : "button button--quiet"}
                    type="button"
                    disabled={busyScheduleId !== null || (!schedule.enabled && schedule.nextFireAt === null)}
                    onClick={() => void toggleSchedule(schedule)}
                  >
                    {busyScheduleId === schedule.id ? "Saving…" : schedule.enabled ? "Disable" : schedule.nextFireAt === null ? "Finished" : "Enable"}
                  </button>
                </span>
              </div>
            ))}
          </div>
          {collection.items.length === 0 ? (
            <div className="publication-group-empty">
              <EmptyState title="No matching schedules">Create a durable schedule here instead of using the Operator API. Timing changes are intentionally modeled as a new schedule so existing run history remains unambiguous.</EmptyState>
              <button className="button button--primary" type="button" onClick={() => void openCreate()}>Create Schedule</button>
            </div>
          ) : null}
        </Panel>
      )}
      <CollectionFooter hasMore={Boolean(collection.nextCursor)} busy={collection.loadingMore} onLoadMore={() => void collection.loadMore()} />
    </>
  );
}
