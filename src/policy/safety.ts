import { type IpRange, parseCidr, rangesOverlap } from "../common/cidr";
import { kubernetesNameError } from "../common/format";
import { systemNamespaces } from "../common/risk";
import {
  addRule,
  type Direction,
  directionLabel,
  directionsFor,
  isDeny,
  isEgress,
  isNamespacedKind,
  l3GroupOf,
  namespaceLabelKey,
  newId,
  newPort,
  newPortRule,
  newRule,
  type Peer,
  peerTypeLabel,
  peerTypesFor,
  type PolicyModel,
  type PortModel,
  type RuleModel,
  selectorIsEmpty,
  supportsL7,
  updateRule,
} from "./model";
import { type EndpointInfo, modelSelectsEndpoint, peerMatchesEndpoint } from "./selection";

// ---- Structural issues: what the API server or Cilium would refuse, or what the builder would leave out ----

export interface ModelIssue {
  readonly level: "error" | "warning";
  readonly message: string;
  readonly direction?: Direction;
  readonly ruleId?: string;
}

export interface Capabilities {
  /** CiliumCIDRGroup is installed. */
  readonly cidrGroups: boolean;
}

const portNamePattern = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

const portIssue = (port: PortModel, kind: PolicyModel["kind"]): string | undefined => {
  if (port.port === "") {
    return kind === "NetworkPolicy" ? undefined : "A port is empty; use 0 for every port";
  }

  if (/^\d+$/.test(port.port)) {
    const number = Number(port.port);

    if (number < 0 || number > 65535 || (kind === "NetworkPolicy" && number === 0)) return `Port ${port.port} is out of range`;
    if (port.endPort !== undefined && (port.endPort < number || port.endPort > 65535)) return `End port ${port.endPort} must be between ${port.port} and 65535`;

    return undefined;
  }

  if (port.port.length > 15 || !portNamePattern.test(port.port)) return `"${port.port}" is neither a port number nor a valid port name`;
  if (port.endPort !== undefined) return `End port needs a numeric port, not the named port "${port.port}"`;

  return undefined;
};

const selectorIssues = (selector: Peer["selector"], what: string): string[] =>
  (selector?.matchExpressions ?? []).flatMap((expression) => [
    ...(!expression.key ? [`${what}: an expression has no key`] : []),
    ...((expression.operator === "In" || expression.operator === "NotIn") && expression.values.length === 0 ? [`${what}: "${expression.key}" ${expression.operator} needs at least one value`] : []),
  ]);

const peerIssues = (peer: Peer): string[] => {
  switch (peer.type) {
    case "endpoint":
      return selectorIssues(peer.selector, "Endpoint selector");
    case "namespace":
      return [...(!peer.namespaceLabels && !peer.namespaceName ? ["A namespace peer has no namespace"] : []), ...selectorIssues(peer.podSelector, "Pod selector")];
    case "entity":
      return (peer.entities ?? []).length === 0 ? ["An entity peer names no entity"] : [];
    case "cidr": {
      const range = parseCidr(peer.cidr ?? "");

      if (!peer.cidr || !range || !peer.cidr.includes("/")) return [`"${peer.cidr ?? ""}" is not a CIDR (address/prefix)`];

      return (peer.except ?? []).flatMap((except) => {
        const inner = parseCidr(except);

        if (!inner || !except.includes("/")) return [`Exception "${except}" is not a CIDR`];

        return inner.family === range.family && inner.start >= range.start && inner.end <= range.end ? [] : [`Exception ${except} is not inside ${peer.cidr}`];
      });
    }
    case "cidrGroup":
      return peer.cidrGroupRef ? [] : ["A CIDR group peer names no CiliumCIDRGroup"];
    case "fqdn":
      return (peer.matchPattern ?? peer.matchName ?? "").trim() === "" ? ["An FQDN peer has no name or pattern"] : [];
    case "service":
      return !peer.serviceName && !peer.selector ? ["A service peer has neither a name nor a selector"] : [];
    case "raw":
      return [];
  }
};

