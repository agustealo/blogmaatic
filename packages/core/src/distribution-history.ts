import type {
  DeliveryReceipt,
  DestinationRef,
  PublicationGroup,
} from "./types.js";

export interface DistributionHistoryRecord {
  readonly id: string;
  readonly runId?: string;
  readonly publicationId: string;
  readonly revisionId: string;
  readonly groupId: string;
  readonly routeId: string;
  readonly projectionId: string;
  readonly destination: DestinationRef;
  readonly groupSnapshot: PublicationGroup;
  readonly receipt: DeliveryReceipt;
  readonly recordedAt: string;
}

export interface DistributionHistoryQuery {
  readonly revisionId?: string;
  readonly routeId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface DistributionHistoryPage {
  readonly items: readonly DistributionHistoryRecord[];
  readonly nextCursor?: string;
}

export interface DistributionHistoryStore {
  append(record: DistributionHistoryRecord): Promise<void>;
  list(
    publicationId: string,
    query?: DistributionHistoryQuery,
  ): Promise<DistributionHistoryPage>;
}

function queryLimit(value: number | undefined): number {
  if (value === undefined) return 50;
  if (!Number.isSafeInteger(value) || value < 1 || value > 200) {
    throw new Error("Distribution history limit must be an integer from 1 through 200");
  }
  return value;
}

export class InMemoryDistributionHistoryStore implements DistributionHistoryStore {
  readonly #records = new Map<string, DistributionHistoryRecord>();

  async append(record: DistributionHistoryRecord): Promise<void> {
    if (!record.id.trim()) throw new Error("Distribution history id is required");
    const existing = this.#records.get(record.id);
    if (existing) return;
    this.#records.set(record.id, Object.freeze({
      ...record,
      destination: Object.freeze({ ...record.destination }),
      groupSnapshot: Object.freeze({
        ...record.groupSnapshot,
        routes: Object.freeze([...record.groupSnapshot.routes]),
      }),
      receipt: Object.freeze({ ...record.receipt }),
    }));
  }

  async list(
    publicationId: string,
    query: DistributionHistoryQuery = {},
  ): Promise<DistributionHistoryPage> {
    if (!publicationId.trim()) throw new Error("Publication id is required");
    const limit = queryLimit(query.limit);
    const ordered = [...this.#records.values()]
      .filter((record) =>
        record.publicationId === publicationId &&
        (!query.revisionId || record.revisionId === query.revisionId) &&
        (!query.routeId || record.routeId === query.routeId),
      )
      .sort((left, right) =>
        right.recordedAt.localeCompare(left.recordedAt) || right.id.localeCompare(left.id),
      );
    const start = query.cursor
      ? Math.max(0, ordered.findIndex((record) => record.id === query.cursor) + 1)
      : 0;
    const items = ordered.slice(start, start + limit);
    const hasMore = start + limit < ordered.length;
    const tail = items.at(-1);
    return {
      items,
      ...(hasMore && tail ? { nextCursor: tail.id } : {}),
    };
  }
}
