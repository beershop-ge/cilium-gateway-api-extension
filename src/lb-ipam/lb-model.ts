import { type IpRange, parseIp, rangeContains, rangeOfBlock, rangesOverlap, rangeSize } from "../common/cidr";
import { type Condition, conditionsOf } from "../common/conditions";
import { deepClone, type Json } from "../common/json";
import { type LabelSelector, selectorMatches } from "../common/selectors";

/*
 * LoadBalancer IPAM and L2 announcements: pools and policies as configured (CRD spec), and what the
 * operator and agents report (pool conditions, Service status, leases). Pure functions only.
 */

export const annotationIps = "lbipam.cilium.io/ips";
export const annotationSharingKey = "lbipam.cilium.io/sharing-key";
export const annotationSharingCrossNamespace = "lbipam.cilium.io/sharing-cross-namespace";
export const annotationLegacyIps = "io.cilium/lb-ipam-ips";

export const ciliumServiceAnnotations: ReadonlyArray<{ readonly key: string; readonly label: string; readonly help: string }> = [
  { key: annotationIps, label: "Requested IPs", help: "Comma-separated IPs to assign from a matching pool." },
  { key: annotationSharingKey, label: "Sharing key", help: "Services with the same key can share one IP when their ports do not clash." },
  { key: annotationSharingCrossNamespace, label: "Share across namespaces", help: 'Namespaces allowed to share this IP by sharing key, comma-separated, or "*".' },
  { key: annotationLegacyIps, label: "Requested IPs (legacy)", help: `Older spelling of ${annotationIps}.` },
];

export const bgpClass = "io.cilium/bgp-control-plane";
export const l2Class = "io.cilium/l2-announcer";
export const ciliumClasses = [bgpClass, l2Class] as const;

// ---------------------------------------------------------------------------------------------
// Pools

export interface PoolBlock {
  readonly label: string;
  readonly range?: IpRange;
  readonly isCidr: boolean;
  /** Addresses in the block. */
  readonly size: bigint;
  /** Addresses LB IPAM hands out: the first and last of a CIDR are skipped unless allowFirstLastIPs is Yes. */
  readonly usable: bigint;
  readonly error?: string;
}

export interface PoolReported {
  readonly total?: number;
  readonly available?: number;
  readonly used?: number;
}

export interface LbPool {
  readonly name: string;
  readonly disabled: boolean;
  readonly allowFirstLastIPs: boolean;
  readonly serviceSelector?: LabelSelector;
  readonly blocks: readonly PoolBlock[];
  readonly usable: bigint;
  readonly conditions: readonly Condition[];
  /** Counts the operator reports in the pool's conditions (runtime state). */
  readonly reported: PoolReported;
  readonly conflict?: string;
  readonly resource: Json;
}

export const usableOfBlock = (range: IpRange, isCidr: boolean, allowFirstLastIPs: boolean): bigint => {
  const size = rangeSize(range);
  const width = range.family === 4 ? 32n : 128n;
  const prefixLength = width - BigInt(size.toString(2).length - 1);

  // /32, /31 (and /128, /127) have no network and broadcast addresses to skip.
  if (!isCidr || allowFirstLastIPs || prefixLength >= width - 1n) {
    return size;
  }

  return size - 2n;
};

const countFromMessage = (message: string | undefined) => {
  const match = /-?\d+/.exec(message ?? "");

  return match ? Number(match[0]) : undefined;
};

