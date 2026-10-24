import type { DistributionHistoryRecord, DistributionHistoryStore } from "@blogmaatic/core";
import type {
  OperatorPublicationDestinationMatrixManager,
  PublicationDestinationMatrix,
  PublicationDestinationMatrixItem,
  PublicationDestinationMatrixState,
  PublicationProjectionPreviewItem,
} from "@blogmaatic/operator-api";

import type { PublicationGroupManager } from "./publication-group-manager.js";
import type { PublicationPreviewManager } from "./publication-preview-manager.js";
import type { PublicationWorkspaceManager } from "./publication-workspace-manager.js";

export interface PublicationDestinationMatrixManagerOptions {
  readonly publications: PublicationWorkspaceManager;
  readonly publicationGroups: PublicationGroupManager;
  readonly previews: PublicationPreviewManager;
  readonly distributions: DistributionHistoryStore;
  readonly now?: () => string;
}

function destinationKey(
  groupId: string,
  routeId: string,
  extensionId: string,
  connectionId: string,
  channel: string,
): string {
  return [groupId, routeId, extensionId, connectionId, channel].join("\u0000");
}

function stateFor(
  latest: DistributionHistoryRecord | undefined,
  currentRevisionId: string,
): PublicationDestinationMatrixState {
  if (!latest) return "not_sent";
  if (latest.receipt.status === "drifted") return "drifted";
  if (latest.receipt.status !== "verified") return "failed";
  return latest.revisionId === currentRevisionId ? "current" : "update_available";
}

function previewByRoute(
  items: readonly PublicationProjectionPreviewItem[],
): ReadonlyMap<string, PublicationProjectionPreviewItem> {
  const map = new Map<string, PublicationProjectionPreviewItem>();
  for (const item of items) map.set(item.routeId, item);
  return map;
}

export class PublicationDestinationMatrixManager implements OperatorPublicationDestinationMatrixManager {
  readonly #publications: PublicationWorkspaceManager;
  readonly #publicationGroups: PublicationGroupManager;
  readonly #previews: PublicationPreviewManager;
  readonly #distributions: DistributionHistoryStore;
  readonly #now: () => string;

  constructor(options: PublicationDestinationMatrixManagerOptions) {
    this.#publications = options.publications;
    this.#publicationGroups = options.publicationGroups;
    this.#previews = options.previews;
    this.#distributions = options.distributions;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async get(publicationId: string): Promise<PublicationDestinationMatrix> {
    const publicationEntry = await this.#publications.get(publicationId);
    if (!publicationEntry) throw new Error(`Publication is not registered: ${publicationId}`);

    const groups = [];
    let groupCursor: string | undefined;
    do {
      const page = await this.#publicationGroups.list({
        enabled: true,
        limit: 100,
        ...(groupCursor ? { cursor: groupCursor } : {}),
      });
      groups.push(...page.items);
      groupCursor = page.nextCursor;
    } while (groupCursor);

    const history: DistributionHistoryRecord[] = [];
    let historyCursor: string | undefined;
    do {
      const page = await this.#distributions.list(publicationId, {
        limit: 200,
        ...(historyCursor ? { cursor: historyCursor } : {}),
      });
      history.push(...page.items);
      historyCursor = page.nextCursor;
    } while (historyCursor);

    const latestByDestination = new Map<string, DistributionHistoryRecord>();
    const countByDestination = new Map<string, number>();
    for (const record of history) {
      const key = destinationKey(
        record.groupId,
        record.routeId,
        record.destination.extensionId,
        record.destination.connectionId,
        record.destination.channel,
      );
      countByDestination.set(key, (countByDestination.get(key) ?? 0) + 1);
      if (!latestByDestination.has(key)) latestByDestination.set(key, record);
    }

    const previews = new Map<string, ReadonlyMap<string, PublicationProjectionPreviewItem>>();
    const previewFailures = new Map<string, string>();
    await Promise.all(groups.map(async (entry) => {
      try {
        const preview = await this.#previews.preview(publicationId, entry.group.id);
        previews.set(entry.group.id, previewByRoute(preview.items));
      } catch (error) {
        previewFailures.set(
          entry.group.id,
          error instanceof Error ? error.message : "Destination preview could not be compiled",
        );
      }
    }));

    const currentRevisionId = publicationEntry.publication.current.id;
    const currentRevisionOrdinal = publicationEntry.publication.current.ordinal;
    const items: PublicationDestinationMatrixItem[] = [];

    for (const entry of groups) {
      const previewItems = previews.get(entry.group.id);
      for (const route of entry.group.routes) {
        if (!route.enabled) continue;
        const key = destinationKey(
          entry.group.id,
          route.id,
          route.destination.extensionId,
          route.destination.connectionId,
          route.destination.channel,
        );
        const latest = latestByDestination.get(key);
        const previewItem = previewItems?.get(route.id);
        const preview = previewItem?.status === "ready"
          ? {
            status: "ready" as const,
            projectionId: previewItem.projectionId,
            fingerprint: previewItem.fingerprint,
          }
          : {
            status: "error" as const,
            error: previewItem?.status === "error"
              ? previewItem.error
              : previewFailures.get(entry.group.id) ?? "Destination preview is unavailable",
          };
        const destination = previewItem?.destination ?? {
          extensionId: route.destination.extensionId,
          extensionName: route.destination.extensionId,
          connectionId: route.destination.connectionId,
          connectionName: route.destination.connectionId,
          channel: route.destination.channel,
        };
        items.push({
          key,
          groupId: entry.group.id,
          groupName: entry.group.name,
          groupVersion: entry.version,
          routeId: route.id,
          destination,
          state: stateFor(latest, currentRevisionId),
          currentRevisionId,
          currentRevisionOrdinal,
          deliveryCount: countByDestination.get(key) ?? 0,
          ...(latest ? {
            latestRevisionId: latest.revisionId,
            latestReceiptStatus: latest.receipt.status,
            latestRecordedAt: latest.recordedAt,
            latestProjectionId: latest.projectionId,
            ...(latest.receipt.remote ? { remote: latest.receipt.remote } : {}),
          } : {}),
          preview,
        });
      }
    }

    items.sort((left, right) =>
      left.groupName.localeCompare(right.groupName) ||
      left.destination.extensionName.localeCompare(right.destination.extensionName) ||
      left.destination.connectionName.localeCompare(right.destination.connectionName) ||
      left.routeId.localeCompare(right.routeId),
    );

    return {
      publicationId,
      currentRevisionId,
      currentRevisionOrdinal,
      generatedAt: this.#now(),
      items,
    };
  }
}
