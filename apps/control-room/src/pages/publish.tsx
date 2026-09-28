import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

import type {
  AutomationRegistryEntry,
  ManualRunBody,
  PublicationGroupRegistryEntry,
  ScheduleRegistrationBody,
} from "@blogmaatic/operator-client";

import {
  EmptyState,
  ErrorBanner,
  LoadingBlock,
  PageHeader,
  Panel,
  StatusPill,
} from "../components";
import { useConnection } from "../connection";
import { humanize, triggerLabel } from "../format";
import { consumerSlug } from "../publishing";

type Publication = ManualRunBody["publication"];
type PublicationStatus = Publication["status"];
type RecurrenceKind = ScheduleRegistrationBody["recurrence"]["kind"];
type MissedRunPolicy = ScheduleRegistrationBody["missedRunPolicy"];
type PublishMode = "now" | "schedule";

const publicationStatuses: readonly PublicationStatus[] = [
  "draft",
  "ready",
  "approved",
  "queued",
];

const weekdays = [
  [0, "Sun"],
  [1, "Mon"],
  [2, "Tue"],
  [3, "Wed"],
  [4, "Thu"],
  [5, "Fri"],
  [6, "Sat"],
] as const;

function localDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function tagList(value: string): readonly string[] {
  return [...new Set(value.split(",").map((tag) => tag.trim()).filter(Boolean))];
}

function groupIdsFor(entry: AutomationRegistryEntry): readonly string[] {
  return [...new Set(entry.definition.steps.flatMap((step) => step.kind === "publish_group" ? [step.groupId] : []))];
}

function workflowIsRunnable(
  entry: AutomationRegistryEntry,
  groups: ReadonlyMap<string, PublicationGroupRegistryEntry>,
  kind: "manual" | "schedule",
): boolean {
  if (!entry.enabled || entry.definition.trigger.kind !== kind) return false;
  const groupIds = groupIdsFor(entry);
  return groupIds.length > 0 && groupIds.every((id) => groups.get(id)?.enabled);
}

