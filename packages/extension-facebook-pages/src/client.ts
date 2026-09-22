import type { ConnectionRecord } from "@blogmaatic/extension-sdk";
import { SecretAuthority } from "@blogmaatic/secrets";

import type { FacebookSettings } from "./types.js";

interface GraphErrorBody {
  readonly error?: {
    readonly message?: string;
    readonly type?: string;
    readonly code?: number;
    readonly error_subcode?: number;
    readonly fbtrace_id?: string;
  };
}

export class FacebookGraphError extends Error {
  readonly status: number;
  readonly code?: number;
  readonly subcode?: number;

  constructor(status: number, body: GraphErrorBody) {
    const graph = body.error;
    super(`Facebook Graph request failed (${status})${graph?.code ? ` ${graph.code}` : ""}${graph?.message ? `: ${graph.message}` : ""}`);
    this.name = "FacebookGraphError";
    this.status = status;
    if (typeof graph?.code === "number") this.code = graph.code;
    if (typeof graph?.error_subcode === "number") this.subcode = graph.error_subcode;
  }
}

export class FacebookGraphClient {
  readonly #connection: ConnectionRecord;
  readonly #settings: FacebookSettings;
  readonly #secrets: SecretAuthority;

  constructor(connection: ConnectionRecord, settings: FacebookSettings, secrets: SecretAuthority) {
    this.#connection = connection;
    this.#settings = settings;
    this.#secrets = secrets;
  }

  async getJson<T>(path: string, params: Readonly<Record<string, string>> = {}): Promise<T> {
    const query = new URLSearchParams(params);
    return this.#request<T>("GET", path, query, undefined);
  }

  async postForm<T>(path: string, params: Readonly<Record<string, string>>): Promise<T> {
    return this.#request<T>("POST", path, undefined, new URLSearchParams(params));
  }

  async postMultipart<T>(path: string, form: FormData): Promise<T> {
    return this.#request<T>("POST", path, undefined, form);
  }

  async #request<T>(
    method: "GET" | "POST",
    path: string,
    query: URLSearchParams | undefined,
    body: URLSearchParams | FormData | undefined,
  ): Promise<T> {
    const suffix = path.replace(/^\/+/, "");
    const url = new URL(`${this.#settings.apiRoot}/${this.#settings.apiVersion}/${suffix}`);
    if (query) url.search = query.toString();
    return this.#secrets.withUtf8(this.#settings.pageAccessTokenRef, async (token) => {
      const headers = new Headers({ Accept: "application/json", Authorization: `Bearer ${token}` });
      if (body instanceof URLSearchParams) {
        headers.set("Content-Type", "application/x-www-form-urlencoded;charset=UTF-8");
      }
      const response = await fetch(url, {
        method,
        headers,
        ...(body ? { body } : {}),
        signal: AbortSignal.timeout(this.#settings.timeoutMs),
      });
      const text = await response.text();
      let parsed: unknown = undefined;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      if (!response.ok) {
        const graph = parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as GraphErrorBody)
          : { error: { message: typeof parsed === "string" ? parsed.slice(0, 400) : response.statusText } };
        throw new FacebookGraphError(response.status, graph);
      }
      return parsed as T;
    });
  }

  connectionId(): string {
    return this.#connection.id;
  }
}
