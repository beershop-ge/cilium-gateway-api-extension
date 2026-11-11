import type { Health } from "../common/conditions";
import type { GraphEdge, GraphNode } from "./graph";
import type { Layout } from "./layout";
import { observedLabel, type ObservedEdge, verdictOf } from "./traffic";

/** Concrete colours for a file that has no access to Lens's theme variables; the UI reads them from the theme. */
export interface SvgPalette {
  readonly background: string;
  readonly nodeFill: string;
  readonly nodeStroke: string;
  readonly text: string;
  readonly mutedText: string;
  readonly edge: string;
  readonly ok: string;
  readonly warn: string;
  readonly error: string;
  readonly unknown: string;
  readonly primary: string;
}

export const defaultPalette: SvgPalette = {
  background: "#1e2124",
  nodeFill: "#262b2f",
  nodeStroke: "#4b5258",
  text: "#e0e0e0",
  mutedText: "#a0a0a0",
  edge: "#8a9096",
  ok: "#48c78e",
  warn: "#ff9f43",
  error: "#ce3933",
  unknown: "#87909c",
  primary: "#3d90ce",
};

export interface SvgInput {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly observed?: readonly ObservedEdge[];
  readonly layout: Layout;
  readonly palette?: SvgPalette;
  readonly title?: string;
}

const escapeXml = (text: string) => text.replace(/[<>&"']/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[character]!);

const clip = (text: string, length: number) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

const healthColor = (palette: SvgPalette, health: Health) => ({ ok: palette.ok, warn: palette.warn, error: palette.error, unknown: palette.unknown })[health];

const margin = 24;
const titleHeight = 32;

/** The size of the exported document, for rasterising it. */
export const svgSize = (layout: Layout, title?: string) => {
  const top = margin + (title ? titleHeight : 0);

  return { top, width: Math.max(layout.width, 200) + margin * 2, height: Math.max(layout.height, layout.options.nodeHeight) + top + margin };
};

/** The graph as a standalone SVG document, drawn from the layout's positions (not from the screen). */
export const graphToSvg = ({ nodes, edges, observed = [], layout, palette = defaultPalette, title }: SvgInput): string => {
  const { nodeWidth, nodeHeight } = layout.options;
  const { top, width, height } = svgSize(layout, title);
  const at = (id: string) => {
    const position = layout.positions.get(id);

    return position ? { x: position.x + margin, y: position.y + top } : undefined;
  };
  const curve = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const x1 = from.x + nodeWidth;
    const y1 = from.y + nodeHeight / 2;
    const x2 = to.x;
    const y2 = to.y + nodeHeight / 2;
    const bend = Math.max(40, Math.abs(x2 - x1) / 2);

    return `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`;
  };
  const verdictColor = { forwarded: palette.ok, dropped: palette.error, mixed: palette.warn, other: palette.unknown };
  const parts: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif">`,
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${palette.edge}"/></marker></defs>`,
    `<rect width="100%" height="100%" fill="${palette.background}"/>`,
  ];

  if (title) parts.push(`<text x="${margin}" y="${margin + 14}" font-size="16" font-weight="600" fill="${palette.text}">${escapeXml(title)}</text>`);

  parts.push(`<g class="edges">`);

  for (const edge of edges) {
    const from = at(edge.from);
    const to = at(edge.to);

    if (!from || !to) continue;

    const stroke = edge.health === "error" ? palette.error : edge.health === "warn" ? palette.warn : palette.edge;
    const dash = edge.relation === "config" ? ` stroke-dasharray="2 4"` : edge.via ? ` stroke-dasharray="8 3"` : "";

    parts.push(`<path d="${curve(from, to)}" fill="none" stroke="${stroke}" stroke-width="1.5"${dash} marker-end="url(#arrow)"><title>${escapeXml([edge.label, edge.via ? `via ${edge.via}` : ""].filter(Boolean).join(" · ") || edge.relation)}</title></path>`);
  }

  for (const edge of observed) {
    const from = at(edge.from);
    const to = at(edge.to);

    if (!from || !to) continue;

    const color = verdictColor[verdictOf(edge)];
    const path = curve(from, to);
    const mx = (from.x + nodeWidth + to.x) / 2;
    const my = (from.y + to.y + nodeHeight) / 2;

    parts.push(`<path d="${path}" fill="none" stroke="${color}" stroke-width="2.5" stroke-dasharray="6 4" marker-end="url(#arrow)"><title>${escapeXml(observedLabel(edge))}</title></path>`);
    parts.push(`<text x="${mx}" y="${my - 4}" font-size="10" text-anchor="middle" fill="${color}">${escapeXml(observedLabel(edge))}</text>`);
  }

  parts.push(`</g><g class="nodes">`);

  for (const node of nodes) {
    const position = at(node.id);

    if (!position) continue;

    const stroke = node.health === "error" ? palette.error : node.health === "warn" ? palette.warn : palette.nodeStroke;

    parts.push(
      `<g transform="translate(${position.x},${position.y})">`,
      `<title>${escapeXml(`${node.kind} ${node.namespace ? `${node.namespace}/` : ""}${node.title}${node.healthReason ? ` — ${node.healthReason}` : ""}`)}</title>`,
      `<rect width="${nodeWidth}" height="${nodeHeight}" rx="6" fill="${palette.nodeFill}" stroke="${stroke}" stroke-width="${node.health === "error" || node.health === "warn" ? 2 : 1}"${node.missing ? ` stroke-dasharray="4 3"` : ""}/>`,
      `<circle cx="14" cy="16" r="5" fill="${healthColor(palette, node.health)}"/>`,
      `<text x="26" y="20" font-size="10" fill="${palette.mutedText}">${escapeXml(clip(node.kind, 32))}</text>`,
      `<text x="12" y="38" font-size="13" font-weight="600" fill="${palette.text}">${escapeXml(clip(node.title, 30))}</text>`,
      node.subtitle ? `<text x="12" y="54" font-size="10" fill="${palette.mutedText}">${escapeXml(clip(node.subtitle, 38))}</text>` : "",
      `</g>`,
    );
  }

  parts.push(`</g></svg>`);

  return parts.filter(Boolean).join("\n");
};
