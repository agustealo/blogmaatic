import { createHash, timingSafeEqual } from "node:crypto";

export const OPERATOR_PERMISSIONS = [
  "automations:read",
  "automations:write",
  "schedules:read",
  "schedules:write",
  "schedules:dispatch",
  "events:ingest",
  "runs:read",
  "runs:write",
  "approvals:write",
] as const;

export type OperatorPermission = (typeof OPERATOR_PERMISSIONS)[number];
export type OperatorPermissionGrant = OperatorPermission | "*";
export type OperatorPrincipalKind = "operator" | "integration";

export interface OperatorPrincipal {
  readonly id: string;
  readonly kind: OperatorPrincipalKind;
  readonly permissions: readonly OperatorPermissionGrant[];
  readonly roles: readonly string[];
  readonly source?: string;
}

export interface OperatorAuthorizer {
  authorize(authorization: string | undefined, permission: OperatorPermission): Promise<OperatorPrincipal>;
}

export class OperatorAuthError extends Error {
  constructor(
    readonly statusCode: 401 | 403,
    readonly code: "UNAUTHORIZED" | "FORBIDDEN",
    message: string,
  ) {
    super(message);
    this.name = "OperatorAuthError";
  }
}

export interface StaticBearerCredential {
  readonly id: string;
  readonly token: string;
  readonly kind?: OperatorPrincipalKind;
  readonly permissions: readonly OperatorPermissionGrant[];
  readonly roles?: readonly string[];
  readonly source?: string;
}

interface StoredCredential {
  readonly digest: Buffer;
  readonly principal: OperatorPrincipal;
}

function digestToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function validateGrant(grant: string): asserts grant is OperatorPermissionGrant {
  if (grant === "*") return;
  if (!(OPERATOR_PERMISSIONS as readonly string[]).includes(grant)) {
    throw new Error(`Unknown operator permission: ${grant}`);
  }
}

export class StaticBearerAuthorizer implements OperatorAuthorizer {
  readonly #credentials: readonly StoredCredential[];

  constructor(credentials: readonly StaticBearerCredential[]) {
    if (credentials.length === 0) throw new Error("At least one operator bearer credential is required");
    const identities = new Set<string>();
    const digests = new Set<string>();
    this.#credentials = credentials.map((credential) => {
      if (!credential.id.trim()) throw new Error("Operator credential id is required");
      if (identities.has(credential.id)) throw new Error(`Duplicate operator credential id: ${credential.id}`);
      identities.add(credential.id);
      if (credential.token.length < 32) {
        throw new Error(`Operator bearer token for ${credential.id} must be at least 32 characters`);
      }
      for (const permission of credential.permissions) validateGrant(permission);
      for (const role of credential.roles ?? []) {
        if (!role.trim()) throw new Error(`Operator role for ${credential.id} cannot be empty`);
      }
      if (credential.source !== undefined && !credential.source.trim()) {
        throw new Error(`Operator source for ${credential.id} cannot be empty`);
      }
      const digest = digestToken(credential.token);
      const hex = digest.toString("hex");
      if (digests.has(hex)) throw new Error("Operator bearer tokens must be unique");
      digests.add(hex);
      return {
        digest,
        principal: {
          id: credential.id,
          kind: credential.kind ?? "operator",
          permissions: [...credential.permissions],
          roles: [...(credential.roles ?? [])],
          ...(credential.source === undefined ? {} : { source: credential.source }),
        },
      };
    });
  }

  async authorize(authorization: string | undefined, permission: OperatorPermission): Promise<OperatorPrincipal> {
    const match = authorization?.match(/^Bearer ([^\s]+)$/);
    if (!match?.[1]) {
      throw new OperatorAuthError(401, "UNAUTHORIZED", "A valid Bearer token is required");
    }
    const supplied = digestToken(match[1]);
    let credential: StoredCredential | undefined;
    for (const candidate of this.#credentials) {
      if (timingSafeEqual(supplied, candidate.digest)) credential = candidate;
    }
    if (!credential) {
      throw new OperatorAuthError(401, "UNAUTHORIZED", "A valid Bearer token is required");
    }
    const grants = credential.principal.permissions;
    if (!grants.includes("*") && !grants.includes(permission)) {
      throw new OperatorAuthError(403, "FORBIDDEN", `Permission ${permission} is required`);
    }
    return credential.principal;
  }
}
