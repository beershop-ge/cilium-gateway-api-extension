import { parseCidr, parseIp } from "../common/cidr";
import { type Condition, conditionsOf } from "../common/conditions";
import { deepClone, type Json } from "../common/json";
import { isEmptySelector, type LabelSelector, selectorMatches } from "../common/selectors";

/*
 * The BGP control plane as Cilium configures it, read from the CRDs (configuration state) and from
 * CiliumBGPNodeConfig status and `cilium-dbg bgp …` output (runtime state). Pure functions only.
 */

export const maxAsn = 4294967295;

export const asnError = (asn: unknown, { allowZero = false } = {}): string | undefined => {
  if (asn === undefined || asn === null || asn === "") {
    return "not set";
  }

  const value = Number(asn);

  if (!Number.isInteger(value)) {
    return `"${String(asn)}" is not a whole number`;
  }

  if (value === 0 && allowZero) {
    return undefined;
  }

  if (value < 1 || value > maxAsn) {
    return `${value} is outside 1–${maxAsn}`;
  }

  return undefined;
};

const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : undefined);

const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

// ---------------------------------------------------------------------------------------------
// Configuration: v2 control plane

export interface BgpPeer {
  readonly name: string;
  readonly peerAddress?: string;
  readonly peerASN?: number;
  readonly peerConfigRef?: string;
  /** Peers found by auto-discovery (Cilium 1.18+) have no address of their own. */
  readonly autoDiscovery?: string;
}

export interface BgpInstance {
  readonly name: string;
  readonly localASN?: number;
  readonly localPort?: number;
  readonly peers: readonly BgpPeer[];
}

export interface ClusterConfig {
  readonly name: string;
  readonly nodeSelector?: LabelSelector;
  readonly instances: readonly BgpInstance[];
  readonly conditions: readonly Condition[];
  readonly resource: Json;
}

export const parseClusterConfig = (resource: Json): ClusterConfig => ({
  name: resource?.metadata?.name,
  nodeSelector: resource?.spec?.nodeSelector ?? undefined,
  instances: ((resource?.spec?.bgpInstances ?? []) as Json[]).map((instance) => ({
    name: String(instance?.name ?? ""),
    localASN: num(instance?.localASN),
    localPort: num(instance?.localPort),
    peers: ((instance?.peers ?? []) as Json[]).map((peer) => ({
      name: String(peer?.name ?? ""),
      peerAddress: str(peer?.peerAddress),
      peerASN: num(peer?.peerASN),
      peerConfigRef: str(peer?.peerConfigRef?.name),
      autoDiscovery: str(peer?.autoDiscovery?.mode),
    })),
  })),
  conditions: conditionsOf(resource?.status),
  resource,
});

export interface PeerFamily {
  readonly afi: string;
  readonly safi: string;
  readonly advertisements?: LabelSelector;
}

export interface PeerConfig {
  readonly name: string;
  readonly holdTimeSeconds?: number;
  readonly keepAliveTimeSeconds?: number;
  readonly connectRetryTimeSeconds?: number;
  readonly authSecretRef?: string;
  readonly ebgpMultihop?: number;
  readonly gracefulRestart?: { readonly enabled: boolean; readonly restartTimeSeconds?: number };
  readonly localPort?: number;
  readonly peerPort?: number;
  readonly families: readonly PeerFamily[];
  /** No families in the spec: Cilium uses IPv4 and IPv6 unicast, advertising nothing. */
  readonly familiesDefaulted: boolean;
  readonly conditions: readonly Condition[];
  readonly resource: Json;
}

export const parsePeerConfig = (resource: Json): PeerConfig => {
  const spec = resource?.spec ?? {};
  const families = ((spec.families ?? []) as Json[]).map((family) => ({ afi: String(family?.afi ?? ""), safi: String(family?.safi ?? ""), advertisements: family?.advertisements ?? undefined }));

  return {
    name: resource?.metadata?.name,
    holdTimeSeconds: num(spec.timers?.holdTimeSeconds),
    keepAliveTimeSeconds: num(spec.timers?.keepAliveTimeSeconds),
    connectRetryTimeSeconds: num(spec.timers?.connectRetryTimeSeconds),
    authSecretRef: str(spec.authSecretRef),
    ebgpMultihop: num(spec.ebgpMultihop),
    gracefulRestart: spec.gracefulRestart ? { enabled: Boolean(spec.gracefulRestart.enabled), restartTimeSeconds: num(spec.gracefulRestart.restartTimeSeconds) } : undefined,
    localPort: num(spec.transport?.localPort),
    peerPort: num(spec.transport?.peerPort),
    families: families.length > 0 ? families : [{ afi: "ipv4", safi: "unicast" }, { afi: "ipv6", safi: "unicast" }],
    familiesDefaulted: families.length === 0,
    conditions: conditionsOf(resource?.status),
    resource,
  };
};

