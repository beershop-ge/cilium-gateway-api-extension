import { Badge } from "@k8slens/badge";
import { ClickableDiv, Div, Span } from "@k8slens/element-components";
import { ArrowForwardIcon, CloseIcon, ContentCopyIcon, FileDownloadIcon, FilterAltIcon, OpenInBrowserIcon } from "@k8slens/icon";
import { PlainButton, TextInput } from "@k8slens/input-components";
import { useInject } from "@k8slens/use-inject";
import {
  Background,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  MiniMap,
  type Node,
  type NodeProps,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Viewport,
} from "../vendor/xyflow-react";
import { observer } from "mobx-react";
import { memo, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { Health } from "../common/conditions";
import { errorMessage } from "../common/json";
import type { Query, QueryState } from "../common/query";
import { redactText } from "../common/redact";
import type { ClusterContext } from "../kube/cluster-context.injectable";
import type { Snapshot } from "../kube/snapshot";
import { useViewState } from "../navigation/view-state.injectable";
import { type FlowResult, hubbleStatus, observeFlows } from "../observability/hubble";
import { resourceActionsInjectable } from "../resources/resource-actions.injectable";
import { settingsStoreInjectable } from "../settings/settings.injectable";
import { downloadBlob, downloadText } from "../ui/code-editor";
import { Callout, Checkbox, ConditionsList, Facts, HealthBadge, Section, useQueryState } from "../ui/components";
import { notifyInjectable } from "../ui/notify.injectable";
import { useClusterContext, useRefreshSeconds } from "../ui/use-cluster";
import { defaultPalette, graphToSvg, type SvgPalette, svgSize } from "./export-svg";
import { connectedPath, layerCounts, namespaceCounts, searchNodes } from "./filter";
import { buildGraph, type Graph, type GraphEdge, type GraphNode, type Layer, layers } from "./graph";
import { topologyBuiltins, topologyKinds } from "./kinds";
import type { Layout } from "./layout";
import { computeView, type TopologyView } from "./model";
import styles from "./topology.module.scss";
import { observedLabel, type ObservedEdge, verdictOf } from "./traffic";

const healthClass: Record<Health, string> = { ok: styles.ok, warn: styles.warn, error: styles.error, unknown: styles.unknown };
const dotClass: Record<Health, string> = { ok: styles.dotOk, warn: styles.dotWarn, error: styles.dotError, unknown: styles.dotUnknown };
const verdictColor = { forwarded: "var(--success)", dropped: "var(--critical)", mixed: "var(--warning)", other: "var(--grey40)" } as const;

/* ---------- Data ---------- */

/** Kinds and builtins whose read failed, so the builder reports health that depends on them as unknown. */
export const unavailableOf = (snapshot: Snapshot, titleOfKind: (kind: string) => string | undefined): string[] => {
  const failed = new Set(snapshot.errors.map((error) => error.what));

  return [...topologyKinds.filter((kind) => failed.has(titleOfKind(kind) ?? kind)), ...topologyBuiltins.filter((builtin) => failed.has(builtin))];
};

interface TrafficState {
  readonly enabled: boolean;
  readonly status?: { readonly available: boolean; readonly reason?: string };
  readonly checking: boolean;
  readonly infoError?: Error;
  readonly flows?: QueryState<FlowResult>;
  readonly refresh?: () => void;
}

/** Hubble flows for the overlay, read only while the toggle is on and Hubble is available. */
const useTraffic = (context: ClusterContext, enabled: boolean): TrafficState => {
  const settings = useInject(settingsStoreInjectable)().get();
  const refreshSeconds = useRefreshSeconds();
  const info = context.ciliumInfo.state();
  const status = info.value ? hubbleStatus(info.value) : undefined;
  const available = enabled && status?.available === true;
  const query: Query<FlowResult> = context.queries.get(`topology-flows:${settings.flowLimit}:${settings.hubbleRelayAddress}`, async () => {
    const current = context.ciliumInfo.state().value;

    if (!current) throw new Error("Cilium has not been read yet");

    return observeFlows(context.kubectl, current, { last: settings.flowLimit }, { relayOverride: settings.hubbleRelayAddress || undefined });
  });

  useEffect(() => {
    if (enabled) context.ciliumInfo.ensure();
  }, [enabled, context]);

  useEffect(() => {
    if (!available) return undefined;

    query.ensure();

    if (refreshSeconds <= 0) return undefined;

    const interval = setInterval(() => void query.refresh(), refreshSeconds * 1000);

    return () => clearInterval(interval);
  }, [available, query, refreshSeconds]);

  return {
    enabled,
    status,
    checking: enabled && !info.value && info.status !== "error",
    infoError: info.value ? undefined : info.error,
    flows: available ? query.state() : undefined,
    refresh: available ? () => void query.refresh() : undefined,
  };
};

/* ---------- Graph node ---------- */

interface NodeData extends Record<string, unknown> {
  readonly node: GraphNode;
  readonly isSelected: boolean;
  readonly matched: boolean;
}

type TopologyNode = Node<NodeData, "topology">;

const TopologyNodeView = memo(({ data }: NodeProps<TopologyNode>) => {
  const { node } = data;

  return (
    <div
      className={[styles.node, healthClass[node.health], node.missing ? styles.missing : "", data.isSelected ? styles.selected : "", data.matched ? styles.matched : ""].join(" ")}
      title={`${node.kind} ${node.namespace ? `${node.namespace}/` : ""}${node.title}${node.healthReason ? `\n${node.healthReason}` : ""}`}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} className={styles.handle} />
      <div className={styles.kindLine}>
        <span className={`${styles.dot} ${dotClass[node.health]}`} />
        <span>{node.kind}</span>
        {node.missing && <span>· not found</span>}
      </div>
      <div className={styles.title}>{node.title}</div>
      {node.subtitle && <div className={styles.subtitle}>{node.subtitle}</div>}
      <Handle type="source" position={Position.Right} isConnectable={false} className={styles.handle} />
    </div>
  );
});

