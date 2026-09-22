import { Buffer } from "node:buffer";

import type { ConnectionRecord } from "@blogmaatic/extension-sdk";
import { SecretAuthority } from "@blogmaatic/secrets";

import type { WordPressSettings } from "./types.js";

interface WordPressErrorBody {
  readonly code?: string;
  readonly message?: string;
  readonly data?: { readonly status?: number; readonly term_id?: number };
}

export class WordPressHttpError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly termId?: number;

  constructor(status: number, body: WordPressErrorBody) {
    super(`WordPress REST request failed (${status})${body.code ? ` ${body.code}` : ""}${body.message ? `: ${body.message}` : ""}`);
    this.name = "WordPressHttpError";
    this.status = status;
    if (body.code) this.code = body.code;
    if (typeof body.data?.term_id === "number") this.termId = body.data.term_id;
  }
}

export class WordPressRestClient {
  readonly #connection: ConnectionRecord;
  readonly #settings: WordPressSettings;
  readonly #secrets: SecretAuthority;

  constructor(connection: ConnectionRecord, settings: WordPressSettings, secrets: SecretAuthority) {
    this.#connection = connection;
    this.#settings = settings;
    this.#secrets = secrets;
  }

  async requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    return this.#request<T>(path, init, true);
  }

  async requestBytes<T>(path: string, bytes: Uint8Array, contentType: string, filename: string): Promise<T> {
    const headers = new Headers({
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename=${JSON.stringify(filename)}`,
    });
    const body = new Uint8Array(bytes).buffer;
    return this.#request<T>(path, { method: "POST", headers, body }, true);
  }

  async #request<T>(path: string, init: RequestInit, authenticated: boolean): Promise<T> {
    const url = path.startsWith("http") ? path : `${this.#settings.apiRoot}${path}`;
    const execute = async (authorization?: string): Promise<T> => {
      const headers = new Headers(init.headers);
      headers.set("Accept", "application/json");
      if (authorization) headers.set("Authorization", authorization);
      if (init.body && typeof init.body === "string" && !headers.has("Content-Type")) {
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
            ? (body as WordPressErrorBody)
            : { message: typeof body === "string" ? body.slice(0, 400) : response.statusText };
        throw new WordPressHttpError(response.status, errorBody);
      }
      return body as T;
    };

    if (!authenticated) return execute();
    return this.#secrets.withUtf8(this.#settings.applicationPasswordRef, async (password) => {
      const material = Buffer.from(`${this.#settings.username}:${password}`, "utf8");
      try {
        const authorization = `Basic ${material.toString("base64")}`;
        return await execute(authorization);
      } finally {
        material.fill(0);
      }
    });
  }

  connectionId(): string {
    return this.#connection.id;
  }
}
