import type { Json } from "./json";

export interface LabelSelector {
  readonly matchLabels?: Readonly<Record<string, string>>;
  readonly matchExpressions?: ReadonlyArray<{ readonly key: string; readonly operator: string; readonly values?: readonly string[] }>;
}

/**
 * Cilium writes label keys with a source prefix (`k8s:app`, `any:app`, `reserved:host`).
 * Kubernetes labels of a pod are `k8s:` labels; `any:` matches any source.
 */
export const normalizeCiliumKey = (key: string): { source: string; key: string } => {
  const match = /^(k8s|any|reserved|cidr|fqdn|container|unspec|cilium-generated):(.*)$/.exec(key);

  return match ? { source: match[1], key: match[2] } : { source: "any", key };
};

const labelValue = (labels: Readonly<Record<string, string>>, rawKey: string): string | undefined => {
  const { source, key } = normalizeCiliumKey(rawKey);

  if (source !== "k8s" && source !== "any") {
    return labels[`${source}:${key}`];
  }

  return labels[key] ?? labels[`k8s:${key}`];
};

/** Whether `labels` match a Kubernetes or Cilium label selector. An empty selector matches everything. */
export const selectorMatches = (selector: LabelSelector | undefined | null, labels: Readonly<Record<string, string>>): boolean => {
  if (!selector) {
    return true;
  }

  for (const [key, value] of Object.entries(selector.matchLabels ?? {})) {
    if (labelValue(labels, key) !== value) {
      return false;
    }
  }

  for (const expression of selector.matchExpressions ?? []) {
    const value = labelValue(labels, expression.key);
    const values = expression.values ?? [];

    switch (expression.operator) {
      case "In":
        if (value === undefined || !values.includes(value)) return false;
        break;
      case "NotIn":
        if (value !== undefined && values.includes(value)) return false;
        break;
      case "Exists":
        if (value === undefined) return false;
        break;
      case "DoesNotExist":
        if (value !== undefined) return false;
        break;
      default:
        return false;
    }
  }

  return true;
};

export const isEmptySelector = (selector: LabelSelector | undefined | null) =>
  !selector || (Object.keys(selector.matchLabels ?? {}).length === 0 && (selector.matchExpressions ?? []).length === 0);

export const describeSelector = (selector: LabelSelector | undefined | null): string => {
  if (isEmptySelector(selector)) {
    return "all";
  }

  const parts = [
    ...Object.entries(selector?.matchLabels ?? {}).map(([key, value]) => `${key}=${value}`),
    ...(selector?.matchExpressions ?? []).map((expression) =>
      expression.operator === "Exists" ? expression.key : expression.operator === "DoesNotExist" ? `!${expression.key}` : `${expression.key} ${expression.operator === "In" ? "in" : "notin"} (${(expression.values ?? []).join(",")})`,
    ),
  ];

  return parts.join(", ");
};

/** The labels Cilium sees for a pod: its own, plus its namespace (and, when known, its namespace's labels). */
export const ciliumLabelsOfPod = (pod: Json, namespaceLabels: Readonly<Record<string, string>> = {}): Record<string, string> => {
  const labels: Record<string, string> = { ...(pod?.metadata?.labels ?? {}) };
  const namespace = pod?.metadata?.namespace;

  if (namespace) {
    labels["io.kubernetes.pod.namespace"] = namespace;
  }

  if (pod?.spec?.serviceAccountName) {
    labels["io.cilium.k8s.policy.serviceaccount"] = pod.spec.serviceAccountName;
  }

  for (const [key, value] of Object.entries(namespaceLabels)) {
    labels[`io.cilium.k8s.namespace.labels.${key}`] = value;
  }

  return labels;
};

/** Parses CiliumIdentity / CiliumEndpoint label strings such as `k8s:app=web` into a record. */
export const parseCiliumLabelList = (list: readonly string[] | undefined): Record<string, string> => {
  const labels: Record<string, string> = {};

  for (const entry of list ?? []) {
    const separator = entry.indexOf("=");
    const rawKey = separator >= 0 ? entry.slice(0, separator) : entry;
    const value = separator >= 0 ? entry.slice(separator + 1) : "";
    const { source, key } = normalizeCiliumKey(rawKey);

    labels[source === "k8s" || source === "any" ? key : `${source}:${key}`] = value;
  }

  return labels;
};