const nodeTypes = { topology: TopologyNodeView };

/* ---------- Canvas ---------- */

interface CanvasProps {
  readonly view: Extract<TopologyView, { kind: "ready" }>;
  readonly selected: string | undefined;
  readonly onSelect: (id: string | undefined) => void;
  readonly matches: readonly GraphNode[];
  readonly focus: { readonly id: string; readonly seq: number } | undefined;
  readonly tabKey: string;
}

const edgeStyle = (edge: GraphEdge) => ({
  stroke: edge.health === "error" ? "var(--critical)" : edge.health === "warn" ? "var(--warning)" : "var(--grey50)",
  strokeWidth: 1.5,
  strokeDasharray: edge.relation === "config" ? "2 4" : edge.via ? "8 3" : undefined,
});

const Canvas = observer(({ view, selected, onSelect, matches, focus, tabKey }: CanvasProps) => {
  const [savedViewport, setSavedViewport] = useViewState<Viewport | undefined>(tabKey, "viewport", undefined);
  const [initialViewport] = useState(savedViewport);
  const flow = useReactFlow();
  const { nodeWidth, nodeHeight } = view.layout.options;

  const highlight = useMemo(() => {
    if (!selected) return undefined;

    const observedEdge = view.traffic?.edges.find((edge) => edge.id === selected);

    if (observedEdge) return { nodes: new Set([observedEdge.from, observedEdge.to]), edges: new Set([observedEdge.id]) };

    const path = connectedPath(view.graph.edges, selected);
    const observedTouching = (view.traffic?.edges ?? []).filter((edge) => edge.from === selected || edge.to === selected);

    return {
      nodes: new Set([...path.nodes, ...observedTouching.flatMap((edge) => [edge.from, edge.to])]),
      edges: new Set([...path.edges, ...observedTouching.map((edge) => edge.id)]),
    };
  }, [selected, view]);

  const matchIds = useMemo(() => new Set(matches.map((node) => node.id)), [matches]);

  const nodes = useMemo<TopologyNode[]>(
    () =>
      view.nodes.map((node) => ({
        id: node.id,
        type: "topology",
        position: view.layout.positions.get(node.id) ?? { x: 0, y: 0 },
        data: { node, isSelected: node.id === selected, matched: matchIds.has(node.id) },
        width: nodeWidth,
        height: nodeHeight,
        style: { width: nodeWidth, height: nodeHeight },
        className: highlight && !highlight.nodes.has(node.id) ? "dimmed" : undefined,
        draggable: false,
        connectable: false,
        ariaLabel: `${node.kind} ${node.title}`,
      })),
    [view, selected, matchIds, highlight, nodeWidth, nodeHeight],
  );

  const edges = useMemo<Edge[]>(() => {
    const configured: Edge[] = view.graph.edges.map((edge) => {
      const onPath = highlight?.edges.has(edge.id) ?? false;
      const label = edge.via ? `via ${edge.via}` : onPath ? edge.label : undefined;

      return {
        id: edge.id,
        source: edge.from,
        target: edge.to,
        style: edgeStyle(edge),
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: edgeStyle(edge).stroke },
        label,
        selectable: false,
        focusable: false,
        className: highlight && !onPath ? "dimmed" : undefined,
        zIndex: onPath ? 1 : 0,
      };
    });
    const observed: Edge[] = (view.traffic?.edges ?? []).map((edge) => {
      const color = verdictColor[verdictOf(edge)];

      return {
        id: edge.id,
        source: edge.from,
        target: edge.to,
        animated: true,
        style: { stroke: color, strokeWidth: edge.id === selected ? 4 : 2.5 },
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color },
        label: observedLabel(edge),
        labelStyle: { fill: color, fontWeight: 600 },
        className: highlight && !highlight.edges.has(edge.id) ? "dimmed" : undefined,
        zIndex: 2,
      };
    });

    return [...configured, ...observed];
  }, [view, highlight, selected]);

  // Centre the current search match (or the node picked in the side panel).
  useEffect(() => {
    if (!focus) return;

    const position = view.layout.positions.get(focus.id);

    if (position) void flow.setCenter(position.x + nodeWidth / 2, position.y + nodeHeight / 2, { zoom: Math.max(flow.getZoom(), 0.9), duration: 300 });
    // Only when asked to focus, not on every refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  return (
    <ReactFlow<TopologyNode, Edge>
      className={styles.flow}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      defaultViewport={initialViewport}
      fitView={!initialViewport}
      fitViewOptions={{ padding: 0.1, maxZoom: 1 }}
      minZoom={0.05}
      maxZoom={2.5}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      onlyRenderVisibleElements={view.nodes.length > 150}
      onNodeClick={(_, node) => onSelect(node.id)}
      onEdgeClick={(_, edge) => {
        if (edge.id.startsWith("observed:")) onSelect(edge.id);
      }}
      onPaneClick={() => onSelect(undefined)}
      onMoveEnd={(_, viewport) => setSavedViewport(viewport)}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={24} />
      <Controls showInteractive={false} position="bottom-left" />
      <MiniMap
        pannable
        zoomable
        position="bottom-right"
        nodeColor={(node) => {
          const health = (node.data as NodeData).node.health;

          return health === "error" ? "var(--critical)" : health === "warn" ? "var(--warning)" : "var(--grey60)";
        }}
      />
      <Panel position="top-right">
        <Legend traffic={view.traffic !== undefined} />
      </Panel>
    </ReactFlow>
  );
});

