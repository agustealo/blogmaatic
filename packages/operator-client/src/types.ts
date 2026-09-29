import type { AutomationApproval, AutomationDefinition, AutomationRunResult } from "@blogmaatic/automation";
import type {
  AuditLedgerEntry,
  AuditListQuery,
  AutomationListQuery,
  AutomationRegistryEntry,
  AutomationSchedule,
  AutomationVersionListQuery,
  Page,
  PageRequest,
  PublicationGroupListQuery,
  PublicationGroupRegistryEntry,
  PublicationGroupVersionListQuery,
  PublicationWorkspaceEntry,
  PublicationWorkspaceListQuery,
  RunListQuery,
  ScheduleListQuery,
  ControlPlaneRunRecord,
} from "@blogmaatic/control-plane";
import type {
  ConnectionCreateBody,
  ConnectionUpdateBody,
  ManualRunBody,
  OperatorConnectionSettingField,
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
  PublicationWorkspaceCreateBody,
  PublicationWorkspaceDispatchBody,
  PublicationWorkspaceDispatchResult,
  PublicationWorkspaceUpdateBody,
  WorkspacePublicationStatus,
} from "@blogmaatic/operator-api";

export type {
  AuditLedgerEntry,
  AuditListQuery,
  AutomationApproval,
  AutomationDefinition,
  AutomationListQuery,
  AutomationRegistryEntry,
  AutomationRunResult,
  AutomationSchedule,
  AutomationVersionListQuery,
  ConnectionCreateBody,
  ConnectionUpdateBody,
  ControlPlaneRunRecord,
  ManualRunBody,
  OperatorConnectionSettingField,
  OperatorConnectionTestResult,
  OperatorConnectionType,
  OperatorConnectionView,
  OperatorOperation,
  OperatorOperationKind,
  OperatorOperationsPage,
  OperatorOperationsQuery,
  Page,
  PageRequest,
  PublicationGroupActivationBody,
  PublicationGroupCreateBody,
  PublicationGroupListQuery,
  PublicationGroupRegistryEntry,
  PublicationGroupUpdateBody,
  PublicationGroupVersionListQuery,
  PublicationWorkspaceCreateBody,
  PublicationWorkspaceDispatchBody,
  PublicationWorkspaceDispatchResult,
  PublicationWorkspaceEntry,
  PublicationWorkspaceListQuery,
  PublicationWorkspaceUpdateBody,
  RunListQuery,
  ScheduleListQuery,
  WorkspacePublicationStatus,
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

export interface PublicationGroupOptionsResponse {
  readonly policySetIds: readonly string[];
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
export type PublicationWorkspacePage = Page<PublicationWorkspaceEntry>;
export type PublicationWorkspaceVersionPage = Page<PublicationWorkspaceEntry>;
export type RunPage = Page<ControlPlaneRunRecord>;
export type SchedulePage = Page<AutomationSchedule>;
export type AuditPage = Page<AuditLedgerEntry>;
