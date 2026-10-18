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

export interface SourceContentQuery {
  readonly search?: string;
  readonly status?: string;
  readonly page?: number;
  readonly limit?: number;
}

export interface SourceContentRecord {
  readonly connectionId: string;
  readonly extensionId: string;
  readonly remoteId: string;
  readonly remoteUrl: string;
  readonly title: string;
  readonly excerpt: string;
  readonly contentHtml: string;
  readonly slug: string;
  readonly status: string;
  readonly publishedAt?: string | null;
  readonly modifiedAt?: string;
  readonly managed: boolean;
  readonly publicationId?: string;
  readonly routeId?: string;
  readonly metadata: Readonly<Record<string, JsonValue>>;
}

export interface SourceContentPage {
  readonly items: readonly SourceContentRecord[];
  readonly page: number;
  readonly limit: number;
  readonly hasMore: boolean;
}

export interface SourceContentRevision {
  readonly remoteRevisionId: string;
  readonly title: string;
  readonly excerpt: string;
  readonly contentHtml: string;
  readonly createdAt?: string | null;
  readonly modifiedAt?: string;
  readonly metadata: Readonly<Record<string, JsonValue>>;
}

export interface SourceRevisionRestoreBody {
  readonly publicationId: string;
  readonly expectedVersion: number;
}

export interface SourceRevisionRestoreResult {
  readonly publication: PublicationWorkspaceEntry;
  readonly revision: SourceContentRevision;
}

export interface SourceContentImportBody {
  readonly groupId: string;
  readonly routeId: string;
}

export interface SourceContentImportResult {
  readonly publication: PublicationWorkspaceEntry;
  readonly remote: SourceContentRecord;
}

export interface SourceAuthorQuery {
  readonly search?: string;
  readonly page?: number;
  readonly limit?: number;
}

export interface SourceAuthorRecord {
  readonly connectionId: string;
  readonly extensionId: string;
  readonly remoteId: string;
  readonly displayName: string;
  readonly slug: string;
  readonly link?: string;
  readonly avatarUrl?: string;
  readonly metadata: Readonly<Record<string, JsonValue>>;
}

export interface SourceAuthorPage {
  readonly items: readonly SourceAuthorRecord[];
  readonly page: number;
  readonly limit: number;
  readonly hasMore: boolean;
}

export interface SourceAuthorAssignBody {
  readonly publicationId: string;
  readonly expectedVersion: number;
}

export interface SourceAuthorAssignResult {
  readonly publication: PublicationWorkspaceEntry;
  readonly author: SourceAuthorRecord;
}

export interface SourcePublishingStateBody {
  readonly publicationId: string;
  readonly expectedVersion: number;
  readonly status: string;
  readonly scheduledAt?: string;
}

export interface SourcePublishingStateResult {
  readonly publication: PublicationWorkspaceEntry;
  readonly status: string;
  readonly scheduledAt?: string;
}

export interface SourceAssetQuery {
  readonly search?: string;
  readonly page?: number;
  readonly limit?: number;
}

export interface SourceAssetRecord {
  readonly connectionId: string;
  readonly extensionId: string;
  readonly remoteId: string;
  readonly sourceUrl: string;
  readonly kind: "image";
  readonly mediaType?: string;
  readonly title?: string;
  readonly alt?: string;
  readonly width?: number;
  readonly height?: number;
  readonly modifiedAt?: string;
  readonly metadata: Readonly<Record<string, JsonValue>>;
}

export interface SourceAssetPage {
  readonly items: readonly SourceAssetRecord[];
  readonly page: number;
  readonly limit: number;
  readonly hasMore: boolean;
}

export interface SourceAssetAttachBody {
  readonly publicationId: string;
  readonly expectedVersion: number;
  readonly featured?: boolean;
}

export interface SourceAssetAttachResult {
  readonly publication: PublicationWorkspaceEntry;
  readonly asset: SourceAssetRecord;
}

export interface SourceAssetUploadInput {
  readonly publicationId: string;
  readonly expectedVersion: number;
  readonly filename: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly featured?: boolean;
  readonly alt?: string;
  readonly title?: string;
}

export type SourceTaxonomyKind = "category" | "tag";

export interface SourceTaxonomyQuery {
  readonly kind: SourceTaxonomyKind;
  readonly search?: string;
  readonly page?: number;
  readonly limit?: number;
}

export interface SourceTaxonomyRecord {
  readonly connectionId: string;
  readonly extensionId: string;
  readonly kind: SourceTaxonomyKind;
  readonly remoteId: string;
  readonly name: string;
  readonly slug: string;
  readonly description?: string;
  readonly count?: number;
  readonly metadata: Readonly<Record<string, JsonValue>>;
}

export interface SourceTaxonomyPage {
  readonly items: readonly SourceTaxonomyRecord[];
  readonly page: number;
  readonly limit: number;
  readonly hasMore: boolean;
}

