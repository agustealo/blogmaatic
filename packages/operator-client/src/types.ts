import type { AutomationApproval, AutomationRunResult } from "@blogmaatic/automation";
import type {
  AuditLedgerEntry,
  AuditListQuery,
  AutomationListQuery,
  AutomationRegistryEntry,
  AutomationSchedule,
  AutomationVersionListQuery,
  Page,
  RunListQuery,
  ScheduleListQuery,
  ControlPlaneRunRecord,
} from "@blogmaatic/control-plane";
import type {
  OperatorOperation,
  OperatorOperationKind,
  OperatorOperationsPage,
  OperatorOperationsQuery,
} from "@blogmaatic/operator-api";

export type {
  AuditLedgerEntry,
  AuditListQuery,
  AutomationApproval,
  AutomationListQuery,
  AutomationRegistryEntry,
  AutomationRunResult,
  AutomationSchedule,
  AutomationVersionListQuery,
  ControlPlaneRunRecord,
  OperatorOperation,
  OperatorOperationKind,
  OperatorOperationsPage,
  OperatorOperationsQuery,
  Page,
  RunListQuery,
  ScheduleListQuery,
};

export interface OperatorHealth {
  readonly status: "ok";
  readonly service: string;
}

export interface ApprovalDecisionInput {
  readonly decision: "approve" | "reject";
  readonly note?: string;
}

export interface ApprovalDecisionResponse {
  readonly accepted: boolean;
  readonly approval: AutomationApproval;
}

export interface ActivationInput {
  readonly enabled: boolean;
}

export interface SchedulerDispatchInput {
  readonly now?: string;
  readonly limit?: number;
}

export interface ScheduleDispatchSummary {
  readonly scheduleId: string;
  readonly scheduledFor: string;
  readonly outcome: "started" | "skipped" | "launch_failed" | "disabled";
  readonly detail?: string;
  readonly run?: ControlPlaneRunRecord;
}

export interface SchedulerDispatchResponse {
  readonly results: readonly ScheduleDispatchSummary[];
}

export interface OperatorErrorBody {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly requestId?: string;
  };
}

export type AutomationPage = Page<AutomationRegistryEntry>;
export type AutomationVersionPage = Page<AutomationRegistryEntry>;
export type RunPage = Page<ControlPlaneRunRecord>;
export type SchedulePage = Page<AutomationSchedule>;
export type AuditPage = Page<AuditLedgerEntry>;
