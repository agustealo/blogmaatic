import type {
  AutomationApproval,
  AutomationApprovalResponse,
  AutomationDefinition,
  AutomationRunResult,
  AutomationRunStatus,
} from "@blogmaatic/automation";
import type {
  AutomationControlPlane,
  AutomationSchedule,
  AutomationScheduleInput,
  ControlPlaneRunRecord,
  ControlPlaneStore,
  PublicationAutomationEvent,
  PublicationGroupListQuery,
  PublicationGroupRegistryEntry,
  PublicationGroupVersionListQuery,
  PublicationWorkspaceEntry,
  PublicationWorkspaceListQuery,
  Page,
  PageRequest,
} from "@blogmaatic/control-plane";
import type {
  DistributionHistoryPage,
  DistributionHistoryQuery,
  ExtensionCapability,
  JsonValue,
  Publication,
  PublicationGroup,
  PublicationRoute,
  PublicationStatus,
} from "@blogmaatic/core";

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
    readonly capabilities: readonly ExtensionCapability[];
  };
  readonly connectionContract: {
    readonly schemaVersion: 1;
    readonly settingsFields: readonly OperatorConnectionSettingField[];
    readonly secretFields: readonly OperatorConnectionSecretField[];
    readonly defaultRoute: {
      readonly channel: string;
      readonly requiredCapabilities: readonly ExtensionCapability[];
      readonly variant?: Readonly<Record<string, JsonValue>>;
    };
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
  listPolicySetIds(): readonly string[];
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

export type WorkspacePublicationStatus = Extract<PublicationStatus, "idea" | "draft" | "ready" | "approved" | "archived">;

export interface PublicationWorkspaceCreateBody {
  readonly title: string;
  readonly body?: string;
  readonly summary?: string;
  readonly language?: string;
  readonly tags?: readonly string[];
  readonly slug?: string;
  readonly canonicalUrl?: string;
  readonly status?: WorkspacePublicationStatus;
}

export interface PublicationWorkspaceUpdateBody {
  readonly expectedVersion: number;
  readonly title?: string;
  readonly body?: string;
  readonly summary?: string;
  readonly language?: string;
  readonly tags?: readonly string[];
  readonly slug?: string;
  readonly canonicalUrl?: string;
  readonly status?: WorkspacePublicationStatus;
}

export interface PublicationWorkspaceDispatchBody {
  readonly expectedVersion: number;
}

export interface PublicationWorkspaceDispatchResult {
  readonly publication: PublicationWorkspaceEntry;
  readonly runs: readonly ControlPlaneRunRecord[];
}

export interface OperatorDistributionHistory {
  list(
    publicationId: string,
    query?: DistributionHistoryQuery,
  ): Promise<DistributionHistoryPage>;
}

export type OperatorDistributionHistoryQuery = DistributionHistoryQuery;
export type OperatorDistributionHistoryPage = DistributionHistoryPage;

export interface OperatorPublicationWorkspaceManager {
  list(query?: PublicationWorkspaceListQuery): Promise<Page<PublicationWorkspaceEntry>>;
  get(publicationId: string): Promise<PublicationWorkspaceEntry | undefined>;
  listVersions(publicationId: string, query?: PageRequest): Promise<Page<PublicationWorkspaceEntry>>;
  getVersion(publicationId: string, version: number): Promise<PublicationWorkspaceEntry | undefined>;
  create(input: PublicationWorkspaceCreateBody): Promise<PublicationWorkspaceEntry>;
  update(publicationId: string, input: PublicationWorkspaceUpdateBody): Promise<PublicationWorkspaceEntry>;
  approveAndDispatch(publicationId: string, expectedVersion: number): Promise<PublicationWorkspaceDispatchResult>;
}

export interface ScheduleActivationBody {
  readonly expectedUpdatedAt: string;
  readonly enabled: boolean;
}

export interface OperatorScheduleManager {
  setEnabled(
    scheduleId: string,
    expectedUpdatedAt: string,
    enabled: boolean,
  ): Promise<AutomationSchedule>;
}

export interface OperatorApiOptions {
  readonly controlPlane: AutomationControlPlane;
  readonly store: ControlPlaneStore;
  readonly runtime: OperatorAutomationRuntime;
  readonly connections?: OperatorConnectionManager;
  readonly publicationGroups?: OperatorPublicationGroupManager;
  readonly publications?: OperatorPublicationWorkspaceManager;
  readonly distributions?: OperatorDistributionHistory;
  readonly schedules?: OperatorScheduleManager;
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
