import { type Condition, conditionsOf } from "../common/conditions";
import { isPlainObject, type Json } from "../common/json";
import { ciliumLabelsOfPod, normalizeCiliumKey, parseCiliumLabelList, selectorMatches } from "../common/selectors";
import { ciliumPeerSelector, selectorToJson } from "./manifest";
import { isNamespacedKind, type Peer, type PolicyModel } from "./model";

/** An endpoint as the policy views see it: a pod, or a CiliumEndpoint when pods cannot be read. */
export interface EndpointInfo {
  /** `namespace/name` */
  readonly key: string;
  readonly namespace: string;
  readonly name: string;
  /** The labels Cilium matches selectors against, without source prefixes, namespace and service account included. */
  readonly labels: Readonly<Record<string, string>>;
  readonly namespaceLabels: Readonly<Record<string, string>>;
  readonly source: "pod" | "ciliumendpoint";
  readonly identity?: number;
  readonly node?: string;
  /** From CiliumEndpoint status.policy; undefined when there is no CiliumEndpoint for the pod. */
  readonly enforcement?: { readonly ingress?: boolean; readonly egress?: boolean; readonly state?: string };
  /** Whether a CiliumEndpoint exists for it (a pod without one is not managed by Cilium). */
  readonly managed: boolean;
}

export interface EndpointSources {
  readonly pods: readonly Json[];
  readonly namespaces: readonly Json[];
  readonly ciliumEndpoints: readonly Json[];
  readonly identities: readonly Json[];
}

const enforcementOf = (cep: Json): EndpointInfo["enforcement"] => {
  const policy = cep?.status?.policy;

  if (!isPlainObject(policy)) {
    return undefined;
  }

  const enforcing = (direction: Json) => (typeof direction?.enforcing === "boolean" ? direction.enforcing : undefined);

  return { ingress: enforcing(policy.ingress), egress: enforcing(policy.egress), state: cep?.status?.state };
};

const identityLabels = (identity: Json): Record<string, string> => {
  const security = identity?.["security-labels"];

  return isPlainObject(security) ? parseCiliumLabelList(Object.entries(security).map(([key, value]) => (value === "" ? key : `${key}=${value}`))) : {};
};

/**
 * Lists endpoints from pods (labels as Cilium derives them, enforcement from their CiliumEndpoint),
 * falling back to CiliumEndpoints alone, labelled through their identity, for those without a readable pod.
 */
export const endpointsFrom = ({ pods, namespaces, ciliumEndpoints, identities }: EndpointSources): EndpointInfo[] => {
  const namespaceLabels = new Map<string, Record<string, string>>(namespaces.map((namespace) => [String(namespace?.metadata?.name), { ...(namespace?.metadata?.labels ?? {}) }]));
  const ceps = new Map<string, Json>(ciliumEndpoints.map((cep) => [`${cep?.metadata?.namespace}/${cep?.metadata?.name}`, cep]));
  const identitiesById = new Map<string, Json>(identities.map((identity) => [String(identity?.metadata?.name), identity]));
  const seen = new Set<string>();
  const endpoints: EndpointInfo[] = [];

  for (const pod of pods) {
    const namespace = String(pod?.metadata?.namespace ?? "");
    const name = String(pod?.metadata?.name ?? "");
    const phase = pod?.status?.phase;

    if (pod?.spec?.hostNetwork || phase === "Succeeded" || phase === "Failed") {
      continue;
    }

    const key = `${namespace}/${name}`;
    const cep = ceps.get(key);
    const nsLabels = namespaceLabels.get(namespace) ?? {};

    seen.add(key);
    endpoints.push({
      key,
      namespace,
      name,
      labels: ciliumLabelsOfPod(pod, nsLabels),
      namespaceLabels: nsLabels,
      source: "pod",
      identity: typeof cep?.status?.identity?.id === "number" ? cep.status.identity.id : undefined,
      node: pod?.spec?.nodeName,
      enforcement: cep ? enforcementOf(cep) : undefined,
      managed: cep !== undefined,
    });
  }

  for (const [key, cep] of ceps) {
    if (seen.has(key)) {
      continue;
    }

    const namespace = String(cep?.metadata?.namespace ?? "");
    const identity = cep?.status?.identity;
    const fromStatus = Array.isArray(identity?.labels) ? parseCiliumLabelList(identity.labels) : {};
    const labels = Object.keys(fromStatus).length > 0 ? fromStatus : identityLabels(identitiesById.get(String(identity?.id)));

    endpoints.push({
      key,
      namespace,
      name: String(cep?.metadata?.name ?? ""),
      labels: { "io.kubernetes.pod.namespace": namespace, ...labels },
      namespaceLabels: namespaceLabels.get(namespace) ?? {},
      source: "ciliumendpoint",
      identity: typeof identity?.id === "number" ? identity.id : undefined,
      enforcement: enforcementOf(cep),
      managed: true,
    });
  }

  return endpoints;
};

/** Whether a policy's selector selects an endpoint (host policies select nodes, never endpoints). */
export const modelSelectsEndpoint = (model: PolicyModel, endpoint: Pick<EndpointInfo, "namespace" | "labels">): boolean => {
  if (model.subject === "nodes") {
    return false;
  }

  if (isNamespacedKind(model.kind) && endpoint.namespace !== model.namespace) {
    return false;
  }

  return selectorMatches(selectorToJson(model.selector), endpoint.labels);
};

