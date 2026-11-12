import { Div, Span } from "@k8slens/element-components";
import { CloseIcon } from "@k8slens/icon";
import { PlainButton } from "@k8slens/input-components";
import { getInjectable2 } from "@k8slens/injectable";
import { Background, Controls, type Edge, Handle, MarkerType, type Node, type NodeProps, Position, ReactFlow } from "../vendor/xyflow-react";
import { observer } from "mobx-react";
import { useMemo, useState } from "react";
import { ciliumPageInjectionToken, type PageProps } from "../navigation/pages";
import { useViewState } from "../navigation/view-state.injectable";
import { settingsStoreInjectable } from "../settings/settings.injectable";
import { useInject } from "@k8slens/use-inject";
import { Callout, EmptyState, uiStyles, UpdatedAt } from "../ui/components";
import { DataTable } from "../ui/data-table";
import { PageLayout } from "../ui/page-layout";
import { buildFlowFilter, emptyFilterForm, flowKey, type FlowFilterForm, protocolPort, sortableTime } from "./flow-logic";
import { flowsOfEndpoint } from "./flow-stats";
import { aggregateFlows, endpointName, type Flow } from "./hubble";
import { FlowDrawer, FlowFilterBar, FlowScope, FlowsView, formatFlowTime, HubblePage, observabilityStyles as styles, useFlowLimit, useFlows, VerdictBadge } from "./hubble-view";
import { buildServiceMap, type MapNode } from "./service-map";

interface EndpointData extends Record<string, unknown> {
  readonly node: MapNode;
  readonly selected: boolean;
}

interface GroupData extends Record<string, unknown> {
  readonly name: string;
  readonly count: number;
}

const kindLabel: Record<MapNode["kind"], string> = { workload: "workload", pod: "pod", reserved: "identity", external: "external" };

const EndpointNode = ({ data }: NodeProps<Node<EndpointData>>) => (
  <div className={`${styles.mapNode} ${data.selected ? styles.mapNodeSelected : ""}`} title={data.node.id}>
    <Handle type="target" position={Position.Left} />
    <div className={uiStyles.truncate} style={{ fontWeight: 700 }}>
      {data.node.label}
    </div>
    <div style={{ color: "var(--grey40)" }}>
      {kindLabel[data.node.kind]} · <span style={{ color: "var(--success)" }}>{data.node.forwarded}</span>
      {data.node.dropped > 0 && <span style={{ color: "var(--critical)" }}> / {data.node.dropped} dropped</span>}
    </div>
    <Handle type="source" position={Position.Right} />
  </div>
);

const GroupNode = ({ data }: NodeProps<Node<GroupData>>) => (
  <div className={styles.mapGroup}>
    {data.name} ({data.count})
  </div>
);

const nodeTypes = { endpoint: EndpointNode, namespaceLabel: GroupNode };

const colorVar = { success: "var(--success)", warning: "var(--warning)", critical: "var(--critical)", grey: "var(--grey40)" } as const;

const TrafficGraph = ({ flows, selected, onSelect, maxNodes }: { flows: readonly Flow[]; selected?: string; onSelect: (id: string | undefined) => void; maxNodes: number }) => {
  const map = useMemo(() => buildServiceMap(aggregateFlows(flows), maxNodes), [flows, maxNodes]);
  const nodes = useMemo<Node[]>(
    () => [
      ...map.groups.map((group) => ({ id: `group:${group.name}`, type: "namespaceLabel", position: { x: group.x, y: 0 }, data: { name: group.name, count: group.count }, draggable: false, selectable: false, connectable: false })),
      ...map.nodes.map((node) => ({ id: node.id, type: "endpoint", position: { x: node.x, y: node.y }, data: { node, selected: node.id === selected }, connectable: false })),
    ],
    [map, selected],
  );
  const edges = useMemo<Edge[]>(
    () =>
      map.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: edge.label,
        animated: edge.color === "critical",
        style: { stroke: colorVar[edge.color], strokeWidth: 1 + Math.min(3, Math.log10(1 + edge.edge.forwarded + edge.edge.dropped)), opacity: selected && edge.source !== selected && edge.target !== selected ? 0.25 : 1 },
        markerEnd: { type: MarkerType.ArrowClosed, color: colorVar[edge.color] },
        labelStyle: { fill: "var(--grey20)", fontSize: 10 },
        labelBgStyle: { fill: "var(--grey80)" },
      })),
    [map, selected],
  );

  if (map.nodes.length === 0) return <EmptyState title="No traffic" text="Hubble returned no flow to draw for these filters." />;

  return (
    <Div $flex={{ direction: "vertical", gap: "s" }} $style={{ height: "100%" }}>
      {map.truncated > 0 && <Callout level="info">The {map.truncated} least busy endpoints are left out (Topology max nodes in the extension settings).</Callout>}
      <div className={styles.graph} style={{ flex: 1 }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          minZoom={0.1}
          nodesConnectable={false}
          onNodeClick={(_event, node) => node.type === "endpoint" && onSelect(node.id === selected ? undefined : node.id)}
          onPaneClick={() => onSelect(undefined)}
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <Div $flex={{ direction: "horizontal", gap: "m", wrap: true }} $font={{ size: "s" }} $color="textMuted">
        <Span>
          <span className={styles.swatch} style={{ background: "var(--success)" }} /> forwarded
        </Span>
        <Span>
          <span className={styles.swatch} style={{ background: "var(--warning)" }} /> some dropped
        </Span>
        <Span>
          <span className={styles.swatch} style={{ background: "var(--critical)" }} /> all dropped
        </Span>
        <Span>Edge labels: ✓ forwarded, ✗ dropped, and the destination ports. Replies are not counted.</Span>
      </Div>
    </Div>
  );
};

