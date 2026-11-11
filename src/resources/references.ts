import type { Json } from "../common/json";

export interface Reference {
  readonly label: string;
  readonly kind: string;
  readonly name: string;
  readonly namespace?: string;
  readonly group?: string;
}

const groupOf = (apiVersion: unknown) => (typeof apiVersion === "string" && apiVersion.includes("/") ? apiVersion.split("/")[0] : "");

/**
 * The resources a resource points at, from the fields Cilium and the Gateway API use for references:
 * owners, parentRefs, backendRefs, certificate and parameter refs, BGP peer config refs, and more.
 */
export const findReferences = (resource: Json): Reference[] => {
  const namespace: string | undefined = resource?.metadata?.namespace;
  const spec = resource?.spec ?? {};
  const references: Reference[] = [];
  const add = (reference: Reference) => {
    if (reference.name && !references.some((other) => other.kind === reference.kind && other.name === reference.name && other.namespace === reference.namespace && other.label === reference.label)) {
      references.push(reference);
    }
  };

  for (const owner of (resource?.metadata?.ownerReferences ?? []) as Json[]) {
    add({ label: owner.controller ? "Controller" : "Owner", kind: owner.kind, name: owner.name, namespace, group: groupOf(owner.apiVersion) });
  }

  if (spec.gatewayClassName) {
    add({ label: "GatewayClass", kind: "GatewayClass", name: spec.gatewayClassName, group: "gateway.networking.k8s.io" });
  }

  if (spec.parametersRef?.name) {
    add({ label: "Parameters", kind: spec.parametersRef.kind, name: spec.parametersRef.name, namespace: spec.parametersRef.namespace, group: spec.parametersRef.group });
  }

  const parentRefs = [...((spec.parentRefs ?? []) as Json[]), ...(spec.parentRef ? [spec.parentRef] : [])];

  for (const parent of parentRefs) {
    add({ label: "Parent", kind: parent.kind ?? "Gateway", name: parent.name, namespace: parent.namespace ?? namespace, group: parent.group ?? "gateway.networking.k8s.io" });
  }

  for (const rule of (spec.rules ?? []) as Json[]) {
    for (const backend of (rule.backendRefs ?? []) as Json[]) {
      add({ label: "Backend", kind: backend.kind ?? "Service", name: backend.name, namespace: backend.namespace ?? namespace, group: backend.group ?? "" });
    }

    for (const filter of (rule.filters ?? []) as Json[]) {
      if (filter.requestMirror?.backendRef) {
        add({ label: "Mirror", kind: filter.requestMirror.backendRef.kind ?? "Service", name: filter.requestMirror.backendRef.name, namespace: filter.requestMirror.backendRef.namespace ?? namespace });
      }
    }
  }

  for (const listener of (spec.listeners ?? []) as Json[]) {
    for (const certificate of (listener.tls?.certificateRefs ?? []) as Json[]) {
      add({ label: `TLS of ${listener.name}`, kind: certificate.kind ?? "Secret", name: certificate.name, namespace: certificate.namespace ?? namespace, group: certificate.group ?? "" });
    }
  }

  for (const target of (spec.targetRefs ?? []) as Json[]) {
    add({ label: "Target", kind: target.kind, name: target.name, namespace, group: target.group });
  }

  for (const certificate of (spec.validation?.caCertificateRefs ?? []) as Json[]) {
    add({ label: "CA certificate", kind: certificate.kind ?? "ConfigMap", name: certificate.name, namespace, group: certificate.group });
  }

  for (const instance of (spec.bgpInstances ?? []) as Json[]) {
    for (const peer of (instance.peers ?? []) as Json[]) {
      if (peer.peerConfigRef?.name) {
        add({ label: `Peer config of ${peer.name}`, kind: "CiliumBGPPeerConfig", name: peer.peerConfigRef.name, group: "cilium.io" });
      }
    }
  }

  if (spec.authSecretRef) {
    add({ label: "Auth secret", kind: "Secret", name: spec.authSecretRef, namespace: "kube-system" });
  }

  for (const service of ((spec.redirectFrontend?.serviceMatcher ? [spec.redirectFrontend.serviceMatcher] : []) as Json[])) {
    add({ label: "Frontend service", kind: "Service", name: service.serviceName, namespace: service.namespace ?? namespace });
  }

  for (const service of (spec.services ?? []) as Json[]) {
    if (service.name) {
      add({ label: "Service", kind: "Service", name: service.name, namespace: service.namespace ?? namespace });
    }
  }

  for (const group of [...((spec.ingress ?? []) as Json[]), ...((spec.egress ?? []) as Json[])].flatMap((rule) => [...((rule.fromCIDRSet ?? []) as Json[]), ...((rule.toCIDRSet ?? []) as Json[])])) {
    if (group.cidrGroupRef) {
      add({ label: "CIDR group", kind: "CiliumCIDRGroup", name: group.cidrGroupRef, group: "cilium.io" });
    }
  }

  if (resource?.kind === "CiliumEndpoint" && resource.metadata?.name) {
    add({ label: "Pod", kind: "Pod", name: resource.metadata.name, namespace });

    if (resource.status?.identity?.id !== undefined) {
      add({ label: "Identity", kind: "CiliumIdentity", name: String(resource.status.identity.id), group: "cilium.io" });
    }
  }

  if (resource?.kind === "CiliumNode") {
    add({ label: "Node", kind: "Node", name: resource.metadata.name });
  }

  if (resource?.kind === "CiliumBGPNodeConfig") {
    add({ label: "Node", kind: "Node", name: resource.metadata.name });
  }

  return references;
};
