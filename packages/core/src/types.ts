export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };

export type PublicationStatus =
  | "idea"
  | "draft"
  | "ready"
  | "approved"
  | "queued"
  | "publishing"
  | "published"
  | "archived";

export type PublicationBlockKind =
  | "heading"
  | "paragraph"
  | "image"
  | "gallery"
  | "quote"
  | "code"
  | "embed"
  | "table"
  | "callout";

export interface PublicationBlock {
  readonly id: string;
  readonly kind: PublicationBlockKind;
  readonly data: Readonly<Record<string, JsonValue>>;
}

export interface PublicationAsset {
  readonly id: string;
  readonly kind: "image" | "video" | "audio" | "document" | "other";
  readonly source: string;
  readonly mediaType?: string;
  readonly alt?: string;
  readonly attributes?: Readonly<Record<string, JsonValue>>;
}

export interface PublicationIR {
  readonly schemaVersion: 1;
  readonly title: string;
  readonly summary?: string;
  readonly language: string;
  readonly blocks: readonly PublicationBlock[];
  readonly assets: readonly PublicationAsset[];
  readonly tags: readonly string[];
  readonly attributes: Readonly<Record<string, JsonValue>>;
}

export interface PublicationRevision {
  readonly id: string;
  readonly ordinal: number;
  readonly createdAt: string;
  readonly content: PublicationIR;
}

export interface Publication {
  readonly id: string;
  readonly createdAt: string;
  readonly slug?: string;
  readonly status: PublicationStatus;
  readonly current: PublicationRevision;
  readonly canonicalUrl?: string;
  readonly provenance: Readonly<Record<string, JsonValue>>;
}

export type ExtensionCapability =
  | "article.create"
  | "article.update"
  | "article.delete"
  | "article.inspect"
  | "article.schedule"
  | "article.draft"
  | "asset.publish"
  | "taxonomy.publish"
  | "canonical.publish";

export interface DestinationRef {
  readonly extensionId: string;
  readonly connectionId: string;
  readonly channel: string;
}

export interface PublicationRoute {
  readonly id: string;
  readonly destination: DestinationRef;
  readonly requiredCapabilities: readonly ExtensionCapability[];
  readonly desiredState: "present";
  readonly enabled: boolean;
  readonly variant?: Readonly<Record<string, JsonValue>>;
}

export interface PublicationGroup {
  readonly id: string;
  readonly name: string;
  readonly routes: readonly PublicationRoute[];
  readonly policySetId: string;
}

export type PolicyEffect = "allow" | "deny" | "require_approval";

export interface PolicyMatch {
  readonly statuses?: readonly PublicationStatus[];
  readonly routeIds?: readonly string[];
  readonly extensionIds?: readonly string[];
  readonly tagsAny?: readonly string[];
}

export interface PolicyRule {
  readonly id: string;
  readonly description: string;
  readonly match: PolicyMatch;
  readonly effect: PolicyEffect;
  readonly approvalRole?: string;
}

export interface PolicySet {
  readonly id: string;
  readonly defaultEffect: "allow" | "deny";
  readonly rules: readonly PolicyRule[];
}

export interface PolicyDecision {
  readonly effect: PolicyEffect;
  readonly ruleId?: string;
  readonly approvalRole?: string;
  readonly reason: string;
}

export interface CompiledProjection {
  readonly projectionId: string;
  readonly publicationId: string;
  readonly sourceRevisionId: string;
  readonly routeId: string;
  readonly destination: DestinationRef;
  readonly payload: JsonValue;
  readonly fingerprint: string;
}

export interface RemoteIdentity {
  readonly id: string;
  readonly url?: string;
  readonly version?: string;
}

export type ObservedProjectionState =
  | "missing"
  | "synchronized"
  | "drifted"
  | "unreachable";

export interface ObservedProjection {
  readonly state: ObservedProjectionState;
  readonly remote?: RemoteIdentity;
  readonly fingerprint?: string;
  readonly observedAt: string;
  readonly detail?: string;
}

export interface DeliveryRequest {
  readonly idempotencyKey: string;
  readonly projection: CompiledProjection;
  readonly existingRemote?: RemoteIdentity;
}

export interface DeliveryResult {
  readonly remote: RemoteIdentity;
  readonly acceptedAt: string;
  readonly evidence: Readonly<Record<string, JsonValue>>;
}

export type ReconciliationAction = "create" | "update" | "none" | "blocked";

export interface ReconciliationItem {
  readonly routeId: string;
  readonly projectionId: string;
  readonly action: ReconciliationAction;
  readonly policy: PolicyDecision;
  readonly observed: ObservedProjection;
  readonly desiredFingerprint?: string;
  readonly reason: string;
}

export interface ReconciliationReport {
  readonly publicationId: string;
  readonly revisionId: string;
  readonly groupId: string;
  readonly generatedAt: string;
  readonly items: readonly ReconciliationItem[];
}

export type DeliveryReceiptStatus =
  | "blocked"
  | "awaiting_approval"
  | "verified"
  | "drifted"
  | "unreachable";

export interface DeliveryReceipt {
  readonly publicationId: string;
  readonly revisionId: string;
  readonly groupId: string;
  readonly routeId: string;
  readonly projectionId: string;
  readonly idempotencyKey?: string;
  readonly status: DeliveryReceiptStatus;
  readonly policy: PolicyDecision;
  readonly remote?: RemoteIdentity;
  readonly evidence?: Readonly<Record<string, JsonValue>>;
  readonly observed?: ObservedProjection;
  readonly completedAt: string;
}

export interface ApprovalGrant {
  readonly routeId: string;
  readonly role: string;
  readonly approvedBy: string;
  readonly approvedRevisionId: string;
  readonly approvedAt: string;
}