function workflowDescription(entry: AutomationRegistryEntry): string {
  const groupCount = groupIdsFor(entry).length;
  const approvalCount = entry.definition.steps.filter((step) => step.kind === "approval").length;
  const delayCount = entry.definition.steps.filter((step) => step.kind === "delay").length;
  const extras = [
    approvalCount ? `${approvalCount} approval${approvalCount === 1 ? "" : "s"}` : "",
    delayCount ? `${delayCount} delay${delayCount === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return `${groupCount} publishing group${groupCount === 1 ? "" : "s"}${extras.length ? ` · ${extras.join(" · ")}` : ""}`;
}

function publicationSnapshot(input: {
  readonly id: string;
  readonly revisionId: string;
  readonly createdAt: string;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly tags: string;
  readonly language: string;
  readonly canonicalUrl: string;
  readonly status: PublicationStatus;
}): Publication {
  const paragraphs = input.body
    .split(/\n\s*\n/g)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  if (!input.title.trim()) throw new Error("Publication title is required");
  if (paragraphs.length === 0) throw new Error("Publication body is required");
  const blocks: Publication["current"]["content"]["blocks"] = paragraphs.map((text, index) => ({
    id: `block_${index + 1}`,
    kind: "paragraph",
    data: { text },
  }));
  const canonicalUrl = input.canonicalUrl.trim();
  if (canonicalUrl) {
    const parsed = new URL(canonicalUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Canonical URL must use HTTP or HTTPS");
  }
  return {
    id: input.id,
    createdAt: input.createdAt,
    slug: consumerSlug(input.title),
    status: input.status,
    current: {
      id: input.revisionId,
      ordinal: 1,
      createdAt: input.createdAt,
      content: {
        schemaVersion: 1,
        title: input.title.trim(),
        ...(input.summary.trim() ? { summary: input.summary.trim() } : {}),
        language: input.language.trim() || "en",
        blocks,
        assets: [],
        tags: tagList(input.tags),
        attributes: {},
      },
    },
    ...(canonicalUrl ? { canonicalUrl } : {}),
    provenance: {
      source: "control-room",
      entryMode: "consumer-compose",
    },
  };
}

export function PublishPage() {
  const { session } = useConnection();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const mode: PublishMode = searchParams.get("mode") === "schedule" ? "schedule" : "now";
  const [automations, setAutomations] = useState<readonly AutomationRegistryEntry[]>([]);
  const [groups, setGroups] = useState<readonly PublicationGroupRegistryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState("");
  const [language, setLanguage] = useState("en");
  const [canonicalUrl, setCanonicalUrl] = useState("");
  const [status, setStatus] = useState<PublicationStatus>("approved");
  const [automationId, setAutomationId] = useState("");
  const [localDate, setLocalDate] = useState(() => localDateString(new Date(Date.now() + 24 * 60 * 60 * 1000)));
  const [localTime, setLocalTime] = useState("09:00");
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [recurrenceKind, setRecurrenceKind] = useState<RecurrenceKind>("once");
  const [weeklyDays, setWeeklyDays] = useState<ReadonlySet<number>>(() => new Set([new Date().getDay()]));
  const [missedRunPolicy, setMissedRunPolicy] = useState<MissedRunPolicy>("catch_up_once");
  const [identity] = useState(() => {
    const id = crypto.randomUUID();
    return {
      publicationId: `publication_${id}`,
      revisionId: `revision_${crypto.randomUUID()}`,
      commandId: `command_${crypto.randomUUID()}`,
      scheduleId: `schedule_${crypto.randomUUID()}`,
      createdAt: new Date().toISOString(),
    };
  });

  const groupMap = useMemo(() => new Map(groups.map((entry) => [entry.group.id, entry])), [groups]);
  const workflows = useMemo(
    () => automations.filter((entry) => workflowIsRunnable(entry, groupMap, mode === "now" ? "manual" : "schedule")),
    [automations, groupMap, mode],
  );
  const selected = useMemo(
    () => workflows.find((entry) => entry.definition.id === automationId) ?? workflows[0],
    [automationId, workflows],
  );

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void Promise.all([
      session!.client.listAutomations({ enabled: true, limit: 100 }),
      session!.client.listPublicationGroups({ enabled: true, limit: 100 }),
    ]).then(([automationPage, groupPage]) => {
      if (!active) return;
      setAutomations(automationPage.items);
      setGroups(groupPage.items);
    }).catch((cause: unknown) => {
      if (!active) return;
      setError(cause instanceof Error ? cause : new Error("Publishing workspace could not be loaded"));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [session]);

  useEffect(() => {
    if (selected && selected.definition.id !== automationId) setAutomationId(selected.definition.id);
  }, [automationId, selected]);

  const setMode = useCallback((next: PublishMode) => {
    setSearchParams(next === "schedule" ? { mode: "schedule" } : {});
    setAutomationId("");
    setError(null);
  }, [setSearchParams]);

  const submit = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (!selected) throw new Error(`Create and enable a ${mode === "now" ? "manual" : "scheduled"} automation before publishing`);
      const publication = publicationSnapshot({
        id: identity.publicationId,
        revisionId: identity.revisionId,
        createdAt: identity.createdAt,
        title,
        summary,
        body,
        tags,
        language,
        canonicalUrl,
        status,
      });
      const requiredGroupIds = groupIdsFor(selected);
      const snapshots = requiredGroupIds.map((id) => {
        const group = groupMap.get(id);
        if (!group?.enabled) throw new Error(`Publishing group ${id} is not enabled`);
        return group.group;
      });

      if (mode === "now") {
        const run = await session!.client.startManualRun({
          automationId: selected.definition.id,
          automationVersion: selected.definition.version,
          publication,
          groups: snapshots,
        }, identity.commandId);
        navigate(`/runs/${encodeURIComponent(run.runId)}`);
        return;
      }

      if (!localDate || !localTime) throw new Error("Schedule date and time are required");
      if (!timezone.trim()) throw new Error("Timezone is required");
      if (recurrenceKind === "weekly" && weeklyDays.size === 0) throw new Error("Choose at least one weekday for a weekly schedule");
      const recurrence: ScheduleRegistrationBody["recurrence"] = recurrenceKind === "weekly"
        ? { kind: "weekly", weekdays: [...weeklyDays].sort((a, b) => a - b) }
        : { kind: recurrenceKind };
      const schedule = await session!.client.createSchedule({
        id: identity.scheduleId,
        automationId: selected.definition.id,
        automationVersion: selected.definition.version,
        publication,
        groups: snapshots,
        timezone: timezone.trim(),
        localDate,
        localTime,
        recurrence,
        missedRunPolicy,
        enabled: true,
      });
      navigate(`/schedules?created=${encodeURIComponent(schedule.id)}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(mode === "now" ? "Publication could not start" : "Publication could not be scheduled"));
    } finally {
      setBusy(false);
    }
  }, [automationId, body, canonicalUrl, groupMap, identity, language, localDate, localTime, missedRunPolicy, mode, navigate, recurrenceKind, selected, session, status, summary, tags, timezone, title, weeklyDays]);

  return (
    <>
      <PageHeader
        eyebrow="Publication desk"
        title="Publish"
        description="Compose a canonical publication snapshot, then run it now or hand it to the durable scheduler. The selected automation remains the workflow authority."
      />
      <div className="publish-mode-tabs" role="tablist" aria-label="Publishing mode">
        <button className={mode === "now" ? "is-active" : ""} type="button" role="tab" aria-selected={mode === "now"} onClick={() => setMode("now")}>Publish now</button>
        <button className={mode === "schedule" ? "is-active" : ""} type="button" role="tab" aria-selected={mode === "schedule"} onClick={() => setMode("schedule")}>Schedule</button>
      </div>
      <ErrorBanner error={error} />
      {loading ? <LoadingBlock /> : (
        <form className="publish-layout" onSubmit={submit}>
          <Panel title="Publication" meta="Canonical content snapshot" className="publish-composer">
            <div className="publish-form">
              <label className="field">
                <span>Title</span>
                <input value={title} onChange={(event) => setTitle(event.target.value)} required autoComplete="off" placeholder="What are you publishing?" />
              </label>
              <label className="field">
                <span>Summary</span>
                <textarea value={summary} onChange={(event) => setSummary(event.target.value)} rows={3} placeholder="Optional short description" />
              </label>
              <label className="field">
                <span>Body</span>
                <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={14} required placeholder="Write the publication body. Blank lines create separate paragraphs." />
                <small>Paragraphs become canonical Blogmaatic content blocks before destination-specific projection.</small>
              </label>
              <div className="publish-field-grid">
                <label className="field">
                  <span>Tags</span>
                  <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="release, news" />
                  <small>Comma-separated.</small>
                </label>
                <label className="field">
                  <span>Language</span>
                  <input value={language} onChange={(event) => setLanguage(event.target.value)} required placeholder="en" />
                </label>
                <label className="field">
                  <span>Publication status</span>
                  <select value={status} onChange={(event) => setStatus(event.target.value as PublicationStatus)}>
                    {publicationStatuses.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span>Canonical URL</span>
                  <input type="url" value={canonicalUrl} onChange={(event) => setCanonicalUrl(event.target.value)} placeholder="https://example.com/article" />
                  <small>Optional. Useful when a social projection should point back to a canonical page.</small>
                </label>
              </div>
            </div>
          </Panel>

          <div className="publish-sidebar">
            <Panel title={mode === "now" ? "Publishing workflow" : "Scheduled workflow"}>
              <div className="publish-execution-form">
                {workflows.length ? (
                  <>
                    <label className="field">
                      <span>Automation</span>
                      <select value={selected?.definition.id ?? ""} onChange={(event) => setAutomationId(event.target.value)}>
                        {workflows.map((entry) => <option key={entry.definition.id} value={entry.definition.id}>{entry.definition.name}</option>)}
                      </select>
                    </label>
                    {selected ? (
                      <div className="publish-workflow-summary">
                        <div><span>Trigger</span><strong>{triggerLabel(selected.definition.trigger.kind)}</strong></div>
                        <div><span>Workflow</span><strong>{workflowDescription(selected)}</strong></div>
                        <div><span>Version</span><strong>v{selected.definition.version}</strong></div>
                        <StatusPill value="enabled" tone="good" />
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className="publish-no-workflow">
                    <EmptyState title={mode === "now" ? "No Publish now automation" : "No scheduled automation"}>
                      Create an enabled automation with a {mode === "now" ? "Publish on demand" : "From a publishing schedule"} trigger and at least one publishing-group step.
                    </EmptyState>
                    <Link className="button button--primary" to="/automations">Create automation</Link>
                  </div>
                )}
              </div>
            </Panel>

            {mode === "schedule" ? (
              <Panel title="When to publish">
                <div className="publish-execution-form">
                  <div className="publish-field-grid publish-field-grid--schedule">
                    <label className="field"><span>Start date</span><input type="date" value={localDate} onChange={(event) => setLocalDate(event.target.value)} required /></label>
                    <label className="field"><span>Local time</span><input type="time" value={localTime} onChange={(event) => setLocalTime(event.target.value)} required /></label>
                  </div>
                  <label className="field"><span>Timezone</span><input value={timezone} onChange={(event) => setTimezone(event.target.value)} required /></label>
                  <label className="field">
                    <span>Repeat</span>
                    <select value={recurrenceKind} onChange={(event) => setRecurrenceKind(event.target.value as RecurrenceKind)}>
                      <option value="once">Once</option>
                      <option value="daily">Daily</option>
                      <option value="weekly">Weekly</option>
                    </select>
                  </label>
                  {recurrenceKind === "weekly" ? (
                    <fieldset className="weekday-picker">
                      <legend>Weekdays</legend>
                      {weekdays.map(([value, label]) => (
                        <label key={value}>
                          <input
                            type="checkbox"
                            checked={weeklyDays.has(value)}
                            onChange={(event) => setWeeklyDays((current) => {
                              const next = new Set(current);
                              if (event.target.checked) next.add(value);
                              else next.delete(value);
                              return next;
                            })}
                          />
                          {label}
                        </label>
                      ))}
                    </fieldset>
                  ) : null}
                  <label className="field">
                    <span>If the app was offline at publish time</span>
                    <select value={missedRunPolicy} onChange={(event) => setMissedRunPolicy(event.target.value as MissedRunPolicy)}>
                      <option value="catch_up_once">Publish once when Blogmaatic returns</option>
                      <option value="skip">Skip the missed occurrence</option>
                    </select>
                  </label>
                </div>
              </Panel>
            ) : null}

            <button className="button button--primary publish-submit" type="submit" disabled={busy || !selected || !title.trim() || !body.trim()}>
              {busy ? (mode === "now" ? "Starting publication…" : "Scheduling…") : mode === "now" ? "Publish now" : "Schedule publication"}
            </button>
          </div>
        </form>
      )}
    </>
  );
}
