import { getInjectable2 } from "@k8slens/injectable";
import { runKubectlInjectionToken } from "@k8slens/kubectl-contracts";
import { createQueryCache, type Query, type QueryCache } from "../common/query";
import { settingsStoreInjectable } from "../settings/settings.injectable";
import { type CiliumInfo, loadCiliumInfo } from "./cilium-info";
import { createKubectlClient, type KubectlClient } from "./kubectl";
import { createResourceOperations, type Discovery, type ResourceOperations } from "./operations";
import type { ResourceType } from "./resource-types";

/** Everything the extension does to one cluster goes through its context, so nothing can reach another cluster by accident. */
export interface ClusterContext {
  readonly clusterId: string;
  readonly kubectl: KubectlClient;
  readonly ops: ResourceOperations;
  readonly queries: QueryCache;
  readonly discovery: Query<Discovery>;
  readonly ciliumInfo: Query<CiliumInfo>;
  /** The discovered type of a kind, if this cluster serves it. */
  readonly typeOfKind: (kind: string, group?: string) => ResourceType | undefined;
  readonly typeById: (id: string) => ResourceType | undefined;
  readonly isReadOnly: () => boolean;
  /** Refreshes every cached read of this cluster after a write. */
  readonly invalidate: () => void;
}

export const clusterContextInjectable = getInjectable2({
  id: "cilium-ui-cluster-context",
  consumptions: [runKubectlInjectionToken],

  instantiate: (di) => {
    const runKubectlFor = di.inject(runKubectlInjectionToken);
    const settings = di.inject(settingsStoreInjectable)();
    const contexts = new Map<string, ClusterContext>();

    return () =>
      (clusterId: string): ClusterContext => {
        const existing = contexts.get(clusterId);

        if (existing) {
          return existing;
        }

        const kubectl = createKubectlClient(runKubectlFor(clusterId));
        const ops = createResourceOperations(kubectl);
        const queries = createQueryCache();
        const discovery = queries.get("discovery", () => ops.discover());
        const ciliumInfo = queries.get("cilium-info", () => loadCiliumInfo(kubectl, settings.get().ciliumNamespace || undefined));

        const types = () => discovery.state().value?.types ?? [];

        const context: ClusterContext = {
          clusterId,
          kubectl,
          ops,
          queries,
          discovery,
          ciliumInfo,
          typeOfKind: (kind, group) => types().find((type) => type.kind === kind && (group === undefined || type.group === group)),
          typeById: (id) => types().find((type) => type.id === id),
          isReadOnly: () => settings.isReadOnly(clusterId),
          invalidate: () => queries.invalidate("q:"),
        };

        contexts.set(clusterId, context);

        return context;
      };
  },
});
