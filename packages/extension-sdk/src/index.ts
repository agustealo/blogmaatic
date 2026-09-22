import {
  ExtensionRegistry,
  type JsonValue,
  type PublisherExtension,
  type PublisherExtensionManifest,
} from "@blogmaatic/core";

export type ConnectionStatus = "active" | "disabled";
export type ExtensionHealthState = "healthy" | "degraded" | "unhealthy";

export interface ConnectionRecord {
  readonly id: string;
  readonly extensionId: string;
  readonly displayName: string;
  readonly status: ConnectionStatus;
  readonly settings: Readonly<Record<string, JsonValue>>;
  readonly secretRefs: Readonly<Record<string, string>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConnectionValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export interface ExtensionHealth {
  readonly state: ExtensionHealthState;
  readonly checkedAt: string;
  readonly detail: string;
  readonly evidence?: Readonly<Record<string, JsonValue>>;
}

export interface ManagedPublisherExtensionManifest extends PublisherExtensionManifest {
  readonly apiVersion: 1;
  readonly kind: "publisher";
  readonly connectionSchemaVersion: 1;
}

export interface ManagedPublisherExtension extends PublisherExtension {
  readonly manifest: ManagedPublisherExtensionManifest;
  validateConnection(connection: ConnectionRecord): Promise<ConnectionValidation>;
  checkHealth(connection: ConnectionRecord): Promise<ExtensionHealth>;
}

function validateManifest(manifest: ManagedPublisherExtensionManifest): void {
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(manifest.id)) {
    throw new Error(`Extension id must be namespaced and lowercase: ${manifest.id}`);
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new Error(`Extension version must be semantic: ${manifest.version}`);
  }
  if (
    manifest.apiVersion !== 1 ||
    manifest.kind !== "publisher" ||
    manifest.connectionSchemaVersion !== 1
  ) {
    throw new Error(`Unsupported extension manifest contract: ${manifest.id}`);
  }
  if (new Set(manifest.capabilities).size !== manifest.capabilities.length) {
    throw new Error(`Extension declares duplicate capabilities: ${manifest.id}`);
  }
}

export class ConnectionAuthority {
  readonly #connections = new Map<string, ConnectionRecord>();

  constructor(initial: readonly ConnectionRecord[] = []) {
    for (const connection of initial) this.register(connection);
  }

  register(connection: ConnectionRecord): void {
    if (this.#connections.has(connection.id)) {
      throw new Error(`Connection already registered: ${connection.id}`);
    }
    if (!connection.id.trim() || !connection.extensionId.trim() || !connection.displayName.trim()) {
      throw new Error("Connection id, extensionId, and displayName are required");
    }
    this.#connections.set(connection.id, Object.freeze({ ...connection }));
  }

  replace(connection: ConnectionRecord): void {
    const existing = this.#connections.get(connection.id);
    if (!existing) throw new Error(`Connection is not registered: ${connection.id}`);
    if (existing.extensionId !== connection.extensionId) {
      throw new Error(`Connection ${connection.id} cannot change extension ownership`);
    }
    this.#connections.set(connection.id, Object.freeze({ ...connection }));
  }

  get(connectionId: string): ConnectionRecord {
    const connection = this.#connections.get(connectionId);
    if (!connection) throw new Error(`Connection is not registered: ${connectionId}`);
    return connection;
  }

  requireActive(extensionId: string, connectionId: string): ConnectionRecord {
    const connection = this.get(connectionId);
    if (connection.extensionId !== extensionId) {
      throw new Error(
        `Connection ${connectionId} belongs to ${connection.extensionId}, not ${extensionId}`,
      );
    }
    if (connection.status !== "active") {
      throw new Error(`Connection is disabled: ${connectionId}`);
    }
    return connection;
  }

  list(extensionId?: string): readonly ConnectionRecord[] {
    return [...this.#connections.values()].filter(
      (connection) => !extensionId || connection.extensionId === extensionId,
    );
  }
}

export class ExtensionRuntime {
  readonly publishers = new ExtensionRegistry();
  readonly connections: ConnectionAuthority;
  readonly #managed = new Map<string, ManagedPublisherExtension>();

  constructor(connections: ConnectionAuthority = new ConnectionAuthority()) {
    this.connections = connections;
  }

  registerPublisher(extension: ManagedPublisherExtension): void {
    validateManifest(extension.manifest);
    if (this.#managed.has(extension.manifest.id)) {
      throw new Error(`Managed publisher already registered: ${extension.manifest.id}`);
    }
    this.#managed.set(extension.manifest.id, extension);
    this.publishers.register(extension);
  }

  getPublisher(extensionId: string): ManagedPublisherExtension {
    const extension = this.#managed.get(extensionId);
    if (!extension) throw new Error(`Managed publisher is not registered: ${extensionId}`);
    return extension;
  }

  async validateConnection(connectionId: string): Promise<ConnectionValidation> {
    const connection = this.connections.get(connectionId);
    const extension = this.getPublisher(connection.extensionId);
    return extension.validateConnection(connection);
  }

  async checkHealth(connectionId: string): Promise<ExtensionHealth> {
    const connection = this.connections.get(connectionId);
    const extension = this.getPublisher(connection.extensionId);
    if (connection.status !== "active") {
      return {
        state: "unhealthy",
        checkedAt: new Date().toISOString(),
        detail: `Connection is disabled: ${connection.id}`,
      };
    }
    const validation = await extension.validateConnection(connection);
    if (!validation.valid) {
      return {
        state: "unhealthy",
        checkedAt: new Date().toISOString(),
        detail: validation.errors.join("; "),
      };
    }
    return extension.checkHealth(connection);
  }
}
