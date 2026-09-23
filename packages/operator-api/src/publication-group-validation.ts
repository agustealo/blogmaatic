import {
  decodeCursor,
  type PublicationGroupListQuery,
  type PublicationGroupVersionListQuery,
} from "@blogmaatic/control-plane";
import { validatePublicationGroup, type PublicationRoute } from "@blogmaatic/core";

import type {
  PublicationGroupActivationBody,
  PublicationGroupCreateBody,
  PublicationGroupUpdateBody,
} from "./types.js";
import { OperatorRequestError } from "./validation.js";

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new OperatorRequestError(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownFields(input: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const permitted = new Set(allowed);
  const unknown = Object.keys(input).filter((key) => !permitted.has(key));
  if (unknown.length > 0) throw new OperatorRequestError(`${label} contains unknown field: ${unknown[0]}`);
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw new OperatorRequestError(`${key} is required`);
  return value;
}

function optionalBoolean(input: Record<string, unknown>, key: string): boolean | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new OperatorRequestError(`${key} must be a boolean`);
  return value;
}

function positiveInteger(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new OperatorRequestError(`${key} must be a positive integer`);
  }
  return value as number;
}

function routes(input: Record<string, unknown>): readonly PublicationRoute[] {
  if (!Array.isArray(input.routes)) throw new OperatorRequestError("routes must be an array");
  return input.routes as readonly PublicationRoute[];
}

function validateFields(name: string, policySetId: string, groupRoutes: readonly PublicationRoute[]): void {
  try {
    validatePublicationGroup({
      id: "request-validation",
      name,
      policySetId,
      routes: groupRoutes,
    });
  } catch (error) {
    throw new OperatorRequestError(error instanceof Error ? error.message : "Invalid publication group");
  }
}

export function parsePublicationGroupCreateBody(body: unknown): PublicationGroupCreateBody {
  const input = record(body, "request body");
  rejectUnknownFields(input, ["name", "policySetId", "routes", "enabled"], "request body");
  const name = requiredString(input, "name");
  const policySetId = requiredString(input, "policySetId");
  const groupRoutes = routes(input);
  const enabled = optionalBoolean(input, "enabled");
  validateFields(name, policySetId, groupRoutes);
  return {
    name,
    policySetId,
    routes: groupRoutes,
    ...(enabled === undefined ? {} : { enabled }),
  };
}

export function parsePublicationGroupUpdateBody(body: unknown): PublicationGroupUpdateBody {
  const input = record(body, "request body");
  rejectUnknownFields(
    input,
    ["expectedVersion", "name", "policySetId", "routes", "enabled"],
    "request body",
  );
  const expectedVersion = positiveInteger(input, "expectedVersion");
  const name = requiredString(input, "name");
  const policySetId = requiredString(input, "policySetId");
  const groupRoutes = routes(input);
  const enabled = optionalBoolean(input, "enabled");
  validateFields(name, policySetId, groupRoutes);
  return {
    expectedVersion,
    name,
    policySetId,
    routes: groupRoutes,
    ...(enabled === undefined ? {} : { enabled }),
  };
}

export function parsePublicationGroupActivationBody(body: unknown): PublicationGroupActivationBody {
  const input = record(body, "request body");
  rejectUnknownFields(input, ["expectedVersion", "enabled"], "request body");
  const expectedVersion = positiveInteger(input, "expectedVersion");
  if (typeof input.enabled !== "boolean") throw new OperatorRequestError("enabled must be a boolean");
  return { expectedVersion, enabled: input.enabled };
}

export function parsePublicationGroupListQuery(query: unknown): PublicationGroupListQuery {
  if (query === undefined || query === null) return {};
  const input = record(query, "query");
  rejectUnknownFields(input, ["limit", "cursor", "enabled"], "query");
  const result: { limit?: number; cursor?: string; enabled?: boolean } = {};
  if (input.limit !== undefined) {
    if (typeof input.limit !== "string" || !/^\d+$/.test(input.limit)) {
      throw new OperatorRequestError("limit must be an integer between 1 and 200");
    }
    const limit = Number(input.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new OperatorRequestError("limit must be an integer between 1 and 200");
    }
    result.limit = limit;
  }
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== "string" || !input.cursor.trim()) {
      throw new OperatorRequestError("cursor must be a non-empty string");
    }
    try {
      decodeCursor("publication-groups", input.cursor, 2);
    } catch {
      throw new OperatorRequestError("cursor is invalid for this resource");
    }
    result.cursor = input.cursor;
  }
  if (input.enabled !== undefined) {
    if (input.enabled === "true") result.enabled = true;
    else if (input.enabled === "false") result.enabled = false;
    else throw new OperatorRequestError("enabled must be true or false");
  }
  return result;
}

export function parsePublicationGroupVersionListQuery(query: unknown): PublicationGroupVersionListQuery {
  if (query === undefined || query === null) return {};
  const input = record(query, "query");
  rejectUnknownFields(input, ["limit", "cursor"], "query");
  const result: { limit?: number; cursor?: string } = {};
  if (input.limit !== undefined) {
    if (typeof input.limit !== "string" || !/^\d+$/.test(input.limit)) {
      throw new OperatorRequestError("limit must be an integer between 1 and 200");
    }
    const limit = Number(input.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new OperatorRequestError("limit must be an integer between 1 and 200");
    }
    result.limit = limit;
  }
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== "string" || !input.cursor.trim()) {
      throw new OperatorRequestError("cursor must be a non-empty string");
    }
    try {
      decodeCursor("publication-group-versions", input.cursor, 1);
    } catch {
      throw new OperatorRequestError("cursor is invalid for this resource");
    }
    result.cursor = input.cursor;
  }
  return result;
}