export type AdvertisementType = "PodCIDR" | "CiliumPodIPPool" | "Service" | "Interface" | string;

export interface AdvertisementEntry {
  readonly advertisementType: AdvertisementType;
  /** For Service: ClusterIP, ExternalIP, LoadBalancerIP. */
  readonly addresses: readonly string[];
  readonly selector?: LabelSelector;
  readonly interfaceName?: string;
  readonly communities?: { readonly standard: readonly string[]; readonly wellKnown: readonly string[]; readonly large: readonly string[] };
  readonly localPreference?: number;
}

export interface Advertisement {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly entries: readonly AdvertisementEntry[];
  readonly resource: Json;
}

export const parseAdvertisement = (resource: Json): Advertisement => ({
  name: resource?.metadata?.name,
  labels: resource?.metadata?.labels ?? {},
  entries: ((resource?.spec?.advertisements ?? []) as Json[]).map((entry) => ({
    advertisementType: String(entry?.advertisementType ?? ""),
    addresses: ((entry?.service?.addresses ?? []) as Json[]).map(String),
    selector: entry?.selector ?? undefined,
    interfaceName: str(entry?.interface?.name),
    communities: entry?.attributes?.communities
      ? {
          standard: (entry.attributes.communities.standard ?? []).map(String),
          wellKnown: (entry.attributes.communities.wellKnown ?? []).map(String),
          large: (entry.attributes.communities.large ?? []).map(String),
        }
      : undefined,
    localPreference: num(entry?.attributes?.localPreference),
  })),
  resource,
});

/** The advertisements a peer family selects by label. A family without a selector advertises nothing. */
export const advertisementsOfFamily = (family: PeerFamily, advertisements: readonly Advertisement[]): Advertisement[] =>
  family.advertisements ? advertisements.filter((advertisement) => selectorMatches(family.advertisements, advertisement.labels)) : [];

// ---------------------------------------------------------------------------------------------
// Configuration: legacy v1 (CiliumBGPPeeringPolicy)

export interface LegacyNeighbor {
  readonly peerAddress?: string;
  readonly peerASN?: number;
  readonly authSecretRef?: string;
  readonly eBGPMultihopTTL?: number;
  readonly holdTimeSeconds?: number;
  readonly keepAliveTimeSeconds?: number;
  readonly connectRetryTimeSeconds?: number;
  readonly gracefulRestart?: { readonly enabled: boolean; readonly restartTimeSeconds?: number };
  readonly families: readonly string[];
}

export interface LegacyVirtualRouter {
  readonly localASN?: number;
  readonly exportPodCIDR: boolean;
  readonly podIPPoolSelector?: LabelSelector;
  readonly serviceSelector?: LabelSelector;
  readonly serviceAdvertisements: readonly string[];
  readonly neighbors: readonly LegacyNeighbor[];
}

export interface LegacyPolicy {
  readonly name: string;
  readonly nodeSelector?: LabelSelector;
  readonly virtualRouters: readonly LegacyVirtualRouter[];
  readonly resource: Json;
}

export const parseLegacyPolicy = (resource: Json): LegacyPolicy => ({
  name: resource?.metadata?.name,
  nodeSelector: resource?.spec?.nodeSelector ?? undefined,
  virtualRouters: ((resource?.spec?.virtualRouters ?? []) as Json[]).map((router) => ({
    localASN: num(router?.localASN),
    exportPodCIDR: Boolean(router?.exportPodCIDR),
    podIPPoolSelector: router?.podIPPoolSelector ?? undefined,
    serviceSelector: router?.serviceSelector ?? undefined,
    serviceAdvertisements: ((router?.serviceAdvertisements ?? (router?.serviceSelector ? ["LoadBalancerIP"] : [])) as Json[]).map(String),
    neighbors: ((router?.neighbors ?? []) as Json[]).map((neighbor) => ({
      peerAddress: str(neighbor?.peerAddress),
      peerASN: num(neighbor?.peerASN),
      authSecretRef: str(neighbor?.authSecretRef),
      eBGPMultihopTTL: num(neighbor?.eBGPMultihopTTL),
      holdTimeSeconds: num(neighbor?.holdTimeSeconds),
      keepAliveTimeSeconds: num(neighbor?.keepAliveTimeSeconds),
      connectRetryTimeSeconds: num(neighbor?.connectRetryTimeSeconds),
      gracefulRestart: neighbor?.gracefulRestart ? { enabled: Boolean(neighbor.gracefulRestart.enabled), restartTimeSeconds: num(neighbor.gracefulRestart.restartTimeSeconds) } : undefined,
      families: ((neighbor?.families ?? []) as Json[]).map((family) => `${family?.afi}/${family?.safi}`),
    })),
  })),
  resource,
});

// ---------------------------------------------------------------------------------------------
// Validation

