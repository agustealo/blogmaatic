import type { RemoteIdentity } from "./types.js";

export interface ProjectionStateRecord {
  readonly publicationId: string;
  readonly routeId: string;
  readonly projectionId: string;
  readonly extensionId: string;
  readonly connectionId: string;
  readonly sourceRevisionId: string;
  readonly desiredFingerprint: string;
  readonly remote: RemoteIdentity;
  readonly updatedAt: string;
}

export interface ProjectionStateStore {
  get(publicationId: string, routeId: string): Promise<ProjectionStateRecord | undefined>;
  put(record: ProjectionStateRecord): Promise<void>;
  delete(publicationId: string, routeId: string): Promise<void>;
}

export class InMemoryProjectionStateStore implements ProjectionStateStore {
  readonly #records = new Map<string, ProjectionStateRecord>();

  #key(publicationId: string, routeId: string): string {
    return `${publicationId}\u0000${routeId}`;
  }

  async get(publicationId: string, routeId: string): Promise<ProjectionStateRecord | undefined> {
    return this.#records.get(this.#key(publicationId, routeId));
  }

  async put(record: ProjectionStateRecord): Promise<void> {
    this.#records.set(this.#key(record.publicationId, record.routeId), Object.freeze({ ...record }));
  }

  async delete(publicationId: string, routeId: string): Promise<void> {
    this.#records.delete(this.#key(publicationId, routeId));
  }
}
