import type {
  ApprovalGrant,
  DeliveryReceipt,
  Publication,
  PublicationGroup,
} from "@blogmaatic/core";
import type { PublicationKernel } from "@blogmaatic/core";

import type { AutomationApproval } from "./types.js";

export interface PublishGroupInput {
  readonly publication: Publication;
  readonly group: PublicationGroup;
  readonly approvals: readonly ApprovalGrant[];
}

export interface AutomationPublisher {
  publishGroup(input: PublishGroupInput): Promise<readonly DeliveryReceipt[]>;
}

export function createKernelAutomationPublisher(kernel: PublicationKernel): AutomationPublisher {
  return {
    publishGroup: ({ publication, group, approvals }) =>
      kernel.publish({ publication, group, approvals }),
  };
}

export function approvalGrantsForGroup(
  group: PublicationGroup,
  publication: Publication,
  approvals: readonly AutomationApproval[],
): readonly ApprovalGrant[] {
  const approved = approvals.filter(
    (approval) =>
      approval.decision === "approve" && approval.revisionId === publication.current.id,
  );

  const grants: ApprovalGrant[] = [];
  for (const route of group.routes.filter((candidate) => candidate.enabled)) {
    for (const approval of approved) {
      grants.push({
        routeId: route.id,
        role: approval.role,
        approvedBy: approval.approvedBy,
        approvedRevisionId: approval.revisionId,
        approvedAt: approval.decidedAt,
      });
    }
  }
  return grants;
}
