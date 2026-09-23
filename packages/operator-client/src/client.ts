import type {
  ActivationInput,
  ApprovalDecisionInput,
  ApprovalDecisionResponse,
  AuditListQuery,
  AuditPage,
  AutomationListQuery,
  AutomationPage,
  AutomationRegistryEntry,
  AutomationRunResult,
  AutomationVersionListQuery,
  AutomationVersionPage,
  ControlPlaneRunRecord,
  OperatorErrorBody,
  OperatorHealth,
  OperatorOperationsPage,
  OperatorOperationsQuery,
  RunListQuery,
  RunPage,
  ScheduleListQuery,
  SchedulePage,
  SchedulerDispatchInput,
  SchedulerDispatchResponse,
} from "./types.js";

export interface OperatorClientOptions {
  readonly baseUrl: string;
  readonly token: string;
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

function pathWithQuery(path: string, query: Readonly<Record<string, unknown>> | undefined): string {
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
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(options: OperatorClientOptions) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl);
    this.#token = options.token.trim();
    if (!this.#token) throw new Error("Operator bearer token is required");
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  async #request<T>(
    path: string,
    options: {
      readonly method?: "GET" | "POST";
      readonly body?: unknown;
      readonly authenticated?: boolean;
    } = {},
  ): Promise<T> {
    const headers = new Headers({ accept: "application/json" });
    if (options.authenticated !== false) headers.set("authorization", `Bearer ${this.#token}`);
    if (options.body !== undefined) headers.set("content-type", "application/json");
    const response = await this.#fetch(joinBase(this.#baseUrl, path), {
      method: options.method ?? "GET",
      headers,
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

  listAutomations(query: AutomationListQuery = {}): Promise<AutomationPage> {
    return this.#request<AutomationPage>(pathWithQuery("/v1/automations", query));
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
