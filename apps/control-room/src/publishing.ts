import type {
  OperatorConnectionType,
  OperatorConnectionView,
  PublicationGroupCreateBody,
} from "@blogmaatic/operator-client";

export type PublicationRouteInput = PublicationGroupCreateBody["routes"][number];

export function consumerSlug(value: string, fallback = "publication"): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized || fallback;
}

export function routeIdForConnection(connectionId: string): string {
  return `route_${connectionId}`.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 160);
}

export function policySetLabel(policySetId: string): string {
  if (policySetId === "default") return "Default publishing policy";
  return policySetId
    .replace(/[._:-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function connectionTypeMap(
  types: readonly OperatorConnectionType[],
): ReadonlyMap<string, OperatorConnectionType> {
  return new Map(types.map((type) => [type.manifest.id, type]));
}

export function routeForConnection(
  connection: OperatorConnectionView,
  type: OperatorConnectionType,
  existing?: PublicationRouteInput,
): PublicationRouteInput {
  if (existing) return existing;
  const route = type.connectionContract.defaultRoute;
  return {
    id: routeIdForConnection(connection.id),
    enabled: true,
    desiredState: "present",
    destination: {
      extensionId: connection.extensionId,
      connectionId: connection.id,
      channel: route.channel,
    },
    requiredCapabilities: route.requiredCapabilities,
    ...(route.variant ? { variant: route.variant } : {}),
  };
}