export type IssueSeverity = "error" | "warning" | "info";

export interface BgpIssue {
  readonly severity: IssueSeverity;
  readonly kind: string;
  readonly name: string;
  readonly message: string;
}

export interface SecretInfo {
  readonly name: string;
  readonly namespace: string;
  readonly keys: readonly string[];
}

export interface BgpValidationInput {
  readonly clusterConfigs: readonly ClusterConfig[];
  readonly peerConfigs: readonly PeerConfig[];
  readonly advertisements: readonly Advertisement[];
  readonly legacyPolicies?: readonly LegacyPolicy[];
  /** Secrets with names and keys only; undefined when they could not be read. */
  readonly secrets?: readonly SecretInfo[];
  /** Where Cilium looks up BGP auth secrets (`bgp-secrets-namespace`, default kube-system). */
  readonly secretsNamespace: string;
}

/** Where Cilium reads BGP authentication secrets from. */
export const bgpSecretsNamespace = (config: Readonly<Record<string, string>> | undefined) => config?.["bgp-secrets-namespace"] || "kube-system";

export const secretInfoOf = (secret: Json): SecretInfo => ({ name: secret?.metadata?.name, namespace: secret?.metadata?.namespace, keys: (secret?.keys ?? Object.keys(secret?.data ?? {})) as string[] });

const addressError = (address: string | undefined, { allowCidr = false } = {}) => {
  if (!address) {
    return "no peer address";
  }

  if (allowCidr ? parseCidr(address) : parseIp(address)) {
    return undefined;
  }

  return `"${address}" is not a valid IP address`;
};

const checkSecret = (issues: BgpIssue[], kind: string, name: string, secretName: string, input: BgpValidationInput, where: string) => {
  if (!input.secrets) {
    issues.push({ severity: "info", kind, name, message: `${where}: authentication secret "${secretName}" could not be checked (secrets are not readable).` });

    return;
  }

  const secret = input.secrets.find((candidate) => candidate.name === secretName && candidate.namespace === input.secretsNamespace);

  if (!secret) {
    issues.push({ severity: "error", kind, name, message: `${where}: authentication secret "${secretName}" does not exist in namespace ${input.secretsNamespace}; the session will not come up.` });
  } else if (!secret.keys.includes("password")) {
    issues.push({ severity: "warning", kind, name, message: `${where}: secret ${input.secretsNamespace}/${secretName} has no "password" key, which Cilium reads the TCP-MD5 password from.` });
  }
};

