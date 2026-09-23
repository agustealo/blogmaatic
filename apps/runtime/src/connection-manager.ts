import { randomUUID } from "node:crypto";

import type { JsonValue } from "@blogmaatic/core";
import {
  type ConnectionContract,
  ConnectionAuthority,
  type ConnectionRecord,
  type ConnectionSettingField,
  type ConnectionStatus,
  type ConnectionValidation,
  type ExtensionHealth,
  ExtensionRuntime,
  type PublisherConnectionType,
} from "@blogmaatic/extension-sdk";
import { SecretAuthority } from "@blogmaatic/secrets";

import {
  type RuntimeConfig,
  writeRuntimeConfig,
} from "./config.js";

export interface ConnectionView {
  readonly id: string;
  readonly extensionId: string;
  readonly displayName: string;
  readonly status: ConnectionStatus;
  readonly settings: Readonly<Record<string, JsonValue>>;
  readonly configuredSecrets: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateConnectionInput {
  readonly extensionId: string;
  readonly displayName: string;
  readonly status?: ConnectionStatus;
  readonly settings: Readonly<Record<string, JsonValue>>;
  readonly secrets?: Readonly<Record<string, string>>;
}

export interface UpdateConnectionInput {
  readonly displayName?: string;
  readonly status?: ConnectionStatus;
  readonly settings?: Readonly<Record<string, JsonValue>>;
  readonly secrets?: Readonly<Record<string, string>>;
}

export interface ConnectionTestResult {
  readonly validation: ConnectionValidation;
  readonly health?: ExtensionHealth;
}

export interface ConnectionManagerOptions {
  readonly config: RuntimeConfig;
  readonly configPath: string;
  readonly connections: ConnectionAuthority;
  readonly extensions: ExtensionRuntime;
  readonly secrets: SecretAuthority;
  readonly writeConfig?: (path: string, config: RuntimeConfig) => Promise<void>;
  readonly now?: () => string;
  readonly createId?: () => string;
  readonly removalGuard?: (connection: ConnectionRecord) => Promise<void> | void;
  readonly logger?: Pick<Console, "error">;
}

function requireDisplayName(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("Connection displayName is required");
  if (normalized.length > 120) throw new Error("Connection displayName must not exceed 120 characters");
  return normalized;
}

function validateStatus(value: ConnectionStatus): ConnectionStatus {
  if (value !== "active" && value !== "disabled") {
    throw new Error("Connection status must be active or disabled");
  }
  return value;
}

function validateSetting(field: ConnectionSettingField, value: JsonValue): void {
  switch (field.kind) {
    case "text":
    case "email":
    case "path":
      if (typeof value !== "string" || (field.required && !value.trim())) {
        throw new Error(`${field.label} must be a non-empty string`);
      }
      return;
    case "url": {
      if (typeof value !== "string" || (field.required && !value.trim())) {
        throw new Error(`${field.label} must be a non-empty URL`);
      }
      try {
        new URL(value);
      } catch {
        throw new Error(`${field.label} must be a valid URL`);
      }
      return;
    }
    case "integer":
      if (!Number.isSafeInteger(value)) throw new Error(`${field.label} must be an integer`);
      if (field.min !== undefined && (value as number) < field.min) {
        throw new Error(`${field.label} must be at least ${field.min}`);
      }
      if (field.max !== undefined && (value as number) > field.max) {
        throw new Error(`${field.label} must be at most ${field.max}`);
      }
      return;
    case "boolean":
      if (typeof value !== "boolean") throw new Error(`${field.label} must be true or false`);
      return;
    case "select": {
      if (typeof value !== "string") throw new Error(`${field.label} must be a string option`);
      const allowed = new Set((field.options ?? []).map((option) => option.value));
      if (!allowed.has(value)) throw new Error(`${field.label} contains an unsupported option`);
      return;
    }
    case "string-list":
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
        throw new Error(`${field.label} must contain only non-empty strings`);
      }
      return;
  }
}

