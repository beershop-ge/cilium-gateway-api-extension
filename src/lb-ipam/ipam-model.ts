import { parseCidr, rangeContains, rangeSize } from "../common/cidr";
import type { Json } from "../common/json";

/*
 * Cilium pod IPAM: what each CiliumNode is given (spec.ipam, written by the operator) and uses
 * (status.ipam, written by the agent). Pure functions only.
 */

export interface IpamModeInfo {
  readonly mode: string;
  readonly label: string;
  readonly description: string;
}

const modes: Record<string, Omit<IpamModeInfo, "mode">> = {
  "cluster-pool": { label: "Cluster scope (cluster-pool)", description: "The operator carves per-node pod CIDRs out of cluster-wide CIDRs and writes them to each CiliumNode." },
  kubernetes: { label: "Kubernetes host scope", description: "Pod CIDRs come from each Node's spec.podCIDRs, as allocated by kube-controller-manager." },
  "multi-pool": { label: "Multi-pool", description: "Nodes get CIDRs from several CiliumPodIPPools on demand; pods pick a pool by annotation or selector." },
  eni: { label: "AWS ENI", description: "The operator attaches ENIs and secondary IPs to each node; they appear in the CiliumNode's spec.ipam.pool." },
  azure: { label: "Azure", description: "The operator allocates Azure interface IPs; they appear in the CiliumNode's spec.ipam.pool." },
  alibabacloud: { label: "Alibaba Cloud ENI", description: "The operator allocates ENI IPs; they appear in the CiliumNode's spec.ipam.pool." },
  crd: { label: "CRD-backed", description: "An external operator writes the IPs each node may use to its CiliumNode's spec.ipam.pool." },
  "delegated-plugin": { label: "Delegated plugin", description: "IPs come from another CNI IPAM plugin; Cilium does not track them in CiliumNodes." },
};

/** The IPAM mode from cilium-config (`ipam`); Cilium's default is cluster-pool. */
export const ipamMode = (config: Readonly<Record<string, string>> | undefined): IpamModeInfo | undefined => {
  if (!config) {
    return undefined;
  }

  const mode = config.ipam || "cluster-pool";

  return { mode, ...(modes[mode] ?? { label: mode, description: "An IPAM mode this view does not know." }) };
};

export interface NodePoolAllocation {
  readonly pool: string;
  readonly cidrs: readonly string[];
  readonly capacity: bigint;
  readonly used: number;
}

export interface NodeIpam {
  readonly node: string;
  readonly podCIDRs: readonly string[];
  /** Addresses the node may hand out: the size of its pod CIDRs, or the count of IPs in spec.ipam.pool. */
  readonly capacity: bigint;
  readonly capacitySource: "podCIDRs" | "pool" | "pools" | "none";
  /** Addresses in use on the node (status.ipam.used): runtime state reported by the agent. */
  readonly used: number;
  readonly pools: readonly NodePoolAllocation[];
  readonly requested: ReadonlyArray<{ readonly pool: string; readonly needed?: Json }>;
  readonly operatorError?: string;
  readonly preAllocate?: number;
  readonly minAllocate?: number;
  readonly maxAboveWatermark?: number;
  readonly releasing: number;
}

const cidrSize = (cidr: string) => {
  const range = parseCidr(cidr);

  return range ? rangeSize(range) : 0n;
};