const LegendLine = ({ className, label }: { className?: string; label: string }) => (
  <div className={styles.legendRow}>
    <span className={`${styles.legendLine} ${className ?? ""}`} />
    <span>{label}</span>
  </div>
);

const Legend = ({ traffic }: { traffic: boolean }) => {
  const [open, setOpen] = useState(true);

  return (
    <div className={styles.legend}>
      <Div $flex={{ direction: "horizontal", verticalAlign: "center", gap: "s" }}>
        <Span $font={{ bold: true }} $flexChild>
          Legend
        </Span>
        <PlainButton $onClick={() => setOpen(!open)} $tooltip={open ? "Hide the legend" : "Show the legend"}>
          {open ? "Hide" : "Show"}
        </PlainButton>
      </Div>
      {open && (
        <>
          {(["ok", "warn", "error", "unknown"] as const).map((health) => (
            <div key={health} className={styles.legendRow}>
              <span className={`${styles.dot} ${dotClass[health]}`} />
              <span>{{ ok: "Healthy", warn: "Degraded or pending", error: "Failing or missing", unknown: "No status" }[health]}</span>
            </div>
          ))}
          <LegendLine label="Traffic path (configured)" />
          <LegendLine className={styles.lineBridged} label="Path through hidden layers" />
          <LegendLine className={styles.lineConfig} label="Selects / references" />
          {traffic && (
            <>
              <LegendLine className={styles.lineForwarded} label="Observed: forwarded" />
              <LegendLine className={styles.lineDropped} label="Observed: dropped" />
              <LegendLine className={styles.lineMixed} label="Observed: both" />
            </>
          )}
        </>
      )}
    </div>
  );
};

/* ---------- Side panel ---------- */