/** Finds configuration mistakes that keep sessions down or routes unadvertised, without reading any runtime state. */
export const validateBgp = (input: BgpValidationInput): BgpIssue[] => {
  const issues: BgpIssue[] = [];
  const peerConfigNames = new Set(input.peerConfigs.map((config) => config.name));
  const referenced = new Set<string>();

  for (const config of input.clusterConfigs) {
    const kind = "CiliumBGPClusterConfig";
    const instanceNames = new Set<string>();

    if (config.instances.length === 0) {
      issues.push({ severity: "warning", kind, name: config.name, message: "No BGP instances: this cluster config does nothing." });
    }

    for (const instance of config.instances) {
      const where = `instance ${instance.name || "(unnamed)"}`;

      if (instanceNames.has(instance.name)) {
        issues.push({ severity: "error", kind, name: config.name, message: `Duplicate instance name "${instance.name}".` });
      }

      instanceNames.add(instance.name);

      const localError = asnError(instance.localASN);

      if (localError) {
        issues.push({ severity: "error", kind, name: config.name, message: `${where}: local ASN ${localError}.` });
      }

      const peerNames = new Map<string, number>();
      const peerAddresses = new Map<string, number>();

      for (const peer of instance.peers) {
        const peerWhere = `${where}, peer ${peer.name || "(unnamed)"}`;

        peerNames.set(peer.name, (peerNames.get(peer.name) ?? 0) + 1);

        if (peer.peerAddress) {
          const normalized = parseIp(peer.peerAddress)?.value.toString() ?? peer.peerAddress;

          peerAddresses.set(normalized, (peerAddresses.get(normalized) ?? 0) + 1);
        }

        if (!peer.autoDiscovery) {
          const error = addressError(peer.peerAddress);

          if (error) {
            issues.push({ severity: "error", kind, name: config.name, message: `${peerWhere}: ${error}.` });
          }
        }

        if (peer.peerASN === undefined || peer.peerASN === 0) {
          issues.push({ severity: "info", kind, name: config.name, message: `${peerWhere}: no peer ASN; Cilium accepts the ASN the peer announces in its OPEN message.` });
        } else {
          const error = asnError(peer.peerASN);

          if (error) {
            issues.push({ severity: "error", kind, name: config.name, message: `${peerWhere}: peer ASN ${error}.` });
          }
        }

        if (!peer.peerConfigRef) {
          issues.push({ severity: "info", kind, name: config.name, message: `${peerWhere}: no peerConfigRef, so default timers apply and nothing is advertised to this peer.` });
        } else {
          referenced.add(peer.peerConfigRef);

          if (!peerConfigNames.has(peer.peerConfigRef)) {
            issues.push({ severity: "error", kind, name: config.name, message: `${peerWhere}: peerConfigRef "${peer.peerConfigRef}" names a CiliumBGPPeerConfig that does not exist.` });
          }
        }
      }

      for (const [peerName, count] of peerNames) {
        if (count > 1) {
          issues.push({ severity: "error", kind, name: config.name, message: `${where}: peer name "${peerName}" is used ${count} times.` });
        }
      }

      for (const [address, count] of peerAddresses) {
        if (count > 1) {
          const shown = instance.peers.find((peer) => (parseIp(peer.peerAddress ?? "")?.value.toString() ?? peer.peerAddress) === address)?.peerAddress ?? address;

          issues.push({ severity: "error", kind, name: config.name, message: `${where}: peer address ${shown} is configured ${count} times.` });
        }
      }
    }
  }

  for (const peerConfig of input.peerConfigs) {
    const kind = "CiliumBGPPeerConfig";

    if (!referenced.has(peerConfig.name) && input.clusterConfigs.length > 0) {
      issues.push({ severity: "info", kind, name: peerConfig.name, message: "Not referenced by any peer of a CiliumBGPClusterConfig." });
    }

    if (peerConfig.familiesDefaulted) {
      issues.push({ severity: "warning", kind, name: peerConfig.name, message: "No families: IPv4 and IPv6 unicast are used without an advertisement selector, so nothing is advertised." });
    }

    for (const family of peerConfig.familiesDefaulted ? [] : peerConfig.families) {
      const label = `${family.afi}/${family.safi}`;

      if (!family.advertisements) {
        issues.push({ severity: "warning", kind, name: peerConfig.name, message: `Family ${label} has no advertisement selector: nothing is advertised for it.` });
      } else if (advertisementsOfFamily(family, input.advertisements).length === 0) {
        issues.push({ severity: "warning", kind, name: peerConfig.name, message: `Family ${label} selects no CiliumBGPAdvertisement: nothing is advertised for it.` });
      }
    }

    if (peerConfig.authSecretRef) {
      checkSecret(issues, kind, peerConfig.name, peerConfig.authSecretRef, input, "Authentication");
    }

    if (peerConfig.holdTimeSeconds !== undefined && peerConfig.keepAliveTimeSeconds !== undefined && peerConfig.keepAliveTimeSeconds > peerConfig.holdTimeSeconds) {
      issues.push({ severity: "error", kind, name: peerConfig.name, message: `Keepalive (${peerConfig.keepAliveTimeSeconds}s) is longer than the hold time (${peerConfig.holdTimeSeconds}s).` });
    }
  }

  for (const advertisement of input.advertisements) {
    const kind = "CiliumBGPAdvertisement";

    advertisement.entries.forEach((entry, index) => {
      if ((entry.advertisementType === "Service" || entry.advertisementType === "CiliumPodIPPool") && isEmptySelector(entry.selector) && !entry.selector) {
        issues.push({ severity: "warning", kind, name: advertisement.name, message: `Entry ${index + 1} (${entry.advertisementType}) has no selector, which selects nothing.` });
      }

      if (entry.advertisementType === "Service" && entry.addresses.length === 0) {
        issues.push({ severity: "warning", kind, name: advertisement.name, message: `Entry ${index + 1} (Service) lists no address types, so no service address is advertised.` });
      }
    });
  }

  for (const policy of input.legacyPolicies ?? []) {
    const kind = "CiliumBGPPeeringPolicy";

    policy.virtualRouters.forEach((router, routerIndex) => {
      const where = `virtual router ${routerIndex + 1}`;
      const localError = asnError(router.localASN);

      if (localError) {
        issues.push({ severity: "error", kind, name: policy.name, message: `${where}: local ASN ${localError}.` });
      }

      const seen = new Map<string, number>();

      for (const neighbor of router.neighbors) {
        const neighborWhere = `${where}, neighbor ${neighbor.peerAddress ?? "(no address)"}`;
        const addressProblem = addressError(neighbor.peerAddress, { allowCidr: true });

        if (addressProblem) {
          issues.push({ severity: "error", kind, name: policy.name, message: `${neighborWhere}: ${addressProblem}.` });
        } else {
          const key = parseCidr(neighbor.peerAddress!)!.start.toString();

          seen.set(key, (seen.get(key) ?? 0) + 1);
        }

        const peerError = asnError(neighbor.peerASN);

        if (peerError) {
          issues.push({ severity: "error", kind, name: policy.name, message: `${neighborWhere}: peer ASN ${peerError}.` });
        }

        if (neighbor.authSecretRef) {
          checkSecret(issues, kind, policy.name, neighbor.authSecretRef, input, neighborWhere);
        }
      }

      for (const [, count] of seen) {
        if (count > 1) {
          issues.push({ severity: "error", kind, name: policy.name, message: `${where}: the same neighbor address is configured ${count} times.` });
        }
      }
    });
  }

  if ((input.legacyPolicies?.length ?? 0) > 0 && input.clusterConfigs.length > 0) {
    issues.push({
      severity: "warning",
      kind: "CiliumBGPPeeringPolicy",
      name: "",
      message: "Both legacy CiliumBGPPeeringPolicy and v2 CiliumBGPClusterConfig resources exist. Cilium runs one BGP control plane at a time; check the agent logs for which one is active.",
    });
  }

  const order: Record<IssueSeverity, number> = { error: 0, warning: 1, info: 2 };

  return issues.sort((a, b) => order[a.severity] - order[b.severity]);
};

