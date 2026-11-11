import type { Json } from "../common/json";
import { apiVersionOf, type ResourceType } from "../kube/resource-types";
import { itemsOf, type Snapshot, type SnapshotRequest } from "../kube/snapshot";
import { useQueryState } from "../ui/components";
import { useClusterContext } from "../ui/use-cluster";
import { type DesignerKind, designerKinds, type GatewayFeatures, gatewayTypeOf, type KindSchema } from "./features";
import type { ApiVersions } from "./manifest";
import type { GatewayIssue, Inventory } from "./validation";

/** One read for the designer and the map alike, so they share the cached snapshot. */
export const gatewaySnapshotRequest: SnapshotRequest = {
  kinds: [
    "GatewayClass",
    "Gateway",
    "ListenerSet",
    "HTTPRoute",
    "GRPCRoute",
    "TLSRoute",
    "TCPRoute",
    "UDPRoute",
    "ReferenceGrant",
    "CiliumGatewayClassConfig",
    "CiliumEnvoyConfig",
    "CiliumLoadBalancerIPPool",
  ],
  builtins: ["services", "secrets", "namespaces", "endpointslices.discovery.k8s.io"],
};

export const apiVersionsOf = (types: readonly ResourceType[]): ApiVersions =>
  Object.fromEntries(
    designerKinds.flatMap((kind) => {
      const type = gatewayTypeOf(types, kind);

      return type ? [[kind, apiVersionOf(type, type.preferredVersion)]] : [];
    }),
  );

/** The installed schemas of the designer's kinds, from discovery or, failing that, OpenAPI v3; one read per cluster and set of versions. */
export const useGatewaySchemas = (clusterId: string, types: readonly ResourceType[]) => {
  const context = useClusterContext(clusterId);
  const installed = designerKinds.map((kind) => gatewayTypeOf(types, kind)).filter((type): type is ResourceType => type !== undefined);
  const key = `gateway-schemas:${installed.map((type) => `${type.id}@${type.preferredVersion}`).join(",")}`;
  const query = context.queries.get(key, async () =>
    Object.fromEntries(
      await Promise.all(
        installed.map(async (type) => {
          try {
            return [type.kind, await context.ops.schemaOf(type, type.preferredVersion)] as const;
          } catch {
            return [type.kind, {}] as const;
          }
        }),
      ),
    ) as Partial<Record<DesignerKind, KindSchema>>,
  );

  return useQueryState(query);
};

/** All routes of every installed kind in a snapshot. */
export const allRoutesOf = (snapshot: Snapshot): Json[] => ["HTTPRoute", "GRPCRoute", "TLSRoute", "TCPRoute", "UDPRoute"].flatMap((kind) => itemsOf(snapshot, kind).map((route) => ({ kind, ...route })));

/** What every builder works with: the cluster's resources, what it supports and the current document's issues. */
export interface DesignerContext {
  readonly clusterId: string;
  readonly snapshot: Snapshot;
  readonly inventory: Inventory;
  readonly features: GatewayFeatures;
  readonly apiVersions: ApiVersions;
  readonly issues: readonly GatewayIssue[];
  readonly namespaces: readonly string[];
  /** Opens another resource in the designer, optionally with a draft already changed (attach, detach, a grant to create). */
  readonly edit: (kind: DesignerKind, draft: Json, original?: Json) => void;
}

export interface BuilderProps {
  readonly ctx: DesignerContext;
  readonly document: Json;
  readonly onChange: (document: Json) => void;
  /** Whether the document is new; an existing one keeps its name and namespace. */
  readonly isNew: boolean;
}
