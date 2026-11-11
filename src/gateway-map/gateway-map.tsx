import { Badge } from "@k8slens/badge";
import { ClickableDiv, Div, Span, Svg, Table, TBody, Td, Tr } from "@k8slens/element-components";
import { RefreshIcon } from "@k8slens/icon";
import { PlainButton, PrimaryButton, TextInput } from "@k8slens/input-components";
import { useSubscribable } from "@k8slens/subscribable-react";
import { useInject, useSyncInject } from "@k8slens/use-inject";
import { observer } from "mobx-react";
import { Component, type ReactNode, Suspense, use, useEffect, useMemo } from "react";
import { gatewayMapStateInjectable, openGatewayResourceInjectable } from "./gateway-map-state.injectable";
import { gatewaySnapshotBunch } from "./gateway-snapshot.injectable";
import styles from "./gateway-map.module.scss";
import {
  buildTopology,
  columnGap,
  columns,
  type Health,
  layOut,
  type MapNode,
  nodeHeight,
  nodeWidth,
  pathThrough,
  type PositionedNode,
} from "./topology";

const refreshEveryMs = 15_000;

const healthColor = {
  ok: "success",
  warn: "warning",
  error: "critical",
  unknown: "grey40",
} as const satisfies Record<Health, string>;

const healthLabel: Record<Health, string> = {
  ok: "Healthy",
  warn: "Pending",
  error: "Failing",
  unknown: "Unknown",
};

class MapErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    return this.state.error ? (
      <Div $padding="xl" $flex={{ direction: "vertical", gap: "s" }}>
        <Span $font={{ size: "l", bold: true }}>The Gateway API map could not be loaded</Span>
        <Span $color="textMuted">{this.state.error.message}</Span>
      </Div>
    ) : (
      this.props.children
    );
  }
}

export const GatewayMap = ({ clusterId }: { clusterId: string }) => (
  <MapErrorBoundary>
    <Suspense
      fallback={
        <Div $padding="xl" $color="textMuted">
          Reading Gateway API and Cilium resources…
        </Div>
      }
    >
      <GatewayMapLoaded clusterId={clusterId} />
    </Suspense>
  </MapErrorBoundary>
);

const GatewayMapLoaded = observer(({ clusterId }: { clusterId: string }) => {
  const subscribable = useSyncInject(gatewaySnapshotBunch.subscribable, clusterId);
  const { value, refresh } = useSubscribable(subscribable);
  const loaded = use(value).get();
  const state = useInject(gatewayMapStateInjectable)()(clusterId);

  // Kubectl lists cannot be pushed, so the map polls while it is shown.
  useEffect(() => {
    const interval = setInterval(refresh, refreshEveryMs);

    return () => clearInterval(interval);
  }, [refresh]);

  const topology = useMemo(() => buildTopology(loaded.snapshot), [loaded]);
  const layout = useMemo(() => layOut(topology), [topology]);
  const selectedId = state.selectedId();
  const search = state.search().trim().toLowerCase();
  const selected = topology.nodes.find((node) => node.id === selectedId);

  const highlighted = useMemo(() => {
    if (selectedId && topology.nodes.some((node) => node.id === selectedId)) {
      return pathThrough(topology, selectedId);
    }

    if (search) {
      const matches = topology.nodes.filter((node) => `${node.title} ${node.subtitle ?? ""} ${node.kindLabel}`.toLowerCase().includes(search));

      return new Set(matches.flatMap((node) => [...pathThrough(topology, node.id)]));
    }

    return undefined;
  }, [topology, selectedId, search]);

  const gatewayApiMissing = loaded.notServed.includes("gateways.gateway.networking.k8s.io");
  const count = (column: number) => topology.nodes.filter((node) => node.column === column).length;
  const issues = topology.nodes.filter((node) => node.health === "error" || node.health === "warn").length;

  return (
    <Div $flex={{ direction: "vertical" }} $height="full" $backgroundColor="backgroundSecondary">
      <Div $flex={{ direction: "horizontal", gap: "m", verticalAlign: "center" }} $padding={{ horizontal: "l", vertical: "m" }}>
        <Span $font={{ size: "l", bold: true }}>Gateway API</Span>
        <Span $color="textMuted">Cilium gateway topology</Span>
        <Div $flex={{ direction: "horizontal", gap: "xs" }}>
          <Badge small label={`${count(1)} gateways`} />
          <Badge small label={`${count(2)} listeners`} />
          <Badge small label={`${count(3)} routes`} />
          <Badge small label={`${count(4)} backends`} />
          {issues > 0 && <Badge small label={`${issues} need attention`} $backgroundColor="warning" $color="white" />}
        </Div>
        <Div $flexChild />
        <TextInput
          type="search"
          placeholder="Find a gateway, host, route or service"
          $width={{ width: "11xl" }}
          value={state.search()}
          onChange={(event) => state.setSearch(event.target.value)}
        />
        <Span $color="textMuted" $font={{ size: "s" }}>
          Updated {new Date(loaded.loadedAt).toLocaleTimeString()}
        </Span>
        <PlainButton Icon={RefreshIcon} $onClick={refresh} $tooltip="Read the resources again now">
          Refresh
        </PlainButton>
      </Div>

      {loaded.notServed.length > 0 && !gatewayApiMissing && (
        <Div $padding={{ horizontal: "l", vertical: "xs" }} $color="textMuted" $font={{ size: "s" }}>
          Not served by this cluster, so not shown: {loaded.notServed.map((resource) => resource.split(".")[0]).join(", ")}
        </Div>
      )}

      {loaded.failures.map((failure) => (
        <Div key={failure.resource} $padding={{ horizontal: "l", vertical: "xs" }} $color="warning" $font={{ size: "s" }}>
          Could not list {failure.resource}: {failure.message}
        </Div>
      ))}

      <Div $flex={{ direction: "horizontal" }} $flexChild $overflow="hidden">
        <Div $flexChild $overflow="auto" $padding="xl">
          {gatewayApiMissing ? (
            <EmptyState title="This cluster does not serve the Gateway API" text="Install the Gateway API CRDs and enable Cilium's gateway controller (gatewayAPI.enabled=true)." />
          ) : topology.nodes.length === 0 ? (
            <EmptyState title="No gateways yet" text="Create a GatewayClass for io.cilium/gateway-controller and a Gateway, and they will show here." />
          ) : (
            <Canvas
              nodes={layout.nodes}
              edges={topology.edges}
              width={layout.width}
              height={layout.height}
              highlighted={highlighted}
              selectedId={selectedId}
              onSelect={state.select}
            />
          )}
        </Div>

        {selected && <NodeDetails clusterId={clusterId} node={selected} onClose={() => state.select(undefined)} />}
      </Div>
    </Div>
  );
});

