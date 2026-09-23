import type {
  AutomationRegistryEntry,
  OperatorClient,
  OperatorConnectionTestResult,
  OperatorConnectionType,
  OperatorConnectionView,
  PublicationGroupRegistryEntry,
} from "@blogmaatic/operator-client";

export type OnboardingStage = "connection" | "group" | "automation" | "ready";

export interface ConnectionProbe {
  readonly connection: OperatorConnectionView;
  readonly result?: OperatorConnectionTestResult;
  readonly error?: string;
}

export interface OnboardingReadiness {
  readonly stage: OnboardingStage;
  readonly connectionTypes: readonly OperatorConnectionType[];
  readonly connections: readonly OperatorConnectionView[];
  readonly connectionProbes: readonly ConnectionProbe[];
  readonly usableConnectionIds: ReadonlySet<string>;
  readonly policySetIds: readonly string[];
  readonly enabledGroups: readonly PublicationGroupRegistryEntry[];
  readonly runnableGroups: readonly PublicationGroupRegistryEntry[];
  readonly enabledAutomations: readonly AutomationRegistryEntry[];
  readonly runnableAutomations: readonly AutomationRegistryEntry[];
}

type ReadinessClient = Pick<
  OperatorClient,
  | "listConnectionTypes"
  | "listConnections"
  | "testConnection"
  | "getPublicationGroupOptions"
  | "listPublicationGroups"
  | "listAutomations"
>;

function isUsableProbe(probe: ConnectionProbe): boolean {
  return probe.result?.validation.valid === true &&
    probe.result.health !== undefined &&
    probe.result.health.state !== "unhealthy";
}

function groupUsesOnlyUsableConnections(
  entry: PublicationGroupRegistryEntry,
  usableConnectionIds: ReadonlySet<string>,
): boolean {
  const enabledRoutes = entry.group.routes.filter((route) => route.enabled);
  return entry.enabled &&
    enabledRoutes.length > 0 &&
    enabledRoutes.every((route) => usableConnectionIds.has(route.destination.connectionId));
}

function automationPublishesRunnableGroup(
  entry: AutomationRegistryEntry,
  runnableGroupIds: ReadonlySet<string>,
): boolean {
  return entry.enabled && entry.definition.steps.some(
    (step) => step.kind === "publish_group" && runnableGroupIds.has(step.groupId),
  );
}

export async function loadOnboardingReadiness(client: ReadinessClient): Promise<OnboardingReadiness> {
  const [typeResponse, connectionResponse, groupOptions, groups, automations] = await Promise.all([
    client.listConnectionTypes(),
    client.listConnections(),
    client.getPublicationGroupOptions(),
    client.listPublicationGroups({ enabled: true, limit: 200 }),
    client.listAutomations({ enabled: true, limit: 200 }),
  ]);

  const activeConnections = connectionResponse.items.filter((connection) => connection.status === "active");
  const connectionProbes = await Promise.all(activeConnections.map(async (connection): Promise<ConnectionProbe> => {
    try {
      return { connection, result: await client.testConnection(connection.id) };
    } catch (error) {
      return {
        connection,
        error: error instanceof Error ? error.message : "Connection health check failed",
      };
    }
  }));

  const usableConnectionIds = new Set(
    connectionProbes.filter(isUsableProbe).map((probe) => probe.connection.id),
  );
  const runnableGroups = groups.items.filter((entry) => groupUsesOnlyUsableConnections(entry, usableConnectionIds));
  const runnableGroupIds = new Set(runnableGroups.map((entry) => entry.group.id));
  const runnableAutomations = automations.items.filter(
    (entry) => automationPublishesRunnableGroup(entry, runnableGroupIds),
  );

  const stage: OnboardingStage = usableConnectionIds.size === 0
    ? "connection"
    : runnableGroups.length === 0
      ? "group"
      : runnableAutomations.length === 0
        ? "automation"
        : "ready";

  return {
    stage,
    connectionTypes: typeResponse.items,
    connections: connectionResponse.items,
    connectionProbes,
    usableConnectionIds,
    policySetIds: groupOptions.policySetIds,
    enabledGroups: groups.items,
    runnableGroups,
    enabledAutomations: automations.items,
    runnableAutomations,
  };
}
