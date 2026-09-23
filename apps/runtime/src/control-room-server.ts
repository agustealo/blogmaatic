import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, stat } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";

const MIME: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function securityHeaders(response: ServerResponse): void {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
}

async function requestBody(request: IncomingMessage, limit = 2 * 1024 * 1024): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error("Request body exceeds the local proxy limit");
    chunks.push(buffer);
  }
  return Uint8Array.from(Buffer.concat(chunks));
}

function proxyHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const name of ["accept", "authorization", "content-type", "idempotency-key"] as const) {
    const value = request.headers[name];
    if (typeof value === "string") headers.set(name, value);
  }
  return headers;
}

async function proxy(request: IncomingMessage, response: ServerResponse, operatorOrigin: string): Promise<void> {
  try {
    const incomingUrl = new URL(request.url ?? "/", "http://localhost");
    const upstreamPath = incomingUrl.pathname.slice("/api".length) || "/";
    const target = `${operatorOrigin}${upstreamPath}${incomingUrl.search}`;
    const body = await requestBody(request);
    const upstream = await fetch(target, {
      method: request.method ?? "GET",
      headers: proxyHeaders(request),
      redirect: "manual",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      ...(body === undefined ? {} : { body }),
    });
    response.statusCode = upstream.status;
    for (const name of ["content-type", "cache-control", "www-authenticate", "x-content-type-options"] as const) {
      const value = upstream.headers.get(name);
      if (value) response.setHeader(name, value);
    }
    response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    response.statusCode = 502;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify({
      error: {
        code: "LOCAL_PROXY_UNAVAILABLE",
        message: error instanceof Error ? error.message : "Operator API is unavailable",
      },
    }));
  }
}

function safeFile(root: string, pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0")) return undefined;
  const candidate = resolve(root, `.${decoded === "/" ? "/index.html" : decoded}`);
  const rel = relative(root, candidate);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) return undefined;
  return candidate;
}

async function serveStatic(request: IncomingMessage, response: ServerResponse, root: string): Promise<void> {
  const parsed = new URL(request.url ?? "/", "http://localhost");
  let target = safeFile(root, parsed.pathname);
  if (!target) {
    response.statusCode = 400;
    response.end("Bad request");
    return;
  }
  try {
    if (!(await stat(target)).isFile()) throw Object.assign(new Error("Not a file"), { code: "ENOENT" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || extname(parsed.pathname)) {
      response.statusCode = 404;
      response.end("Not found");
      return;
    }
    target = resolve(root, "index.html");
  }
  try {
    const content = await readFile(target);
    response.statusCode = 200;
    response.setHeader("content-type", MIME[extname(target).toLowerCase()] ?? "application/octet-stream");
    response.setHeader("cache-control", extname(target) === ".html" ? "no-store" : "public, max-age=31536000, immutable");
    if (request.method === "HEAD") response.end();
    else response.end(content);
  } catch {
    response.statusCode = 404;
    response.end("Control Room build is unavailable");
  }
}

export class ControlRoomServer {
  readonly #server: Server;
  readonly address: string;

  private constructor(server: Server, address: string) {
    this.#server = server;
    this.address = address;
  }

  static async start(options: {
    readonly root: string;
    readonly host: string;
    readonly port: number;
    readonly operatorOrigin: string;
  }): Promise<ControlRoomServer> {
    const root = resolve(options.root);
    const index = resolve(root, "index.html");
    try {
      if (!(await stat(index)).isFile()) throw new Error("not a file");
    } catch {
      throw new Error(`Control Room production build is missing: ${index}. Run npm run build first.`);
    }
    const server = createServer((request, response) => {
      securityHeaders(response);
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      const task = pathname === "/api" || pathname.startsWith("/api/")
        ? proxy(request, response, options.operatorOrigin)
        : serveStatic(request, response, root);
      void task.catch((error: unknown) => {
        if (response.headersSent) return response.destroy(error instanceof Error ? error : undefined);
        response.statusCode = 500;
        response.end("Internal server error");
      });
    });
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(options.port, options.host, () => {
        server.off("error", reject);
        resolveListen();
      });
    });
    const bound = server.address();
    if (!bound || typeof bound === "string") {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      throw new Error("Control Room server did not expose a TCP address");
    }
    const port = (bound as AddressInfo).port;
    return new ControlRoomServer(server, `http://${options.host}:${port}`);
  }

  async close(): Promise<void> {
    await new Promise<void>((resolveClose, reject) => {
      this.#server.close((error) => error ? reject(error) : resolveClose());
    });
  }
}
