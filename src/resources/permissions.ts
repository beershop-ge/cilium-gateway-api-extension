import { useInject } from "@k8slens/use-inject";
import { clusterContextInjectable } from "../kube/cluster-context.injectable";
import type { ResourceType } from "../kube/resource-types";
import { useQueryState } from "../ui/components";

export interface Permissions {
  readonly list: boolean;
  readonly create: boolean;
  readonly update: boolean;
  readonly delete: boolean;
  readonly known: boolean;
}

/** What the user's Kubernetes RBAC allows on a type in a namespace, asked once and cached; optimistic until known. */
export const usePermissions = (clusterId: string, type: Pick<ResourceType, "id" | "group" | "plural" | "namespaced">, namespace?: string): Permissions => {
  const context = useInject(clusterContextInjectable)()(clusterId);
  const query = context.queries.get(`rbac:${type.id}:${namespace ?? "*"}`, async () => {
    const [list, create, update, remove] = await Promise.all(["list", "create", "update", "delete"].map((verb) => context.ops.canI(verb, type, namespace)));

    return { list, create, update, delete: remove, known: true };
  });
  const state = useQueryState(query);

  return state.value ?? { list: true, create: true, update: true, delete: true, known: false };
};