// ---------------------------------------------------------------------------------------------
// Guided edits

export interface NewPeer {
  readonly instance: string;
  readonly name: string;
  readonly peerAddress: string;
  readonly peerASN?: number;
  readonly peerConfigRef?: string;
}

export const newPeerErrors = (config: ClusterConfig, peer: NewPeer): Partial<Record<keyof NewPeer, string>> => {
  const errors: Partial<Record<keyof NewPeer, string>> = {};
  const instance = config.instances.find((candidate) => candidate.name === peer.instance);

  if (!instance) {
    errors.instance = "Pick a BGP instance";
  }

  if (!peer.name) {
    errors.name = "A name is required";
  } else if (instance?.peers.some((existing) => existing.name === peer.name)) {
    errors.name = "This instance already has a peer of that name";
  }

  const address = parseIp(peer.peerAddress);

  if (!address) {
    errors.peerAddress = "An IPv4 or IPv6 address, without a prefix length";
  } else if (instance?.peers.some((existing) => parseIp(existing.peerAddress ?? "")?.value === address.value)) {
    errors.peerAddress = "This instance already peers with that address";
  }

  if (peer.peerASN !== undefined) {
    const error = asnError(peer.peerASN, { allowZero: true });

    if (error) {
      errors.peerASN = `ASN ${error}`;
    }
  }

  return errors;
};

/** The cluster config with one more peer in one instance; everything else is kept as read. */
export const withAddedPeer = (resource: Json, peer: NewPeer): Json => {
  const copy = deepClone(resource);

  delete copy.metadata?.managedFields;
  delete copy.status;

  const instances = (copy.spec?.bgpInstances ?? []) as Json[];
  const instance = instances.find((candidate) => candidate?.name === peer.instance);

  if (!instance) {
    throw new Error(`No BGP instance named ${peer.instance}`);
  }

  instance.peers = [
    ...((instance.peers ?? []) as Json[]),
    {
      name: peer.name,
      peerAddress: peer.peerAddress,
      ...(peer.peerASN !== undefined ? { peerASN: peer.peerASN } : {}),
      ...(peer.peerConfigRef ? { peerConfigRef: { name: peer.peerConfigRef } } : {}),
    },
  ];

  return copy;
};

// ---------------------------------------------------------------------------------------------
// Runtime state: sessions

export interface RouteCount {
  readonly afi: string;
  readonly safi: string;
  readonly advertised?: number;
  readonly received?: number;
  readonly accepted?: number;
}

export interface PeerSession {
  readonly node: string;
  readonly instance?: string;
  readonly localASN?: number;
  readonly peerName?: string;
  readonly peerAddress?: string;
  readonly peerASN?: number;
  readonly peerPort?: number;
  readonly state?: string;
  readonly established: boolean;
  readonly uptimeSeconds?: number;
  readonly holdTimeSeconds?: number;
  readonly keepAliveSeconds?: number;
  readonly connectRetrySeconds?: number;
  readonly routes: readonly RouteCount[];
  readonly source: "node-config-status" | "agent";
}

export const isEstablished = (state: string | undefined) => typeof state === "string" && state.trim().toLowerCase() === "established";