export const nodeIpam = (ciliumNode: Json): NodeIpam => {
  const spec = ciliumNode?.spec?.ipam ?? {};
  const status = ciliumNode?.status?.ipam ?? {};
  const usedIps = Object.keys(status.used ?? {});
  const podCIDRs: string[] = spec.podCIDRs ?? [];
  const poolIps = Object.keys(spec.pool ?? {});
  const allocations = ((spec.pools?.allocated ?? []) as Json[]).map((allocation) => {
    const cidrs: string[] = allocation?.cidrs ?? [];
    const ranges = cidrs.map(parseCidr).filter((range) => range !== undefined);

    return {
      pool: String(allocation?.pool ?? ""),
      cidrs,
      capacity: cidrs.reduce((sum, cidr) => sum + cidrSize(cidr), 0n),
      used: usedIps.filter((ip) => ranges.some((range) => rangeContains(range, ip))).length,
    };
  });

  let capacity = 0n;
  let capacitySource: NodeIpam["capacitySource"] = "none";

  if (allocations.length > 0) {
    capacity = allocations.reduce((sum, allocation) => sum + allocation.capacity, 0n);
    capacitySource = "pools";
  } else if (podCIDRs.length > 0) {
    capacity = podCIDRs.reduce((sum, cidr) => sum + cidrSize(cidr), 0n);
    capacitySource = "podCIDRs";
  } else if (poolIps.length > 0) {
    capacity = BigInt(poolIps.length);
    capacitySource = "pool";
  }

  return {
    node: ciliumNode?.metadata?.name,
    podCIDRs,
    capacity,
    capacitySource,
    used: usedIps.length,
    pools: allocations,
    requested: ((spec.pools?.requested ?? []) as Json[]).map((request) => ({ pool: String(request?.pool ?? ""), needed: request?.needed })),
    operatorError: status["operator-status"]?.error || undefined,
    preAllocate: spec["pre-allocate"],
    minAllocate: spec["min-allocate"],
    maxAboveWatermark: spec["max-above-watermark"],
    releasing: Object.keys(status["release-ips"] ?? {}).length,
  };
};

export interface PodIpPoolUsage {
  readonly name: string;
  readonly cidrs: readonly string[];
  readonly maskSizes: { readonly ipv4?: number; readonly ipv6?: number };
  /** Addresses in the pool's CIDRs. */
  readonly size: bigint;
  /** Addresses handed to nodes in per-node CIDRs. */
  readonly allocatedToNodes: bigint;
  readonly nodeCount: number;
  /** Addresses in use by pods, from the nodes' status. */
  readonly used: number;
}

export const podIpPoolUsage = (pools: readonly Json[], nodes: readonly NodeIpam[]): PodIpPoolUsage[] =>
  pools.map((pool) => {
    const name = String(pool?.metadata?.name ?? "");
    const cidrs: string[] = [...(pool?.spec?.ipv4?.cidrs ?? []), ...(pool?.spec?.ipv6?.cidrs ?? [])];
    const allocations = nodes.flatMap((node) => node.pools.filter((allocation) => allocation.pool === name));

    return {
      name,
      cidrs,
      maskSizes: { ipv4: pool?.spec?.ipv4?.maskSize, ipv6: pool?.spec?.ipv6?.maskSize },
      size: cidrs.reduce((sum, cidr) => sum + cidrSize(cidr), 0n),
      allocatedToNodes: allocations.reduce((sum, allocation) => sum + allocation.capacity, 0n),
      nodeCount: new Set(nodes.filter((node) => node.pools.some((allocation) => allocation.pool === name)).map((node) => node.node)).size,
      used: allocations.reduce((sum, allocation) => sum + allocation.used, 0),
    };
  });

export interface IpamTotals {
  readonly nodes: number;
  readonly capacity: bigint;
  readonly used: number;
  readonly nodesWithErrors: number;
  /** The cluster-pool CIDRs from cilium-config, with their size, for cluster-pool mode. */
  readonly clusterPool: ReadonlyArray<{ readonly cidr: string; readonly size: bigint; readonly maskSize?: number; readonly nodeCidrs?: bigint }>;
}

export const ipamTotals = (nodes: readonly NodeIpam[], config: Readonly<Record<string, string>> | undefined): IpamTotals => {
  const clusterPool = (["4", "6"] as const).flatMap((family) => {
    const raw = config?.[`cluster-pool-ipv${family}-cidr`] ?? "";
    const maskText = config?.[`cluster-pool-ipv${family}-mask-size`];
    const maskSize = maskText ? Number(maskText) : undefined;

    return raw
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((cidr) => {
        const range = parseCidr(cidr);
        const size = range ? rangeSize(range) : 0n;
        const prefix = range ? (family === "4" ? 32 : 128) - (size.toString(2).length - 1) : undefined;

        return { cidr, size, maskSize, nodeCidrs: prefix !== undefined && maskSize !== undefined && maskSize >= prefix ? 1n << BigInt(maskSize - prefix) : undefined };
      });
  });

  return {
    nodes: nodes.length,
    capacity: nodes.reduce((sum, node) => sum + node.capacity, 0n),
    used: nodes.reduce((sum, node) => sum + node.used, 0),
    nodesWithErrors: nodes.filter((node) => node.operatorError).length,
    clusterPool,
  };
};
