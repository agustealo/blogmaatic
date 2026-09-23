import type {
  ActivationInput,
  ApprovalDecisionInput,
  ApprovalDecisionResponse,
  AuditListQuery,
  AuditPage,
  AutomationDefinition,
  AutomationListQuery,
  AutomationPage,
  AutomationRegistryEntry,
  AutomationRunResult,
  AutomationVersionListQuery,
  AutomationVersionPage,
  ConnectionCreateBody,
  ConnectionTypesResponse,
  ConnectionsResponse,
  ConnectionUpdateBody,
  ControlPlaneRunRecord,
  OperatorConnectionTestResult,
  OperatorConnectionView,
  OperatorErrorBody,
  OperatorHealth,
  OperatorOperationsPage,
  OperatorOperationsQuery,
  PublicationGroupActivationBody,
  PublicationGroupCreateBody,
  PublicationGroupListQuery,
  PublicationGroupOptionsResponse,
  PublicationGroupPage,
  PublicationGroupRegistryEntry,
  PublicationGroupUpdateBody,
  PublicationGroupVersionListQuery,
  PublicationGroupVersionPage,
  RunListQuery,
  RunPage,
  ScheduleListQuery,
  SchedulePage,
  SchedulerDispatchInput,
  SchedulerDispatchResponse,
} from "./types.js";

export interface OperatorClientOptions {
  readonly baseUrl: string;
  readonly token?: string;
  readonly sessionProof?: string;
  readonly fetchImpl?: typeof fetch;
}

export class OperatorClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "OperatorClientError";
  }
}

function normalizeBaseUrl(input: string): string {
  const value = input.trim();
  if (!value) throw new Error("Operator API base URL is required");
  if (value.startsWith("/")) {
    if (value.startsWith("//") || value.includes("\\") || value.includes("?") || value.includes("#")) {
      throw new Error("Root-relative Operator API base URL must be an unambiguous path");
    }
    const normalized = value.replace(/\/+$/, "");
    return normalized || "/";
  }
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Operator API base URL must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("Operator API base URL must not contain credentials");
  }
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function pathWithQuery<T extends object>(path: string, query: T | undefined): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const suffix = params.toString();
  return suffix ? `${path}?${suffix}` : path;
}

function joinBase(base: string, path: string): string {
  if (base === "/") return path;
  return `${base}${path}`;
}

async function parseJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

