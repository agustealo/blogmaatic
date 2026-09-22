import type {
  DeliveryReceipt,
  Publication,
  PublicationGroup,
  PublicationStatus,
} from "@blogmaatic/core";

export type AutomationTriggerDefinition =
  | { readonly kind: "manual" }
  | { readonly kind: "event"; readonly eventType: string }
  | { readonly kind: "schedule"; readonly scheduleId?: string };

export type AutomationRunTrigger =
  | {
      readonly kind: "manual";
      readonly initiatedBy: string;
      readonly commandId?: string;
      readonly occurredAt?: string;
    }
  | {
      readonly kind: "event";
      readonly eventType: string;
      readonly eventId: string;
      readonly occurredAt: string;
    }
  | {
      readonly kind: "schedule";
      readonly scheduleId: string;
      readonly fireId: string;
      readonly scheduledFor: string;
      readonly timezone: string;
      readonly occurredAt: string;
    };

export interface AutomationCondition {
  readonly statuses?: readonly PublicationStatus[];
  readonly tagsAll?: readonly string[];
  readonly tagsAny?: readonly string[];
}

export type AutomationBusinessFailurePolicy = "stop" | "continue";

export interface PublishGroupStep {
  readonly id: string;
  readonly kind: "publish_group";
  readonly groupId: string;
  readonly onBusinessFailure?: AutomationBusinessFailurePolicy;
}

export interface ApprovalStep {
  readonly id: string;
  readonly kind: "approval";
  readonly role: string;
  readonly prompt?: string;
}

export interface DelayStep {
  readonly id: string;
  readonly kind: "delay";
  readonly durationMs: number;
}

export type AutomationStep = PublishGroupStep | ApprovalStep | DelayStep;

export interface AutomationDefinition {
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly enabled: boolean;
  readonly trigger: AutomationTriggerDefinition;
  readonly conditions?: AutomationCondition;
  readonly steps: readonly AutomationStep[];
}

export interface AutomationRunRequest {
  readonly runId: string;
  readonly definition: AutomationDefinition;
  readonly trigger: AutomationRunTrigger;
  readonly publication: Publication;
  readonly groups: readonly PublicationGroup[];
}

export type AutomationApprovalDecision = "approve" | "reject";

export interface AutomationApproval {
  readonly runId: string;
  readonly stepId: string;
  readonly revisionId: string;
  readonly role: string;
  readonly approvedBy: string;
  readonly decision: AutomationApprovalDecision;
  readonly decidedAt: string;
  readonly note?: string;
}

export interface AutomationApprovalResponse {
  readonly accepted: boolean;
  readonly reason?: string;
}

export type AutomationRunPhase =
  | "running"
  | "waiting_approval"
  | "delaying"
  | "completed"
  | "stopped"
  | "rejected";

export interface AutomationExpectedApproval {
  readonly stepId: string;
  readonly role: string;
  readonly revisionId: string;
}

export interface AutomationRunStatus {
  readonly runId: string;
  readonly automationId: string;
  readonly automationVersion: number;
  readonly publicationId: string;
  readonly revisionId: string;
  readonly phase: AutomationRunPhase;
  readonly completedStepIds: readonly string[];
  readonly currentStepId?: string;
  readonly expectedApproval?: AutomationExpectedApproval;
  readonly detail?: string;
  readonly updatedAt: string;
}

export interface PublishGroupStepResult {
  readonly stepId: string;
  readonly kind: "publish_group";
  readonly groupId: string;
  readonly outcome: "verified" | "business_failure";
  readonly receipts: readonly DeliveryReceipt[];
}

export interface ApprovalStepResult {
  readonly stepId: string;
  readonly kind: "approval";
  readonly outcome: "approved" | "rejected";
  readonly approval: AutomationApproval;
}

export interface DelayStepResult {
  readonly stepId: string;
  readonly kind: "delay";
  readonly outcome: "completed";
  readonly durationMs: number;
}

export type AutomationStepResult =
  | PublishGroupStepResult
  | ApprovalStepResult
  | DelayStepResult;

export interface AutomationRunResult {
  readonly runId: string;
  readonly automationId: string;
  readonly publicationId: string;
  readonly revisionId: string;
  readonly outcome: "completed" | "stopped" | "rejected";
  readonly stepResults: readonly AutomationStepResult[];
  readonly completedAt: string;
  readonly detail?: string;
}
