import { ExtensionRegistry, type PublisherExtension } from "./extension.js";
import { PolicyEngine } from "./policy.js";
import {
  InMemoryProjectionStateStore,
  type ProjectionStateStore,
} from "./projection-state.js";
import type {
  ApprovalGrant,
  CompiledProjection,
  DeliveryReceipt,
  DeliveryRequest,
  ObservedProjection,
  PolicyDecision,
  Publication,
  PublicationGroup,
  PublicationRoute,
  ReconciliationAction,
  ReconciliationItem,
  ReconciliationReport,
  RemoteIdentity,
} from "./types.js";

export interface KernelClock {
  now(): string;
}

const systemClock: KernelClock = {
  now: () => new Date().toISOString(),
};

export interface PublishInput {
  readonly publication: Publication;
  readonly group: PublicationGroup;
  readonly approvals?: readonly ApprovalGrant[];
}

function projectionId(publication: Publication, route: PublicationRoute): string {
  return `${publication.id}:${route.id}`;
}

export function deliveryIdempotencyKey(
  publication: Publication,
  route: PublicationRoute,
  projection: CompiledProjection,
): string {
  return [
    "publication",
    encodeURIComponent(publication.id),
    encodeURIComponent(publication.current.id),
    encodeURIComponent(route.id),
    encodeURIComponent(projection.fingerprint),
  ].join(":");
}

function approvalSatisfied(
  policy: PolicyDecision,
  publication: Publication,
  route: PublicationRoute,
  approvals: readonly ApprovalGrant[],
): boolean {
  if (policy.effect !== "require_approval") {
    return true;
  }

  return approvals.some(
    (grant) =>
      grant.routeId === route.id &&
      grant.role === policy.approvalRole &&
      grant.approvedRevisionId === publication.current.id,
  );
}

async function actionForObservation(
  extension: PublisherExtension,
  projection: CompiledProjection,
  observed: ObservedProjection,
): Promise<{ action: ReconciliationAction; reason: string }> {
  if (observed.state === "missing") {
    return { action: "create", reason: "Remote projection is missing" };
  }
  if (observed.state === "unreachable") {
    return {
      action: "blocked",
      reason: observed.detail ?? "Remote projection cannot currently be reconciled",
    };
  }
  if (observed.fingerprint === projection.fingerprint && observed.state === "synchronized") {
    return {
      action: "none",
      reason: "Remote projection matches the desired source revision",
    };
  }
  if (extension.planDriftReconciliation) {
    const plan = await extension.planDriftReconciliation({ projection, observed });
    return { action: plan.action, reason: plan.reason };
  }
  return {
    action: "update",
    reason: "Remote projection differs from the desired source revision",
  };
}

export class PublicationKernel {
  readonly #extensions: ExtensionRegistry;
  readonly #policies: PolicyEngine;
  readonly #clock: KernelClock;
  readonly #projectionState: ProjectionStateStore;

  constructor(
    extensions: ExtensionRegistry,
    policies: PolicyEngine,
    clock: KernelClock = systemClock,
    projectionState: ProjectionStateStore = new InMemoryProjectionStateStore(),
  ) {
    this.#extensions = extensions;
    this.#policies = policies;
    this.#clock = clock;
    this.#projectionState = projectionState;
  }

