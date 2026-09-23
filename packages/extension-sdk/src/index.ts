import {
  ExtensionRegistry,
  type ExtensionCapability,
  type JsonValue,
  type PublisherExtension,
  type PublisherExtensionManifest,
} from "@blogmaatic/core";

export type ConnectionStatus = "active" | "disabled";
export type ExtensionHealthState = "healthy" | "degraded" | "unhealthy";
export type ConnectionSettingFieldKind =
  | "text"
  | "url"
  | "email"
  | "integer"
  | "boolean"
  | "select"
  | "path"
  | "string-list";

export interface ConnectionSelectOption {
  readonly value: string;
  readonly label: string;
}

export interface ConnectionSettingField {
  readonly key: string;
  readonly label: string;
  readonly kind: ConnectionSettingFieldKind;
  readonly required?: boolean;
  readonly description?: string;
  readonly placeholder?: string;
  readonly defaultValue?: JsonValue;
  readonly min?: number;
  readonly max?: number;
  readonly options?: readonly ConnectionSelectOption[];
}

export interface ConnectionSecretField {
  readonly key: string;
  readonly label: string;
  readonly required?: boolean;
  readonly description?: string;
}

export interface DefaultPublicationRouteContract {
  readonly channel: string;
  readonly requiredCapabilities: readonly ExtensionCapability[];
  readonly variant?: Readonly<Record<string, JsonValue>>;
}

export interface ConnectionContract {
  readonly schemaVersion: 1;
  readonly settingsFields: readonly ConnectionSettingField[];
  readonly secretFields: readonly ConnectionSecretField[];
  readonly defaultRoute: DefaultPublicationRouteContract;
}

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

export interface PublisherConnectionType {
  readonly manifest: ManagedPublisherExtensionManifest;
  readonly connectionContract: ConnectionContract;
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

function validateFieldKey(key: string, label: string): void {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) {
    throw new Error(`${label} key must use lower/upper camel-case identifier characters: ${key}`);
  }
}

function validateConnectionContract(
  manifest: ManagedPublisherExtensionManifest,
  contract: ConnectionContract,
): void {
  if (contract.schemaVersion !== 1) {
    throw new Error(`Unsupported connection contract for ${manifest.id}`);
  }
  const keys = new Set<string>();
  for (const field of contract.settingsFields) {
    validateFieldKey(field.key, `${manifest.id} settings field`);
    if (!field.label.trim()) throw new Error(`${manifest.id} settings field ${field.key} requires a label`);
    if (keys.has(field.key)) throw new Error(`${manifest.id} connection field is duplicated: ${field.key}`);
    keys.add(field.key);
    if (field.kind === "select") {
      if (!field.options?.length) throw new Error(`${manifest.id} select field ${field.key} requires options`);
      const values = field.options.map((option) => option.value);
      if (values.some((value) => !value.trim()) || new Set(values).size !== values.length) {
        throw new Error(`${manifest.id} select field ${field.key} has invalid options`);
      }
    } else if (field.options !== undefined) {
      throw new Error(`${manifest.id} non-select field ${field.key} must not declare options`);
    }
    if ((field.min !== undefined || field.max !== undefined) && field.kind !== "integer") {
      throw new Error(`${manifest.id} field ${field.key} may use min/max only when kind is integer`);
    }
    if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
      throw new Error(`${manifest.id} field ${field.key} has min greater than max`);
    }
  }
  for (const field of contract.secretFields) {
    validateFieldKey(field.key, `${manifest.id} secret field`);
    if (!field.label.trim()) throw new Error(`${manifest.id} secret field ${field.key} requires a label`);
    if (keys.has(field.key)) throw new Error(`${manifest.id} connection field is duplicated: ${field.key}`);
    keys.add(field.key);
  }

  const route = contract.defaultRoute;
  if (!route.channel.trim()) throw new Error(`${manifest.id} default publication route requires a channel`);
  if (route.requiredCapabilities.length === 0) {
    throw new Error(`${manifest.id} default publication route requires at least one capability`);
  }
  if (new Set(route.requiredCapabilities).size !== route.requiredCapabilities.length) {
    throw new Error(`${manifest.id} default publication route declares duplicate capabilities`);
  }
  const available = new Set(manifest.capabilities);
  const missing = route.requiredCapabilities.filter((capability) => !available.has(capability));
  if (missing.length > 0) {
    throw new Error(`${manifest.id} default publication route requires undeclared capabilities: ${missing.join(", ")}`);
  }
  if (!route.requiredCapabilities.includes("article.create")) {
    throw new Error(`${manifest.id} default publication route must require article.create`);
  }
}