export const parsePool = (resource: Json): LbPool => {
  const spec = resource?.spec ?? {};
  const allowFirstLastIPs = String(spec.allowFirstLastIPs ?? "").toLowerCase() === "yes";
  const rawBlocks = (spec.blocks ?? spec.cidrs ?? []) as Json[];
  const blocks: PoolBlock[] = rawBlocks.map((block) => {
    const isCidr = typeof block?.cidr === "string";
    const label = isCidr ? block.cidr : block?.stop ? `${block.start}–${block.stop}` : String(block?.start ?? "?");
    const range = rangeOfBlock(block ?? {});

    if (!range) {
      return { label, isCidr, size: 0n, usable: 0n, error: "Not a valid CIDR or start/stop range" };
    }

    return { label, range, isCidr, size: rangeSize(range), usable: usableOfBlock(range, isCidr, allowFirstLastIPs) };
  });
  const conditions = conditionsOf(resource?.status);
  const byType = (type: string) => conditions.find((condition) => condition.type === type);
  const conflict = byType("cilium.io/PoolConflict");

  return {
    name: resource?.metadata?.name,
    disabled: spec.disabled === true,
    allowFirstLastIPs,
    serviceSelector: spec.serviceSelector ?? undefined,
    blocks,
    usable: blocks.reduce((sum, block) => sum + block.usable, 0n),
    conditions,
    reported: {
      total: countFromMessage(byType("cilium.io/IPsTotal")?.message),
      available: countFromMessage(byType("cilium.io/IPsAvailable")?.message),
      used: countFromMessage(byType("cilium.io/IPsUsed")?.message),
    },
    conflict: conflict?.status === "True" ? (conflict.message ?? conflict.reason ?? "Conflicting pool") : undefined,
    resource,
  };
};

export interface PoolOverlap {
  readonly poolA: string;
  readonly blockA: string;
  readonly poolB: string;
  readonly blockB: string;
}

/** Every pair of blocks that share an address, across pools and within one pool. */
export const findPoolOverlaps = (pools: readonly LbPool[]): PoolOverlap[] => {
  const blocks = pools.flatMap((pool) => pool.blocks.filter((block) => block.range).map((block) => ({ pool: pool.name, block })));
  const overlaps: PoolOverlap[] = [];

  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      if (rangesOverlap(blocks[i].block.range!, blocks[j].block.range!)) {
        overlaps.push({ poolA: blocks[i].pool, blockA: blocks[i].block.label, poolB: blocks[j].pool, blockB: blocks[j].block.label });
      }
    }
  }

  return overlaps;
};

// ---------------------------------------------------------------------------------------------
// Services

export interface LbService {
  readonly namespace: string;
  readonly name: string;
  readonly type: string;
  readonly loadBalancerClass?: string;
  /** Assigned addresses (status.loadBalancer.ingress): runtime state. */
  readonly ingressIPs: readonly string[];
  readonly ingressHostnames: readonly string[];
  /** Addresses asked for in the spec or annotations: configuration. */
  readonly requestedIPs: readonly string[];
  readonly requestSources: readonly string[];
  readonly sharingKey?: string;
  readonly sharingCrossNamespace?: string;
  readonly externalIPs: readonly string[];
  readonly ciliumAnnotations: Readonly<Record<string, string>>;
  /** Cilium's `cilium.io/IPAMRequestSatisfied` condition on the Service, when the operator set one. */
  readonly ipamCondition?: Condition;
  readonly selectorLabels: Readonly<Record<string, string>>;
  readonly resource: Json;
}

const splitList = (value: unknown): string[] =>
  typeof value === "string"
    ? value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
    : [];

/** The labels LB IPAM and L2 policies match services by: the service's own, its name and its namespace. */
export const serviceLabels = (service: Json): Record<string, string> => ({
  ...(service?.metadata?.labels ?? {}),
  "io.kubernetes.service.name": service?.metadata?.name,
  "io.kubernetes.service.namespace": service?.metadata?.namespace,
});