/** Sessions as the agent reports them in CiliumBGPNodeConfig status (v2 control plane). */
export const sessionsFromNodeConfig = (nodeConfig: Json, now = Date.now()): PeerSession[] => {
  const node = String(nodeConfig?.metadata?.name ?? "");

  return ((nodeConfig?.status?.bgpInstances ?? []) as Json[]).flatMap((instance) =>
    ((instance?.peers ?? []) as Json[]).map((peer) => {
      const establishedAt = str(peer?.establishedTime) ? new Date(peer.establishedTime).getTime() : NaN;
      const established = isEstablished(peer?.peeringState);

      return {
        node,
        instance: str(instance?.name),
        localASN: num(instance?.localASN),
        peerName: str(peer?.name),
        peerAddress: str(peer?.peerAddress),
        peerASN: num(peer?.peerASN),
        state: str(peer?.peeringState),
        established,
        uptimeSeconds: established && Number.isFinite(establishedAt) ? Math.max(0, Math.floor((now - establishedAt) / 1000)) : undefined,
        holdTimeSeconds: num(peer?.timers?.appliedHoldTimeSeconds),
        keepAliveSeconds: num(peer?.timers?.appliedKeepaliveSeconds),
        routes: ((peer?.routeCount ?? []) as Json[]).map((count) => ({ afi: String(count?.afi ?? ""), safi: String(count?.safi ?? ""), advertised: num(count?.advertised), received: num(count?.received) })),
        source: "node-config-status" as const,
      };
    }),
  );
};

/** Parses `cilium-dbg bgp peers -o json` (a list of the agent API's BgpPeer). */
export const parseAgentPeers = (output: Json, node: string): PeerSession[] => {
  if (!Array.isArray(output)) {
    throw new Error("Expected a JSON list of peers from cilium-dbg bgp peers");
  }

  return output.map((peer: Json) => {
    const uptimeNs = num(peer?.["uptime-nanoseconds"]);

    return {
      node,
      localASN: num(peer?.["local-asn"]),
      peerAddress: str(peer?.["peer-address"]),
      peerASN: num(peer?.["peer-asn"]),
      peerPort: num(peer?.["peer-port"]),
      state: str(peer?.["session-state"]),
      established: isEstablished(peer?.["session-state"]),
      uptimeSeconds: uptimeNs !== undefined && isEstablished(peer?.["session-state"]) ? Math.floor(uptimeNs / 1e9) : undefined,
      holdTimeSeconds: num(peer?.["applied-hold-time-seconds"]) ?? num(peer?.["configured-hold-time-seconds"]),
      keepAliveSeconds: num(peer?.["applied-keep-alive-time-seconds"]) ?? num(peer?.["configured-keep-alive-time-seconds"]),
      connectRetrySeconds: num(peer?.["connect-retry-time-seconds"]),
      routes: ((peer?.families ?? []) as Json[]).map((family) => ({
        afi: String(family?.afi ?? ""),
        safi: String(family?.safi ?? ""),
        advertised: num(family?.advertised),
        received: num(family?.received),
        accepted: num(family?.accepted),
      })),
      source: "agent" as const,
    };
  });
};

export const formatDuration = (seconds: number | undefined): string => {
  if (seconds === undefined) {
    return "—";
  }

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;

  return `${secs}s`;
};

export const sumRoutes = (routes: readonly RouteCount[], field: "advertised" | "received"): number | undefined =>
  routes.some((route) => route[field] !== undefined) ? routes.reduce((sum, route) => sum + (route[field] ?? 0), 0) : undefined;

// ---------------------------------------------------------------------------------------------
// Runtime state: routes

export interface AgentRoute {
  readonly prefix: string;
  readonly neighbor?: string;
  readonly routerAsn?: number;
  readonly best?: boolean;
  readonly ageSeconds?: number;
  readonly family?: string;
}

/** Parses `cilium-dbg bgp routes advertised <afi> <safi> -o json` (a list of the agent API's BgpRoute). */
export const parseAgentRoutes = (output: Json): AgentRoute[] => {
  if (output === null) {
    return [];
  }

  if (!Array.isArray(output)) {
    throw new Error("Expected a JSON list of routes from cilium-dbg bgp routes");
  }

  return output.flatMap((route: Json) => {
    const paths = (route?.paths ?? []) as Json[];
    const base = { prefix: String(route?.prefix ?? ""), neighbor: str(route?.neighbor), routerAsn: num(route?.["router-asn"]) };

    if (paths.length === 0) {
      return [base];
    }

    return paths.map((path) => {
      const ageNs = num(path?.["age-nanoseconds"]);

      return {
        ...base,
        best: typeof path?.best === "boolean" ? path.best : undefined,
        ageSeconds: ageNs !== undefined ? Math.floor(ageNs / 1e9) : undefined,
        family: path?.family ? `${path.family.afi}/${path.family.safi}` : undefined,
      };
    });
  });
};

// ---------------------------------------------------------------------------------------------
// What advertisements resolve to

export const bgpServiceClass = "io.cilium/bgp-control-plane";

/** The labels Cilium matches service selectors against: the service's own and its name and namespace. */
export const serviceSelectorLabels = (service: Json): Record<string, string> => ({
  ...(service?.metadata?.labels ?? {}),
  "io.kubernetes.service.name": service?.metadata?.name,
  "io.kubernetes.service.namespace": service?.metadata?.namespace,
});