export class OperatorClient {
  readonly #baseUrl: string;
  readonly #token: string | undefined;
  readonly #sessionProof: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: OperatorClientOptions) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl);
    const token = options.token?.trim();
    const sessionProof = options.sessionProof?.trim();
    this.#token = token || undefined;
    this.#sessionProof = sessionProof || undefined;
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  async #request<T>(
    path: string,
    options: {
      readonly method?: "GET" | "POST" | "PATCH" | "DELETE";
      readonly body?: unknown;
      readonly authenticated?: boolean;
    } = {},
  ): Promise<T> {
    const headers = new Headers({ accept: "application/json" });
    if (options.authenticated !== false && this.#token) headers.set("authorization", `Bearer ${this.#token}`);
    if (options.authenticated !== false && !this.#token && this.#sessionProof) {
      headers.set("x-blogmaatic-session-proof", this.#sessionProof);
    }
    if (options.body !== undefined) headers.set("content-type", "application/json");
    const response = await this.#fetch(joinBase(this.#baseUrl, path), {
      method: options.method ?? "GET",
      headers,
      credentials: this.#token ? "omit" : "same-origin",
      redirect: "error",
      referrerPolicy: "no-referrer",
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    if (!response.ok) {
      let body: OperatorErrorBody = {};
      try {
        body = await parseJson<OperatorErrorBody>(response);
      } catch {
        body = {};
      }
      const message = body.error?.message ?? `Operator API request failed with HTTP ${response.status}`;
      throw new OperatorClientError(
        message,
        response.status,
        body.error?.code ?? "OPERATOR_API_ERROR",
        body.error?.requestId,
      );
    }
    return parseJson<T>(response);
  }

  health(): Promise<OperatorHealth> {
    return this.#request<OperatorHealth>("/healthz", { authenticated: false });
  }

  listConnectionTypes(): Promise<ConnectionTypesResponse> {
    return this.#request<ConnectionTypesResponse>("/v1/connection-types");
  }

  listConnections(): Promise<ConnectionsResponse> {
    return this.#request<ConnectionsResponse>("/v1/connections");
  }

  getConnection(connectionId: string): Promise<OperatorConnectionView> {
    return this.#request<OperatorConnectionView>(`/v1/connections/${encodeURIComponent(connectionId)}`);
  }

  createConnection(input: ConnectionCreateBody): Promise<OperatorConnectionView> {
    return this.#request<OperatorConnectionView>("/v1/connections", {
      method: "POST",
      body: input,
    });
  }

  updateConnection(connectionId: string, input: ConnectionUpdateBody): Promise<OperatorConnectionView> {
    return this.#request<OperatorConnectionView>(`/v1/connections/${encodeURIComponent(connectionId)}`, {
      method: "PATCH",
      body: input,
    });
  }

  removeConnection(connectionId: string): Promise<OperatorConnectionView> {
    return this.#request<OperatorConnectionView>(`/v1/connections/${encodeURIComponent(connectionId)}`, {
      method: "DELETE",
    });
  }

  testConnection(connectionId: string): Promise<OperatorConnectionTestResult> {
    return this.#request<OperatorConnectionTestResult>(`/v1/connections/${encodeURIComponent(connectionId)}/test`, {
      method: "POST",
    });
  }

  getPublicationGroupOptions(): Promise<PublicationGroupOptionsResponse> {
    return this.#request<PublicationGroupOptionsResponse>("/v1/publication-group-options");
  }

  listPublicationGroups(query: PublicationGroupListQuery = {}): Promise<PublicationGroupPage> {
    return this.#request<PublicationGroupPage>(pathWithQuery("/v1/publication-groups", query));
  }

  getPublicationGroup(groupId: string): Promise<PublicationGroupRegistryEntry> {
    return this.#request<PublicationGroupRegistryEntry>(`/v1/publication-groups/${encodeURIComponent(groupId)}`);
  }

  listPublicationGroupVersions(
    groupId: string,
    query: PublicationGroupVersionListQuery = {},
  ): Promise<PublicationGroupVersionPage> {
    return this.#request<PublicationGroupVersionPage>(pathWithQuery(
      `/v1/publication-groups/${encodeURIComponent(groupId)}/versions`,
      query,
    ));
  }

  getPublicationGroupVersion(groupId: string, version: number): Promise<PublicationGroupRegistryEntry> {
    return this.#request<PublicationGroupRegistryEntry>(
      `/v1/publication-groups/${encodeURIComponent(groupId)}/versions/${version}`,
    );
  }

  createPublicationGroup(input: PublicationGroupCreateBody): Promise<PublicationGroupRegistryEntry> {
    return this.#request<PublicationGroupRegistryEntry>("/v1/publication-groups", {
      method: "POST",
      body: input,
    });
  }

  updatePublicationGroup(groupId: string, input: PublicationGroupUpdateBody): Promise<PublicationGroupRegistryEntry> {
    return this.#request<PublicationGroupRegistryEntry>(`/v1/publication-groups/${encodeURIComponent(groupId)}`, {
      method: "PATCH",
      body: input,
    });
  }

  setPublicationGroupEnabled(
    groupId: string,
    input: PublicationGroupActivationBody,
  ): Promise<PublicationGroupRegistryEntry> {
    return this.#request<PublicationGroupRegistryEntry>(
      `/v1/publication-groups/${encodeURIComponent(groupId)}/activation`,
      { method: "POST", body: input },
    );
  }

  listAutomations(query: AutomationListQuery = {}): Promise<AutomationPage> {
    return this.#request<AutomationPage>(pathWithQuery("/v1/automations", query));
  }

  registerAutomation(input: AutomationDefinition): Promise<AutomationRegistryEntry> {
    return this.#request<AutomationRegistryEntry>("/v1/automations", {
      method: "POST",
      body: input,
    });
  }

  listAutomationVersions(
    automationId: string,
    query: AutomationVersionListQuery = {},
  ): Promise<AutomationVersionPage> {
    return this.#request<AutomationVersionPage>(pathWithQuery(
      `/v1/automations/${encodeURIComponent(automationId)}/versions`,
      query,
    ));
  }

  activateAutomation(automationId: string, version: number, input: ActivationInput): Promise<AutomationRegistryEntry> {
    return this.#request<AutomationRegistryEntry>(
      `/v1/automations/${encodeURIComponent(automationId)}/versions/${version}/activate`,
      { method: "POST", body: input },
    );
  }

  listRuns(query: RunListQuery = {}): Promise<RunPage> {
    return this.#request<RunPage>(pathWithQuery("/v1/runs", query));
  }

  getRun(runId: string): Promise<ControlPlaneRunRecord> {
    return this.#request<ControlPlaneRunRecord>(`/v1/runs/${encodeURIComponent(runId)}`);
  }

  getRunResult(runId: string): Promise<AutomationRunResult> {
    return this.#request<AutomationRunResult>(`/v1/runs/${encodeURIComponent(runId)}/result`);
  }

  decideApproval(runId: string, input: ApprovalDecisionInput): Promise<ApprovalDecisionResponse> {
    return this.#request<ApprovalDecisionResponse>(`/v1/runs/${encodeURIComponent(runId)}/approvals`, {
      method: "POST",
      body: input,
    });
  }

  listSchedules(query: ScheduleListQuery = {}): Promise<SchedulePage> {
    return this.#request<SchedulePage>(pathWithQuery("/v1/schedules", query));
  }

  dispatchSchedules(input: SchedulerDispatchInput = {}): Promise<SchedulerDispatchResponse> {
    return this.#request<SchedulerDispatchResponse>("/v1/scheduler/dispatch", {
      method: "POST",
      body: input,
    });
  }

  listOperations(query: OperatorOperationsQuery = {}): Promise<OperatorOperationsPage> {
    return this.#request<OperatorOperationsPage>(pathWithQuery("/v1/operations", query));
  }

  listAudit(query: AuditListQuery = {}): Promise<AuditPage> {
    return this.#request<AuditPage>(pathWithQuery("/v1/audit", query));
  }
}