function freezeConnection(connection: ConnectionRecord): ConnectionRecord {
  return Object.freeze({
    ...connection,
    settings: Object.freeze({ ...connection.settings }),
    secretRefs: Object.freeze({ ...connection.secretRefs }),
  });
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
    this.#connections.set(connection.id, freezeConnection(connection));
  }

  replace(connection: ConnectionRecord): void {
    const existing = this.#connections.get(connection.id);
    if (!existing) throw new Error(`Connection is not registered: ${connection.id}`);
    if (existing.extensionId !== connection.extensionId) {
      throw new Error(`Connection ${connection.id} cannot change extension ownership`);
    }
    this.#connections.set(connection.id, freezeConnection(connection));
  }

  remove(connectionId: string): ConnectionRecord {
    const connection = this.get(connectionId);
    this.#connections.delete(connectionId);
    return connection;
  }

  has(connectionId: string): boolean {
    return this.#connections.has(connectionId);
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
  readonly #connectionContracts = new Map<string, ConnectionContract>();

  constructor(connections: ConnectionAuthority = new ConnectionAuthority()) {
    this.connections = connections;
  }

  registerPublisher(extension: ManagedPublisherExtension, connectionContract?: ConnectionContract): void {
    validateManifest(extension.manifest);
    if (this.#managed.has(extension.manifest.id)) {
      throw new Error(`Managed publisher already registered: ${extension.manifest.id}`);
    }
    if (connectionContract) {
      validateConnectionContract(extension.manifest, connectionContract);
      this.#connectionContracts.set(extension.manifest.id, Object.freeze({
        ...connectionContract,
        settingsFields: Object.freeze([...connectionContract.settingsFields]),
        secretFields: Object.freeze([...connectionContract.secretFields]),
        defaultRoute: Object.freeze({
          ...connectionContract.defaultRoute,
          requiredCapabilities: Object.freeze([...connectionContract.defaultRoute.requiredCapabilities]),
          ...(connectionContract.defaultRoute.variant
            ? { variant: Object.freeze({ ...connectionContract.defaultRoute.variant }) }
            : {}),
        }),
      }));
    }
    this.#managed.set(extension.manifest.id, extension);
    this.publishers.register(extension);
  }

  getPublisher(extensionId: string): ManagedPublisherExtension {
    const extension = this.#managed.get(extensionId);
    if (!extension) throw new Error(`Managed publisher is not registered: ${extensionId}`);
    return extension;
  }

  getConnectionContract(extensionId: string): ConnectionContract {
    this.getPublisher(extensionId);
    const contract = this.#connectionContracts.get(extensionId);
    if (!contract) throw new Error(`Publisher connection contract is not registered: ${extensionId}`);
    return contract;
  }

  listConnectionTypes(): readonly PublisherConnectionType[] {
    return [...this.#managed.values()].flatMap((extension) => {
      const connectionContract = this.#connectionContracts.get(extension.manifest.id);
      return connectionContract ? [{ manifest: extension.manifest, connectionContract }] : [];
    });
  }

  async validateConnectionRecord(connection: ConnectionRecord): Promise<ConnectionValidation> {
    const extension = this.getPublisher(connection.extensionId);
    return extension.validateConnection(connection);
  }

  async checkConnectionRecord(connection: ConnectionRecord): Promise<ExtensionHealth> {
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

  async validateConnection(connectionId: string): Promise<ConnectionValidation> {
    return this.validateConnectionRecord(this.connections.get(connectionId));
  }

  async checkHealth(connectionId: string): Promise<ExtensionHealth> {
    return this.checkConnectionRecord(this.connections.get(connectionId));
  }
}
