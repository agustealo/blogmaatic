import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import type {
  ConnectionCreateBody,
  ConnectionUpdateBody,
  OperatorConnectionSettingField,
  OperatorConnectionTestResult,
  OperatorConnectionType,
  OperatorConnectionView,
} from "@blogmaatic/operator-client";

import { EmptyState, ErrorBanner, LoadingBlock, PageHeader, Panel, StatusPill } from "../components";
import { useConnection } from "../connection";

interface EditorState {
  readonly mode: "create" | "edit";
  readonly connectionId?: string;
  readonly extensionId: string;
  readonly displayName: string;
  readonly status: "active" | "disabled";
  readonly settings: Readonly<Record<string, string | boolean>>;
  readonly secrets: Readonly<Record<string, string>>;
}

type FieldValue = string | number | boolean | string[];

function stringifySetting(field: OperatorConnectionSettingField, value: unknown): string | boolean {
  if (field.kind === "boolean") return value === true;
  if (field.kind === "string-list") {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").join("\n") : "";
  }
  if (value === undefined || value === null) {
    const fallback = field.defaultValue;
    if (Array.isArray(fallback)) return fallback.filter((item): item is string => typeof item === "string").join("\n");
    return fallback === undefined || fallback === null ? "" : String(fallback);
  }
  return String(value);
}

function initialSettings(type: OperatorConnectionType, connection?: OperatorConnectionView): Record<string, string | boolean> {
  return Object.fromEntries(type.connectionContract.settingsFields.map((field) => [
    field.key,
    stringifySetting(field, connection?.settings[field.key]),
  ]));
}

function emptySecrets(type: OperatorConnectionType): Record<string, string> {
  return Object.fromEntries(type.connectionContract.secretFields.map((field) => [field.key, ""]));
}

function editorForCreate(type: OperatorConnectionType): EditorState {
  return {
    mode: "create",
    extensionId: type.manifest.id,
    displayName: type.manifest.displayName,
    status: "active",
    settings: initialSettings(type),
    secrets: emptySecrets(type),
  };
}

function editorForConnection(type: OperatorConnectionType, connection: OperatorConnectionView): EditorState {
  return {
    mode: "edit",
    connectionId: connection.id,
    extensionId: connection.extensionId,
    displayName: connection.displayName,
    status: connection.status,
    settings: initialSettings(type, connection),
    secrets: emptySecrets(type),
  };
}

function parseSetting(field: OperatorConnectionSettingField, raw: string | boolean): FieldValue | undefined {
  if (field.kind === "boolean") return raw === true;
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) {
    if (field.required) throw new Error(`${field.label} is required`);
    return undefined;
  }
  if (field.kind === "integer") {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new Error(`${field.label} must be an integer`);
    if (field.min !== undefined && number < field.min) throw new Error(`${field.label} must be at least ${field.min}`);
    if (field.max !== undefined && number > field.max) throw new Error(`${field.label} must be at most ${field.max}`);
    return number;
  }
  if (field.kind === "string-list") {
    const values = value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
    if (field.required && values.length === 0) throw new Error(`${field.label} requires at least one value`);
    return values;
  }
  return value;
}

function preparedSettings(type: OperatorConnectionType, editor: EditorState): Record<string, FieldValue> {
  const settings: Record<string, FieldValue> = {};
  for (const field of type.connectionContract.settingsFields) {
    const value = parseSetting(field, editor.settings[field.key] ?? (field.kind === "boolean" ? false : ""));
    if (value !== undefined) settings[field.key] = value;
  }
  return settings;
}

function preparedSecrets(
  type: OperatorConnectionType,
  editor: EditorState,
  configured: readonly string[],
): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const field of type.connectionContract.secretFields) {
    const value = editor.secrets[field.key]?.trim() ?? "";
    if (value) {
      secrets[field.key] = value;
      continue;
    }
    if (field.required && editor.mode === "create") throw new Error(`${field.label} is required`);
    if (field.required && editor.mode === "edit" && !configured.includes(field.key)) {
      throw new Error(`${field.label} is required`);
    }
  }
  return secrets;
}