function validateInputAgainstContract(
  contract: ConnectionContract,
  settings: Readonly<Record<string, JsonValue>>,
  suppliedSecrets: Readonly<Record<string, string>>,
  existingSecretRefs: Readonly<Record<string, string>> = {},
): void {
  const settingFields = new Map(contract.settingsFields.map((field) => [field.key, field] as const));
  const secretFields = new Map(contract.secretFields.map((field) => [field.key, field] as const));

  for (const key of Object.keys(settings)) {
    if (!settingFields.has(key)) throw new Error(`Unknown connection setting: ${key}`);
  }
  for (const field of contract.settingsFields) {
    const value = settings[field.key];
    if (value === undefined) {
      if (field.required) throw new Error(`${field.label} is required`);
      continue;
    }
    validateSetting(field, value);
  }

  for (const key of Object.keys(suppliedSecrets)) {
    if (!secretFields.has(key)) throw new Error(`Unknown connection secret: ${key}`);
  }
  for (const field of contract.secretFields) {
    const supplied = suppliedSecrets[field.key];
    if (supplied !== undefined && !supplied) throw new Error(`${field.label} must not be empty`);
    if (field.required && supplied === undefined && !existingSecretRefs[field.key]) {
      throw new Error(`${field.label} is required`);
    }
  }
}