const EmptyState = ({ title, text }: { title: string; text: string }) => (
  <Div $flex={{ direction: "vertical", gap: "s" }}>
    <Span $font={{ size: "l", bold: true }}>{title}</Span>
    <Span $color="textMuted">{text}</Span>
  </Div>
);

interface CanvasProps {
  readonly nodes: readonly PositionedNode[];
  readonly edges: ReturnType<typeof buildTopology>["edges"];
  readonly width: number;
  readonly height: number;
  readonly highlighted?: ReadonlySet<string>;
  readonly selectedId?: string;
  readonly onSelect: (id: string | undefined) => void;
}

const Canvas = ({ nodes, edges, width, height, highlighted, selectedId, onSelect }: CanvasProps) => {
  const byId = new Map(nodes.map((node) => [node.id, node]));

  const edgePath = (fromId: string, toId: string) => {
    const from = byId.get(fromId);
    const to = byId.get(toId);

    if (!from || !to) {
      return undefined;
    }

    const x1 = from.x + nodeWidth;
    const y1 = from.y + nodeHeight / 2;
    const x2 = to.x;
    const y2 = to.y + nodeHeight / 2;
    const bend = Math.max(columnGap / 2, (x2 - x1) / 2);

    return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
  };

  return (
    <div className={styles.canvas} style={{ width, height }}>
      {columns.map((title, column) => (
        <Span key={title} className={styles.columnHeader} style={{ left: column * (nodeWidth + columnGap) }} $color="textMuted" $font={{ size: "s", bold: true }}>
          {title}
        </Span>
      ))}

      {(Object.keys(healthColor) as Health[]).map((health) => (
        <Svg key={health} className={styles.edges} width={width} height={height} $color={healthColor[health] === "success" ? "grey30" : healthColor[health]}>
          {edges
            .filter((edge) => edge.health === health)
            .map((edge) => {
              const path = edgePath(edge.from, edge.to);
              const lit = highlighted?.has(edge.from) && highlighted.has(edge.to);

              return path ? (
                <path
                  key={edge.id}
                  d={path}
                  className={[health === "warn" ? styles.pending : "", highlighted ? (lit ? styles.highlighted : styles.dimmed) : ""].join(" ")}
                >
                  {edge.label && <title>{edge.label}</title>}
                </path>
              ) : null;
            })}
        </Svg>
      ))}

      {nodes.map((node) => (
        <NodeCard
          key={node.id}
          node={node}
          selected={node.id === selectedId}
          dimmed={highlighted ? !highlighted.has(node.id) : false}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
};

const NodeCard = ({ node, selected, dimmed, onSelect }: { node: PositionedNode; selected: boolean; dimmed: boolean; onSelect: (id: string) => void }) => (
  <ClickableDiv
    className={[styles.node, selected ? styles.selected : "", dimmed ? styles.dimmed : ""].join(" ")}
    style={{ left: node.x, top: node.y, width: nodeWidth, height: nodeHeight }}
    $flex={{ direction: "horizontal" }}
    $backgroundColor={{ normal: "backgroundPrimary", hover: "grey70" }}
    $border={{ color: selected ? "primary" : "borderPrimary", width: "xxs", radius: "m" }}
    $onClick={() => onSelect(node.id)}
    $tooltip={node.healthReason ? `${healthLabel[node.health]}: ${node.healthReason}` : undefined}
  >
    <Div className={styles.stripe} $backgroundColor={healthColor[node.health]} />
    <Div $flex={{ direction: "vertical", gap: "xxs" }} $padding={{ horizontal: "s", vertical: "xs" }} $flexChild className={styles.truncate}>
      <Span $color="textMuted" $font={{ size: "xs" }} className={styles.truncate}>
        {node.kindLabel}
      </Span>
      <Span $font={{ bold: true }} className={styles.truncate}>
        {node.title}
      </Span>
      {node.subtitle && (
        <Span $color="textMuted" $font={{ size: "s" }} className={styles.truncate}>
          {node.subtitle}
        </Span>
      )}
    </Div>
  </ClickableDiv>
);

const NodeDetails = ({ clusterId, node, onClose }: { clusterId: string; node: MapNode; onClose: () => void }) => {
  const openResource = useInject(openGatewayResourceInjectable)();

  return (
    <Div
      className={styles.details}
      $flex={{ direction: "vertical", gap: "l" }}
      $padding="l"
      $overflow="auto"
      $backgroundColor="backgroundPrimary"
      $border={{ left: { color: "grey60", width: "xxs" } }}
    >
      <Div $flex={{ direction: "vertical", gap: "xs" }}>
        <Span $color="textMuted" $font={{ size: "s" }}>
          {node.kindLabel}
        </Span>
        <Span $font={{ size: "l", bold: true }} className={styles.wrap}>
          {node.title}
        </Span>
        <Div $flex={{ direction: "horizontal", gap: "xs", verticalAlign: "center" }}>
          <Badge small label={healthLabel[node.health]} $backgroundColor={healthColor[node.health]} $color="white" />
          {node.healthReason && (
            <Span $color="textMuted" $font={{ size: "s" }}>
              {node.healthReason}
            </Span>
          )}
        </Div>
      </Div>

      <Div $flex={{ direction: "horizontal", gap: "s" }}>
        {node.ref && (
          <PrimaryButton $onClick={() => void openResource(clusterId, node.ref!)}>
            Open {node.ref.kind}
          </PrimaryButton>
        )}
        <PlainButton $onClick={onClose}>Close</PlainButton>
      </Div>

      {node.facts.length > 0 && (
        <Table>
          <TBody>
            {node.facts.map(([label, value], index) => (
              <Tr key={`${label}-${index}`}>
                <Td className={styles.factLabel} $color="textMuted">
                  {label}
                </Td>
                <Td className={styles.wrap}>{value}</Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}

      {node.rules && node.rules.length > 0 && (
        <Section title="Rules">
          {node.rules.map((rule, index) => (
            <Span key={index} $font={{ size: "s" }} className={styles.wrap}>
              {rule}
            </Span>
          ))}
        </Section>
      )}

      {node.related.length > 0 && (
        <Section title="Provisioned by Cilium">
          {node.related.map((related) => (
            <Div key={`${related.ref.kind}/${related.ref.name}`} $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center" }}>
              <Div $flex={{ direction: "vertical" }} $flexChild className={styles.truncate}>
                <Span $color="textMuted" $font={{ size: "xs" }}>
                  {related.label}
                </Span>
                <Span className={styles.wrap}>{related.ref.name}</Span>
                {related.note && (
                  <Span $color="textMuted" $font={{ size: "s" }} className={styles.wrap}>
                    {related.note}
                  </Span>
                )}
              </Div>
              <PlainButton $onClick={() => void openResource(clusterId, related.ref)}>Open</PlainButton>
            </Div>
          ))}
        </Section>
      )}

      {node.conditions.length > 0 && (
        <Section title="Conditions">
          {node.conditions.map((condition, index) => (
            <Div key={`${condition.type}-${index}`} $flex={{ direction: "vertical" }}>
              <Span $color={condition.status === "True" ? "success" : "critical"} $font={{ size: "s", bold: true }}>
                {condition.type}: {condition.status}
              </Span>
              {(condition.reason || condition.message) && (
                <Span $color="textMuted" $font={{ size: "s" }} className={styles.wrap}>
                  {[condition.reason, condition.message].filter(Boolean).join(" — ")}
                </Span>
              )}
            </Div>
          ))}
        </Section>
      )}
    </Div>
  );
};

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <Div $flex={{ direction: "vertical", gap: "s" }}>
    <Span $color="textMuted" $font={{ size: "s", bold: true }}>
      {title}
    </Span>
    {children}
  </Div>
);