/** What is wrong with the model before it is even sent: refused by Cilium/Kubernetes, or left out of the manifest. */
export const policyModelIssues = (model: PolicyModel, capabilities: Capabilities): ModelIssue[] => {
  const issues: ModelIssue[] = [];
  const nameError = model.name ? kubernetesNameError(model.name) : "A name is required";

  if (nameError) issues.push({ level: "error", message: `Name: ${nameError}` });
  if (isNamespacedKind(model.kind) && !model.namespace) issues.push({ level: "error", message: "A namespace is required" });
  if (model.subject === "nodes" && model.kind !== "CiliumClusterwideNetworkPolicy") issues.push({ level: "error", message: "Only a CiliumClusterwideNetworkPolicy can select nodes" });

  for (const message of selectorIssues(model.selector, model.subject === "nodes" ? "Node selector" : "Selector")) issues.push({ level: "error", message });

  const allowed = directionsFor(model.kind);

  for (const direction of ["ingress", "egress", "ingressDeny", "egressDeny"] as const) {
    const section = model.sections[direction];

    if (!section.enabled) continue;

    if (!allowed.includes(direction)) {
      issues.push({ level: "error", direction, message: `${model.kind} has no ${directionLabel[direction].toLowerCase()} rules; they are left out` });
      continue;
    }

    const types = peerTypesFor(model.kind, direction, capabilities);

    for (const rule of section.rules) {
      const at = { direction, ruleId: rule.id };
      const groups = new Set(rule.peers.map(l3GroupOf));

      if (model.kind !== "NetworkPolicy" && groups.size > 1) {
        issues.push({ level: "error", ...at, message: `Cilium refuses a rule combining ${[...groups].join(" and ")}: split it into one rule per peer type` });
      }

      for (const peer of rule.peers) {
        if (peer.type === "raw" ? model.kind === "NetworkPolicy" !== (peer.field === "from" || peer.field === "to") : !types.includes(peer.type)) {
          issues.push({ level: "error", ...at, message: `${peerTypeLabel[peer.type]} peers are not supported in ${model.kind} ${directionLabel[direction].toLowerCase()} rules; it is left out` });
        }

        for (const message of peerIssues(peer)) issues.push({ level: "error", ...at, message });
      }

      for (const portRule of rule.portRules) {
        for (const port of portRule.ports) {
          const message = portIssue(port, model.kind);

          if (message) issues.push({ level: "error", ...at, message });
        }

        const hasL7 = portRule.http.length > 0 || portRule.dns.length > 0;

        if (hasL7 && !supportsL7(model.kind, direction)) {
          issues.push({ level: "warning", ...at, message: `L7 rules are not supported in ${model.kind === "NetworkPolicy" ? "a NetworkPolicy" : "deny rules"}; they are left out` });
        } else if (hasL7) {
          if (portRule.ports.length === 0) issues.push({ level: "error", ...at, message: "L7 rules need at least one port" });
          if (portRule.http.length > 0 && portRule.dns.length > 0) issues.push({ level: "error", ...at, message: "A port rule takes HTTP or DNS rules, not both" });
          if (portRule.http.length > 0 && portRule.ports.some((port) => port.protocol === "UDP" || port.protocol === "SCTP")) {
            issues.push({ level: "error", ...at, message: "HTTP rules need TCP ports" });
          }
          if (portRule.dns.length > 0 && !isEgress(direction)) issues.push({ level: "warning", ...at, message: "DNS rules belong on egress rules towards the DNS server" });
          if (portRule.dns.some((dns) => (dns.matchPattern ?? dns.matchName ?? "").trim() === "")) issues.push({ level: "error", ...at, message: "A DNS rule has no name or pattern" });
        }

        if (model.kind === "NetworkPolicy" && portRule.ports.some((port) => port.protocol === "ANY")) {
          issues.push({ level: "warning", ...at, message: "NetworkPolicy has no ANY protocol; such ports are written without a protocol (TCP)" });
        }
      }
    }
  }

  return issues;
};

// ---- Safety checks: valid policies that may break things ----

export type SafetyLevel = "info" | "warning" | "danger";

export type SafetyFix = "allow-dns";