const NeighbourList = ({ title, ids, byId, onPick }: { title: string; ids: readonly string[]; byId: ReadonlyMap<string, GraphNode>; onPick: (id: string) => void }) =>
  ids.length === 0 ? null : (
    <Section title={`${title} (${ids.length})`}>
      <Div $flex={{ direction: "vertical", gap: "xxs" }}>
        {ids.slice(0, 50).map((id) => {
          const node = byId.get(id);

          return (
            <Div key={id} $flex={{ direction: "horizontal", gap: "xs", verticalAlign: "center" }}>
              <span className={`${styles.dot} ${dotClass[node?.health ?? "unknown"]}`} />
              <ClickableDiv className={styles.neighbour} $onClick={() => onPick(id)} $tooltip={node?.healthReason}>
                {node ? `${node.kind} ${node.namespace ? `${node.namespace}/` : ""}${node.title}` : id}
              </ClickableDiv>
            </Div>
          );
        })}
        {ids.length > 50 && <Span $color="textMuted">and {ids.length - 50} more</Span>}
      </Div>
    </Section>
  );

const ObservedFacts = ({ edge, byId }: { edge: ObservedEdge; byId: ReadonlyMap<string, GraphNode> }) => (
  <Facts
    rows={[
      ["From", byId.get(edge.from)?.title ?? edge.from],
      ["To", byId.get(edge.to)?.title ?? edge.to],
      ["Forwarded", String(edge.forwarded)],
      ["Dropped", String(edge.dropped)],
      edge.other > 0 && ["Other verdicts", String(edge.other)],
      ["Ports", edge.ports.join(", ") || "—"],
      ["Protocols", edge.protocols.join(", ") || "—"],
      edge.dropReasons.length > 0 && ["Drop reasons", edge.dropReasons.join(", ")],
      edge.allowedBy.length > 0 && ["Allowed by", edge.allowedBy.join("\n")],
      edge.deniedBy.length > 0 && ["Denied by", edge.deniedBy.join("\n")],
      ["Last seen", edge.lastSeen ? new Date(edge.lastSeen).toLocaleString() : "—"],
    ]}
  />
);

const SidePanel = ({
  clusterId,
  selected,
  view,
  onSelect,
  onFocus,
}: {
  clusterId: string;
  selected: string;
  view: Extract<TopologyView, { kind: "ready" }>;
  onSelect: (id: string | undefined) => void;
  onFocus: (id: string) => void;
}) => {
  const actions = useInject(resourceActionsInjectable)();
  const byId = useMemo(() => new Map(view.nodes.map((node) => [node.id, node])), [view]);
  const pick = (id: string) => {
    onSelect(id);
    onFocus(id);
  };
  const observedEdge = view.traffic?.edges.find((edge) => edge.id === selected);
  const node = byId.get(selected);
  const close = (
    <PlainButton Icon={CloseIcon} $onClick={() => onSelect(undefined)} $tooltip="Close the panel">
      Close
    </PlainButton>
  );

  if (observedEdge) {
    return (
      <Div className={styles.panel} $flex={{ direction: "vertical", gap: "m" }} $padding="m" role="complementary" aria-label="Observed traffic">
        <Div $flex={{ direction: "horizontal", verticalAlign: "center", gap: "s" }}>
          <Span $font={{ size: "l", bold: true }} $flexChild>
            Observed traffic
          </Span>
          {close}
        </Div>
        <Span $color="textMuted" $font={{ size: "s" }}>
          From Hubble flows (replies not counted). This is what was seen, not what is allowed.
        </Span>
        <ObservedFacts edge={observedEdge} byId={byId} />
        <Div $flex={{ direction: "horizontal", gap: "s", wrap: true }}>
          <PlainButton Icon={ArrowForwardIcon} $onClick={() => pick(observedEdge.from)}>
            Source
          </PlainButton>
          <PlainButton Icon={ArrowForwardIcon} $onClick={() => pick(observedEdge.to)}>
            Destination
          </PlainButton>
        </Div>
      </Div>
    );
  }

  if (!node) {
    return null;
  }

  const upstream = [...new Set(view.graph.edges.filter((edge) => edge.to === node.id).map((edge) => edge.from))];
  const downstream = [...new Set(view.graph.edges.filter((edge) => edge.from === node.id).map((edge) => edge.to))];
  const traffic = (view.traffic?.edges ?? []).filter((edge) => edge.from === node.id || edge.to === node.id);

  return (
    <Div className={styles.panel} $flex={{ direction: "vertical", gap: "m" }} $padding="m" role="complementary" aria-label={`${node.kind} ${node.title}`}>
      <Div $flex={{ direction: "horizontal", verticalAlign: "center", gap: "s" }}>
        <Div $flex={{ direction: "vertical", gap: "xxs" }} $flexChild>
          <Span $color="textMuted" $font={{ size: "s" }}>
            {node.kind}
          </Span>
          <Span $font={{ size: "l", bold: true }} className={styles.title}>
            {node.title}
          </Span>
        </Div>
        {close}
      </Div>
      <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center", wrap: true }}>
        <HealthBadge health={node.health} reason={node.healthReason} />
        {node.missing && <Badge small label="Not found" $backgroundColor="critical" $color="white" />}
        {node.namespace && <Badge small label={`Namespace: ${node.namespace}`} />}
      </Div>
      {node.healthReason && (
        <Span $font={{ size: "s" }} $color={node.health === "error" ? "critical" : node.health === "warn" ? "warning" : "textMuted"}>
          {node.healthReason}
        </Span>
      )}
      <Div $flex={{ direction: "horizontal", gap: "s", wrap: true }}>
        {node.ref && (
          <PlainButton Icon={OpenInBrowserIcon} $onClick={() => void actions.openRef(clusterId, node.ref!)} $tooltip={`Open ${node.ref.kind} ${node.ref.name}`}>
            Open {node.ref.kind}
          </PlainButton>
        )}
        <PlainButton Icon={ArrowForwardIcon} $onClick={() => onFocus(node.id)} $tooltip="Centre the graph on this node">
          Centre
        </PlainButton>
      </Div>
      <Section title="Facts">
        <Facts rows={node.facts.map(([label, value]) => [label, value] as const)} />
      </Section>
      {node.conditions.length > 0 && (
        <Section title="Conditions">
          <ConditionsList conditions={node.conditions} />
        </Section>
      )}
      <NeighbourList title="Upstream" ids={upstream} byId={byId} onPick={pick} />
      <NeighbourList title="Downstream" ids={downstream} byId={byId} onPick={pick} />
      {traffic.length > 0 && (
        <Section title={`Observed traffic (${traffic.length})`}>
          <Div $flex={{ direction: "vertical", gap: "xxs" }}>
            {traffic.map((edge) => {
              const other = byId.get(edge.from === node.id ? edge.to : edge.from);

              return (
                <ClickableDiv key={edge.id} className={styles.neighbour} $onClick={() => onSelect(edge.id)} $style={{ color: verdictColor[verdictOf(edge)] }}>
                  {edge.from === node.id ? "→" : "←"} {other?.title ?? "?"}: {observedLabel(edge)}
                </ClickableDiv>
              );
            })}
          </Div>
        </Section>
      )}
    </Div>
  );
};