export interface OperatorSourceContentManager {
  list(connectionId: string, query?: SourceContentQuery): Promise<SourceContentPage>;
  get(connectionId: string, remoteId: string): Promise<SourceContentRecord>;
  revisions(connectionId: string, remoteId: string): Promise<readonly SourceContentRevision[]>;
  restoreRevision(
    connectionId: string,
    remoteId: string,
    remoteRevisionId: string,
    body: SourceRevisionRestoreBody,
  ): Promise<SourceRevisionRestoreResult>;
  listAuthors(connectionId: string, query?: SourceAuthorQuery): Promise<SourceAuthorPage>;
  assignAuthor(connectionId: string, remoteId: string, body: SourceAuthorAssignBody): Promise<SourceAuthorAssignResult>;
  setPublishingState(connectionId: string, body: SourcePublishingStateBody): Promise<SourcePublishingStateResult>;
  listAssets(connectionId: string, query?: SourceAssetQuery): Promise<SourceAssetPage>;
  attachAsset(connectionId: string, remoteId: string, body: SourceAssetAttachBody): Promise<SourceAssetAttachResult>;
  uploadAsset(connectionId: string, input: SourceAssetUploadInput): Promise<SourceAssetAttachResult>;
  listTaxonomy(connectionId: string, query: SourceTaxonomyQuery): Promise<SourceTaxonomyPage>;
  import(connectionId: string, remoteId: string, body: SourceContentImportBody): Promise<SourceContentImportResult>;
  trash(connectionId: string, remoteId: string): Promise<SourceContentRecord>;
  restore(connectionId: string, remoteId: string): Promise<SourceContentRecord>;
  deletePermanent(connectionId: string, remoteId: string): Promise<SourceContentRecord>;
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
export type PublicationBodyFormat = "plain" | "html";

export interface PublicationWorkspaceCreateBody {
  readonly title: string;
  readonly body?: string;
  readonly bodyFormat?: PublicationBodyFormat;
  readonly summary?: string;
  readonly language?: string;
  readonly tags?: readonly string[];
  readonly categories?: readonly string[];
  readonly slug?: string;
  readonly canonicalUrl?: string;
  readonly status?: WorkspacePublicationStatus;
}

export interface PublicationWorkspaceUpdateBody {
  readonly expectedVersion: number;
  readonly title?: string;
  readonly body?: string;
  readonly bodyFormat?: PublicationBodyFormat;
  readonly summary?: string;
  readonly language?: string;
  readonly tags?: readonly string[];
  readonly categories?: readonly string[];
  readonly featuredAssetId?: string | null;
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

export interface ProjectionPreviewMediaSummary {
  readonly assetId?: string;
  readonly sourceWidth?: number;
  readonly sourceHeight?: number;
  readonly sourceMediaType?: string;
  readonly outputWidth?: number;
  readonly outputHeight?: number;
  readonly outputMediaType?: string;
  readonly fit?: string;
  readonly renderRequired?: boolean;
  readonly transformationFingerprint?: string;
  readonly derivedAssetId?: string;
}

export interface ProjectionPreviewSummary {
  readonly title?: string;
  readonly text?: string;
  readonly mode?: string;
  readonly status?: string;
  readonly path?: string;
  readonly publicUrl?: string;
  readonly scheduledAt?: string;
  readonly mediaCount?: number;
  readonly media?: readonly ProjectionPreviewMediaSummary[];
  readonly fidelity?: {
    readonly score: number;
    readonly exact?: boolean;
    readonly issues?: JsonValue;
  };
}

export interface PublicationProjectionPreviewDestination {
  readonly extensionId: string;
  readonly extensionName: string;
  readonly connectionId: string;
  readonly connectionName: string;
  readonly channel: string;
}

export type PublicationProjectionPreviewItem =
  | {
    readonly status: "ready";
    readonly routeId: string;
    readonly destination: PublicationProjectionPreviewDestination;
    readonly projectionId: string;
    readonly sourceRevisionId: string;
    readonly fingerprint: string;
    readonly payload: JsonValue;
    readonly summary: ProjectionPreviewSummary;
  }
  | {
    readonly status: "error";
    readonly routeId: string;
    readonly destination: PublicationProjectionPreviewDestination;
    readonly sourceRevisionId: string;
    readonly error: string;
  };

export interface PublicationProjectionPreview {
  readonly publicationId: string;
  readonly revisionId: string;
  readonly revisionOrdinal: number;
  readonly groupId: string;
  readonly groupName: string;
  readonly items: readonly PublicationProjectionPreviewItem[];
}

export interface OperatorPublicationPreviewManager {
  preview(publicationId: string, groupId: string): Promise<PublicationProjectionPreview>;
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
  readonly sourceContent?: OperatorSourceContentManager;
  readonly publicationGroups?: OperatorPublicationGroupManager;
  readonly publications?: OperatorPublicationWorkspaceManager;
  readonly previews?: OperatorPublicationPreviewManager;
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