export interface SafetyFinding {
  readonly id: string;
  readonly level: SafetyLevel;
  readonly message: string;
  /** A change the builder can make to address the finding. */
  readonly fix?: SafetyFix;
}

export interface SafetyContext {
  /** The namespace Cilium runs in. */
  readonly ciliumNamespace?: string;
  /** Pod CIDRs of the cluster (CiliumNode spec.ipam.podCIDRs), when readable. */
  readonly podCIDRs?: readonly string[];
  /** The cluster's endpoints, when readable, for checks that need to know what a selector selects. */
  readonly endpoints?: readonly EndpointInfo[];
}

type Target = Pick<EndpointInfo, "namespace" | "labels" | "namespaceLabels">;

const kubeDnsTarget = (context: SafetyContext): Target => {
  const real = context.endpoints?.find((endpoint) => endpoint.namespace === "kube-system" && endpoint.labels["k8s-app"] === "kube-dns");

  return (
    real ?? {
      namespace: "kube-system",
      labels: { "k8s-app": "kube-dns", "io.kubernetes.pod.namespace": "kube-system" },
      namespaceLabels: { "kubernetes.io/metadata.name": "kube-system" },
    }
  );
};

/** Whether a rule's ports let `port`/`protocol` through. Named ports match by the names kube-dns uses for 53. */
export const portsAllow = (rule: RuleModel, port: number, protocol: "TCP" | "UDP", names: readonly string[] = []): boolean => {
  if (rule.portRules.length === 0) {
    return true;
  }

  return rule.portRules.some((portRule) =>
    portRule.ports.length === 0
      ? true
      : portRule.ports.some((candidate) => {
          const protocolOk = candidate.protocol === undefined || candidate.protocol === "ANY" || candidate.protocol === protocol;

          if (!protocolOk) return false;
          if (candidate.port === "" || candidate.port === "0") return true;
          if (/^\d+$/.test(candidate.port)) {
            const start = Number(candidate.port);

            return port >= start && port <= (candidate.endPort ?? start);
          }

          return names.includes(candidate.port);
        }),
  );
};

const isKubeDnsService = (peer: Peer) => peer.type === "service" && peer.serviceName === "kube-dns" && (peer.serviceNamespace ?? "") === "kube-system";

const ruleReaches = (model: PolicyModel, rule: RuleModel, target: Target) =>
  rule.peers.length === 0 ? model.kind === "NetworkPolicy" || rule.portRules.length > 0 : rule.peers.some((peer) => isKubeDnsService(peer) || peerMatchesEndpoint(model, peer, target));

const dnsNames = { UDP: ["dns"], TCP: ["dns-tcp"] } as const;

/** The egress rules that let DNS (53, by `protocol`) reach kube-dns. */
const dnsRules = (model: PolicyModel, context: SafetyContext, protocol: "TCP" | "UDP", direction: Direction = "egress") =>
  model.sections[direction].rules.filter((rule) => ruleReaches(model, rule, kubeDnsTarget(context)) && portsAllow(rule, 53, protocol, dnsNames[protocol]));

const hasEntity = (rule: RuleModel, entities: readonly string[]) => rule.peers.some((peer) => peer.type === "entity" && (peer.entities ?? []).some((entity) => entities.includes(entity)));