export const parseLbService = (service: Json): LbService => {
  const annotations: Record<string, string> = service?.metadata?.annotations ?? {};
  const requested: string[] = [];
  const sources: string[] = [];
  const add = (ips: string[], source: string) => {
    if (ips.length === 0) return;

    sources.push(source);

    for (const ip of ips) if (!requested.includes(ip)) requested.push(ip);
  };

  add(splitList(annotations[annotationIps]), annotationIps);
  add(splitList(annotations[annotationLegacyIps]), annotationLegacyIps);
  add(service?.spec?.loadBalancerIP ? [String(service.spec.loadBalancerIP)] : [], "spec.loadBalancerIP");

  const ingress = (service?.status?.loadBalancer?.ingress ?? []) as Json[];
  const ciliumAnnotations = Object.fromEntries(Object.entries(annotations).filter(([key]) => key.startsWith("lbipam.cilium.io/") || key.startsWith("io.cilium/") || key.startsWith("service.cilium.io/")));

  return {
    namespace: service?.metadata?.namespace,
    name: service?.metadata?.name,
    type: service?.spec?.type ?? "ClusterIP",
    loadBalancerClass: service?.spec?.loadBalancerClass || undefined,
    ingressIPs: ingress.map((entry) => entry?.ip).filter(Boolean),
    ingressHostnames: ingress.map((entry) => entry?.hostname).filter(Boolean),
    requestedIPs: requested,
    requestSources: sources,
    sharingKey: annotations[annotationSharingKey],
    sharingCrossNamespace: annotations[annotationSharingCrossNamespace],
    externalIPs: service?.spec?.externalIPs ?? [],
    ciliumAnnotations,
    ipamCondition: conditionsOf(service?.status).find((condition) => condition.type === "cilium.io/IPAMRequestSatisfied"),
    selectorLabels: serviceLabels(service),
    resource: service,
  };
};

export const isLoadBalancer = (service: Json) => service?.spec?.type === "LoadBalancer";

/** Whether Cilium's LB IPAM handles a service's class: unset, or one of Cilium's own. */
export const lbIpamHandlesClass = (loadBalancerClass: string | undefined) => !loadBalancerClass || loadBalancerClass.startsWith("io.cilium/");

export interface PoolAssignment {
  readonly ip: string;
  readonly services: ReadonlyArray<{ readonly namespace: string; readonly name: string }>;
}

export interface Assignments {
  /** Assigned IPs by pool name, each with the services sharing it. */
  readonly byPool: ReadonlyMap<string, readonly PoolAssignment[]>;
  /** Assigned IPs in no pool: given by another controller, or the pool was deleted. */
  readonly outsidePools: readonly PoolAssignment[];
  /** Pools each service's assigned IPs fall in, keyed `namespace/name`. */
  readonly poolsOfService: ReadonlyMap<string, readonly string[]>;
}

export const serviceKey = (service: { namespace: string; name: string }) => `${service.namespace}/${service.name}`;

/** Places every assigned LoadBalancer IP in the pools containing it (more than one when pools overlap). */
export const assignIpsToPools = (pools: readonly LbPool[], services: readonly LbService[]): Assignments => {
  const byIp = new Map<string, Array<{ namespace: string; name: string }>>();

  for (const service of services) {
    for (const ip of service.ingressIPs) {
      const normalized = parseIp(ip) ? ip : undefined;

      if (!normalized) continue;

      byIp.set(ip, [...(byIp.get(ip) ?? []), { namespace: service.namespace, name: service.name }]);
    }
  }

  const byPool = new Map<string, PoolAssignment[]>(pools.map((pool) => [pool.name, []]));
  const outsidePools: PoolAssignment[] = [];
  const poolsOfService = new Map<string, string[]>();

  for (const [ip, owners] of [...byIp.entries()].sort(([a], [b]) => compareIps(a, b))) {
    const containing = pools.filter((pool) => pool.blocks.some((block) => block.range && rangeContains(block.range, ip)));

    if (containing.length === 0) {
      outsidePools.push({ ip, services: owners });
    }

    for (const pool of containing) {
      byPool.get(pool.name)!.push({ ip, services: owners });
    }

    for (const owner of owners) {
      const key = serviceKey(owner);
      const list = poolsOfService.get(key) ?? [];

      for (const pool of containing) if (!list.includes(pool.name)) list.push(pool.name);

      poolsOfService.set(key, list);
    }
  }

  return { byPool, outsidePools, poolsOfService };
};

