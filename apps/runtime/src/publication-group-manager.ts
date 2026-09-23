import {
  type PublicationGroupListQuery,
  type PublicationGroupRegistryEntry,
  type PublicationGroupStore,
  type PublicationGroupVersionListQuery,
} from "@blogmaatic/control-plane";
import { validatePublicationGroup, type PublicationGroup } from "@blogmaatic/core";
import { ConnectionAuthority, ExtensionRuntime } from "@blogmaatic/extension-sdk";

export interface PublicationGroupManagerOptions {
  readonly store: PublicationGroupStore;
  readonly connections: ConnectionAuthority;
  readonly extensions: ExtensionRuntime;
  readonly now?: () => string;
}

export interface CreatePublicationGroupInput {
  readonly group: PublicationGroup;
  readonly enabled?: boolean;
}

export interface UpdatePublicationGroupInput {
  readonly group: PublicationGroup;
  readonly expectedVersion: number;
  readonly enabled?: boolean;
}

export class PublicationGroupManager {
  readonly #store: PublicationGroupStore;
  readonly #connections: ConnectionAuthority;
  readonly #extensions: ExtensionRuntime;
  readonly #now: () => string;

  constructor(options: PublicationGroupManagerOptions) {
    this.#store = options.store;
    this.#connections = options.connections;
    this.#extensions = options.extensions;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  list(query: PublicationGroupListQuery = {}) {
    return this.#store.listPublicationGroups(query);
  }

  get(groupId: string) {
    return this.#store.getActivePublicationGroup(groupId);
  }

  listVersions(groupId: string, query: PublicationGroupVersionListQuery = {}) {
    return this.#store.listPublicationGroupVersions(groupId, query);
  }

  getVersion(groupId: string, version: number) {
    return this.#store.getPublicationGroupVersion(groupId, version);
  }

  async create(input: CreatePublicationGroupInput): Promise<PublicationGroupRegistryEntry> {
    const enabled = input.enabled ?? true;
    this.#validateGroup(input.group, enabled);
    return this.#store.createPublicationGroup(input.group, enabled, this.#now());
  }

  async update(input: UpdatePublicationGroupInput): Promise<PublicationGroupRegistryEntry> {
    const current = await this.#store.getActivePublicationGroup(input.group.id);
    if (!current) throw new Error(`Publication group is not registered: ${input.group.id}`);
    const enabled = input.enabled ?? current.enabled;
    this.#validateGroup(input.group, enabled);
    return this.#store.updatePublicationGroup(
      input.group,
      input.expectedVersion,
      enabled,
      this.#now(),
    );
  }

  async setEnabled(
    groupId: string,
    expectedVersion: number,
    enabled: boolean,
  ): Promise<PublicationGroupRegistryEntry> {
    const current = await this.#store.getActivePublicationGroup(groupId);
    if (!current) throw new Error(`Publication group is not registered: ${groupId}`);
    if (enabled) this.#validateGroup(current.group, true);
    return this.#store.setPublicationGroupEnabled(groupId, expectedVersion, enabled, this.#now());
  }

  async assertConnectionRemovable(connectionId: string): Promise<void> {
    const references = await this.#store.listEnabledPublicationGroupsByConnection(connectionId);
    if (references.length === 0) return;
    const groups = references.map((entry) => entry.group.id).sort();
    throw new Error(
      `Connection ${connectionId} is referenced by enabled publication group${groups.length === 1 ? "" : "s"}: ${groups.join(", ")}`,
    );
  }

  #validateGroup(group: PublicationGroup, enabled: boolean): void {
    validatePublicationGroup(group);
    for (const route of group.routes) {
      const connection = this.#connections.get(route.destination.connectionId);
      if (connection.extensionId !== route.destination.extensionId) {
        throw new Error(
          `Publication route ${route.id} expects ${route.destination.extensionId} but connection ${connection.id} belongs to ${connection.extensionId}`,
        );
      }
      const publisher = this.#extensions.getPublisher(route.destination.extensionId);
      const supported = new Set<string>(publisher.manifest.capabilities);
      const missing = route.requiredCapabilities.filter((capability) => !supported.has(capability));
      if (missing.length > 0) {
        throw new Error(
          `Publication route ${route.id} requires unsupported capabilities from ${publisher.manifest.id}: ${missing.join(", ")}`,
        );
      }
      if (enabled && route.enabled && connection.status !== "active") {
        throw new Error(
          `Enabled publication route ${route.id} cannot use disabled connection ${connection.id}`,
        );
      }
    }
  }
}
