/** The kinds the map shows, by their Kubernetes `kind`. */
export const kindNames = [
  "GatewayClass",
  "Gateway",
  "ListenerSet",
  "HTTPRoute",
  "GRPCRoute",
  "TLSRoute",
  "TCPRoute",
  "UDPRoute",
  "CiliumEnvoyConfig",
  "CiliumLoadBalancerIPPool",
  "Service",
] as const;

export type KindName = (typeof kindNames)[number];

/** Kinds the Gateway Designer builds, so the map can open them there. */
export const designerKindNames: readonly string[] = ["GatewayClass", "Gateway", "HTTPRoute", "GRPCRoute", "TLSRoute", "TCPRoute", "UDPRoute"];