/* ---------- Export ---------- */

const readPalette = (element: HTMLElement | null): SvgPalette => {
  if (!element) return defaultPalette;

  const style = getComputedStyle(element);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;

  return {
    background: read("--grey100", defaultPalette.background),
    nodeFill: read("--grey80", defaultPalette.nodeFill),
    nodeStroke: read("--grey60", defaultPalette.nodeStroke),
    text: read("--grey20", defaultPalette.text),
    mutedText: read("--grey40", defaultPalette.mutedText),
    edge: read("--grey50", defaultPalette.edge),
    ok: read("--success", defaultPalette.ok),
    warn: read("--warning", defaultPalette.warn),
    error: read("--critical", defaultPalette.error),
    unknown: read("--grey50", defaultPalette.unknown),
    primary: read("--primary", defaultPalette.primary),
  };
};

/** Rasterises the SVG through an image and a canvas, at up to twice the size, within the canvas limits. */
const svgToPng = async (svg: string, layout: Layout, title: string): Promise<Blob> => {
  const { width, height } = svgSize(layout, title);
  const scale = Math.min(2, 16_000 / width, 16_000 / height, Math.sqrt(120_000_000 / (width * height)));
  const image = new Image();

  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();

  const canvas = document.createElement("canvas");

  canvas.width = Math.max(1, Math.floor(width * scale));
  canvas.height = Math.max(1, Math.floor(height * scale));

  const context2d = canvas.getContext("2d");

  if (!context2d) throw new Error("The canvas is not available");
  context2d.scale(scale, scale);
  context2d.drawImage(image, 0, 0, width, height);

  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The image could not be encoded"))), "image/png"));
};

/* ---------- Filters ---------- */