export interface ResolvedPrefix {
  readonly prefix: string;
  /** What the prefix comes from: a service, a node's pod CIDR, a pool. */
  readonly origin: string;
  readonly originKind: "Service" | "CiliumNode" | "CiliumPodIPPool";
  readonly originNamespace?: string;
  readonly originName: string;
  /** For services: ClusterIP, ExternalIP or LoadBalancerIP. */
  readonly addressType?: string;
  readonly note?: string;
}

export interface ResolvedEntry {
  readonly advertisement: string;
  readonly index: number;
  readonly entry: AdvertisementEntry;
  readonly usedBy: ReadonlyArray<{ readonly peerConfig: string; readonly family: string }>;
  /** Nodes whose BGP instances use this advertisement through some peer. */
  readonly nodes: readonly string[];
  readonly prefixes: readonly ResolvedPrefix[];
  readonly notes: readonly string[];
}

export interface ResolveInput {
  readonly clusterConfigs: readonly ClusterConfig[];
  readonly peerConfigs: readonly PeerConfig[];
  readonly advertisements: readonly Advertisement[];
  readonly services: readonly Json[];
  readonly nodes: readonly Json[];
  readonly ciliumNodes: readonly Json[];
  readonly podIPPools: readonly Json[];
  readonly ipamMode?: string;
}

const hostPrefix = (ip: string) => (ip.includes(":") ? `${ip}/128` : `${ip}/32`);

export const serviceAddresses = (service: Json, addressType: string): string[] => {
  switch (addressType) {
    case "ClusterIP":
      return ((service?.spec?.clusterIPs ?? (service?.spec?.clusterIP ? [service.spec.clusterIP] : [])) as string[]).filter((ip) => ip && ip !== "None");
    case "ExternalIP":
      return (service?.spec?.externalIPs ?? []) as string[];
    case "LoadBalancerIP":
      return service?.spec?.type === "LoadBalancer" ? (((service?.status?.loadBalancer?.ingress ?? []) as Json[]).map((ingress) => ingress?.ip).filter(Boolean) as string[]) : [];
    default:
      return [];
  }
};

/** Node labels by name, from the Node objects, or the CiliumNode's own labels when the Node is not readable. */
const nodeLabels = (nodes: readonly Json[], ciliumNodes: readonly Json[]) => {
  const labels = new Map<string, Record<string, string>>();

  for (const node of ciliumNodes) labels.set(node?.metadata?.name, node?.metadata?.labels ?? {});
  for (const node of nodes) labels.set(node?.metadata?.name, node?.metadata?.labels ?? {});

  return labels;
};

