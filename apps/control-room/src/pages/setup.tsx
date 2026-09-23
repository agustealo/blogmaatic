import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Link, Navigate } from "react-router";

import type {
  AutomationDefinition,
  OperatorConnectionView,
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
import {
  loadOnboardingReadiness,
  type OnboardingReadiness,
  type OnboardingStage,
} from "../onboarding";

const steps: readonly { readonly id: OnboardingStage; readonly label: string }[] = [
  { id: "connection", label: "Destination" },
  { id: "group", label: "Publication Group" },
  { id: "automation", label: "Automation" },
  { id: "ready", label: "Ready" },
];

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function automationId(name: string): string {
  const base = slug(name) || "publication";
  return `automation_${base}_${crypto.randomUUID().slice(0, 8)}`;
}

function routeId(connection: OperatorConnectionView): string {
  return `route_${connection.id}`.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 160);
}

function stepIndex(stage: OnboardingStage): number {
  return steps.findIndex((step) => step.id === stage);
}

function SetupProgress({ stage }: { readonly stage: OnboardingStage }) {
  const activeIndex = stepIndex(stage);
  return (
    <ol className="setup-progress" aria-label="Setup progress">
      {steps.map((step, index) => (
        <li
          key={step.id}
          className={index < activeIndex ? "is-complete" : index === activeIndex ? "is-current" : ""}
          aria-current={index === activeIndex ? "step" : undefined}
        >
          <span>{index < activeIndex ? "✓" : index + 1}</span>
          <strong>{step.label}</strong>
        </li>
      ))}
    </ol>
  );
}

function ConnectionStep({ readiness, onRefresh }: {
  readonly readiness: OnboardingReadiness;
  readonly onRefresh: () => Promise<void>;
}) {
  return (
    <Panel title="Connect a publishing destination" meta={`${readiness.connections.length} configured`}>
      <div className="setup-step">
        <p>
          Choose a real publisher and save its connection. Secret fields go directly to the operating system vault.
          Setup tests each active connection before it can become a publication route.
        </p>
        {readiness.connectionProbes.length ? (
          <div className="setup-checks">
            {readiness.connectionProbes.map((probe) => {
              const healthy = readiness.usableConnectionIds.has(probe.connection.id);
              const detail = probe.error ?? probe.result?.health?.detail ??
                probe.result?.validation.errors.join(" · ") ?? "No health result";
              return (
                <div className="setup-check" key={probe.connection.id}>
                  <div>
                    <strong>{probe.connection.displayName}</strong>
                    <small>{probe.connection.extensionId}</small>
                  </div>
                  <StatusPill value={healthy ? probe.result?.health?.state ?? "verified" : "unhealthy"} tone={healthy ? "good" : "bad"} />
                  <p>{detail}</p>
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState title="No active destination is ready">Create your first destination, then return here for validation and a live health check.</EmptyState>
        )}
        <div className="setup-actions">
          <button className="button button--quiet" type="button" onClick={() => void onRefresh()}>Retest connections</button>
          <Link className="button button--primary" to="/connections?setup=1">Open Connections</Link>
        </div>
      </div>
    </Panel>
  );
}

function PublicationGroupStep({ readiness, onCreated }: {
  readonly readiness: OnboardingReadiness;
  readonly onCreated: () => Promise<void>;
}) {
  const { session } = useConnection();
  const client = session!.client;
  const usableConnections = useMemo(
    () => readiness.connections.filter((connection) => readiness.usableConnectionIds.has(connection.id)),
    [readiness],
  );
  const [name, setName] = useState("Primary publishing");
  const [policySetId, setPolicySetId] = useState(readiness.policySetIds[0] ?? "");
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(usableConnections.map((connection) => connection.id)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!policySetId && readiness.policySetIds[0]) setPolicySetId(readiness.policySetIds[0]);
  }, [policySetId, readiness.policySetIds]);

  useEffect(() => {
    setSelected((current) => {
      if (current.size > 0) return current;
      return new Set(usableConnections.map((connection) => connection.id));
    });
  }, [usableConnections]);

  const create = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (!name.trim()) throw new Error("Publication Group name is required");
      if (!policySetId) throw new Error("A configured policy set is required");
      const chosen = usableConnections.filter((connection) => selected.has(connection.id));
      if (chosen.length === 0) throw new Error("Select at least one verified destination");
      const types = new Map(readiness.connectionTypes.map((type) => [type.manifest.id, type]));
      const routes = chosen.map((connection) => {
        const type = types.get(connection.extensionId);
        if (!type) throw new Error(`Publisher contract is unavailable for ${connection.extensionId}`);
        const capabilities = new Set(type.manifest.capabilities);
        if (!capabilities.has("article.create")) {
          throw new Error(`${type.manifest.displayName} cannot create publications`);
        }
        const requiredCapabilities = [
          "article.create",
          ...(capabilities.has("article.inspect") ? ["article.inspect"] : []),
        ];
        return {
          id: routeId(connection),
          enabled: true,
          desiredState: "present" as const,
          destination: {
            extensionId: connection.extensionId,
            connectionId: connection.id,
            channel: "primary",
          },
          requiredCapabilities,
        };
      });
      await client.createPublicationGroup({
        name: name.trim(),
        policySetId,
        routes,
        enabled: true,
      });
      await onCreated();
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("Publication Group could not be created"));
    } finally {
      setBusy(false);
    }
  }, [client, name, onCreated, policySetId, readiness.connectionTypes, selected, usableConnections]);

  if (readiness.policySetIds.length === 0) {
    return (
      <Panel title="Create a Publication Group">
        <div className="setup-step">
          <EmptyState title="No publication policies are configured">A Publication Group cannot be enabled until the runtime has at least one policy set.</EmptyState>
        </div>
      </Panel>
    );
  }

  return (
    <Panel title="Create your first Publication Group" meta={`${usableConnections.length} verified destinations`}>
      <form className="setup-step setup-form" onSubmit={create}>
        <ErrorBanner error={error} />
        <p>A Publication Group is the reusable set of destinations Blogmaatic publishes to together.</p>
        <label className="field">
          <span>Group name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} required autoComplete="off" />
        </label>
        <label className="field">
          <span>Policy set</span>
          <select value={policySetId} onChange={(event) => setPolicySetId(event.target.value)} required>
            {readiness.policySetIds.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        </label>
        <fieldset className="setup-destinations">
          <legend>Destinations</legend>
          {usableConnections.map((connection) => (
            <label key={connection.id}>
              <input
                type="checkbox"
                checked={selected.has(connection.id)}
                onChange={(event) => setSelected((current) => {
                  const next = new Set(current);
                  if (event.target.checked) next.add(connection.id);
                  else next.delete(connection.id);
                  return next;
                })}
              />
              <span><strong>{connection.displayName}</strong><small>{connection.extensionId}</small></span>
            </label>
          ))}
        </fieldset>
        <div className="setup-actions">
          <button className="button button--primary" type="submit" disabled={busy}>{busy ? "Creating…" : "Create Publication Group"}</button>
        </div>
      </form>
    </Panel>
  );
}

