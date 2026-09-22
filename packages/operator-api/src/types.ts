import type {
  AutomationApproval,
  AutomationApprovalResponse,
  AutomationDefinition,
  AutomationRunResult,
  AutomationRunStatus,
} from "@blogmaatic/automation";
import type {
  AutomationControlPlane,
  AutomationScheduleInput,
  ControlPlaneStore,
  PublicationAutomationEvent,
} from "@blogmaatic/control-plane";
import type { Publication, PublicationGroup } from "@blogmaatic/core";

import type { OperatorAuthorizer } from "./auth.js";

export interface OperatorAutomationRuntime {
  status(runId: string): Promise<AutomationRunStatus | null>;
  approve(approval: AutomationApproval): Promise<AutomationApprovalResponse>;
  result(runId: string): Promise<AutomationRunResult>;
}

export interface OperatorClock {
  now(): string;
}

export interface OperatorApiOptions {
  readonly controlPlane: AutomationControlPlane;
  readonly store: ControlPlaneStore;
  readonly runtime: OperatorAutomationRuntime;
  readonly authorizer: OperatorAuthorizer;
  readonly clock?: OperatorClock;
  readonly logger?: boolean;
  readonly bodyLimit?: number;
}

export interface OperatorApiListenOptions {
  readonly port: number;
  readonly host?: string;
}

export interface ManualRunBody {
  readonly automationId: string;
  readonly automationVersion?: number;
  readonly publication: Publication;
  readonly groups: readonly PublicationGroup[];
}

export type EventIngestBody = Omit<PublicationAutomationEvent, "source">;

export interface ApprovalBody {
  readonly decision: "approve" | "reject";
  readonly note?: string;
}

export interface ActivationBody {
  readonly enabled: boolean;
}

export interface ScheduleDispatchBody {
  readonly now?: string;
  readonly limit?: number;
}

export type AutomationRegistrationBody = AutomationDefinition;
export type ScheduleRegistrationBody = AutomationScheduleInput;