/** Translates a Cilium DNS pattern (`*` wildcards) into a test. */
export const dnsPatternMatches = (pattern: string, name: string): boolean => {
  const normalize = (text: string) => text.trim().toLowerCase().replace(/\.$/, "");
  const expression = normalize(pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(pattern.trim() === "*" ? ".*" : "[-a-z0-9_.]*");

  return new RegExp(`^${expression}$`).test(normalize(name));
};

const findingsForSubject = (model: PolicyModel, context: SafetyContext, findings: SafetyFinding[]) => {
  const system = new Set([...systemNamespaces.filter((namespace) => namespace !== "kube-public" && namespace !== "kube-node-lease"), ...(context.ciliumNamespace ? [context.ciliumNamespace] : [])]);

  if (model.subject === "nodes") {
    if (selectorIsEmpty(model.selector)) {
      findings.push({ id: "empty-selector", level: "warning", message: "The node selector is empty: this host policy applies to every node, control-plane nodes included. Make sure SSH, the kubelet and the API server stay reachable." });
    }

    return;
  }

  if (selectorIsEmpty(model.selector)) {
    findings.push(
      model.kind === "CiliumClusterwideNetworkPolicy"
        ? { id: "empty-selector", level: "danger", message: "The endpoint selector is empty: this policy applies to every endpoint in the cluster, system components (DNS, Cilium, ingress controllers) included." }
        : { id: "empty-selector", level: "warning", message: `The ${model.kind === "NetworkPolicy" ? "pod" : "endpoint"} selector is empty: this policy applies to every ${model.kind === "NetworkPolicy" ? "pod" : "endpoint"} in namespace "${model.namespace}".` },
    );
  }

  if (context.endpoints) {
    const selected = context.endpoints.filter((endpoint) => system.has(endpoint.namespace) && modelSelectsEndpoint(model, endpoint));

    if (selected.length > 0) {
      const namespaces = [...new Set(selected.map((endpoint) => endpoint.namespace))];

      findings.push({
        id: "system-namespace",
        level: "warning",
        message: `This policy selects ${selected.length} endpoint${selected.length === 1 ? "" : "s"} in ${namespaces.join(", ")} (${selected.slice(0, 5).map((endpoint) => endpoint.name).join(", ")}${selected.length > 5 ? ", …" : ""}). A mistake there can break DNS, Cilium itself or the whole cluster.`,
      });
    }
  } else if (isNamespacedKind(model.kind) ? system.has(model.namespace) : true) {
    const pinned = Object.keys(model.selector.matchLabels).some((key) => key.replace(/^(k8s|any):/, "") === "io.kubernetes.pod.namespace");

    if (isNamespacedKind(model.kind) || !pinned) {
      findings.push({
        id: "system-namespace",
        level: "warning",
        message: isNamespacedKind(model.kind)
          ? `This policy is in the system namespace "${model.namespace}": a mistake can break DNS, Cilium itself or the whole cluster.`
          : `This policy is not limited to a namespace, so it may select endpoints in ${[...system].join(", ")}.`,
      });
    }
  }
};

/** Checks a policy for what commonly breaks clusters. These are warnings to read before applying, never a block. */
export const policySafetyFindings = (model: PolicyModel, context: SafetyContext = {}): SafetyFinding[] => {
  const findings: SafetyFinding[] = [];
  const cilium = model.kind !== "NetworkPolicy";
  const { ingress, egress, ingressDeny, egressDeny } = model.sections;

  findingsForSubject(model, context, findings);

  // Default deny from an empty section.
  for (const [direction, section] of [["ingress", ingress], ["egress", egress]] as const) {
    if (section.enabled && section.rules.length === 0) {
      findings.push({
        id: `default-deny-${direction}`,
        level: "warning",
        message: `The ${direction} section is empty: all ${direction} traffic of the selected ${model.subject === "nodes" ? "nodes" : "endpoints"} is denied, except what other policies allow (default deny).`,
      });
    }
  }

  if (cilium) {
    for (const [direction, section] of [["ingressDeny", ingressDeny], ["egressDeny", egressDeny]] as const) {
      if (section.enabled && section.rules.length === 0) {
        findings.push({ id: `empty-${direction}`, level: "info", message: `The ${directionLabel[direction].toLowerCase()} section is empty: it denies nothing.` });
      }
    }
  }

  // DNS to kube-dns.
  if (egress.enabled && model.subject === "endpoints") {
    const udp = dnsRules(model, context, "UDP");
    const tcp = dnsRules(model, context, "TCP");

    if (udp.length === 0) {
      findings.push({
        id: "dns-blocked",
        level: "warning",
        message: "Egress is restricted but DNS to kube-dns (kube-system, k8s-app=kube-dns, port 53 UDP/TCP) is not allowed: name resolution of the selected endpoints will fail unless another policy allows it.",
        fix: "allow-dns",
      });
    } else if (tcp.length === 0) {
      findings.push({ id: "dns-tcp", level: "info", message: "DNS to kube-dns is allowed over UDP only: large DNS answers fall back to TCP port 53 and would be dropped." });
    }
  }

  if (cilium && egressDeny.enabled && egressDeny.rules.some((rule) => ruleReaches(model, rule, kubeDnsTarget(context)) && portsAllow(rule, 53, "UDP", dnsNames.UDP))) {
    findings.push({ id: "dns-denied", level: "danger", message: "An egress deny rule matches DNS to kube-dns: deny overrides every allow, so name resolution of the selected endpoints fails." });
  }

  // toFQDNs need the DNS proxy to see the lookups.
  const fqdnPeers = egress.rules.flatMap((rule) => rule.peers.filter((peer) => peer.type === "fqdn"));

  if (cilium && egress.enabled && fqdnPeers.length > 0) {
    const dnsL7 = egress.rules.flatMap((rule) => rule.portRules.flatMap((portRule) => portRule.dns));

    if (dnsL7.length === 0) {
      findings.push({
        id: "fqdn-without-dns-rule",
        level: "warning",
        message: "toFQDNs rules only work when Cilium's DNS proxy sees the lookups: add an egress rule to kube-dns on port 53 with a DNS rule (for example matchPattern \"*\"). Without it the FQDN rules never match.",
        fix: "allow-dns",
      });
    } else {
      const patterns = dnsL7.map((dns) => dns.matchPattern ?? dns.matchName ?? "");
      const uncovered = fqdnPeers
        .map((peer) => peer.matchName ?? peer.matchPattern ?? "")
        .filter((name) => name && !patterns.some((pattern) => pattern.trim() === "*" || pattern === name || (!name.includes("*") && dnsPatternMatches(pattern, name))));

      if (uncovered.length > 0) {
        findings.push({ id: "fqdn-not-covered", level: "warning", message: `The DNS rules do not allow looking up ${uncovered.join(", ")}: the DNS proxy refuses those lookups, so the FQDN rules for them never match.` });
      }
    }
  }

  // The API server.
  if (egress.enabled && model.subject === "endpoints") {
    const reaches = egress.rules.some((rule) => (rule.peers.length === 0 && (model.kind === "NetworkPolicy" || rule.portRules.length > 0)) || hasEntity(rule, ["kube-apiserver", "cluster", "all"]));
    const maybeByCidr = egress.rules.some((rule) => rule.peers.some((peer) => peer.type === "cidr" || peer.type === "cidrGroup"));

    if (!reaches) {
      findings.push({
        id: "apiserver-blocked",
        level: maybeByCidr ? "info" : "warning",
        message: `Egress is restricted and no rule allows the Kubernetes API server${cilium ? " (entity kube-apiserver)" : ""}${maybeByCidr ? " unless one of the CIDR rules covers its address" : ""}: workloads that talk to the API (operators, controllers, service-account clients) lose access.`,
      });
    }
  }

  if (cilium && egressDeny.enabled && egressDeny.rules.some((rule) => hasEntity(rule, ["kube-apiserver", "cluster", "all"]))) {
    findings.push({ id: "apiserver-denied", level: "danger", message: "An egress deny rule matches the Kubernetes API server (kube-apiserver, cluster or all): the selected workloads cannot reach the API, whatever other policies allow." });
  }

  // Broad deny rules.
  for (const direction of ["ingressDeny", "egressDeny"] as const) {
    if (!cilium || !model.sections[direction].enabled) continue;

    for (const rule of model.sections[direction].rules) {
      if (hasEntity(rule, ["all"])) {
        findings.push({ id: `deny-all-${direction}`, level: "danger", message: `A ${directionLabel[direction].toLowerCase()} rule names the entity "all": it denies all ${isEgress(direction) ? "egress" : "ingress"} traffic${rule.portRules.length > 0 ? " on its ports" : ""}, and deny overrides every allow in every policy.` });
      } else if (hasEntity(rule, ["world"])) {
        findings.push({ id: `deny-world-${direction}`, level: "warning", message: `A ${directionLabel[direction].toLowerCase()} rule names the entity "world": all traffic ${isEgress(direction) ? "to" : "from"} outside the cluster is denied${rule.portRules.length > 0 ? " on its ports" : ""}, overriding allow rules such as toFQDNs or CIDR rules.` });
      }
    }
  }

  // CIDR rules over pod CIDRs.
  const podRanges = (context.podCIDRs ?? []).map(parseCidr).filter((range): range is IpRange => range !== undefined);

  if (podRanges.length > 0) {
    const reported = new Set<string>();

    for (const direction of directionsFor(model.kind)) {
      if (!model.sections[direction].enabled) continue;

      for (const peer of model.sections[direction].rules.flatMap((rule) => rule.peers)) {
        const range = peer.type === "cidr" ? parseCidr(peer.cidr ?? "") : undefined;

        if (!range || !peer.cidr?.includes("/") || peer.cidr.endsWith("/0")) continue;

        const excepts = (peer.except ?? []).map(parseCidr).filter((except): except is IpRange => except !== undefined);

        for (const pod of podRanges) {
          const covered = excepts.some((except) => except.family === pod.family && except.start <= pod.start && except.end >= pod.end);

          if (rangesOverlap(range, pod) && !covered && !reported.has(`${peer.cidr}|${pod.label}`)) {
            reported.add(`${peer.cidr}|${pod.label}`);
            findings.push({
              id: `cidr-overlap-${peer.cidr}-${pod.label}`,
              level: "warning",
              message: `${isDeny(direction) ? "Deny" : "Allow"} rule CIDR ${peer.cidr} overlaps the pod CIDR ${pod.label}. ${cilium ? "Cilium matches pods by identity, not by CIDR, so this rule does not affect pod traffic as it seems to; select the pods with an endpoint or namespace peer instead." : "Pod IPs change; select the pods with a pod or namespace selector instead."}`,
            });
          }
        }
      }
    }
  }

  const order: Record<SafetyLevel, number> = { danger: 0, warning: 1, info: 2 };

  return findings.sort((a, b) => order[a.level] - order[b.level]);
};

// ---- Fixes ----

/**
 * Allows DNS to kube-dns on 53 UDP and TCP, with a Cilium DNS rule (matchPattern "*") so toFQDNs rules work.
 * A rule already reaching kube-dns on 53 gets the DNS rule added rather than a duplicate rule.
 */
export const allowKubeDns = (model: PolicyModel, context: SafetyContext = {}): PolicyModel => {
  const cilium = model.kind !== "NetworkPolicy";
  const existing = model.sections.egress.enabled ? dnsRules(model, context, "UDP").find((rule) => rule.peers.length > 0) : undefined;

  if (existing) {
    if (!cilium || existing.portRules.some((portRule) => portRule.dns.length > 0)) {
      return model;
    }

    return updateRule(model, "egress", existing.id, (rule) => ({
      ...rule,
      portRules:
        rule.portRules.length === 0
          ? [{ ...newPortRule([newPort("53", "UDP"), newPort("53", "TCP")]), dns: [{ id: newId("dns"), matchPattern: "*" }] }]
          : rule.portRules.map((portRule) =>
              portRule.http.length === 0 && portRule.ports.some((port) => port.port === "53" || port.port === "dns") ? { ...portRule, dns: [{ id: newId("dns"), matchPattern: "*" }] } : portRule,
            ),
    }));
  }

  const peer: Peer = cilium
    ? { id: newId("peer"), type: "endpoint", selector: { matchLabels: { [namespaceLabelKey]: "kube-system", "k8s:k8s-app": "kube-dns" }, matchExpressions: [] } }
    : { id: newId("peer"), type: "namespace", namespaceName: "kube-system", podSelector: { matchLabels: { "k8s-app": "kube-dns" }, matchExpressions: [] } };
  const portRule = { ...newPortRule([newPort("53", "UDP"), newPort("53", "TCP")]), ...(cilium ? { dns: [{ id: newId("dns"), matchPattern: "*" }] } : {}) };

  return addRule(model, "egress", { ...newRule([peer]), portRules: [portRule] });
};

export const applyFix = (model: PolicyModel, fix: SafetyFix, context: SafetyContext = {}): PolicyModel => {
  switch (fix) {
    case "allow-dns":
      return allowKubeDns(model, context);
  }
};
