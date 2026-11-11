import { useInject } from "@k8slens/use-inject";
import type { QueryState } from "../common/query";
import { type ClusterContext, clusterContextInjectable } from "../kube/cluster-context.injectable";
import type { CiliumInfo } from "../kube/cilium-info";
import type { Discovery } from "../kube/operations";
import { loadSnapshot, type Snapshot, snapshotQueryKey, type SnapshotRequest } from "../kube/snapshot";
import { settingsStoreInjectable } from "../settings/settings.injectable";
import { useQueryState } from "./components";

export const useClusterContext = (clusterId: string): ClusterContext => useInject(clusterContextInjectable)()(clusterId);

export const useRefreshSeconds = () => useInject(settingsStoreInjectable)().get().refreshSeconds;

/** A composite read of several kinds, refreshed every `refreshSeconds` from the settings while the view is shown. */
export const useSnapshot = (clusterId: string, request: SnapshotRequest): { state: QueryState<Snapshot>; refresh: () => Promise<void> } => {
  const context = useClusterContext(clusterId);
  const refreshSeconds = useRefreshSeconds();
  const query = context.queries.get(snapshotQueryKey(request), () => loadSnapshot(context, request));

  return { state: useQueryState(query, refreshSeconds), refresh: query.refresh };
};

export const useDiscovery = (clusterId: string): QueryState<Discovery> => useQueryState(useClusterContext(clusterId).discovery);

export const useCiliumInfo = (clusterId: string): { state: QueryState<CiliumInfo>; refresh: () => Promise<void> } => {
  const context = useClusterContext(clusterId);

  return { state: useQueryState(context.ciliumInfo), refresh: context.ciliumInfo.refresh };
};
