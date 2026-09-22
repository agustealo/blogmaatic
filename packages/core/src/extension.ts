import type {
  CompiledProjection,
  DeliveryRequest,
  DeliveryResult,
  ExtensionCapability,
  ObservedProjection,
  Publication,
  PublicationRoute,
  RemoteIdentity,
} from "./types.js";

export interface PublisherExtensionManifest {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly capabilities: readonly ExtensionCapability[];
}

export interface CompileProjectionInput {
  readonly publication: Publication;
  readonly route: PublicationRoute;
}

export interface InspectProjectionInput {
  readonly projection: CompiledProjection;
  readonly remote?: RemoteIdentity;
}

export interface DriftReconciliationInput {
  readonly projection: CompiledProjection;
  readonly observed: ObservedProjection;
}

export interface DriftReconciliationPlan {
  readonly action: "update" | "blocked";
  readonly reason: string;
}

export interface PublisherExtension {
  readonly manifest: PublisherExtensionManifest;

  compile(input: CompileProjectionInput): Promise<CompiledProjection>;

  deliver(request: DeliveryRequest): Promise<DeliveryResult>;

  inspect(input: InspectProjectionInput): Promise<ObservedProjection>;

  planDriftReconciliation?(
    input: DriftReconciliationInput,
  ): Promise<DriftReconciliationPlan> | DriftReconciliationPlan;
}

export class ExtensionRegistry {
  readonly #publishers = new Map<string, PublisherExtension>();

  register(extension: PublisherExtension): void {
    if (this.#publishers.has(extension.manifest.id)) {
      throw new Error(`Publisher extension already registered: ${extension.manifest.id}`);
    }
    this.#publishers.set(extension.manifest.id, extension);
  }

  getPublisher(extensionId: string): PublisherExtension {
    const extension = this.#publishers.get(extensionId);
    if (!extension) {
      throw new Error(`Publisher extension is not registered: ${extensionId}`);
    }
    return extension;
  }

  assertCapabilities(extensionId: string, required: readonly ExtensionCapability[]): void {
    const extension = this.getPublisher(extensionId);
    const available = new Set(extension.manifest.capabilities);
    const missing = required.filter((capability) => !available.has(capability));

    if (missing.length > 0) {
      throw new Error(
        `Publisher extension ${extensionId} is missing required capabilities: ${missing.join(", ")}`,
      );
    }
  }
}