/** Resolves every advertisement entry to the prefixes it selects, and the peers and nodes that use it. */
export const resolveAdvertisements = (input: ResolveInput): ResolvedEntry[] => {
  const labelsByNode = nodeLabels(input.nodes, input.ciliumNodes);
  const nodeNames = [...labelsByNode.keys()];

  return input.advertisements.flatMap((advertisement) =>
    advertisement.entries.map((entry, index) => {
      const usedBy = input.peerConfigs.flatMap((peerConfig) =>
        (peerConfig.familiesDefaulted ? [] : peerConfig.families)
          .filter((family) => family.advertisements && selectorMatches(family.advertisements, advertisement.labels))
          .map((family) => ({ peerConfig: peerConfig.name, family: `${family.afi}/${family.safi}` })),
      );
      const usingPeerConfigs = new Set(usedBy.map((use) => use.peerConfig));
      const nodes = new Set<string>();

      for (const config of input.clusterConfigs) {
        if (config.instances.some((instance) => instance.peers.some((peer) => peer.peerConfigRef && usingPeerConfigs.has(peer.peerConfigRef)))) {
          for (const node of nodeNames) {
            if (selectorMatches(config.nodeSelector, labelsByNode.get(node) ?? {})) nodes.add(node);
          }
        }
      }

      const notes: string[] = [];
      const prefixes: ResolvedPrefix[] = [];

      if (usedBy.length === 0) {
        notes.push("No peer config family selects this advertisement, so nothing of it is advertised.");
      } else if (nodes.size === 0) {
        notes.push("No node runs a BGP instance whose peers use this advertisement.");
      }

      switch (entry.advertisementType) {
        case "Service": {
          if (!entry.selector) {
            notes.push("No selector: selects no service. To select every service, use a NotIn expression with a value no service has.");
            break;
          }

          for (const service of input.services) {
            if (!selectorMatches(entry.selector, serviceSelectorLabels(service))) continue;

            const namespace = service?.metadata?.namespace;
            const name = service?.metadata?.name;
            const lbClass = service?.spec?.loadBalancerClass;
            const local = service?.spec?.externalTrafficPolicy === "Local" ? "externalTrafficPolicy Local: advertised only from nodes with a ready endpoint" : undefined;

            for (const addressType of entry.addresses) {
              if (addressType === "LoadBalancerIP" && lbClass && lbClass !== bgpServiceClass) {
                if (service?.spec?.type === "LoadBalancer") {
                  notes.push(`${namespace}/${name}: loadBalancerClass ${lbClass} is not ${bgpServiceClass}, so its LoadBalancer IPs are not advertised.`);
                }

                continue;
              }

              for (const ip of serviceAddresses(service, addressType)) {
                prefixes.push({ prefix: hostPrefix(ip), origin: `${namespace}/${name} (${addressType})`, originKind: "Service", originNamespace: namespace, originName: name, addressType, note: addressType === "ClusterIP" ? undefined : local });
              }
            }
          }

          break;
        }
        case "PodCIDR": {
          if (input.ipamMode === "multi-pool") {
            notes.push("IPAM mode is multi-pool: pod CIDRs are advertised with CiliumPodIPPool advertisements instead.");
          }

          for (const name of [...nodes].sort()) {
            const ciliumNode = input.ciliumNodes.find((candidate) => candidate?.metadata?.name === name);
            const node = input.nodes.find((candidate) => candidate?.metadata?.name === name);
            const cidrs: string[] = ciliumNode?.spec?.ipam?.podCIDRs?.length ? ciliumNode.spec.ipam.podCIDRs : (node?.spec?.podCIDRs ?? (node?.spec?.podCIDR ? [node.spec.podCIDR] : []));

            for (const cidr of cidrs) {
              prefixes.push({ prefix: cidr, origin: `node ${name}`, originKind: "CiliumNode", originName: name });
            }
          }

          break;
        }
        case "CiliumPodIPPool": {
          if (!entry.selector) {
            notes.push("No selector: selects no pool.");
            break;
          }

          const pools = input.podIPPools.filter((pool) => selectorMatches(entry.selector, pool?.metadata?.labels ?? {}));

          if (pools.length === 0) {
            notes.push("The selector matches no CiliumPodIPPool.");
          }

          for (const pool of pools) {
            const poolName = pool?.metadata?.name;
            let allocated = false;

            for (const name of [...nodes].sort()) {
              const ciliumNode = input.ciliumNodes.find((candidate) => candidate?.metadata?.name === name);

              for (const allocation of (ciliumNode?.spec?.ipam?.pools?.allocated ?? []) as Json[]) {
                if (allocation?.pool !== poolName) continue;

                for (const cidr of (allocation?.cidrs ?? []) as string[]) {
                  allocated = true;
                  prefixes.push({ prefix: cidr, origin: `pool ${poolName} on node ${name}`, originKind: "CiliumPodIPPool", originName: poolName });
                }
              }
            }

            if (!allocated) {
              notes.push(`Pool ${poolName}: no CIDR of it is allocated to a node using this advertisement yet.`);
            }
          }

          break;
        }
        case "Interface":
          notes.push(`Advertises the addresses of interface ${entry.interfaceName ?? "(unnamed)"} on each node; they are only known to the agent.`);
          break;
        default:
          notes.push(`Advertisement type ${entry.advertisementType || "(none)"} is not known to this view.`);
      }

      return { advertisement: advertisement.name, index, entry, usedBy, nodes: [...nodes].sort(), prefixes, notes };
    }),
  );
};

/** The address families the agents serve, from cilium-config: IPv4 unless turned off, IPv6 when turned on. */
export const enabledFamilies = (config: Readonly<Record<string, string>> | undefined): Array<"ipv4" | "ipv6"> => {
  const families: Array<"ipv4" | "ipv6"> = [];

  if (config?.["enable-ipv4"] !== "false") families.push("ipv4");
  if (config?.["enable-ipv6"] === "true") families.push("ipv6");

  return families;
};

/** Services whose LoadBalancer IPs some peer is sent: by a used v2 advertisement, keyed `namespace/name`. */
export const bgpAdvertisedServices = (resolved: readonly ResolvedEntry[]): Set<string> =>
  new Set(
    resolved
      .filter((entry) => entry.usedBy.length > 0 && entry.nodes.length > 0)
      .flatMap((entry) => entry.prefixes.filter((prefix) => prefix.originKind === "Service" && prefix.addressType === "LoadBalancerIP").map((prefix) => `${prefix.originNamespace}/${prefix.originName}`)),
  );

/** Whether a legacy peering policy advertises a service's LoadBalancer IPs. */
export const legacyAdvertisesService = (policy: LegacyPolicy, service: Json): boolean =>
  service?.spec?.type === "LoadBalancer" &&
  (!service?.spec?.loadBalancerClass || service.spec.loadBalancerClass === bgpServiceClass) &&
  policy.virtualRouters.some((router) => router.neighbors.length > 0 && router.serviceSelector !== undefined && router.serviceAdvertisements.includes("LoadBalancerIP") && selectorMatches(router.serviceSelector, serviceSelectorLabels(service)));
