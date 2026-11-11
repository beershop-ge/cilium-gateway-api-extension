import { TextInput } from "@k8slens/input-components";
import { useInject } from "@k8slens/use-inject";
import { observer } from "mobx-react";
import type { Json } from "../common/json";
import { clusterContextInjectable } from "../kube/cluster-context.injectable";
import { Select, useQueryState } from "../ui/components";

export const useNamespaces = (clusterId: string) => {
  const context = useInject(clusterContextInjectable)()(clusterId);
  const query = context.queries.get("q:namespaces", async () => {
    const result = await context.kubectl.json<Json>(["get", "namespaces", "--output", "json"]);

    return ((result?.items ?? []) as Json[]).map((namespace) => String(namespace.metadata.name)).sort();
  });

  return useQueryState(query);
};

/** Picks a namespace from the cluster's list, or takes it typed when listing namespaces is not allowed. */
export const NamespaceSelect = observer(
  ({ clusterId, value, onChange, allowAll, ariaLabel = "Namespace", disabled }: { clusterId: string; value: string | undefined; onChange: (namespace: string) => void; allowAll?: boolean; ariaLabel?: string; disabled?: boolean }) => {
    const namespaces = useNamespaces(clusterId);

    if (namespaces.status === "error" && namespaces.value === undefined) {
      return <TextInput aria-label={ariaLabel} placeholder="namespace" value={value ?? ""} readOnly={disabled} onChange={(event) => onChange(event.target.value.trim())} />;
    }

    return (
      <Select
        ariaLabel={ariaLabel}
        value={value ?? (allowAll ? "" : undefined)}
        disabled={disabled}
        placeholder={namespaces.value ? (allowAll ? "All namespaces" : "Select a namespace") : "Loading namespaces…"}
        options={[...(allowAll && value ? [{ value: "", label: "All namespaces" }] : []), ...(namespaces.value ?? []).map((namespace) => ({ value: namespace, label: namespace }))]}
        onChange={onChange}
      />
    );
  },
);
