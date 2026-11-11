import type { Json } from "../common/json";
import { itemsOf, type Snapshot, type SnapshotRequest } from "../kube/snapshot";
import type { PolicyKind } from "./model";
import { type EndpointInfo, endpointsFrom } from "./selection";

/** What both policy pages read, as one snapshot (shared through the query cache). */
export const policySnapshotRequest: SnapshotRequest = {
  kinds: ["CiliumNetworkPolicy", "CiliumClusterwideNetworkPolicy", "CiliumEndpoint", "CiliumIdentity", "CiliumCIDRGroup", "CiliumNode"],
  builtins: ["pods", "namespaces", "services", "networkpolicies.networking.k8s.io"],
};

const networkPolicies = "networkpolicies.networking.k8s.io";

export const policiesOf = (snapshot: Snapshot | undefined, kind?: PolicyKind): Json[] => {
  const all: Array<[PolicyKind, readonly Json[]]> = [
    ["CiliumNetworkPolicy", itemsOf(snapshot, "CiliumNetworkPolicy")],
    ["CiliumClusterwideNetworkPolicy", itemsOf(snapshot, "CiliumClusterwideNetworkPolicy")],
    ["NetworkPolicy", itemsOf(snapshot, networkPolicies)],
  ];

  // `kubectl get` lists leave kind and apiVersion off the items of a built-in list only sometimes; set them.
  return all
    .filter(([candidate]) => !kind || candidate === kind)
    .flatMap(([candidate, items]) => items.map((item) => ({ ...item, kind: item.kind ?? candidate, apiVersion: item.apiVersion ?? (candidate === "NetworkPolicy" ? "networking.k8s.io/v1" : "cilium.io/v2") })));
};

/** Finds the policy `openCiliumPageInjectable` selected (`namespace/name`, with an optional kind). */
export const findPolicy = (snapshot: Snapshot | undefined, selected: string, kind?: string): Json | undefined => {
  const separator = selected.indexOf("/");
  const namespace = selected.slice(0, separator);
  const name = selected.slice(separator + 1);

  return policiesOf(snapshot).find(
    (policy) => (!kind || policy.kind === kind) && policy.metadata?.name === name && (policy.kind === "CiliumClusterwideNetworkPolicy" || (policy.metadata?.namespace ?? "") === namespace),
  );
};

export const podCidrsOf = (snapshot: Snapshot | undefined): string[] => [
  ...new Set(itemsOf(snapshot, "CiliumNode").flatMap((node) => [...(node?.spec?.ipam?.podCIDRs ?? []), ...(node?.spec?.ipam?.pools?.allocated ?? []).flatMap((pool: Json) => pool?.cidrs ?? [])].map(String))),
];

export const endpointsOfSnapshot = (snapshot: Snapshot | undefined): EndpointInfo[] =>
  endpointsFrom({
    pods: itemsOf(snapshot, "pods"),
    namespaces: itemsOf(snapshot, "namespaces"),
    ciliumEndpoints: itemsOf(snapshot, "CiliumEndpoint"),
    identities: itemsOf(snapshot, "CiliumIdentity"),
  });

export const kubectlResourceOfKind: Record<PolicyKind, string> = {
  CiliumNetworkPolicy: "ciliumnetworkpolicies.cilium.io",
  CiliumClusterwideNetworkPolicy: "ciliumclusterwidenetworkpolicies.cilium.io",
  NetworkPolicy: networkPolicies,
};
