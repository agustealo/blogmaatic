import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, stat } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";

import { httpOrigin } from "./network.js";

const SESSION_COOKIE_PREFIX = "blogmaatic_control_room_session";
const SESSION_PROOF_HEADER = "x-blogmaatic-session-proof";
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

export interface ControlRoomUpdateStatus {
  readonly currentVersion: string;
  readonly latestVersion: string;
  readonly tag: string;
  readonly releaseUrl: string;
  readonly updateAvailable: boolean;
  readonly packageName?: string;
  readonly installerOpened?: boolean;
}

export interface ControlRoomUpdateService {
  check(): Promise<ControlRoomUpdateStatus>;
  install(): Promise<ControlRoomUpdateStatus>;
}

export interface ControlRoomDiagnostics {
  readonly productVersion: string;
  readonly runtimeStatus: "running";
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("cross-origin-resource-policy", "same-origin");
  response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
}

function json(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
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

function proxyHeaders(request: IncomingMessage, operatorToken: string, authenticated: boolean): Headers {
  const headers = new Headers();
  if (authenticated) headers.set("authorization", `Bearer ${operatorToken}`);
  for (const name of ["accept", "content-type", "idempotency-key"] as const) {
    const value = request.headers[name];
    if (typeof value === "string") headers.set(name, value);
  }
  return headers;
}

function requestMatchesBoundOrigin(request: IncomingMessage, controlRoomOrigin: string): boolean {
  if (!controlRoomOrigin) return false;
  const expected = new URL(controlRoomOrigin);
  const host = request.headers.host;
  if (!host || host !== expected.host) return false;

  const fetchSite = request.headers["sec-fetch-site"];
  if (typeof fetchSite === "string" && fetchSite !== "same-origin" && fetchSite !== "none") return false;

  const origin = request.headers.origin;
  if (typeof origin === "string" && origin !== expected.origin) return false;
  return true;
}

function cookieValue(request: IncomingMessage, name: string): string | undefined {
  const raw = request.headers.cookie;
  if (!raw) return undefined;
  for (const item of raw.split(";")) {
    const [key, ...parts] = item.trim().split("=");
    if (key === name) return parts.join("=");
  }
  return undefined;
}

function bearerValue(request: IncomingMessage): string | undefined {
  const raw = request.headers.authorization;
  if (typeof raw !== "string") return undefined;
  const match = /^Bearer\s+(.+)$/.exec(raw);
  return match?.[1];
}

function secretMatches(received: string | undefined, expected: string): boolean {
  if (!received) return false;
  const left = Buffer.from(received, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function localAuthorityAuthorized(request: IncomingMessage, controlRoomOrigin: string, operatorToken: string): boolean {
  return request.method === "POST"
    && requestMatchesBoundOrigin(request, controlRoomOrigin)
    && secretMatches(bearerValue(request), operatorToken);
}

function sessionAuthorized(
  request: IncomingMessage,
  controlRoomOrigin: string,
  sessionCookieName: string,
  sessionToken: string,
  sessionProof: string,
): boolean {
  const proof = request.headers[SESSION_PROOF_HEADER];
  return requestMatchesBoundOrigin(request, controlRoomOrigin)
    && secretMatches(cookieValue(request, sessionCookieName), sessionToken)
    && typeof proof === "string"
    && secretMatches(proof, sessionProof);
}

function forbiddenProxy(response: ServerResponse): void {
  json(response, 403, {
    error: {
      code: "CONTROL_ROOM_SESSION_REQUIRED",
      message: "Open the Control Room using a one-time launch URL minted by the Blogmaatic runtime",
    },
  });
}

function forbiddenLauncher(response: ServerResponse): void {
  json(response, 403, {
    error: {
      code: "CONTROL_ROOM_LOCAL_AUTHORITY_REQUIRED",
      message: "A local Blogmaatic operator credential is required",
    },
  });
}

type BootstrapConsumeResult = "accepted" | "used" | "invalid";

function bootstrapSession(
  request: IncomingMessage,
  response: ServerResponse,
  controlRoomOrigin: string,
  sessionCookieName: string,
  sessionToken: string,
  sessionProof: string,
  consume: (token: string) => BootstrapConsumeResult,
): void {
  if (request.method !== "GET" || !requestMatchesBoundOrigin(request, controlRoomOrigin)) {
    forbiddenProxy(response);
    return;
  }
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  const token = pathname.slice("/session/".length);
  const result = consume(token);
  if (result === "invalid") {
    forbiddenProxy(response);
    return;
  }
  if (result === "used") {
    response.statusCode = 410;
    response.setHeader("cache-control", "no-store");
    response.end("Control Room launch capability has already been consumed");
    return;
  }

  response.statusCode = 303;
  response.setHeader("location", `/#session=${sessionProof}`);
  response.setHeader("cache-control", "no-store");
  response.setHeader("set-cookie", `${sessionCookieName}=${sessionToken}; Path=/; HttpOnly; SameSite=Strict`);
  response.end();
}

function mintLaunch(
  request: IncomingMessage,
  response: ServerResponse,
  controlRoomOrigin: string,
  operatorToken: string,
  mint: () => string,
): void {
  if (!localAuthorityAuthorized(request, controlRoomOrigin, operatorToken)) {
    forbiddenLauncher(response);
    return;
  }
  const launchAddress = mint();
  json(response, 201, { launchAddress });
}

function requestShutdown(
  request: IncomingMessage,
  response: ServerResponse,
  controlRoomOrigin: string,
  operatorToken: string,
  onShutdown: (() => void) | undefined,
): void {
  if (!localAuthorityAuthorized(request, controlRoomOrigin, operatorToken)) {
    forbiddenLauncher(response);
    return;
  }
  if (!onShutdown) {
    json(response, 409, { error: { code: "CONTROL_ROOM_SHUTDOWN_UNAVAILABLE", message: "This runtime was not started with local shutdown ownership" } });
    return;
  }
  json(response, 202, { accepted: true });
  setImmediate(onShutdown);
}

function diagnosticsAction(
  request: IncomingMessage,
  response: ServerResponse,
  controlRoomOrigin: string,
  sessionCookieName: string,
  sessionToken: string,
  sessionProof: string,
  productVersion: string | undefined,
): void {
  if (!sessionAuthorized(request, controlRoomOrigin, sessionCookieName, sessionToken, sessionProof)) {
    forbiddenProxy(response);
    return;
  }
  if (request.method !== "GET") {
    response.statusCode = 405;
    response.setHeader("allow", "GET");
    response.setHeader("cache-control", "no-store");
    response.end("Method not allowed");
    return;
  }
  const version = productVersion?.trim();
  if (!version) {
    json(response, 503, { error: { code: "CONTROL_ROOM_DIAGNOSTICS_UNAVAILABLE", message: "Runtime product metadata is unavailable" } });
    return;
  }
  const diagnostics: ControlRoomDiagnostics = { productVersion: version, runtimeStatus: "running" };
  json(response, 200, diagnostics);
}

async function updateAction(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  controlRoomOrigin: string,
  sessionCookieName: string,
  sessionToken: string,
  sessionProof: string,
  updates: ControlRoomUpdateService | undefined,
): Promise<void> {
  if (!sessionAuthorized(request, controlRoomOrigin, sessionCookieName, sessionToken, sessionProof)) {
    forbiddenProxy(response);
    return;
  }
  if (!updates) {
    json(response, 503, { error: { code: "CONTROL_ROOM_UPDATE_UNAVAILABLE", message: "This runtime does not own the trusted native update channel" } });
    return;
  }
  try {
    if (pathname === "/local/update" && request.method === "GET") {
      json(response, 200, await updates.check());
      return;
    }
    if (pathname === "/local/update/install" && request.method === "POST") {
      json(response, 202, await updates.install());
      return;
    }
    response.statusCode = 405;
    response.setHeader("allow", pathname.endsWith("/install") ? "POST" : "GET");
    response.setHeader("cache-control", "no-store");
    response.end("Method not allowed");
  } catch (error) {
    json(response, 502, {
      error: {
        code: "CONTROL_ROOM_UPDATE_FAILED",
        message: error instanceof Error ? error.message : "Trusted update operation failed",
      },
    });
  }
}

async function proxy(
  request: IncomingMessage,
  response: ServerResponse,
  operatorOrigin: string,
  operatorToken: string,
  controlRoomOrigin: string,
  sessionCookieName: string,
  sessionToken: string,
  sessionProof: string,
): Promise<void> {
  const incomingUrl = new URL(request.url ?? "/", "http://localhost");
  const upstreamPath = incomingUrl.pathname.slice("/api".length) || "/";
  const publicHealth = request.method === "GET" && upstreamPath === "/healthz";
  if (!publicHealth && !sessionAuthorized(request, controlRoomOrigin, sessionCookieName, sessionToken, sessionProof)) {
    forbiddenProxy(response);
    return;
  }

  try {
    const target = `${operatorOrigin}${upstreamPath}${incomingUrl.search}`;
    const body = await requestBody(request);
    const upstream = await fetch(target, {
      method: request.method ?? "GET",
      headers: proxyHeaders(request, operatorToken, !publicHealth),
      redirect: "manual",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      ...(body === undefined ? {} : { body }),
    });
    response.statusCode = upstream.status;
    response.setHeader("cache-control", "no-store");
    for (const name of ["content-type", "www-authenticate", "x-content-type-options"] as const) {
      const value = upstream.headers.get(name);
      if (value) response.setHeader(name, value);
    }
    response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    json(response, 502, {
      error: {
        code: "LOCAL_PROXY_UNAVAILABLE",
        message: error instanceof Error ? error.message : "Operator API is unavailable",
      },
    });
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
  readonly launchAddress: string;

  private constructor(server: Server, address: string, launchAddress: string) {
    this.#server = server;
    this.address = address;
    this.launchAddress = launchAddress;
  }

  static async start(options: {
    readonly root: string;
    readonly host: string;
    readonly port: number;
    readonly operatorOrigin: string;
    readonly operatorToken: string;
    readonly onShutdown?: () => void;
    readonly updates?: ControlRoomUpdateService;
    readonly productVersion?: string;
  }): Promise<ControlRoomServer> {
    const root = resolve(options.root);
    const index = resolve(root, "index.html");
    try {
      if (!(await stat(index)).isFile()) throw new Error("not a file");
    } catch {
      throw new Error(`Control Room production build is missing: ${index}. Run npm run build first.`);
    }
    if (!options.operatorToken.trim()) throw new Error("Control Room operator token is required");

    const sessionToken = randomBytes(32).toString("base64url");
    const sessionProof = randomBytes(32).toString("base64url");
    const availableBootstraps = new Set<string>();
    const consumedBootstraps = new Set<string>();
    let controlRoomOrigin = "";
    let sessionCookieName = SESSION_COOKIE_PREFIX;
    let installInFlight: Promise<ControlRoomUpdateStatus> | undefined;
    const updateService = options.updates ? {
      check: () => options.updates!.check(),
      install: () => {
        if (!installInFlight) {
          installInFlight = options.updates!.install().finally(() => { installInFlight = undefined; });
        }
        return installInFlight;
      },
    } satisfies ControlRoomUpdateService : undefined;

    const mintBootstrap = (): string => {
      if (!controlRoomOrigin) throw new Error("Control Room origin is unavailable");
      const token = randomBytes(24).toString("base64url");
      availableBootstraps.add(token);
      return `${controlRoomOrigin}/session/${token}`;
    };
    const consumeBootstrap = (token: string): BootstrapConsumeResult => {
      if (availableBootstraps.delete(token)) {
        consumedBootstraps.add(token);
        if (consumedBootstraps.size > 64) {
          const oldest = consumedBootstraps.values().next().value as string | undefined;
          if (oldest) consumedBootstraps.delete(oldest);
        }
        return "accepted";
      }
      if (consumedBootstraps.has(token)) return "used";
      return "invalid";
    };

    const server = createServer((request, response) => {
      securityHeaders(response);
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      let task: Promise<void>;
      if (pathname === "/local/launch") {
        mintLaunch(request, response, controlRoomOrigin, options.operatorToken, mintBootstrap);
        task = Promise.resolve();
      } else if (pathname === "/local/shutdown") {
        requestShutdown(request, response, controlRoomOrigin, options.operatorToken, options.onShutdown);
        task = Promise.resolve();
      } else if (pathname === "/local/diagnostics") {
        diagnosticsAction(
          request,
          response,
          controlRoomOrigin,
          sessionCookieName,
          sessionToken,
          sessionProof,
          options.productVersion,
        );
        task = Promise.resolve();
      } else if (pathname === "/local/update" || pathname === "/local/update/install") {
        task = updateAction(
          request,
          response,
          pathname,
          controlRoomOrigin,
          sessionCookieName,
          sessionToken,
          sessionProof,
          updateService,
        );
      } else if (pathname.startsWith("/session/")) {
        bootstrapSession(request, response, controlRoomOrigin, sessionCookieName, sessionToken, sessionProof, consumeBootstrap);
        task = Promise.resolve();
      } else if (pathname === "/api" || pathname.startsWith("/api/")) {
        task = proxy(request, response, options.operatorOrigin, options.operatorToken, controlRoomOrigin, sessionCookieName, sessionToken, sessionProof);
      } else {
        task = serveStatic(request, response, root);
      }
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
        const bound = server.address();
        if (!bound || typeof bound === "string") {
          reject(new Error("Control Room server did not expose a TCP address"));
          return;
        }
        const port = (bound as AddressInfo).port;
        controlRoomOrigin = httpOrigin(options.host, port);
        sessionCookieName = `${SESSION_COOKIE_PREFIX}_${port}`;
        resolveListen();
      });
    });
    if (!controlRoomOrigin) {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      throw new Error("Control Room server did not establish its bound origin");
    }
    return new ControlRoomServer(server, controlRoomOrigin, mintBootstrap());
  }

  async close(): Promise<void> {
    await new Promise<void>((resolveClose, reject) => {
      this.#server.close((error) => error ? reject(error) : resolveClose());
    });
  }
}