  async #knownRemote(publication: Publication, route: PublicationRoute): Promise<RemoteIdentity | undefined> {
    const record = await this.#projectionState.get(publication.id, route.id);
    if (!record) return undefined;
    if (
      record.extensionId !== route.destination.extensionId ||
      record.connectionId !== route.destination.connectionId
    ) {
      return undefined;
    }
    return record.remote;
  }

  async #remember(
    publication: Publication,
    route: PublicationRoute,
    projection: CompiledProjection,
    remote: RemoteIdentity,
  ): Promise<void> {
    await this.#projectionState.put({
      publicationId: publication.id,
      routeId: route.id,
      projectionId: projection.projectionId,
      extensionId: route.destination.extensionId,
      connectionId: route.destination.connectionId,
      sourceRevisionId: publication.current.id,
      desiredFingerprint: projection.fingerprint,
      remote,
      updatedAt: this.#clock.now(),
    });
  }

  async reconcile(publication: Publication, group: PublicationGroup): Promise<ReconciliationReport> {
    const items: ReconciliationItem[] = [];

    for (const route of group.routes.filter((candidate) => candidate.enabled)) {
      const extension = this.#extensions.getPublisher(route.destination.extensionId);
      this.#extensions.assertCapabilities(route.destination.extensionId, route.requiredCapabilities);

      const policy = this.#policies.evaluate(group.policySetId, publication, route);
      const id = projectionId(publication, route);

      if (policy.effect === "deny") {
        items.push({
          routeId: route.id,
          projectionId: id,
          action: "blocked",
          policy,
          observed: {
            state: "unreachable",
            observedAt: this.#clock.now(),
            detail: "Inspection skipped because policy denied the route",
          },
          reason: policy.reason,
        });
        continue;
      }

      const projection = await extension.compile({ publication, route });
      const knownRemote = await this.#knownRemote(publication, route);
      const observed = await extension.inspect({
        projection,
        ...(knownRemote ? { remote: knownRemote } : {}),
      });
      if (observed.state === "missing" && knownRemote) {
        await this.#projectionState.delete(publication.id, route.id);
      } else if (observed.remote) {
        await this.#remember(publication, route, projection, observed.remote);
      }
      const plan = await actionForObservation(extension, projection, observed);

      items.push({
        routeId: route.id,
        projectionId: projection.projectionId,
        action: plan.action,
        policy,
        observed,
        desiredFingerprint: projection.fingerprint,
        reason: plan.reason,
      });
    }

    return {
      publicationId: publication.id,
      revisionId: publication.current.id,
      groupId: group.id,
      generatedAt: this.#clock.now(),
      items,
    };
  }

  async publish(input: PublishInput): Promise<readonly DeliveryReceipt[]> {
    const approvals = input.approvals ?? [];
    const receipts: DeliveryReceipt[] = [];

    for (const route of input.group.routes.filter((candidate) => candidate.enabled)) {
      const extension = this.#extensions.getPublisher(route.destination.extensionId);
      this.#extensions.assertCapabilities(route.destination.extensionId, route.requiredCapabilities);
      const policy = this.#policies.evaluate(input.group.policySetId, input.publication, route);
      const id = projectionId(input.publication, route);

      if (policy.effect === "deny") {
        receipts.push({
          publicationId: input.publication.id,
          revisionId: input.publication.current.id,
          groupId: input.group.id,
          routeId: route.id,
          projectionId: id,
          status: "blocked",
          policy,
          completedAt: this.#clock.now(),
        });
        continue;
      }

      if (!approvalSatisfied(policy, input.publication, route, approvals)) {
        receipts.push({
          publicationId: input.publication.id,
          revisionId: input.publication.current.id,
          groupId: input.group.id,
          routeId: route.id,
          projectionId: id,
          status: "awaiting_approval",
          policy,
          completedAt: this.#clock.now(),
        });
        continue;
      }

      const projection = await extension.compile({ publication: input.publication, route });
      const idempotencyKey = deliveryIdempotencyKey(input.publication, route, projection);
      const knownRemote = await this.#knownRemote(input.publication, route);
      const before = await extension.inspect({
        projection,
        ...(knownRemote ? { remote: knownRemote } : {}),
      });

      if (before.state === "missing" && knownRemote) {
        await this.#projectionState.delete(input.publication.id, route.id);
      } else if (before.remote) {
        await this.#remember(input.publication, route, projection, before.remote);
      }

      if (before.state === "unreachable") {
        receipts.push({
          publicationId: input.publication.id,
          revisionId: input.publication.current.id,
          groupId: input.group.id,
          routeId: route.id,
          projectionId: projection.projectionId,
          idempotencyKey,
          status: "unreachable",
          policy,
          ...(before.remote ? { remote: before.remote } : {}),
          observed: before,
          completedAt: this.#clock.now(),
        });
        continue;
      }

      if (before.state === "synchronized" && before.fingerprint === projection.fingerprint) {
        if (before.remote) await this.#remember(input.publication, route, projection, before.remote);
        receipts.push({
          publicationId: input.publication.id,
          revisionId: input.publication.current.id,
          groupId: input.group.id,
          routeId: route.id,
          projectionId: projection.projectionId,
          idempotencyKey,
          status: "verified",
          policy,
          ...(before.remote ? { remote: before.remote } : {}),
          observed: before,
          completedAt: this.#clock.now(),
        });
        continue;
      }

      if (before.state === "missing") {
        this.#extensions.assertCapabilities(route.destination.extensionId, ["article.create"]);
      } else {
        const plan = await actionForObservation(extension, projection, before);
        if (plan.action === "blocked") {
          receipts.push({
            publicationId: input.publication.id,
            revisionId: input.publication.current.id,
            groupId: input.group.id,
            routeId: route.id,
            projectionId: projection.projectionId,
            idempotencyKey,
            status: "blocked",
            policy,
            ...(before.remote ? { remote: before.remote } : {}),
            observed: before,
            evidence: { reason: plan.reason },
            completedAt: this.#clock.now(),
          });
          continue;
        }
        this.#extensions.assertCapabilities(route.destination.extensionId, ["article.update"]);
      }

      const request: DeliveryRequest = {
        idempotencyKey,
        projection,
        ...(before.remote ? { existingRemote: before.remote } : {}),
      };
      const delivered = await extension.deliver(request);
      await this.#remember(input.publication, route, projection, delivered.remote);
      const observed = await extension.inspect({ projection, remote: delivered.remote });
      if (observed.remote) await this.#remember(input.publication, route, projection, observed.remote);

      const status =
        observed.state === "unreachable"
          ? "unreachable"
          : observed.state === "synchronized" && observed.fingerprint === projection.fingerprint
            ? "verified"
            : "drifted";

      receipts.push({
        publicationId: input.publication.id,
        revisionId: input.publication.current.id,
        groupId: input.group.id,
        routeId: route.id,
        projectionId: projection.projectionId,
        idempotencyKey,
        status,
        policy,
        remote: delivered.remote,
        evidence: delivered.evidence,
        observed,
        completedAt: this.#clock.now(),
      });
    }

    return receipts;
  }
}
