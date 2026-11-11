import type { BuiltinResource } from "../kube/snapshot";

/** The Cilium and Gateway API kinds the topology reads; ones the cluster does not serve are reported, not guessed. */
export const topologyKinds = [
  "Gateway",
  "HTTPRoute",
  "GRPCRoute",
  "TLSRoute",
  "TCPRoute",
  "UDPRoute",
  "CiliumNetworkPolicy",
  "CiliumClusterwideNetworkPolicy",
  "CiliumEndpoint",
  "CiliumIdentity",
  "CiliumBGPClusterConfig",
  "CiliumBGPPeerConfig",
  "CiliumBGPAdvertisement",
  "CiliumBGPNodeConfig",
  "CiliumBGPPeeringPolicy",
  "CiliumLoadBalancerIPPool",
  "CiliumL2AnnouncementPolicy",
  "CiliumEgressGatewayPolicy",
  "CiliumEnvoyConfig",
  "CiliumClusterwideEnvoyConfig",
] as const;

export type TopologyKind = (typeof topologyKinds)[number];

export const topologyBuiltins = [
  "services",
  "endpointslices.discovery.k8s.io",
  "pods",
  "nodes",
  "namespaces",
  "networkpolicies.networking.k8s.io",
] as const satisfies readonly BuiltinResource[];

export const routeKinds = ["HTTPRoute", "GRPCRoute", "TLSRoute", "TCPRoute", "UDPRoute"] as const;
