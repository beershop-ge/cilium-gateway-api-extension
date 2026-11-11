export interface LayoutNode {
  readonly id: string;
  readonly column: number;
  /** Initial order within the column, and the tie-break: deterministic for the same input. */
  readonly sortKey: string;
}

export interface LayoutEdge {
  readonly from: string;
  readonly to: string;
}

export interface LayoutOptions {
  readonly nodeWidth: number;
  readonly nodeHeight: number;
  readonly columnGap: number;
  readonly rowGap: number;
  /** Ordering sweeps; each sweep runs left to right, then right to left. */
  readonly sweeps: number;
}

export const defaultLayoutOptions: LayoutOptions = { nodeWidth: 232, nodeHeight: 64, columnGap: 96, rowGap: 18, sweeps: 4 };

export interface Layout {
  readonly positions: ReadonlyMap<string, { readonly x: number; readonly y: number }>;
  readonly width: number;
  readonly height: number;
  readonly options: LayoutOptions;
}

/**
 * A layered layout: one column per layer that has nodes (empty ones are dropped), each column ordered by the
 * barycenter of its neighbours' rows to reduce crossings, then centred vertically. Same input, same output.
 */
export const layoutGraph = (nodes: readonly LayoutNode[], edges: readonly LayoutEdge[], options: LayoutOptions = defaultLayoutOptions): Layout => {
  const columns = [...new Set(nodes.map((node) => node.column))].sort((a, b) => a - b);
  const columnIndex = new Map(columns.map((value, index) => [value, index]));
  const columnOf = new Map(nodes.map((node) => [node.id, columnIndex.get(node.column)!]));
  const known = new Set(columnOf.keys());
  const neighbours = new Map<string, { up: string[]; down: string[] }>(nodes.map((node) => [node.id, { up: [], down: [] }]));

  for (const edge of edges) {
    if (!known.has(edge.from) || !known.has(edge.to) || edge.from === edge.to) continue;
    neighbours.get(edge.from)!.down.push(edge.to);
    neighbours.get(edge.to)!.up.push(edge.from);
  }

  const order: LayoutNode[][] = columns.map((value) =>
    nodes.filter((node) => node.column === value).sort((a, b) => a.sortKey.localeCompare(b.sortKey) || a.id.localeCompare(b.id)),
  );
  // Rows are normalised to 0..1 so columns of different heights compare fairly.
  const rank = new Map<string, number>();
  const assignRanks = (index: number) =>
    order[index].forEach((node, row) => rank.set(node.id, order[index].length === 1 ? 0.5 : row / (order[index].length - 1)));

  order.forEach((_, index) => assignRanks(index));

  const reorder = (index: number, side: "up" | "down") => {
    const current = order[index];
    const position = new Map(current.map((node, row) => [node.id, row]));
    const barycenter = (node: LayoutNode) => {
      const ranks = neighbours.get(node.id)![side].filter((other) => columnOf.get(other) !== index).map((other) => rank.get(other)!);

      return ranks.length > 0 ? ranks.reduce((sum, value) => sum + value, 0) / ranks.length : rank.get(node.id)!;
    };
    const centres = new Map(current.map((node) => [node.id, barycenter(node)]));

    order[index] = [...current].sort((a, b) => centres.get(a.id)! - centres.get(b.id)! || position.get(a.id)! - position.get(b.id)!);
    assignRanks(index);
  };

  for (let sweep = 0; sweep < options.sweeps; sweep++) {
    for (let index = 1; index < order.length; index++) reorder(index, "up");
    for (let index = order.length - 2; index >= 0; index--) reorder(index, "down");
  }

  const rowHeight = options.nodeHeight + options.rowGap;
  const tallest = Math.max(0, ...order.map((columnNodes) => columnNodes.length));
  const positions = new Map<string, { x: number; y: number }>();

  order.forEach((columnNodes, index) => {
    const offset = ((tallest - columnNodes.length) * rowHeight) / 2;

    columnNodes.forEach((node, row) => positions.set(node.id, { x: index * (options.nodeWidth + options.columnGap), y: offset + row * rowHeight }));
  });

  return {
    positions,
    width: columns.length === 0 ? 0 : columns.length * options.nodeWidth + (columns.length - 1) * options.columnGap,
    height: tallest === 0 ? 0 : tallest * rowHeight - options.rowGap,
    options,
  };
};
