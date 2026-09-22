import type { ConnectionRecord } from "@blogmaatic/extension-sdk";
import { SecretAuthority } from "@blogmaatic/secrets";

import type { LinkedInSettings } from "./types.js";

interface LinkedInErrorBody {
  readonly code?: string | number;
  readonly message?: string;
  readonly status?: number;
}

export interface LinkedInHttpResponse<T> {
  readonly status: number;
  readonly headers: Headers;
  readonly body: T;
}

export class LinkedInHttpError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, body: LinkedInErrorBody) {
    const code = body.code === undefined ? undefined : String(body.code);
    super(`LinkedIn REST request failed (${status})${code ? ` ${code}` : ""}${body.message ? `: ${body.message.slice(0, 400)}` : ""}`);
    this.name = "LinkedInHttpError";
    this.status = status;
    if (code) this.code = code;
  }
}

export class LinkedInRestClient {
  readonly #connection: ConnectionRecord;
  readonly #settings: LinkedInSettings;
  readonly #secrets: SecretAuthority;

  constructor(connection: ConnectionRecord, settings: LinkedInSettings, secrets: SecretAuthority) {
    this.#connection = connection;
    this.#settings = settings;
    this.#secrets = secrets;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<LinkedInHttpResponse<T>> {
    const url = path.startsWith("http") ? path : `${this.#settings.apiRoot}${path}`;
    return this.#secrets.withUtf8(this.#settings.accessTokenRef, async (token) => {
      const headers = new Headers(init.headers);
      headers.set("Accept", "application/json");
      headers.set("Authorization", `Bearer ${token}`);
      headers.set("Linkedin-Version", this.#settings.apiVersion);
      headers.set("X-Restli-Protocol-Version", "2.0.0");
      if (typeof init.body === "string" && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }
      const response = await fetch(url, {
        ...init,
        headers,
        signal: AbortSignal.timeout(this.#settings.timeoutMs),
      });
      const text = await response.text();
      let body: unknown = undefined;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      if (!response.ok) {
        const errorBody =
          body && typeof body === "object" && !Array.isArray(body)
            ? (body as LinkedInErrorBody)
            : { message: typeof body === "string" ? body.slice(0, 400) : response.statusText };
        throw new LinkedInHttpError(response.status, errorBody);
      }
      return { status: response.status, headers: response.headers, body: body as T };
    });
  }

  connectionId(): string {
    return this.#connection.id;
  }
}