const mentionsNamespace = (selector: Json) =>
  [...Object.keys(selector?.matchLabels ?? {}), ...((selector?.matchExpressions ?? []) as Json[]).map((expression) => String(expression.key))].some(
    (key) => normalizeCiliumKey(key).key === "io.kubernetes.pod.namespace",
  );

/**
 * Whether a peer of a rule could be an endpoint. Peers that name addresses (CIDR, FQDN) or Services are not
 * resolved against endpoints and count as not matching; entities `cluster` and `all` match every endpoint.
 */
export const peerMatchesEndpoint = (model: PolicyModel, peer: Peer, endpoint: Pick<EndpointInfo, "namespace" | "labels" | "namespaceLabels">): boolean => {
  if (model.kind === "NetworkPolicy") {
    switch (peer.type) {
      case "endpoint":
        return endpoint.namespace === model.namespace && selectorMatches(selectorToJson(peer.selector), endpoint.labels);
      case "namespace": {
        const namespaceOk = peer.namespaceLabels ? selectorMatches(selectorToJson(peer.namespaceLabels), endpoint.namespaceLabels) : peer.namespaceName === endpoint.namespace;

        return namespaceOk && selectorMatches(selectorToJson(peer.podSelector), endpoint.labels);
      }
      default:
        return false;
    }
  }

  switch (peer.type) {
    case "endpoint":
    case "namespace": {
      const selector = ciliumPeerSelector(peer);

      // A CiliumNetworkPolicy's endpoint selectors stay in its namespace unless they name another.
      if (model.kind === "CiliumNetworkPolicy" && !mentionsNamespace(selector) && endpoint.namespace !== model.namespace) {
        return false;
      }

      const labels: Record<string, string> = { ...endpoint.labels };

      for (const [key, value] of Object.entries(endpoint.namespaceLabels)) labels[`io.cilium.k8s.namespace.labels.${key}`] = value;

      return selectorMatches(selector, labels);
    }
    case "entity":
      return (peer.entities ?? []).some((entity) => entity === "cluster" || entity === "all");
    default:
      return false;
  }
};

export interface PolicyStatusSummary {
  readonly conditions: readonly Condition[];
  /** The "Valid" condition when the policy reports one. */
  readonly valid?: { readonly ok: boolean; readonly message?: string };
  /** Per-node enforcement Cilium reported in older versions (status.nodes). */
  readonly nodes?: { readonly total: number; readonly ok: number; readonly enforcing: number; readonly errors: readonly string[] };
}

export const policyStatusOf = (policy: Json): PolicyStatusSummary => {
  const status = policy?.status;
  const conditions = conditionsOf(status ?? {});
  const validCondition = conditions.find((condition) => condition.type === "Valid");
  const nodes = isPlainObject(status?.nodes) ? Object.entries(status.nodes as Record<string, Json>) : undefined;

  return {
    conditions,
    valid: validCondition ? { ok: validCondition.status === "True", message: validCondition.message } : undefined,
    nodes: nodes
      ? {
          total: nodes.length,
          ok: nodes.filter(([, node]) => node?.ok === true).length,
          enforcing: nodes.filter(([, node]) => node?.enforcing === true).length,
          errors: nodes.filter(([, node]) => node?.error).map(([name, node]) => `${name}: ${node.error}`),
        }
      : undefined,
  };
};

export interface PolicyRef {
  readonly kind: string;
  readonly namespace?: string;
  readonly name: string;
  /** `Kind/namespace/name` */
  readonly key: string;
}

export const policyRefOf = (policy: Json): PolicyRef => ({
  kind: String(policy?.kind),
  namespace: policy?.metadata?.namespace,
  name: String(policy?.metadata?.name),
  key: `${policy?.kind}/${policy?.metadata?.namespace ?? ""}/${policy?.metadata?.name}`,
});

export interface NamespaceCoverage {
  readonly namespace: string;
  readonly rows: ReadonlyArray<{ readonly endpoint: EndpointInfo; readonly policies: readonly PolicyRef[] }>;
  readonly unprotected: number;
}

/** Which policies select which endpoint, grouped by namespace, endpoints with no policy counted. */
export const coverageByNamespace = (endpoints: readonly EndpointInfo[], selections: ReadonlyMap<string, readonly string[]>, policies: readonly PolicyRef[]): NamespaceCoverage[] => {
  const byKey = new Map(policies.map((policy) => [policy.key, policy]));
  const groups = new Map<string, Array<{ endpoint: EndpointInfo; policies: PolicyRef[] }>>();

  for (const endpoint of endpoints) {
    const rows = groups.get(endpoint.namespace) ?? [];

    rows.push({ endpoint, policies: (selections.get(endpoint.key) ?? []).map((key) => byKey.get(key)).filter((policy): policy is PolicyRef => policy !== undefined) });
    groups.set(endpoint.namespace, rows);
  }

  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([namespace, rows]) => ({
      namespace,
      rows: rows.sort((a, b) => a.endpoint.name.localeCompare(b.endpoint.name)),
      unprotected: rows.filter((row) => row.policies.length === 0).length,
    }));
};