const FilterBar = ({
  full,
  namespaces,
  setNamespaces,
  hiddenLayers,
  setHiddenLayers,
}: {
  full: Graph;
  namespaces: readonly string[];
  setNamespaces: (value: string[]) => void;
  hiddenLayers: readonly Layer[];
  setHiddenLayers: (value: Layer[]) => void;
}) => {
  const counts = useMemo(() => namespaceCounts(full), [full]);
  const perLayer = useMemo(() => layerCounts(full), [full]);

  return (
    <div className={styles.filters}>
      <div className={styles.filterGroup}>
        <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center" }}>
          <Span $font={{ bold: true, size: "s" }}>Layers</Span>
          <PlainButton $onClick={() => setHiddenLayers([])} $enabled={hiddenLayers.length > 0}>
            Show all
          </PlainButton>
        </Div>
        <div className={styles.filterList}>
          {layers
            .filter((layer) => (perLayer.get(layer.id) ?? 0) > 0 || hiddenLayers.includes(layer.id))
            .map((layer) => (
              <Checkbox
                key={layer.id}
                checked={!hiddenLayers.includes(layer.id)}
                label={`${layer.label} (${perLayer.get(layer.id) ?? 0})`}
                onChange={(checked) => setHiddenLayers(checked ? hiddenLayers.filter((id) => id !== layer.id) : [...hiddenLayers, layer.id])}
              />
            ))}
        </div>
      </div>
      <div className={styles.filterGroup} style={{ flex: 1 }}>
        <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center" }}>
          <Span $font={{ bold: true, size: "s" }}>Namespaces {namespaces.length === 0 ? "(all)" : `(${namespaces.length} chosen)`}</Span>
          <PlainButton $onClick={() => setNamespaces([])} $enabled={namespaces.length > 0}>
            All namespaces
          </PlainButton>
        </Div>
        <div className={styles.filterList}>
          {counts.map(({ namespace, count }) => (
            <Checkbox
              key={namespace}
              checked={namespaces.includes(namespace)}
              label={`${namespace} (${count})`}
              onChange={(checked) => setNamespaces(checked ? [...namespaces, namespace] : namespaces.filter((candidate) => candidate !== namespace))}
            />
          ))}
        </div>
      </div>
    </div>
  );
};

/* ---------- Page body ---------- */

export interface TopologyBodyProps {
  readonly clusterId: string;
  readonly tabKey: string;
  readonly snapshot: Snapshot;
}