export const compareIps = (a: string, b: string) => {
  const left = parseIp(a);
  const right = parseIp(b);

  if (!left || !right) return a.localeCompare(b);
  if (left.family !== right.family) return left.family - right.family;

  return left.value < right.value ? -1 : left.value > right.value ? 1 : 0;
};

export interface PoolUsage {
  readonly used: number;
  readonly usable: bigint;
  readonly percent: number;
}

export const poolUsage = (pool: LbPool, assignments: readonly PoolAssignment[]): PoolUsage => {
  const used = assignments.length;

  return { used, usable: pool.usable, percent: pool.usable > 0n ? Math.min(100, (used / Number(pool.usable)) * 100) : 0 };
};

/** Pools whose service selector matches a service: the ones LB IPAM may assign it an address from. */
export const eligiblePools = (pools: readonly LbPool[], service: LbService) => pools.filter((pool) => selectorMatches(pool.serviceSelector, service.selectorLabels));

/**
 * Why a LoadBalancer service has no address, as far as configuration and status tell. Undefined when
 * it has one. The operator's own condition comes first, as it is the most specific.
 */
export const pendingReason = (service: LbService, pools: readonly LbPool[], { lbIpamEnabled = true }: { lbIpamEnabled?: boolean } = {}): string | undefined => {
  if (service.type !== "LoadBalancer" || service.ingressIPs.length > 0 || service.ingressHostnames.length > 0) {
    return undefined;
  }

  if (service.ipamCondition && service.ipamCondition.status === "False") {
    return `LB IPAM: ${service.ipamCondition.reason ?? "request not satisfied"}${service.ipamCondition.message ? ` — ${service.ipamCondition.message}` : ""}`;
  }

  if (!lbIpamHandlesClass(service.loadBalancerClass)) {
    return `loadBalancerClass ${service.loadBalancerClass} belongs to another controller, so Cilium LB IPAM does not assign it an address.`;
  }

  if (!lbIpamEnabled) {
    return "LB IPAM is not available on this cluster (no CiliumLoadBalancerIPPool type).";
  }

  if (pools.length === 0) {
    return "There is no CiliumLoadBalancerIPPool.";
  }

  const eligible = eligiblePools(pools, service);
  const enabled = eligible.filter((pool) => !pool.disabled && !pool.conflict);

  if (eligible.length === 0) {
    return "No pool's serviceSelector matches this service.";
  }

  if (enabled.length === 0) {
    return `Every matching pool is disabled or in conflict (${eligible.map((pool) => pool.name).join(", ")}).`;
  }

  if (service.requestedIPs.length > 0) {
    const outside = service.requestedIPs.filter((ip) => !enabled.some((pool) => pool.blocks.some((block) => block.range && rangeContains(block.range, ip))));

    if (outside.length > 0) {
      return `Requested ${outside.join(", ")} ${outside.length === 1 ? "is" : "are"} in no enabled pool matching this service.`;
    }
  }

  if (enabled.every((pool) => pool.reported.available === 0)) {
    return "Every matching pool reports no available addresses.";
  }

  return undefined;
};

// ---------------------------------------------------------------------------------------------
// L2 announcements

export interface L2Policy {
  readonly name: string;
  readonly serviceSelector?: LabelSelector;
  readonly nodeSelector?: LabelSelector;
  readonly interfaces: readonly string[];
  readonly externalIPs: boolean;
  readonly loadBalancerIPs: boolean;
  readonly conditions: readonly Condition[];
  readonly resource: Json;
}

export const parseL2Policy = (resource: Json): L2Policy => ({
  name: resource?.metadata?.name,
  serviceSelector: resource?.spec?.serviceSelector ?? undefined,
  nodeSelector: resource?.spec?.nodeSelector ?? undefined,
  interfaces: resource?.spec?.interfaces ?? [],
  externalIPs: resource?.spec?.externalIPs === true,
  loadBalancerIPs: resource?.spec?.loadBalancerIPs === true,
  conditions: conditionsOf(resource?.status),
  resource,
});

