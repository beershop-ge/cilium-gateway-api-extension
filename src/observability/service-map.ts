import type { FlowEdge, FlowEndpoint } from "./hubble";

export type MapNodeKind = "workload" | "pod" | "reserved" | "external";

export interface MapNode {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly kind: MapNodeKind;
  readonly x: number;
  readonly y: number;
  readonly forwarded: number;
  readonly dropped: number;
}

export interface MapEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly color: "success" | "warning" | "critical" | "grey";
  readonly label: string;
  readonly edge: FlowEdge;
}

export interface ServiceMap {
  readonly nodes: readonly MapNode[];
  readonly edges: readonly MapEdge[];
  readonly groups: ReadonlyArray<{ readonly name: string; readonly x: number; readonly count: number }>;
  readonly truncated: number;
}

const kindOf = (endpoint: FlowEndpoint): MapNodeKind =>
  endpoint.workload ? "workload" : endpoint.podName ? "pod" : endpoint.labels.some((label) => label.startsWith("reserved:")) ? "reserved" : "external";

/** Where a node sits: its namespace, or a column for what is outside the cluster's pods. */
export const groupOf = (endpoint: FlowEndpoint): string => {
  const kind = kindOf(endpoint);

  if (kind === "workload" || kind === "pod") return endpoint.namespace ?? "(no namespace)";
  if (kind === "reserved" && !endpoint.labels.includes("reserved:world")) return "cluster & host";

  return "world";
};

export const edgeColor = (edge: Pick<FlowEdge, "forwarded" | "dropped">): MapEdge["color"] =>
  edge.dropped > 0 && edge.forwarded === 0 ? "critical" : edge.dropped > 0 ? "warning" : edge.forwarded > 0 ? "success" : "grey";

export const edgeLabel = (edge: FlowEdge): string => {
  const counts = [edge.forwarded > 0 ? `${edge.forwarded} ✓` : "", edge.dropped > 0 ? `${edge.dropped} ✗` : "", edge.other > 0 ? `${edge.other} other` : ""].filter(Boolean).join(" ");
  const ports = edge.ports.length > 3 ? `${edge.ports.slice(0, 3).join(", ")} +${edge.ports.length - 3}` : edge.ports.join(", ");

  return ports ? `${counts} · ${ports}` : counts;
};

export const columnWidth = 280;
export const rowHeight = 90;

/**
 * Lays the service map out deterministically: one column per namespace (alphabetically, with "world" and the
 * cluster's reserved identities at the edges), nodes in a column sorted by name; the busiest `maxNodes` are kept.
 */
export const buildServiceMap = (edges: readonly FlowEdge[], maxNodes = 200): ServiceMap => {
  const nodes = new Map<string, { id: string; label: string; group: string; kind: MapNodeKind; forwarded: number; dropped: number }>();

  const touch = (id: string, endpoint: FlowEndpoint, edge: FlowEdge) => {
    const node = nodes.get(id) ?? { id, label: id.includes("/") && kindOf(endpoint) !== "external" ? id.slice(id.indexOf("/") + 1) : id, group: groupOf(endpoint), kind: kindOf(endpoint), forwarded: 0, dropped: 0 };

    node.forwarded += edge.forwarded;
    node.dropped += edge.dropped;
    nodes.set(id, node);
  };

  for (const edge of edges) {
    touch(edge.from, edge.fromEndpoint, edge);
    touch(edge.to, edge.toEndpoint, edge);
  }

  const ranked = [...nodes.values()].sort((a, b) => b.forwarded + b.dropped - (a.forwarded + a.dropped) || a.id.localeCompare(b.id));
  const kept = new Set(ranked.slice(0, Math.max(1, maxNodes)).map((node) => node.id));
  const groupOrder = (group: string) => (group === "world" ? 2 : group === "cluster & host" ? 1 : 0);
  const groupNames = [...new Set(ranked.filter((node) => kept.has(node.id)).map((node) => node.group))].sort((a, b) => groupOrder(a) - groupOrder(b) || a.localeCompare(b));
  const laidOut: MapNode[] = [];
  const groups = groupNames.map((name, column) => {
    const members = ranked.filter((node) => kept.has(node.id) && node.group === name).sort((a, b) => a.label.localeCompare(b.label));

    members.forEach((node, row) => laidOut.push({ ...node, x: column * columnWidth, y: 40 + row * rowHeight }));

    return { name, x: column * columnWidth, count: members.length };
  });

  return {
    nodes: laidOut,
    edges: edges
      .filter((edge) => kept.has(edge.from) && kept.has(edge.to))
      .map((edge) => ({ id: `${edge.from}→${edge.to}`, source: edge.from, target: edge.to, color: edgeColor(edge), label: edgeLabel(edge), edge })),
    groups,
    truncated: nodes.size - kept.size,
  };
};