export const TopologyBody = observer(({ clusterId, tabKey, snapshot }: TopologyBodyProps) => {
  const context = useClusterContext(clusterId);
  const notify = useInject(notifyInjectable)();
  const maxNodes = useInject(settingsStoreInjectable)().get().topologyMaxNodes;
  const [search, setSearch] = useViewState(tabKey, "search", "");
  const [namespaces, setNamespaces] = useViewState<string[]>(tabKey, "namespaces", []);
  const [hiddenLayers, setHiddenLayers] = useViewState<Layer[]>(tabKey, "hiddenLayers", []);
  const [selected, setSelected] = useViewState<string | undefined>(tabKey, "selected", undefined);
  const [trafficOn, setTrafficOn] = useViewState(tabKey, "traffic", false);
  const [filtersOpen, setFiltersOpen] = useViewState(tabKey, "filtersOpen", false);
  const [matchIndex, setMatchIndex] = useState(0);
  const [focus, setFocus] = useState<{ id: string; seq: number }>();
  const container = useRef<HTMLDivElement>(null);
  const traffic = useTraffic(context, trafficOn);
  const discoveryTypes = context.discovery.state().value?.types;

  const unavailable = useMemo(() => unavailableOf(snapshot, (kind) => context.typeOfKind(kind)?.title), [snapshot, context, discoveryTypes]);
  const full = useMemo(() => buildGraph({ items: snapshot.items, unavailable }), [snapshot, unavailable]);
  const flows = traffic.flows?.value?.flows;
  const view = useMemo(() => computeView(full, { namespaces, hiddenLayers }, maxNodes, trafficOn ? flows : undefined), [full, namespaces, hiddenLayers, maxNodes, trafficOn, flows]);
  const matches = useMemo(() => (view.kind === "ready" ? searchNodes(view.nodes, search) : []), [view, search]);
  const focusOn = (id: string) => setFocus((previous) => ({ id, seq: (previous?.seq ?? 0) + 1 }));

  // A selection that no longer exists after a refresh or a filter change is dropped; one that still exists stays.
  const selectionShown = view.kind === "ready" && selected !== undefined && (view.nodes.some((node) => node.id === selected) || (view.traffic?.edges.some((edge) => edge.id === selected) ?? false));

  useEffect(() => setMatchIndex(0), [search]);

  const goToMatch = (index: number) => {
    if (matches.length === 0) return;

    const next = ((index % matches.length) + matches.length) % matches.length;

    setMatchIndex(next);
    focusOn(matches[next].id);
  };

  const exportTitle = `Cilium network topology — ${new Date().toLocaleString()}`;
  const svgOf = () =>
    view.kind === "ready"
      ? graphToSvg({ nodes: view.nodes, edges: view.graph.edges, observed: view.traffic?.edges, layout: view.layout, palette: readPalette(container.current), title: exportTitle })
      : undefined;
  const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const exportPng = async (to: "file" | "clipboard") => {
    const svg = svgOf();

    if (!svg || view.kind !== "ready") return;

    try {
      const blob = await svgToPng(svg, view.layout, exportTitle);

      if (to === "file") {
        downloadBlob(`cilium-topology-${stamp()}.png`, blob);
      } else {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        notify.success("The topology image is on the clipboard.");
      }
    } catch (error) {
      notify.error(error, to === "file" ? "Could not render the PNG" : "Could not copy the image");
    }
  };

  const canExport = view.kind === "ready" && view.nodes.length > 0;

  return (
    <div className={styles.root} ref={container}>
      <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center", wrap: true }} $padding={{ horizontal: "l", bottom: "s" }}>
        <Div $width={{ width: "11xl" }}>
          <TextInput
            type="search"
            aria-label="Search the topology"
            placeholder="Search by name, kind or namespace"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") goToMatch(event.shiftKey ? matchIndex - 1 : matches.length > 0 && focus?.id === matches[matchIndex]?.id ? matchIndex + 1 : matchIndex);
            }}
          />
        </Div>
        {search.trim() !== "" && (
          <>
            <Span $color={matches.length ? "textMuted" : "warning"} $font={{ size: "s" }} aria-live="polite">
              {matches.length ? `${matchIndex + 1} of ${matches.length}` : "No match"}
            </Span>
            <PlainButton $onClick={() => goToMatch(matchIndex - 1)} $enabled={matches.length > 0} $tooltip="Previous match (Shift+Enter)">
              Previous
            </PlainButton>
            <PlainButton $onClick={() => goToMatch(matchIndex + 1)} $enabled={matches.length > 0} $tooltip="Next match (Enter)">
              Next
            </PlainButton>
          </>
        )}
        <PlainButton Icon={FilterAltIcon} $onClick={() => setFiltersOpen(!filtersOpen)} $tooltip="Filter by namespace and layer">
          Filters{namespaces.length + hiddenLayers.length > 0 ? ` (${namespaces.length + hiddenLayers.length})` : ""}
        </PlainButton>
        <Checkbox
          checked={trafficOn}
          onChange={setTrafficOn}
          label="Observed traffic (Hubble)"
          title="Overlay the flows Hubble observed between pods. Nothing is drawn without telemetry."
        />
        <Div $flexChild />
        <PlainButton Icon={FileDownloadIcon} $enabled={canExport} $onClick={() => {
          const svg = svgOf();

          if (svg) downloadText(`cilium-topology-${stamp()}.svg`, svg, "image/svg+xml");
        }} $tooltip="Save the graph as it is filtered now, as SVG">
          SVG
        </PlainButton>
        <PlainButton Icon={FileDownloadIcon} $enabled={canExport} $onClick={() => void exportPng("file")} $tooltip="Save the graph as PNG">
          PNG
        </PlainButton>
        <PlainButton Icon={ContentCopyIcon} $enabled={canExport} $onClick={() => void exportPng("clipboard")} $tooltip="Copy the graph to the clipboard as PNG">
          Copy PNG
        </PlainButton>
      </Div>

      {filtersOpen && <FilterBar full={full} namespaces={namespaces} setNamespaces={setNamespaces} hiddenLayers={hiddenLayers} setHiddenLayers={setHiddenLayers} />}

      <Notices snapshot={snapshot} traffic={traffic} view={view} />

      {view.kind === "too-large" ? (
        <TooLarge view={view} full={full} namespaces={namespaces} setNamespaces={setNamespaces} openFilters={() => setFiltersOpen(true)} />
      ) : view.nodes.length === 0 ? (
        <Div $padding="xl" $flex={{ direction: "vertical", gap: "s" }}>
          <Span $font={{ size: "l", bold: true }}>Nothing to show</Span>
          <Span $color="textMuted">
            {full.nodes.length === 0 ? "No resources of the kinds this view reads were found (or none could be read)." : "No resource matches the current filters."}
          </Span>
        </Div>
      ) : (
        <div className={styles.main}>
          <div className={styles.canvas}>
            <ReactFlowProvider>
              <Canvas view={view} selected={selectionShown ? selected : undefined} onSelect={setSelected} matches={matches} focus={focus} tabKey={tabKey} />
            </ReactFlowProvider>
          </div>
          {selectionShown && selected && <SidePanel clusterId={clusterId} selected={selected} view={view} onSelect={setSelected} onFocus={focusOn} />}
        </div>
      )}
    </div>
  );
});