/** Services an L2 policy announces: matched by its selector, with a class L2 announcements serve, and an address of an announced kind. */
export const servicesOfL2Policy = (policy: L2Policy, services: readonly LbService[]): LbService[] =>
  services.filter(
    (service) =>
      selectorMatches(policy.serviceSelector, service.selectorLabels) &&
      (!service.loadBalancerClass || service.loadBalancerClass === l2Class) &&
      ((policy.loadBalancerIPs && service.ingressIPs.length > 0) || (policy.externalIPs && service.externalIPs.length > 0)),
  );

export const nodesOfL2Policy = (policy: L2Policy, nodes: readonly Json[]): string[] =>
  nodes.filter((node) => selectorMatches(policy.nodeSelector, node?.metadata?.labels ?? {})).map((node) => node?.metadata?.name as string);

/** The lease the agents elect the announcing node by. */
export const l2LeaseName = (service: { namespace: string; name: string }) => `cilium-l2announce-${service.namespace}-${service.name}`;

export interface LeaseHolder {
  readonly holder?: string;
  readonly renewTime?: string;
  readonly leaseDurationSeconds?: number;
}

export const leaseHolders = (leases: readonly Json[]): Map<string, LeaseHolder> =>
  new Map(
    leases
      .filter((lease) => String(lease?.metadata?.name ?? "").startsWith("cilium-l2announce-"))
      .map((lease) => [lease.metadata.name as string, { holder: lease?.spec?.holderIdentity || undefined, renewTime: lease?.spec?.renewTime, leaseDurationSeconds: lease?.spec?.leaseDurationSeconds }]),
  );

// ---------------------------------------------------------------------------------------------
// Editing a service's Cilium settings

export interface ServiceEdit {
  /** Cilium annotations wanted; a key missing or empty is removed. Other annotations are kept. */
  readonly annotations: Readonly<Record<string, string>>;
  /** Set only when the live service has none: the field is immutable once set. */
  readonly loadBalancerClass?: string;
}

/** The live service with its Cilium annotations and class changed, ready for a replace or apply. */
export const buildServiceEdit = (live: Json, edit: ServiceEdit): Json => {
  const copy = deepClone(live);

  delete copy.metadata?.managedFields;
  delete copy.status;
  copy.apiVersion ??= "v1";
  copy.kind ??= "Service";

  const annotations: Record<string, string> = { ...(copy.metadata?.annotations ?? {}) };

  for (const { key } of ciliumServiceAnnotations) delete annotations[key];
  for (const [key, value] of Object.entries(edit.annotations)) {
    if (value.trim() !== "") annotations[key] = value.trim();
  }

  copy.metadata = { ...(copy.metadata ?? {}) };

  if (Object.keys(annotations).length > 0) {
    copy.metadata.annotations = annotations;
  } else {
    delete copy.metadata.annotations;
  }

  if (edit.loadBalancerClass) {
    if (live?.spec?.loadBalancerClass && live.spec.loadBalancerClass !== edit.loadBalancerClass) {
      throw new Error("loadBalancerClass is immutable once set");
    }

    copy.spec = { ...(copy.spec ?? {}), loadBalancerClass: edit.loadBalancerClass };
  }

  return copy;
};

export const serviceEditErrors = (edit: ServiceEdit): string[] => {
  const errors: string[] = [];

  for (const key of [annotationIps, annotationLegacyIps]) {
    const invalid = splitList(edit.annotations[key]).filter((ip) => !parseIp(ip));

    if (invalid.length > 0) {
      errors.push(`${key}: ${invalid.join(", ")} ${invalid.length === 1 ? "is not an IP address" : "are not IP addresses"}`);
    }
  }

  if (edit.loadBalancerClass && !/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?\/[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/.test(edit.loadBalancerClass)) {
    errors.push("loadBalancerClass must be a label-style name with a prefix, such as io.cilium/bgp-control-plane");
  }

  return errors;
};
