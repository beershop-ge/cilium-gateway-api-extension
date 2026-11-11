import type { Flow, FlowEndpoint } from "../observability/hubble";
import { column, type GraphNode, nodeId } from "./graph";

/** Traffic Hubble observed between two nodes of the graph; never inferred from configuration. */
export interface ObservedEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly forwarded: number;
  readonly dropped: number;
  /** Audit, traced and other verdicts. */
  readonly other: number;
  readonly ports: readonly string[];
  readonly protocols: readonly string[];
  readonly dropReasons: readonly string[];
  readonly allowedBy: readonly string[];
  readonly deniedBy: readonly string[];
  readonly lastSeen: string;
}

export type ObservedVerdict = "dropped" | "mixed" | "forwarded" | "other";

export const verdictOf = (edge: Pick<ObservedEdge, "forwarded" | "dropped">): ObservedVerdict =>
  edge.dropped > 0 && edge.forwarded > 0 ? "mixed" : edge.dropped > 0 ? "dropped" : edge.forwarded > 0 ? "forwarded" : "other";

export const observedLabel = (edge: ObservedEdge) =>
  [edge.forwarded > 0 ? `${edge.forwarded} fwd` : "", edge.dropped > 0 ? `${edge.dropped} drop` : "", edge.other > 0 ? `${edge.other} other` : ""].filter(Boolean).join(" · ");

export interface Traffic {
  readonly edges: readonly ObservedEdge[];
  /** Peers outside the graph's pods (the world, hosts, other clusters), drawn as nodes of their own. */
  readonly peers: readonly GraphNode[];
  readonly flowCount: number;
  /** Flows left out because an endpoint is a pod not shown under the current filters. */
  readonly hiddenFlows: number;
}

const reservedOf = (endpoint: FlowEndpoint) => endpoint.labels.find((label) => label.startsWith("reserved:"))?.slice("reserved:".length);

/**
 * Maps flows onto the shown graph: a flow end that is a shown pod lands on that pod; the world lands on the
 * Internet node when shown; anything else that is not a pod becomes an observed peer. Replies are skipped so
 * each connection counts once, in the direction it was opened.
 */
export const observedTraffic = (flows: readonly Flow[], shown: readonly GraphNode[]): Traffic => {
  const shownIds = new Set(shown.map((node) => node.id));
  const peers = new Map<string, GraphNode>();
  const edges = new Map<string, { from: string; to: string; forwarded: number; dropped: number; other: number; ports: Set<string>; protocols: Set<string>; dropReasons: Set<string>; allowedBy: Set<string>; deniedBy: Set<string>; lastSeen: string }>();
  let hiddenFlows = 0;
  let flowCount = 0;

  const resolve = (endpoint: FlowEndpoint): string | undefined => {
    if (endpoint.podName && endpoint.namespace) {
      const id = nodeId.pod(endpoint.namespace, endpoint.podName);

      return shownIds.has(id) ? id : undefined;
    }

    const reserved = reservedOf(endpoint);

    if (reserved === "world" && shownIds.has(nodeId.internet)) return nodeId.internet;

    const name = reserved ?? endpoint.names?.[0] ?? endpoint.ip ?? "unknown";
    const id = `observed:${name}`;

    if (!peers.has(id)) {
      peers.set(id, {
        id,
        layer: "external",
        column: column.external,
        kind: reserved ? "Reserved identity" : "Observed peer",
        title: name,
        subtitle: [endpoint.identity !== undefined ? `identity ${endpoint.identity}` : undefined, endpoint.ip].filter(Boolean).join(" · ") || undefined,
        health: "unknown",
        healthReason: "Seen only in Hubble flows; not a resource of this cluster",
        facts: [
          ["Source", "Hubble flows"],
          ["Identity", endpoint.identity !== undefined ? String(endpoint.identity) : "—"],
          ["Labels", endpoint.labels.join(", ") || "—"],
          ["IP", endpoint.ip ?? "—"],
          ...(endpoint.names?.length ? [["DNS names", endpoint.names.join(", ")] as const] : []),
        ],
        conditions: [],
      });
    }

    return id;
  };

  for (const flow of flows) {
    if (flow.isReply) continue;
    flowCount++;

    const from = resolve(flow.source);
    const to = resolve(flow.destination);

    if (!from || !to) {
      hiddenFlows++;
      continue;
    }

    if (from === to) continue;

    const id = `observed:${from}->${to}`;
    let edge = edges.get(id);

    if (!edge) {
      edge = { from, to, forwarded: 0, dropped: 0, other: 0, ports: new Set(), protocols: new Set(), dropReasons: new Set(), allowedBy: new Set(), deniedBy: new Set(), lastSeen: flow.time };
      edges.set(id, edge);
    }

    if (flow.verdict === "FORWARDED" || flow.verdict === "REDIRECTED" || flow.verdict === "TRANSLATED") edge.forwarded++;
    else if (flow.verdict === "DROPPED" || flow.verdict === "ERROR") edge.dropped++;
    else edge.other++;

    if (flow.destination.port) edge.ports.add(String(flow.destination.port));
    if (flow.protocol) edge.protocols.add(flow.protocol);
    if (flow.dropReason) edge.dropReasons.add(flow.dropReason);
    for (const policy of flow.allowedBy ?? []) edge.allowedBy.add(policy);
    for (const policy of flow.deniedBy ?? []) edge.deniedBy.add(policy);
    if (flow.time && flow.time > edge.lastSeen) edge.lastSeen = flow.time;
  }

  // Only peers that an edge reaches are kept (a flow whose other end is hidden adds none).
  const used = new Set([...edges.values()].flatMap((edge) => [edge.from, edge.to]));

  return {
    edges: [...edges.entries()]
      .map(([id, edge]) => ({
        id,
        from: edge.from,
        to: edge.to,
        forwarded: edge.forwarded,
        dropped: edge.dropped,
        other: edge.other,
        ports: [...edge.ports].sort(),
        protocols: [...edge.protocols].sort(),
        dropReasons: [...edge.dropReasons].sort(),
        allowedBy: [...edge.allowedBy].sort(),
        deniedBy: [...edge.deniedBy].sort(),
        lastSeen: edge.lastSeen,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    peers: [...peers.values()].filter((peer) => used.has(peer.id)).sort((a, b) => a.id.localeCompare(b.id)),
    flowCount,
    hiddenFlows,
  };
};
