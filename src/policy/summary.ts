import { describeSelector } from "../common/selectors";
import { selectorToJson } from "./manifest";
import {
  type Direction,
  directionsFor,
  isDeny,
  isEgress,
  isNamespacedKind,
  type Peer,
  type PolicyModel,
  type PortModel,
  type PortRuleModel,
  type RuleModel,
  selectorIsEmpty,
} from "./model";

const describeModelSelector = (selector: Peer["selector"]) => describeSelector(selectorToJson(selector));

export const describePeer = (model: PolicyModel, peer: Peer): string => {
  switch (peer.type) {
    case "endpoint": {
      const scope = isNamespacedKind(model.kind) ? ` in ${model.namespace || "the policy's namespace"}` : "";
      const what = model.kind === "NetworkPolicy" ? "pods" : "endpoints";

      return selectorIsEmpty(peer.selector) ? `all ${what}${scope || " in the cluster"}` : `${what} ${describeModelSelector(peer.selector)}${model.kind === "CiliumClusterwideNetworkPolicy" ? "" : scope}`;
    }
    case "namespace": {
      const namespace = peer.namespaceLabels ? `namespaces ${describeModelSelector(peer.namespaceLabels)}` : `namespace ${peer.namespaceName || "(unnamed)"}`;

      return peer.podSelector && !selectorIsEmpty(peer.podSelector) ? `pods ${describeModelSelector(peer.podSelector)} in ${namespace}` : `all pods in ${namespace}`;
    }
    case "entity":
      return `${(peer.entities ?? []).length === 1 ? "entity" : "entities"} ${(peer.entities ?? []).join(", ") || "(none)"}`;
    case "cidr":
      return `${peer.cidr || "(no CIDR)"}${(peer.except ?? []).length > 0 ? ` except ${peer.except!.join(", ")}` : ""}`;
    case "cidrGroup":
      return `CIDR group ${peer.cidrGroupRef || "(unnamed)"}`;
    case "fqdn":
      return peer.matchPattern !== undefined ? `names matching ${peer.matchPattern || "(empty)"}` : `name ${peer.matchName || "(empty)"}`;
    case "service":
      return peer.selector && !peer.serviceName
        ? `services ${describeModelSelector(peer.selector)}${peer.serviceNamespace ? ` in ${peer.serviceNamespace}` : ""}`
        : `service ${peer.serviceNamespace ? `${peer.serviceNamespace}/` : ""}${peer.serviceName || "(unnamed)"}`;
    case "raw":
      return `${peer.field}: ${JSON.stringify(peer.raw)}`;
  }
};

export const describePort = (port: PortModel, defaultProtocol: string): string => {
  const range = port.port === "" || port.port === "0" ? "any port" : port.endPort !== undefined ? `${port.port}-${port.endPort}` : port.port;

  return `${range}/${port.protocol ?? defaultProtocol}`;
};

export const describeL7 = (portRule: PortRuleModel): string[] => [
  ...portRule.http.map((http) => `HTTP ${http.method || "any method"} ${http.path || "any path"}${http.headers.length > 0 ? ` with ${http.headers.join(", ")}` : ""}`),
  ...portRule.dns.map((dns) => (dns.matchPattern !== undefined ? `DNS pattern ${dns.matchPattern}` : `DNS name ${dns.matchName}`)),
  ...Object.keys(portRule.extraRules ?? {}).map((key) => `${key} rules`),
];

export interface RuleSummary {
  readonly id: string;
  readonly peers: readonly string[];
  readonly ports: readonly string[];
  readonly l7: readonly string[];
  /** One sentence: "Allow from endpoints app=web on 80/TCP (HTTP GET /api)". */
  readonly text: string;
  /** For a Cilium rule with neither peers nor ports: it matches nothing. */
  readonly matchesNothing: boolean;
}

export const summarizeRule = (model: PolicyModel, direction: Direction, rule: RuleModel): RuleSummary => {
  const defaultProtocol = model.kind === "NetworkPolicy" ? "TCP" : "ANY";
  const peers = rule.peers.map((peer) => describePeer(model, peer));
  const ports = rule.portRules.flatMap((portRule) => portRule.ports.map((port) => describePort(port, defaultProtocol)));
  const l7 = rule.portRules.flatMap(describeL7);
  const extras = Object.keys(rule.extra ?? {});
  const matchesNothing = model.kind !== "NetworkPolicy" && rule.peers.length === 0 && rule.portRules.length === 0 && extras.length === 0;
  const verb = isDeny(direction) ? "Deny" : "Allow";
  const preposition = isEgress(direction) ? "to" : "from";
  const text = matchesNothing
    ? `${verb} nothing (an empty rule)`
    : `${verb} ${preposition} ${peers.length > 0 ? peers.join(" or ") : "any peer"} on ${ports.length > 0 ? ports.join(", ") : "every port"}${l7.length > 0 ? ` (${l7.join("; ")})` : ""}${extras.length > 0 ? ` [also: ${extras.join(", ")}]` : ""}`;

  return { id: rule.id, peers, ports, l7, text, matchesNothing };
};

export interface SectionSummary {
  readonly direction: Direction;
  readonly enabled: boolean;
  /** Enabled without rules: everything in this direction is denied unless another policy allows it. */
  readonly defaultDeny: boolean;
  readonly rules: readonly RuleSummary[];
}

export interface PolicySummary {
  readonly subject: string;
  readonly sections: readonly SectionSummary[];
  /** Ingress or egress the policy puts in default-deny for the selected endpoints. */
  readonly enforces: { readonly ingress: boolean; readonly egress: boolean };
}

export const describeSubject = (model: PolicyModel): string => {
  if (model.subject === "nodes") {
    return selectorIsEmpty(model.selector) ? "every node (host policy)" : `nodes ${describeModelSelector(model.selector)} (host policy)`;
  }

  const what = model.kind === "NetworkPolicy" ? "pods" : "endpoints";

  if (model.kind === "CiliumClusterwideNetworkPolicy") {
    return selectorIsEmpty(model.selector) ? `every ${what.slice(0, -1)} in the cluster` : `${what} ${describeModelSelector(model.selector)} in every namespace`;
  }

  return selectorIsEmpty(model.selector) ? `every ${what.slice(0, -1)} in ${model.namespace}` : `${what} ${describeModelSelector(model.selector)} in ${model.namespace}`;
};

export const summarizeModel = (model: PolicyModel): PolicySummary => {
  const sections = directionsFor(model.kind).map((direction) => {
    const section = model.sections[direction];

    return {
      direction,
      enabled: section.enabled,
      defaultDeny: section.enabled && !isDeny(direction) && section.rules.length === 0,
      rules: section.enabled ? section.rules.map((rule) => summarizeRule(model, direction, rule)) : [],
    };
  });

  return {
    subject: describeSubject(model),
    sections,
    enforces: { ingress: model.sections.ingress.enabled, egress: model.sections.egress.enabled },
  };
};
