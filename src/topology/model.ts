import type { Flow } from "../observability/hubble";
import { applyFilter, type GraphFilter } from "./filter";
import type { Graph, GraphNode } from "./graph";
import { defaultLayoutOptions, type Layout, layoutGraph, type LayoutOptions } from "./layout";
import { observedTraffic, type Traffic } from "./traffic";

export type TopologyView =
  | { readonly kind: "too-large"; readonly count: number; readonly max: number; readonly graph: Graph }
  | { readonly kind: "ready"; readonly graph: Graph; readonly nodes: readonly GraphNode[]; readonly traffic?: Traffic; readonly layout: Layout };

/**
 * What the page draws: the graph narrowed by the filters, refused when larger than `maxNodes` (so the user
 * narrows it rather than getting an unusable picture), with observed traffic overlaid when flows are given.
 */
export const computeView = (full: Graph, filter: GraphFilter, maxNodes: number, flows?: readonly Flow[], options: LayoutOptions = defaultLayoutOptions): TopologyView => {
  const graph = applyFilter(full, filter);

  if (maxNodes > 0 && graph.nodes.length > maxNodes) {
    return { kind: "too-large", count: graph.nodes.length, max: maxNodes, graph };
  }

  const traffic = flows ? observedTraffic(flows, graph.nodes) : undefined;
  const nodes = [...graph.nodes, ...(traffic?.peers ?? [])];
  const layout = layoutGraph(
    nodes.map((node) => ({ id: node.id, column: node.column, sortKey: `${node.namespace ?? ""}/${node.title}` })),
    [...graph.edges, ...(traffic?.edges ?? [])],
    options,
  );

  return { kind: "ready", graph, nodes, traffic, layout };
};
