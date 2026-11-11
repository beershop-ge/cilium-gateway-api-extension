import { coreV1, getKubeResourceKind, getKubernetesApiVersion, serviceKind } from "@k8slens/kubernetes-contracts";

// Only what navigating to a resource's details takes: the kind and the version it is served in.
type Shape = { metadata: { name: string; namespace?: string } };

export const gatewayV1 = getKubernetesApiVersion("gateway.networking.k8s.io/v1");
export const ciliumV2 = getKubernetesApiVersion("cilium.io/v2");

export const gatewayClassKind = getKubeResourceKind<{ "gateway.networking.k8s.io/v1": Shape }>("GatewayClass");
export const gatewayKind = getKubeResourceKind<{ "gateway.networking.k8s.io/v1": Shape }>("Gateway");
export const listenerSetKind = getKubeResourceKind<{ "gateway.networking.k8s.io/v1": Shape }>("ListenerSet");
export const httpRouteKind = getKubeResourceKind<{ "gateway.networking.k8s.io/v1": Shape }>("HTTPRoute");
export const grpcRouteKind = getKubeResourceKind<{ "gateway.networking.k8s.io/v1": Shape }>("GRPCRoute");
export const tlsRouteKind = getKubeResourceKind<{ "gateway.networking.k8s.io/v1": Shape }>("TLSRoute");
export const tcpRouteKind = getKubeResourceKind<{ "gateway.networking.k8s.io/v1": Shape }>("TCPRoute");
export const udpRouteKind = getKubeResourceKind<{ "gateway.networking.k8s.io/v1": Shape }>("UDPRoute");
export const ciliumEnvoyConfigKind = getKubeResourceKind<{ "cilium.io/v2": Shape }>("CiliumEnvoyConfig");
export const ciliumLoadBalancerIpPoolKind = getKubeResourceKind<{ "cilium.io/v2": Shape }>("CiliumLoadBalancerIPPool");

/** The kinds the map shows, by their Kubernetes `kind`, with what opening their details takes. */
export const kindsByName = {
  GatewayClass: { kind: gatewayClassKind, apiVersion: gatewayV1 },
  Gateway: { kind: gatewayKind, apiVersion: gatewayV1 },
  ListenerSet: { kind: listenerSetKind, apiVersion: gatewayV1 },
  HTTPRoute: { kind: httpRouteKind, apiVersion: gatewayV1 },
  GRPCRoute: { kind: grpcRouteKind, apiVersion: gatewayV1 },
  TLSRoute: { kind: tlsRouteKind, apiVersion: gatewayV1 },
  TCPRoute: { kind: tcpRouteKind, apiVersion: gatewayV1 },
  UDPRoute: { kind: udpRouteKind, apiVersion: gatewayV1 },
  CiliumEnvoyConfig: { kind: ciliumEnvoyConfigKind, apiVersion: ciliumV2 },
  CiliumLoadBalancerIPPool: { kind: ciliumLoadBalancerIpPoolKind, apiVersion: ciliumV2 },
  Service: { kind: serviceKind, apiVersion: coreV1 },
} as const;

export type KindName = keyof typeof kindsByName;
