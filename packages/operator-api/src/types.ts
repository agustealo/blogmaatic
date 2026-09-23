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
  PublicationGroupListQuery,
  PublicationGroupRegistryEntry,
  PublicationGroupVersionListQuery,
  Page,
} from "@blogmaatic/control-plane";
import type { JsonValue, Publication, PublicationGroup, PublicationRoute } from "@blogmaatic/core";

import type { OperatorAuthorizer } from "./auth.js";

export interface OperatorAutomationRuntime {
  status(runId: string): Promise<AutomationRunStatus | null>;
  approve(approval: AutomationApproval): Promise<AutomationApprovalResponse>;
  result(runId: string): Promise<AutomationRunResult>;
}

export interface OperatorClock {
  now(): string;
}

export type OperatorConnectionStatus = "active" | "disabled";
export type OperatorConnectionFieldKind =
  | "text"
  | "url"
  | "email"
  | "integer"
  | "boolean"
  | "select"
  | "path"
  | "string-list";

export interface OperatorConnectionFieldOption {
  readonly value: string;
  readonly label: string;
}

export interface OperatorConnectionSettingField {
  readonly key: string;
  readonly label: string;
  readonly kind: OperatorConnectionFieldKind;
  readonly required?: boolean;
  readonly description?: string;
  readonly placeholder?: string;
  readonly defaultValue?: JsonValue;
  readonly min?: number;
  readonly max?: number;
  readonly options?: readonly OperatorConnectionFieldOption[];
}

export interface OperatorConnectionSecretField {
  readonly key: string;
  readonly label: string;
  readonly required?: boolean;
  readonly description?: string;
}

export interface OperatorConnectionType {
  readonly manifest: {
    readonly apiVersion: 1;
    readonly kind: "publisher";
    readonly connectionSchemaVersion: 1;
    readonly id: string;
    readonly displayName: string;
    readonly version: string;
    readonly capabilities: readonly string[];
  };
  readonly connectionContract: {
    readonly schemaVersion: 1;
    readonly settingsFields: readonly OperatorConnectionSettingField[];
    readonly secretFields: readonly OperatorConnectionSecretField[];
  };
}

export interface OperatorConnectionView {
  readonly id: string;
  readonly extensionId: string;
  readonly displayName: string;
  readonly status: OperatorConnectionStatus;
  readonly settings: Readonly<Record<string, JsonValue>>;
  readonly configuredSecrets: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConnectionCreateBody {
  readonly extensionId: string;
  readonly displayName: string;
  readonly status?: OperatorConnectionStatus;
  readonly settings: Readonly<Record<string, JsonValue>>;
  readonly secrets?: Readonly<Record<string, string>>;
}

export interface ConnectionUpdateBody {
  readonly displayName?: string;
  readonly status?: OperatorConnectionStatus;
  readonly settings?: Readonly<Record<string, JsonValue>>;
  readonly secrets?: Readonly<Record<string, string>>;
}

export interface OperatorConnectionTestResult {
  readonly validation: {
    readonly valid: boolean;
    readonly errors: readonly string[];
  };
  readonly health?: {
    readonly state: "healthy" | "degraded" | "unhealthy";
    readonly checkedAt: string;
    readonly detail: string;
    readonly evidence?: Readonly<Record<string, JsonValue>>;
  };
}

export interface OperatorConnectionManager {
  listTypes(): readonly OperatorConnectionType[];
  list(): readonly OperatorConnectionView[];
  get(connectionId: string): OperatorConnectionView;
  create(input: ConnectionCreateBody & { readonly id?: string }): Promise<OperatorConnectionView>;
  update(connectionId: string, input: ConnectionUpdateBody): Promise<OperatorConnectionView>;
  remove(connectionId: string): Promise<OperatorConnectionView>;
  test(connectionId: string): Promise<OperatorConnectionTestResult>;
}

export interface PublicationGroupCreateBody {
  readonly name: string;
  readonly policySetId: string;
  readonly routes: readonly PublicationRoute[];
  readonly enabled?: boolean;
}

export interface PublicationGroupUpdateBody extends PublicationGroupCreateBody {
  readonly expectedVersion: number;
}

export interface PublicationGroupActivationBody {
  readonly expectedVersion: number;
  readonly enabled: boolean;
}

export interface OperatorPublicationGroupManager {
  list(query?: PublicationGroupListQuery): Promise<Page<PublicationGroupRegistryEntry>>;
  get(groupId: string): Promise<PublicationGroupRegistryEntry | undefined>;
  listVersions(
    groupId: string,
    query?: PublicationGroupVersionListQuery,
  ): Promise<Page<PublicationGroupRegistryEntry>>;
  getVersion(groupId: string, version: number): Promise<PublicationGroupRegistryEntry | undefined>;
  create(input: {
    readonly group: PublicationGroup;
    readonly enabled?: boolean;
  }): Promise<PublicationGroupRegistryEntry>;
  update(input: {
    readonly group: PublicationGroup;
    readonly expectedVersion: number;
    readonly enabled?: boolean;
  }): Promise<PublicationGroupRegistryEntry>;
  setEnabled(
    groupId: string,
    expectedVersion: number,
    enabled: boolean,
  ): Promise<PublicationGroupRegistryEntry>;
}

export interface OperatorApiOptions {
  readonly controlPlane: AutomationControlPlane;
  readonly store: ControlPlaneStore;
  readonly runtime: OperatorAutomationRuntime;
  readonly connections?: OperatorConnectionManager;
  readonly publicationGroups?: OperatorPublicationGroupManager;
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