import type { AutomationApproval, AutomationRunResult } from "@blogmaatic/automation";
import type {
  AuditLedgerEntry,
  AuditListQuery,
  AutomationListQuery,
  AutomationRegistryEntry,
  AutomationSchedule,
  AutomationVersionListQuery,
  Page,
  PublicationGroupListQuery,
  PublicationGroupRegistryEntry,
  PublicationGroupVersionListQuery,
  RunListQuery,
  ScheduleListQuery,
  ControlPlaneRunRecord,
} from "@blogmaatic/control-plane";
import type {
  ConnectionCreateBody,
  ConnectionUpdateBody,
  OperatorConnectionTestResult,
  OperatorConnectionType,
  OperatorConnectionView,
  OperatorOperation,
  OperatorOperationKind,
  OperatorOperationsPage,
  OperatorOperationsQuery,
  PublicationGroupActivationBody,
  PublicationGroupCreateBody,
  PublicationGroupUpdateBody,
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
  ConnectionCreateBody,
  ConnectionUpdateBody,
  ControlPlaneRunRecord,
  OperatorConnectionTestResult,
  OperatorConnectionType,
  OperatorConnectionView,
  OperatorOperation,
  OperatorOperationKind,
  OperatorOperationsPage,
  OperatorOperationsQuery,
  Page,
  PublicationGroupActivationBody,
  PublicationGroupCreateBody,
  PublicationGroupListQuery,
  PublicationGroupRegistryEntry,
  PublicationGroupUpdateBody,
  PublicationGroupVersionListQuery,
  RunListQuery,
  ScheduleListQuery,
};

export interface OperatorHealth {
  readonly status: "ok";
  readonly service: string;
}

export interface ConnectionTypesResponse {
  readonly items: readonly OperatorConnectionType[];
}

export interface ConnectionsResponse {
  readonly items: readonly OperatorConnectionView[];
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
export type PublicationGroupPage = Page<PublicationGroupRegistryEntry>;
export type PublicationGroupVersionPage = Page<PublicationGroupRegistryEntry>;
export type RunPage = Page<ControlPlaneRunRecord>;
export type SchedulePage = Page<AutomationSchedule>;
export type AuditPage = Page<AuditLedgerEntry>;