const NodeFlows = ({ clusterId, name, flows, onClose }: { clusterId: string; name: string; flows: readonly Flow[]; onClose: () => void }) => {
  const [selected, setSelected] = useState<string>();
  const own = useMemo(() => flowsOfEndpoint(flows, name), [flows, name]);
  const selectedFlow = selected ? own.find((flow) => flowKey(flow) === selected) : undefined;

  if (selectedFlow) return <FlowDrawer clusterId={clusterId} flow={selectedFlow} onClose={() => setSelected(undefined)} />;

  return (
    <Div className={uiStyles.drawer} $flex={{ direction: "vertical" }} role="complementary" aria-label={`Flows of ${name}`}>
      <Div className={uiStyles.scroll} $flex={{ direction: "vertical", gap: "m" }} $padding="l">
        <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "top" }}>
          <Div $flex={{ direction: "vertical", gap: "xxs" }} $flexChild>
            <Span $color="textMuted" $font={{ size: "s" }}>
              Flows from and to
            </Span>
            <Span $font={{ size: "l", bold: true }} className={uiStyles.wrap}>
              {name}
            </Span>
          </Div>
          <PlainButton Icon={CloseIcon} $onClick={onClose} $tooltip="Close">
            <Span $visuallyHidden>Close</Span>
          </PlainButton>
        </Div>
        <DataTable<Flow>
          ariaLabel={`Flows of ${name}`}
          rows={own}
          rowKey={flowKey}
          onRowClick={(flow) => setSelected(flowKey(flow))}
          initialSort={{ column: "time", descending: true }}
          columns={[
            { id: "time", header: "Time", render: (flow) => formatFlowTime(flow.time), sortValue: (flow) => sortableTime(flow.time) },
            { id: "peer", header: "Peer", render: (flow) => (endpointName(flow.source) === name ? `→ ${endpointName(flow.destination)}` : `← ${endpointName(flow.source)}`) },
            { id: "port", header: "Port", render: protocolPort },
            { id: "verdict", header: "Verdict", render: (flow) => <VerdictBadge verdict={flow.verdict} />, sortValue: (flow) => flow.verdict },
          ]}
        />
      </Div>
    </Div>
  );
};

const TrafficContent = observer(({ clusterId, tabKey }: PageProps) => {
  const limit = useFlowLimit();
  const maxNodes = useInject(settingsStoreInjectable)().get().topologyMaxNodes;
  const [form, setForm] = useViewState<FlowFilterForm>(tabKey, "form", emptyFilterForm);
  const [applied, setApplied] = useViewState<FlowFilterForm>(tabKey, "applied", emptyFilterForm);
  const [selected, setSelected] = useViewState<string | undefined>(tabKey, "selected", undefined);
  const [errors, setErrors] = useState<readonly string[]>([]);
  const { filter } = useMemo(() => buildFlowFilter(applied, limit), [applied, limit]);
  const { state, refresh } = useFlows(clusterId, filter ?? { last: limit }, { keepRaw: true });
  const flows = state.value?.flows ?? [];

  return (
    <PageLayout
      clusterId={clusterId}
      title="Traffic Visualization"
      subtitle="A service map of the flows Hubble observed, between workloads, identities and the world"
      scroll={false}
      actions={<UpdatedAt state={state} onRefresh={() => void refresh()} />}
      toolbar={
        <FlowFilterBar
          form={form}
          onChange={setForm}
          onApply={() => {
            const built = buildFlowFilter(form, limit);

            setErrors(built.errors);
            if (built.filter) setApplied(form);
          }}
          onClear={() => {
            setForm(emptyFilterForm);
            setApplied(emptyFilterForm);
            setErrors([]);
          }}
          errors={errors}
          fields={["namespace", "labels", "verdict", "protocol", "port", "time"]}
        />
      }
      drawer={selected && state.value && <NodeFlows key={selected} clusterId={clusterId} name={selected} flows={flows} onClose={() => setSelected(undefined)} />}
    >
      <FlowsView state={state} onRetry={() => void refresh()}>
        {(result) => (
          <Div $flex={{ direction: "vertical", gap: "s" }} $padding={{ horizontal: "l", bottom: "l" }} $style={{ height: "100%", minHeight: 0, boxSizing: "border-box" }}>
            <FlowScope result={result} count={result.flows.length} limit={limit} />
            <Div $flexChild $style={{ minHeight: 0 }}>
              <TrafficGraph flows={result.flows} selected={selected} onSelect={setSelected} maxNodes={maxNodes} />
            </Div>
          </Div>
        )}
      </FlowsView>
    </PageLayout>
  );
});

const TrafficPage = observer((props: PageProps) => (
  <HubblePage clusterId={props.clusterId} title="Traffic Visualization">
    {() => <TrafficContent {...props} />}
  </HubblePage>
));

export const trafficPageInjectable = getInjectable2({
  id: "cilium-ui-page-traffic",
  injectionToken: ciliumPageInjectionToken,
  instantiate: () => () => ({
    id: "traffic",
    section: "observability" as const,
    title: "Traffic Visualization",
    orderNumber: 20,
    Component: TrafficPage,
    description: "Service map of observed flows, coloured by verdict",
  }),
});