const Notices = ({ snapshot, traffic, view }: { snapshot: Snapshot; traffic: TrafficState; view: TopologyView }) => {
  const notices: ReactNode[] = [];

  if (snapshot.errors.length > 0) {
    notices.push(
      <Callout key="errors" level="warning" title="Some resources could not be read, so their part of the graph is missing">
        {snapshot.errors.map((error) => (
          <div key={error.what}>
            {error.what}: {error.forbidden ? "not allowed for your Kubernetes user" : redactText(error.message.split("\n")[0])}
          </div>
        ))}
      </Callout>,
    );
  }

  if (snapshot.notInstalled.length > 0) {
    notices.push(
      <Callout key="missing" level="info" title="Not installed on this cluster">
        {snapshot.notInstalled.join(", ")}. Their layers are left out.
      </Callout>,
    );
  }

  if (traffic.enabled) {
    if (traffic.checking) {
      notices.push(<Callout key="hubble" level="info">Checking whether Hubble is available…</Callout>);
    } else if (traffic.infoError) {
      notices.push(
        <Callout key="hubble" level="warning" title="Observed traffic is not shown">
          Cilium could not be read: {redactText(errorMessage(traffic.infoError))}
        </Callout>,
      );
    } else if (traffic.status && !traffic.status.available) {
      notices.push(
        <Callout key="hubble" level="warning" title="Observed traffic is not shown: Hubble is not available">
          {traffic.status.reason}
        </Callout>,
      );
    } else if (traffic.flows) {
      const state = traffic.flows;

      if (state.status === "error" && state.error) {
        notices.push(
          <Callout key="hubble" level="warning" title={state.value ? "The last read of Hubble flows failed; showing the previous one" : "Hubble flows could not be read; no traffic is drawn"}>
            {redactText(errorMessage(state.error))}
          </Callout>,
        );
      } else if (!state.value) {
        notices.push(<Callout key="hubble" level="info">Reading flows from Hubble…</Callout>);
      }

      if (state.value) {
        const result = state.value;
        const overlay = view.kind === "ready" ? view.traffic : undefined;

        notices.push(
          <Callout key="hubble-ok" level="info" title={`Observed traffic: ${result.flows.length} recent flows ${result.scope.kind === "relay" ? "from Hubble Relay" : `from node ${result.scope.node}`}`}>
            {overlay
              ? `${overlay.edges.length} observed connections drawn${overlay.hiddenFlows > 0 ? `; ${overlay.hiddenFlows} flows involve pods not shown under the current filters` : ""}. Observed edges are animated and coloured by verdict; configured relationships are grey.`
              : "Narrow the graph to draw the observed connections."}
            {result.warnings.map((warning) => (
              <div key={warning}>{warning}</div>
            ))}
          </Callout>,
        );
      }
    }
  }

  return notices.length > 0 ? (
    <Div $flex={{ direction: "vertical", gap: "xs" }} $padding={{ horizontal: "l", bottom: "s" }}>
      {notices}
    </Div>
  ) : null;
};

const TooLarge = ({
  view,
  full,
  namespaces,
  setNamespaces,
  openFilters,
}: {
  view: Extract<TopologyView, { kind: "too-large" }>;
  full: Graph;
  namespaces: readonly string[];
  setNamespaces: (value: string[]) => void;
  openFilters: () => void;
}) => {
  const counts = useMemo(() => namespaceCounts(full).slice(0, 12), [full]);

  return (
    <Div $padding="xl" $flex={{ direction: "vertical", gap: "m" }}>
      <Callout level="warning" title={`${view.count} resources match, more than the ${view.max} this view draws`}>
        A graph this size would be unreadable. Pick one or more namespaces, or hide layers such as Endpoints or Pods. The limit is the setting “topology max nodes” of the extension.
      </Callout>
      <Div $flex={{ direction: "horizontal", gap: "s", wrap: true, verticalAlign: "center" }}>
        <Span $font={{ bold: true }}>Largest namespaces:</Span>
        {counts.map(({ namespace, count }) => (
          <PlainButton key={namespace} $onClick={() => setNamespaces([...namespaces.filter((candidate) => candidate !== namespace), namespace])} $tooltip={`Show namespace ${namespace}`}>
            {namespace} ({count})
          </PlainButton>
        ))}
      </Div>
      <Div>
        <PlainButton Icon={FilterAltIcon} $onClick={openFilters}>
          Choose namespaces and layers
        </PlainButton>
      </Div>
    </Div>
  );
};
