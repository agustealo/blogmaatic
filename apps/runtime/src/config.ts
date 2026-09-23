import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

import type { JsonValue, PolicyMatch, PolicyRule, PolicySet, PublicationStatus } from "@blogmaatic/core";
import type { ConnectionRecord } from "@blogmaatic/extension-sdk";

export interface RuntimeConfig {
  readonly schemaVersion: 1;
  readonly operator: {
    readonly host: string;
    readonly port: number;
    readonly principalId: string;
  };
  readonly controlRoom: {
    readonly host: string;
    readonly port: number;
  };
  readonly scheduler: {
    readonly pollMs: number;
    readonly batchSize: number;
  };
  readonly restate: {
    readonly mode: "managed-local" | "external";
    readonly ingressUrl: string;
    readonly adminUrl: string;
    readonly workflowHost: string;
    readonly workflowPort: number;
  };
  readonly connections: readonly ConnectionRecord[];
  readonly policies: readonly PolicySet[];
}

export interface RuntimePaths {
  readonly dataDir: string;
  readonly configPath: string;
  readonly controlPlanePath: string;
  readonly projectionStatePath: string;
  readonly operatorTokenPath: string;
  readonly restateDataDir: string;
}

const publicationStatuses = new Set<PublicationStatus>([
  "idea", "draft", "ready", "approved", "queued", "publishing", "published", "archived",
]);

function object(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value;
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${label} must be an integer from ${min} through ${max}`);
  }
  return value as number;
}

function url(value: unknown, label: string): string {
  const parsed = new URL(string(value, label));
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must use HTTP or HTTPS`);
  }
  if (parsed.username || parsed.password) throw new Error(`${label} must not contain credentials`);
  return parsed.toString().replace(/\/$/, "");
}

function host(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (parsed !== "127.0.0.1" && parsed !== "::1" && parsed !== "localhost") {
    throw new Error(`${label} must bind to loopback in the local runtime`);
  }
  return parsed;
}

