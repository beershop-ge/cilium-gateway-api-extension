import type { Graph, GraphEdge, GraphNode, Layer } from "./graph";

export interface GraphFilter {
  /** Namespaces to show; empty shows every namespace. */
  readonly namespaces: readonly string[];
  readonly hiddenLayers: readonly Layer[];
}

/** Layers whose nodes, when hidden, are bridged over along the traffic path, so Service → Pod stays visible without Endpoints. */
const bridgeable: ReadonlySet<Layer> = new Set(["listener", "route", "endpoint"]);

/**
 * Keeps namespaced nodes of the chosen namespaces, and the cluster-scoped nodes connected to them through
 * other cluster-scoped nodes only (a pool serving one of their Services, the BGP chain advertising it, their nodes),
 * without walking on through a Kubernetes node.
 */
export const filterByNamespaces = (graph: Graph, namespaces: readonly string[]): Graph => {
  if (namespaces.length === 0) return graph;

  const chosen = new Set(namespaces);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const neighbours = new Map<string, string[]>();

  for (const edge of graph.edges) {
    neighbours.set(edge.from, [...(neighbours.get(edge.from) ?? []), edge.to]);
    neighbours.set(edge.to, [...(neighbours.get(edge.to) ?? []), edge.from]);
  }

  const kept = new Set(graph.nodes.filter((node) => node.namespace !== undefined && chosen.has(node.namespace)).map((node) => node.id));
  const queue = [...kept];

  while (queue.length > 0) {
    const id = queue.shift()!;

    // A Kubernetes node is kept but not walked through: it would pull in everything else on that node.
    if (byId.get(id)?.layer === "node") continue;

    for (const next of neighbours.get(id) ?? []) {
      const node = byId.get(next);

      if (node && node.namespace === undefined && !kept.has(next)) {
        kept.add(next);
        queue.push(next);
      }
    }
  }

  return { nodes: graph.nodes.filter((node) => kept.has(node.id)), edges: graph.edges.filter((edge) => kept.has(edge.from) && kept.has(edge.to)) };
};

/** Removes hidden layers; a traffic path through hidden listeners, routes or endpoints is kept as one edge marked `via`. */
export const filterByLayers = (graph: Graph, hiddenLayers: readonly Layer[]): Graph => {
  if (hiddenLayers.length === 0) return graph;

  const hidden = new Set(hiddenLayers);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const isKept = (id: string) => !hidden.has(byId.get(id)!.layer);
  const pathOut = new Map<string, GraphEdge[]>();

  for (const edge of graph.edges) {
    if (edge.relation === "path") pathOut.set(edge.from, [...(pathOut.get(edge.from) ?? []), edge]);
  }

  const edges = graph.edges.filter((edge) => isKept(edge.from) && isKept(edge.to));
  const existing = new Set(edges.map((edge) => edge.id));

  for (const start of graph.nodes) {
    if (!isKept(start.id)) continue;

    // Walk forward through hidden bridgeable nodes only, collecting the kept nodes reached.
    const stack = (pathOut.get(start.id) ?? []).filter((edge) => !isKept(edge.to) && bridgeable.has(byId.get(edge.to)!.layer)).map((edge) => ({ id: edge.to, via: [byId.get(edge.to)!.kind] }));
    const seen = new Set<string>();

    while (stack.length > 0) {
      const { id, via } = stack.pop()!;

      if (seen.has(id)) continue;
      seen.add(id);

      for (const edge of pathOut.get(id) ?? []) {
        const target = byId.get(edge.to)!;

        if (isKept(edge.to)) {
          const bridged = `${start.id}->${edge.to}`;

          if (!existing.has(bridged)) {
            existing.add(bridged);
            edges.push({ id: bridged, from: start.id, to: edge.to, relation: "path", health: edge.health, via: [...new Set(via)].join(", ") });
          }
        } else if (bridgeable.has(target.layer)) {
          stack.push({ id: edge.to, via: [...via, target.kind] });
        }
      }
    }
  }

  return { nodes: graph.nodes.filter((node) => isKept(node.id)), edges };
};

export const applyFilter = (graph: Graph, filter: GraphFilter): Graph => filterByLayers(filterByNamespaces(graph, filter.namespaces), filter.hiddenLayers);

export interface Connected {
  readonly nodes: ReadonlySet<string>;
  readonly edges: ReadonlySet<string>;
}

/** Everything upstream and downstream of a node: what leads to it and what it leads to, transitively. */
export const connectedPath = (edges: readonly Pick<GraphEdge, "id" | "from" | "to">[], id: string): Connected => {
  const nodes = new Set([id]);
  const used = new Set<string>();
  const walk = (direction: "down" | "up") => {
    const seen = new Set([id]);
    const queue = [id];

    while (queue.length > 0) {
      const current = queue.shift()!;

      for (const edge of edges) {
        const [here, there] = direction === "down" ? [edge.from, edge.to] : [edge.to, edge.from];

        if (here !== current) continue;
        used.add(edge.id);
        nodes.add(there);

        if (!seen.has(there)) {
          seen.add(there);
          queue.push(there);
        }
      }
    }
  };

  walk("down");
  walk("up");

  return { nodes, edges: used };
};

/** Nodes whose kind, name, namespace or subtitle contain every word of the query, in layout order. */
export const searchNodes = (nodes: readonly GraphNode[], query: string): GraphNode[] => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);

  if (words.length === 0) return [];

  return nodes.filter((node) => {
    const text = `${node.kind} ${node.title} ${node.namespace ?? ""} ${node.subtitle ?? ""}`.toLowerCase();

    return words.every((word) => text.includes(word));
  });
};

/** How many nodes each namespace contributes, largest first, to help pick a smaller view. */
export const namespaceCounts = (graph: Graph): Array<{ namespace: string; count: number }> => {
  const counts = new Map<string, number>();

  for (const node of graph.nodes) {
    if (node.namespace !== undefined) counts.set(node.namespace, (counts.get(node.namespace) ?? 0) + 1);
  }

  return [...counts.entries()].map(([namespace, count]) => ({ namespace, count })).sort((a, b) => b.count - a.count || a.namespace.localeCompare(b.namespace));
};

export const layerCounts = (graph: Graph): Map<Layer, number> => {
  const counts = new Map<Layer, number>();

  for (const node of graph.nodes) counts.set(node.layer, (counts.get(node.layer) ?? 0) + 1);

  return counts;
};