function view(connection: ConnectionRecord): ConnectionView {
  return {
    id: connection.id,
    extensionId: connection.extensionId,
    displayName: connection.displayName,
    status: connection.status,
    settings: connection.settings,
    configuredSecrets: Object.keys(connection.secretRefs).sort(),
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

function managedVaultReference(connectionId: string, field: string): string {
  return `vault:connection/${connectionId}/${field}/${randomUUID()}`;
}

function isManagerOwnedVaultReference(reference: string): boolean {
  return reference.startsWith("vault:connection/");
}

export class ConnectionManager {
  readonly #configPath: string;
  readonly #connections: ConnectionAuthority;
  readonly #extensions: ExtensionRuntime;
  readonly #secrets: SecretAuthority;
  readonly #writeConfig: (path: string, config: RuntimeConfig) => Promise<void>;
  readonly #now: () => string;
  readonly #createId: () => string;
  readonly #removalGuard: ((connection: ConnectionRecord) => Promise<void> | void) | undefined;
  readonly #logger: Pick<Console, "error">;
  #config: RuntimeConfig;
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(options: ConnectionManagerOptions) {
    this.#config = options.config;
    this.#configPath = options.configPath;
    this.#connections = options.connections;
    this.#extensions = options.extensions;
    this.#secrets = options.secrets;
    this.#writeConfig = options.writeConfig ?? writeRuntimeConfig;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#createId = options.createId ?? (() => `connection_${randomUUID()}`);
    this.#removalGuard = options.removalGuard;
    this.#logger = options.logger ?? console;
  }

  listTypes(): readonly PublisherConnectionType[] {
    return this.#extensions.listConnectionTypes();
  }

  list(): readonly ConnectionView[] {
    return this.#connections.list().map(view);
  }

  get(connectionId: string): ConnectionView {
    return view(this.#connections.get(connectionId));
  }

  async create(input: CreateConnectionInput): Promise<ConnectionView> {
    return this.#exclusive(async () => {
      const extensionId = input.extensionId.trim();
      if (!extensionId) throw new Error("Connection extensionId is required");
      this.#extensions.getPublisher(extensionId);
      const contract = this.#extensions.getConnectionContract(extensionId);
      const suppliedSecrets = input.secrets ?? {};
      validateInputAgainstContract(contract, input.settings, suppliedSecrets);
      const id = this.#createId();
      if (!id.trim() || this.#connections.has(id)) throw new Error("Generated connection id is invalid or already in use");
      const now = this.#now();
      const staged = await this.#stageSecrets(id, suppliedSecrets);
      const candidate: ConnectionRecord = {
        id,
        extensionId,
        displayName: requireDisplayName(input.displayName),
        status: validateStatus(input.status ?? "active"),
        settings: { ...input.settings },
        secretRefs: staged.refs,
        createdAt: now,
        updatedAt: now,
      };
      try {
        await this.#requireStructurallyValid(candidate);
        this.#connections.register(candidate);
        try {
          await this.#persistConnections();
        } catch (error) {
          this.#connections.remove(candidate.id);
          throw error;
        }
        return view(this.#connections.get(candidate.id));
      } catch (error) {
        await this.#cleanupReferences(staged.created, "new connection rollback");
        throw error;
      }
    });
  }

  async update(connectionId: string, input: UpdateConnectionInput): Promise<ConnectionView> {
    return this.#exclusive(async () => {
      const existing = this.#connections.get(connectionId);
      const contract = this.#extensions.getConnectionContract(existing.extensionId);
      const settings = input.settings ?? existing.settings;
      const suppliedSecrets = input.secrets ?? {};
      validateInputAgainstContract(contract, settings, suppliedSecrets, existing.secretRefs);
      const staged = await this.#stageSecrets(existing.id, suppliedSecrets);
      const nextSecretRefs = { ...existing.secretRefs, ...staged.refs };
      const candidate: ConnectionRecord = {
        ...existing,
        displayName: input.displayName === undefined ? existing.displayName : requireDisplayName(input.displayName),
        status: input.status === undefined ? existing.status : validateStatus(input.status),
        settings: { ...settings },
        secretRefs: nextSecretRefs,
        updatedAt: this.#now(),
      };
      try {
        await this.#requireStructurallyValid(candidate);
        this.#connections.replace(candidate);
        try {
          await this.#persistConnections();
        } catch (error) {
          this.#connections.replace(existing);
          throw error;
        }
      } catch (error) {
        await this.#cleanupReferences(staged.created, "connection update rollback");
        throw error;
      }

      const replaced = Object.keys(staged.refs)
        .map((key) => existing.secretRefs[key])
        .filter((reference): reference is string => Boolean(reference) && isManagerOwnedVaultReference(reference));
      await this.#cleanupReferences(replaced, "superseded connection credential");
      return view(this.#connections.get(connectionId));
    });
  }

  async remove(connectionId: string): Promise<ConnectionView> {
    return this.#exclusive(async () => {
      const existing = this.#connections.get(connectionId);
      await this.#removalGuard?.(existing);
      this.#connections.remove(connectionId);
      try {
        await this.#persistConnections();
      } catch (error) {
        this.#connections.register(existing);
        throw error;
      }
      await this.#cleanupReferences(
        Object.values(existing.secretRefs).filter(isManagerOwnedVaultReference),
        "removed connection credential",
      );
      return view(existing);
    });
  }

  async test(connectionId: string): Promise<ConnectionTestResult> {
    const validation = await this.#extensions.validateConnection(connectionId);
    if (!validation.valid) return { validation };
    return { validation, health: await this.#extensions.checkHealth(connectionId) };
  }

  async #stageSecrets(
    connectionId: string,
    values: Readonly<Record<string, string>>,
  ): Promise<{ readonly refs: Readonly<Record<string, string>>; readonly created: readonly string[] }> {
    const keys = Object.keys(values);
    if (keys.length === 0) return { refs: {}, created: [] };
    if (!this.#secrets.hasProvider("vault")) {
      throw new Error("The OS credential vault is unavailable on this runtime");
    }
    const refs: Record<string, string> = {};
    const created: string[] = [];
    try {
      for (const key of keys) {
        const reference = managedVaultReference(connectionId, key);
        await this.#secrets.storeUtf8(reference, values[key]!);
        refs[key] = reference;
        created.push(reference);
      }
      return { refs, created };
    } catch (error) {
      await this.#cleanupReferences(created, "credential staging rollback");
      throw error;
    }
  }

  async #requireStructurallyValid(connection: ConnectionRecord): Promise<void> {
    const validation = await this.#extensions.validateConnectionRecord(connection);
    if (!validation.valid) {
      throw new Error(`Connection is invalid: ${validation.errors.join("; ")}`);
    }
  }

  async #persistConnections(): Promise<void> {
    const next: RuntimeConfig = {
      ...this.#config,
      connections: this.#connections.list(),
    };
    await this.#writeConfig(this.#configPath, next);
    this.#config = next;
  }

  async #cleanupReferences(references: readonly string[], context: string): Promise<void> {
    for (const reference of references) {
      try {
        await this.#secrets.delete(reference);
      } catch {
        this.#logger.error(`Failed to delete ${context}; vault locator redacted`);
      }
    }
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#mutationTail.then(operation, operation);
    this.#mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }
}