function jsonValue(value: unknown, label: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} must contain finite JSON numbers`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, `${label}[${index}]`));
  const input = object(value, label);
  const output: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(input)) output[key] = jsonValue(item, `${label}.${key}`);
  return output;
}

function jsonObject(value: unknown, label: string): Readonly<Record<string, JsonValue>> {
  const parsed = jsonValue(value, label);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed;
}

function stringRecord(value: unknown, label: string): Readonly<Record<string, string>> {
  const input = object(value, label);
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(input)) output[key] = string(item, `${label}.${key}`);
  return output;
}

function optionalStringArray(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => string(item, `${label}[${index}]`));
}

function policyMatch(value: unknown, label: string): PolicyMatch {
  const input = object(value, label);
  const statuses = optionalStringArray(input.statuses, `${label}.statuses`);
  if (statuses?.some((status) => !publicationStatuses.has(status as PublicationStatus))) {
    throw new Error(`${label}.statuses contains an unknown publication status`);
  }
  const routeIds = optionalStringArray(input.routeIds, `${label}.routeIds`);
  const extensionIds = optionalStringArray(input.extensionIds, `${label}.extensionIds`);
  const tagsAny = optionalStringArray(input.tagsAny, `${label}.tagsAny`);
  return {
    ...(statuses ? { statuses: statuses as readonly PublicationStatus[] } : {}),
    ...(routeIds ? { routeIds } : {}),
    ...(extensionIds ? { extensionIds } : {}),
    ...(tagsAny ? { tagsAny } : {}),
  };
}

function policyRule(value: unknown, label: string): PolicyRule {
  const input = object(value, label);
  const effect = input.effect;
  if (effect !== "allow" && effect !== "deny" && effect !== "require_approval") {
    throw new Error(`${label}.effect must be allow, deny, or require_approval`);
  }
  const approvalRole = input.approvalRole === undefined ? undefined : string(input.approvalRole, `${label}.approvalRole`);
  if (effect === "require_approval" && !approvalRole) {
    throw new Error(`${label}.approvalRole is required for require_approval`);
  }
  return {
    id: string(input.id, `${label}.id`),
    description: string(input.description, `${label}.description`),
    match: policyMatch(input.match, `${label}.match`),
    effect,
    ...(approvalRole ? { approvalRole } : {}),
  };
}

function connection(value: unknown, index: number): ConnectionRecord {
  const item = object(value, `connections[${index}]`);
  const status = item.status;
  if (status !== "active" && status !== "disabled") {
    throw new Error(`connections[${index}].status must be active or disabled`);
  }
  return {
    id: string(item.id, `connections[${index}].id`),
    extensionId: string(item.extensionId, `connections[${index}].extensionId`),
    displayName: string(item.displayName, `connections[${index}].displayName`),
    status,
    settings: jsonObject(item.settings, `connections[${index}].settings`),
    secretRefs: stringRecord(item.secretRefs, `connections[${index}].secretRefs`),
    createdAt: string(item.createdAt, `connections[${index}].createdAt`),
    updatedAt: string(item.updatedAt, `connections[${index}].updatedAt`),
  };
}

function policy(value: unknown, index: number): PolicySet {
  const item = object(value, `policies[${index}]`);
  if (item.defaultEffect !== "allow" && item.defaultEffect !== "deny") {
    throw new Error(`policies[${index}].defaultEffect must be allow or deny`);
  }
  if (!Array.isArray(item.rules)) throw new Error(`policies[${index}].rules must be an array`);
  const rules = item.rules.map((rule, ruleIndex) => policyRule(rule, `policies[${index}].rules[${ruleIndex}]`));
  const ruleIds = rules.map((rule) => rule.id);
  if (new Set(ruleIds).size !== ruleIds.length) throw new Error(`policies[${index}] rule ids must be unique`);
  return {
    id: string(item.id, `policies[${index}].id`),
    defaultEffect: item.defaultEffect,
    rules,
  };
}

export function defaultDataDir(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (platform === "darwin") return join(home, "Library", "Application Support", "Blogmaatic");
  if (platform === "win32") {
    return join(environment.LOCALAPPDATA ?? environment.APPDATA ?? join(home, "AppData", "Local"), "Blogmaatic");
  }
  return join(environment.XDG_DATA_HOME ?? join(home, ".local", "share"), "blogmaatic");
}

export function runtimePaths(dataDir: string): RuntimePaths {
  const root = resolve(dataDir);
  return {
    dataDir: root,
    configPath: join(root, "runtime.json"),
    controlPlanePath: join(root, "control-plane.sqlite"),
    projectionStatePath: join(root, "projection-state.sqlite"),
    operatorTokenPath: join(root, "secrets", "operator.token"),
    restateDataDir: join(root, "restate"),
  };
}

export function defaultRuntimeConfig(): RuntimeConfig {
  return {
    schemaVersion: 1,
    operator: { host: "127.0.0.1", port: 4317, principalId: "local-operator" },
    controlRoom: { host: "127.0.0.1", port: 4320 },
    scheduler: { pollMs: 5000, batchSize: 50 },
    restate: {
      mode: "managed-local",
      ingressUrl: "http://127.0.0.1:8080",
      adminUrl: "http://127.0.0.1:9070",
      workflowHost: "127.0.0.1",
      workflowPort: 9080,
    },
    connections: [],
    policies: [{ id: "default", defaultEffect: "allow", rules: [] }],
  };
}

export function parseRuntimeConfig(value: unknown): RuntimeConfig {
  const root = object(value, "runtime config");
  if (root.schemaVersion !== 1) throw new Error("runtime config schemaVersion must be 1");
  const operator = object(root.operator, "operator");
  const controlRoom = object(root.controlRoom, "controlRoom");
  const scheduler = object(root.scheduler, "scheduler");
  const restate = object(root.restate, "restate");
  if (restate.mode !== "managed-local" && restate.mode !== "external") {
    throw new Error("restate.mode must be managed-local or external");
  }
  if (!Array.isArray(root.connections)) throw new Error("connections must be an array");
  if (!Array.isArray(root.policies) || root.policies.length === 0) {
    throw new Error("policies must be a non-empty array");
  }
  const config: RuntimeConfig = {
    schemaVersion: 1,
    operator: {
      host: host(operator.host, "operator.host"),
      port: integer(operator.port, "operator.port", 1, 65535),
      principalId: string(operator.principalId, "operator.principalId"),
    },
    controlRoom: {
      host: host(controlRoom.host, "controlRoom.host"),
      port: integer(controlRoom.port, "controlRoom.port", 1, 65535),
    },
    scheduler: {
      pollMs: integer(scheduler.pollMs, "scheduler.pollMs", 1000, 60000),
      batchSize: integer(scheduler.batchSize, "scheduler.batchSize", 1, 500),
    },
    restate: {
      mode: restate.mode,
      ingressUrl: url(restate.ingressUrl, "restate.ingressUrl"),
      adminUrl: url(restate.adminUrl, "restate.adminUrl"),
      workflowHost: host(restate.workflowHost, "restate.workflowHost"),
      workflowPort: integer(restate.workflowPort, "restate.workflowPort", 1, 65535),
    },
    connections: root.connections.map(connection),
    policies: root.policies.map(policy),
  };
  const ports = [config.operator.port, config.controlRoom.port, config.restate.workflowPort];
  if (new Set(ports).size !== ports.length) {
    throw new Error("operator, Control Room, and workflow ports must be distinct");
  }
  const connectionIds = config.connections.map((item) => item.id);
  if (new Set(connectionIds).size !== connectionIds.length) throw new Error("connection ids must be unique");
  const policyIds = config.policies.map((item) => item.id);
  if (new Set(policyIds).size !== policyIds.length) throw new Error("policy ids must be unique");
  return config;
}

export async function loadRuntimeConfig(path: string): Promise<RuntimeConfig> {
  const raw = await readFile(path, "utf8");
  return parseRuntimeConfig(JSON.parse(raw) as unknown);
}

export async function writeRuntimeConfig(path: string, config: RuntimeConfig): Promise<void> {
  const parsed = parseRuntimeConfig(config);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}