function AutomationStep({ readiness, onCreated }: {
  readonly readiness: OnboardingReadiness;
  readonly onCreated: () => Promise<void>;
}) {
  const { session } = useConnection();
  const client = session!.client;
  const [groupId, setGroupId] = useState(readiness.runnableGroups[0]?.group.id ?? "");
  const [name, setName] = useState("Publish approved content");
  const [trigger, setTrigger] = useState<"manual" | "approved">("manual");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!groupId && readiness.runnableGroups[0]) setGroupId(readiness.runnableGroups[0].group.id);
  }, [groupId, readiness.runnableGroups]);

  const create = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (!name.trim()) throw new Error("Automation name is required");
      if (!groupId) throw new Error("Choose a Publication Group");
      const definition: AutomationDefinition = {
        id: automationId(name),
        version: 1,
        name: name.trim(),
        enabled: true,
        trigger: trigger === "manual"
          ? { kind: "manual" }
          : { kind: "event", eventType: "publication.approved" },
        steps: [{ id: "publish", kind: "publish_group", groupId }],
      };
      await client.registerAutomation(definition);
      await onCreated();
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("Automation could not be created"));
    } finally {
      setBusy(false);
    }
  }, [client, groupId, name, onCreated, trigger]);

  return (
    <Panel title="Create your first Automation" meta="Uses the existing automation registry">
      <form className="setup-step setup-form" onSubmit={create}>
        <ErrorBanner error={error} />
        <p>Start with a small real automation. You can expand its trigger and workflow later from Automations.</p>
        <label className="field">
          <span>Automation name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} required autoComplete="off" />
        </label>
        <label className="field">
          <span>Publication Group</span>
          <select value={groupId} onChange={(event) => setGroupId(event.target.value)} required>
            {readiness.runnableGroups.map((entry) => (
              <option key={entry.group.id} value={entry.group.id}>{entry.group.name}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Trigger</span>
          <select value={trigger} onChange={(event) => setTrigger(event.target.value as "manual" | "approved")}>
            <option value="manual">Manual</option>
            <option value="approved">When a publication is approved</option>
          </select>
        </label>
        <div className="setup-actions">
          <button className="button button--primary" type="submit" disabled={busy}>{busy ? "Creating…" : "Create Automation"}</button>
        </div>
      </form>
    </Panel>
  );
}

function ReadyStep({ readiness }: { readonly readiness: OnboardingReadiness }) {
  return (
    <Panel title="Blogmaatic is ready" meta="First-run complete">
      <div className="setup-step setup-ready">
        <div className="setup-ready__mark">✓</div>
        <p>
          You have a verified publishing destination, a runnable Publication Group, and an enabled automation wired to that group.
        </p>
        <div className="setup-ready__summary">
          <span><strong>{readiness.usableConnectionIds.size}</strong> verified destination{readiness.usableConnectionIds.size === 1 ? "" : "s"}</span>
          <span><strong>{readiness.runnableGroups.length}</strong> runnable group{readiness.runnableGroups.length === 1 ? "" : "s"}</span>
          <span><strong>{readiness.runnableAutomations.length}</strong> publishing automation{readiness.runnableAutomations.length === 1 ? "" : "s"}</span>
        </div>
        <div className="setup-actions">
          <Link className="button button--primary" to="/">Enter Control Room</Link>
        </div>
      </div>
    </Panel>
  );
}

export function SetupPage() {
  const { session } = useConnection();
  const client = session!.client;
  const [readiness, setReadiness] = useState<OnboardingReadiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReadiness(await loadOnboardingReadiness(client));
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("Setup readiness could not be loaded"));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => { void refresh(); }, [refresh]);

  if (loading && !readiness) return <LoadingBlock />;

  return (
    <>
      <PageHeader
        eyebrow="First run"
        title="Set up your publishing engine"
        description="Connect a destination, group the places you publish to, then create one real automation. Each step reads and writes the same authorities the normal Control Room uses."
        actions={readiness ? <StatusPill value={readiness.stage === "ready" ? "ready" : "setup in progress"} tone={readiness.stage === "ready" ? "good" : "warn"} /> : undefined}
      />
      <ErrorBanner error={error} />
      {readiness ? <SetupProgress stage={readiness.stage} /> : null}
      {readiness?.stage === "connection" ? <ConnectionStep readiness={readiness} onRefresh={refresh} /> : null}
      {readiness?.stage === "group" ? <PublicationGroupStep readiness={readiness} onCreated={refresh} /> : null}
      {readiness?.stage === "automation" ? <AutomationStep readiness={readiness} onCreated={refresh} /> : null}
      {readiness?.stage === "ready" ? <ReadyStep readiness={readiness} /> : null}
      {readiness && loading ? <div className="setup-refreshing">Refreshing runtime truth…</div> : null}
      {!readiness && !loading ? (
        <Panel><EmptyState title="Setup state unavailable">Fix the reported runtime error, then retry.</EmptyState><div className="setup-actions"><button className="button button--primary" type="button" onClick={() => void refresh()}>Retry</button></div></Panel>
      ) : null}
    </>
  );
}

export function FirstRunEntry({ ready }: { readonly ready: ReactNode }) {
  const { session } = useConnection();
  const client = session!.client;
  const [state, setState] = useState<{ readonly loading: boolean; readonly ready: boolean; readonly error: Error | null }>({
    loading: true,
    ready: false,
    error: null,
  });

  const check = useCallback(async () => {
    setState({ loading: true, ready: false, error: null });
    try {
      const readiness = await loadOnboardingReadiness(client);
      setState({ loading: false, ready: readiness.stage === "ready", error: null });
    } catch (cause) {
      setState({
        loading: false,
        ready: false,
        error: cause instanceof Error ? cause : new Error("First-run readiness could not be checked"),
      });
    }
  }, [client]);

  useEffect(() => { void check(); }, [check]);

  if (state.loading) return <LoadingBlock />;
  if (state.error) {
    return (
      <>
        <PageHeader eyebrow="Runtime" title="Readiness check failed" description="The Control Room could not establish current setup state." />
        <ErrorBanner error={state.error} />
        <Panel><div className="setup-actions"><button className="button button--primary" type="button" onClick={() => void check()}>Retry</button></div></Panel>
      </>
    );
  }
  return state.ready ? <>{ready}</> : <Navigate to="/setup" replace />;
}