function healthTone(result: OperatorConnectionTestResult | undefined): "good" | "warn" | "bad" | "neutral" {
  if (!result) return "neutral";
  if (!result.validation.valid || result.health?.state === "unhealthy") return "bad";
  if (result.health?.state === "degraded") return "warn";
  return "good";
}

function healthLabel(result: OperatorConnectionTestResult | undefined): string {
  if (!result) return "Not tested";
  if (!result.validation.valid) return "Invalid";
  return result.health?.state ?? "Valid";
}

function SettingField({
  field,
  value,
  onChange,
}: {
  readonly field: OperatorConnectionSettingField;
  readonly value: string | boolean;
  readonly onChange: (value: string | boolean) => void;
}) {
  if (field.kind === "boolean") {
    return (
      <label className="field field--checkbox">
        <span>{field.label}{field.required ? " *" : ""}</span>
        <input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />
        {field.description ? <small>{field.description}</small> : null}
      </label>
    );
  }
  if (field.kind === "select") {
    return (
      <label className="field">
        <span>{field.label}{field.required ? " *" : ""}</span>
        <select value={String(value)} onChange={(event) => onChange(event.target.value)} required={field.required}>
          {!field.required ? <option value="">Default</option> : null}
          {field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        {field.description ? <small>{field.description}</small> : null}
      </label>
    );
  }
  if (field.kind === "string-list") {
    return (
      <label className="field">
        <span>{field.label}{field.required ? " *" : ""}</span>
        <textarea rows={4} value={String(value)} placeholder={field.placeholder} onChange={(event) => onChange(event.target.value)} required={field.required} />
        <small>{field.description ?? "One value per line."}</small>
      </label>
    );
  }
  return (
    <label className="field">
      <span>{field.label}{field.required ? " *" : ""}</span>
      <input
        type={field.kind === "integer" ? "number" : field.kind === "email" ? "email" : field.kind === "url" ? "url" : "text"}
        value={String(value)}
        placeholder={field.placeholder}
        min={field.min}
        max={field.max}
        onChange={(event) => onChange(event.target.value)}
        required={field.required}
        autoComplete="off"
      />
      {field.description ? <small>{field.description}</small> : null}
    </label>
  );
}

export function ConnectionsPage() {
  const { session } = useConnection();
  const client = session!.client;
  const [types, setTypes] = useState<readonly OperatorConnectionType[]>([]);
  const [connections, setConnections] = useState<readonly OperatorConnectionView[]>([]);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [health, setHealth] = useState<Readonly<Record<string, OperatorConnectionTestResult>>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [typeResponse, connectionResponse] = await Promise.all([
        client.listConnectionTypes(),
        client.listConnections(),
      ]);
      setTypes(typeResponse.items);
      setConnections(connectionResponse.items);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("Could not load publisher connections"));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => { void load(); }, [load]);

  const typeById = useMemo(() => new Map(types.map((type) => [type.manifest.id, type])), [types]);
  const selectedType = editor ? typeById.get(editor.extensionId) : undefined;
  const selectedConnection = editor?.connectionId
    ? connections.find((connection) => connection.id === editor.connectionId)
    : undefined;

  const startCreate = useCallback((type?: OperatorConnectionType) => {
    const selected = type ?? types[0];
    if (!selected) return;
    setError(null);
    setEditor(editorForCreate(selected));
  }, [types]);

  const startEdit = useCallback((connection: OperatorConnectionView) => {
    const type = typeById.get(connection.extensionId);
    if (!type) {
      setError(new Error(`Publisher contract is unavailable for ${connection.extensionId}`));
      return;
    }
    setError(null);
    setEditor(editorForConnection(type, connection));
  }, [typeById]);

  const testConnection = useCallback(async (connectionId: string) => {
    setBusy(`test:${connectionId}`);
    setError(null);
    try {
      const result = await client.testConnection(connectionId);
      setHealth((current) => ({ ...current, [connectionId]: result }));
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("Connection test failed"));
    } finally {
      setBusy(null);
    }
  }, [client]);

  const save = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    if (!editor || !selectedType) return;
    const operation = editor.mode === "create" ? "create" : `save:${editor.connectionId}`;
    setBusy(operation);
    setError(null);
    try {
      const settings = preparedSettings(selectedType, editor);
      const secrets = preparedSecrets(selectedType, editor, selectedConnection?.configuredSecrets ?? []);
      if (editor.mode === "create") {
        const input: ConnectionCreateBody = {
          extensionId: editor.extensionId,
          displayName: editor.displayName.trim(),
          status: editor.status,
          settings,
          ...(Object.keys(secrets).length ? { secrets } : {}),
        };
        const created = await client.createConnection(input);
        setConnections((current) => [...current, created].sort((a, b) => a.displayName.localeCompare(b.displayName)));
        setEditor(null);
        const result = await client.testConnection(created.id);
        setHealth((current) => ({ ...current, [created.id]: result }));
      } else if (editor.connectionId) {
        const input: ConnectionUpdateBody = {
          displayName: editor.displayName.trim(),
          status: editor.status,
          settings,
          ...(Object.keys(secrets).length ? { secrets } : {}),
        };
        const updated = await client.updateConnection(editor.connectionId, input);
        setConnections((current) => current.map((connection) => connection.id === updated.id ? updated : connection));
        setEditor(editorForConnection(selectedType, updated));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("Connection could not be saved"));
    } finally {
      setBusy(null);
    }
  }, [client, editor, selectedConnection, selectedType]);

  const remove = useCallback(async (connection: OperatorConnectionView) => {
    if (!window.confirm(`Remove ${connection.displayName}? Enabled Publication Groups must be updated first.`)) return;
    setBusy(`remove:${connection.id}`);
    setError(null);
    try {
      await client.removeConnection(connection.id);
      setConnections((current) => current.filter((item) => item.id !== connection.id));
      setHealth((current) => {
        const next = { ...current };
        delete next[connection.id];
        return next;
      });
      if (editor?.connectionId === connection.id) setEditor(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("Connection could not be removed"));
    } finally {
      setBusy(null);
    }
  }, [client, editor?.connectionId]);

  if (loading) return <LoadingBlock />;

  return (
    <>
      <PageHeader
        eyebrow="Destinations"
        title="Connections"
        description="Connect real publishing destinations. Credentials are written directly into the operating system vault and are never returned to this browser."
        actions={<button className="button button--primary" type="button" onClick={() => startCreate()} disabled={types.length === 0}>New connection</button>}
      />
      <ErrorBanner error={error} />

      {types.length === 0 ? (
        <Panel><EmptyState title="No publisher contracts are registered">The runtime has no connection-capable publisher extensions available.</EmptyState></Panel>
      ) : (
        <div className={`connection-manager ${editor ? "connection-manager--editing" : ""}`.trim()}>
          <Panel title="Publishing destinations" meta={`${connections.length} configured`} className="connection-list-panel">
            {connections.length === 0 ? (
              <EmptyState title="No destinations yet">Create a destination to connect Blogmaatic to Jekyll, WordPress, LinkedIn, Facebook Pages, or another installed publisher.</EmptyState>
            ) : (
              <div className="connection-list">
                {connections.map((connection) => {
                  const type = typeById.get(connection.extensionId);
                  const result = health[connection.id];
                  return (
                    <article className="connection-row" key={connection.id}>
                      <div className="connection-row__identity">
                        <strong>{connection.displayName}</strong>
                        <small>{type?.manifest.displayName ?? connection.extensionId}</small>
                      </div>
                      <div className="connection-row__state">
                        <StatusPill value={connection.status === "active" ? "enabled" : "disabled"} />
                        <StatusPill value={healthLabel(result)} tone={healthTone(result)} />
                      </div>
                      <div className="connection-row__actions">
                        <button className="button button--quiet" type="button" onClick={() => void testConnection(connection.id)} disabled={busy !== null}>
                          {busy === `test:${connection.id}` ? "Testing…" : "Test"}
                        </button>
                        <button className="button button--quiet" type="button" onClick={() => startEdit(connection)} disabled={busy !== null}>Edit</button>
                        <button className="button button--danger" type="button" onClick={() => void remove(connection)} disabled={busy !== null}>Remove</button>
                      </div>
                      {result ? (
                        <div className="connection-row__detail">
                          {result.validation.valid ? "Configuration valid" : result.validation.errors.join(" · ")}
                          {result.health?.detail ? ` · ${result.health.detail}` : ""}
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            )}
          </Panel>

          {editor && selectedType ? (
            <Panel
              title={editor.mode === "create" ? `Connect ${selectedType.manifest.displayName}` : `Edit ${editor.displayName}`}
              meta={editor.mode === "edit" ? editor.connectionId : "New destination"}
              className="connection-editor"
            >
              <form className="connection-editor__form" onSubmit={save}>
                {editor.mode === "create" ? (
                  <label className="field">
                    <span>Publisher</span>
                    <select
                      value={editor.extensionId}
                      onChange={(event) => {
                        const next = typeById.get(event.target.value);
                        if (next) setEditor(editorForCreate(next));
                      }}
                    >
                      {types.map((type) => <option key={type.manifest.id} value={type.manifest.id}>{type.manifest.displayName}</option>)}
                    </select>
                  </label>
                ) : null}

                <label className="field">
                  <span>Connection name *</span>
                  <input
                    value={editor.displayName}
                    onChange={(event) => setEditor((current) => current ? { ...current, displayName: event.target.value } : current)}
                    required
                    autoComplete="off"
                  />
                </label>

                <label className="field">
                  <span>Status</span>
                  <select
                    value={editor.status}
                    onChange={(event) => setEditor((current) => current ? { ...current, status: event.target.value as "active" | "disabled" } : current)}
                  >
                    <option value="active">Active</option>
                    <option value="disabled">Disabled</option>
                  </select>
                </label>

                {selectedType.connectionContract.settingsFields.length ? <div className="form-section-title">Destination settings</div> : null}
                {selectedType.connectionContract.settingsFields.map((field) => (
                  <SettingField
                    key={field.key}
                    field={field}
                    value={editor.settings[field.key] ?? (field.kind === "boolean" ? false : "")}
                    onChange={(value) => setEditor((current) => current ? {
                      ...current,
                      settings: { ...current.settings, [field.key]: value },
                    } : current)}
                  />
                ))}

                {selectedType.connectionContract.secretFields.length ? (
                  <div className="form-section-title">Credentials · OS vault</div>
                ) : null}
                {selectedType.connectionContract.secretFields.map((field) => {
                  const configured = selectedConnection?.configuredSecrets.includes(field.key) ?? false;
                  return (
                    <label className="field" key={field.key}>
                      <span>{field.label}{field.required && !configured ? " *" : ""}</span>
                      <input
                        type="password"
                        value={editor.secrets[field.key] ?? ""}
                        onChange={(event) => setEditor((current) => current ? {
                          ...current,
                          secrets: { ...current.secrets, [field.key]: event.target.value },
                        } : current)}
                        required={field.required && editor.mode === "create"}
                        autoComplete="new-password"
                        placeholder={configured ? "Stored in OS vault · leave blank to keep" : undefined}
                      />
                      <small>{configured ? "Already stored in the OS credential vault. Enter a new value only to rotate it." : field.description}</small>
                    </label>
                  );
                })}

                <div className="connection-editor__actions">
                  <button className="button button--quiet" type="button" onClick={() => setEditor(null)} disabled={busy !== null}>Cancel</button>
                  <button className="button button--primary" type="submit" disabled={busy !== null || !editor.displayName.trim()}>
                    {busy ? "Saving…" : editor.mode === "create" ? "Save connection" : "Save changes"}
                  </button>
                </div>
                <p className="security-note">Secret values are sent only in this save request, written into the OS vault by the runtime, then discarded by the browser form.</p>
              </form>
            </Panel>
          ) : null}
        </div>
      )}
    </>
  );
}
