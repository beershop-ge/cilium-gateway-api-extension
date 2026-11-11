import { Div, Span } from "@k8slens/element-components";
import { getInjectable2 } from "@k8slens/injectable";
import { observer } from "mobx-react";
import { formatCount } from "../common/cidr";
import { itemsOf, type SnapshotRequest } from "../kube/snapshot";
import { ciliumPageInjectionToken, type PageProps } from "../navigation/pages";
import { refOf } from "../resources/resource-actions.injectable";
import { Mono, SnapshotProblems, StateBadge, useResourceNavigation } from "../bgp/shared";
import { Callout, EmptyState, Facts, QueryView, Section, UpdatedAt, UsageBar } from "../ui/components";
import { DataTable } from "../ui/data-table";
import { PageLayout } from "../ui/page-layout";
import { useCiliumInfo, useSnapshot } from "../ui/use-cluster";
import { ipamMode, ipamTotals, type NodeIpam, nodeIpam, type PodIpPoolUsage, podIpPoolUsage } from "./ipam-model";

const kinds = ["CiliumNode", "CiliumPodIPPool"];
const request: SnapshotRequest = { kinds };

const percent = (used: number, capacity: bigint) => (capacity > 0n ? `${((used / Number(capacity)) * 100).toFixed(0)}%` : "—");

const IpAllocationPage = observer(({ clusterId }: PageProps) => {
  const { state, refresh } = useSnapshot(clusterId, request);
  const cilium = useCiliumInfo(clusterId);
  const nav = useResourceNavigation(clusterId);
  const config = cilium.state.value?.config;
  const mode = ipamMode(config);

  return (
    <PageLayout
      clusterId={clusterId}
      title="IP Address Allocation"
      subtitle="Pod IP address management: what each node was given, and how much of it is in use"
      actions={<UpdatedAt state={state} onRefresh={() => void refresh()} />}
    >
      <QueryView state={state} onRetry={() => void refresh()} loadingText="Reading CiliumNodes…">
        {(snapshot) => {
          const ciliumNodes = itemsOf(snapshot, "CiliumNode");
          const nodes = ciliumNodes.map(nodeIpam);
          const totals = ipamTotals(nodes, config);
          const pools = podIpPoolUsage(itemsOf(snapshot, "CiliumPodIPPool"), nodes);
          const showPools = mode?.mode === "multi-pool" || pools.length > 0;

          return (
            <Div $flex={{ direction: "vertical", gap: "l" }} $padding={{ horizontal: "l", bottom: "l" }}>
              <SnapshotProblems snapshot={snapshot} kinds={["CiliumNode"]} />

              <Section title="IPAM mode">
                {mode ? (
                  <Facts
                    rows={[
                      ["Mode", <Span $font={{ bold: true }}>{mode.label}</Span>],
                      ["How it works", mode.description],
                      ["Source", <Span $color="textMuted">cilium-config: ipam={config?.ipam ?? "(not set, default cluster-pool)"}</Span>],
                      ...totals.clusterPool.map(
                        (pool) =>
                          [
                            "Cluster pool CIDR",
                            <span>
                              <Mono>{pool.cidr}</Mono> · {formatCount(pool.size)} addresses
                              {pool.maskSize !== undefined && ` · /${pool.maskSize} per node${pool.nodeCidrs !== undefined ? ` (room for ${formatCount(pool.nodeCidrs)} node CIDRs)` : ""}`}
                            </span>,
                          ] as const,
                      ),
                    ]}
                  />
                ) : (
                  <Callout level="info">
                    The IPAM mode is unknown: cilium-config is not readable{cilium.state.value?.configError ? ` (${cilium.state.value.configError})` : ""}.
                  </Callout>
                )}
                {mode?.mode === "delegated-plugin" && <Callout level="info">With a delegated IPAM plugin, Cilium does not record allocations in CiliumNodes, so usage below may be empty.</Callout>}
              </Section>

              {ciliumNodes.length === 0 ? (
                <EmptyState title="No CiliumNodes" text={snapshot.notInstalled.includes("CiliumNode") ? "CiliumNode is not installed." : "No node runs a Cilium agent yet."} />
              ) : (
                <>
                  <Section title={<Div $flex={{ direction: "horizontal", gap: "s" }}><span>Totals</span><StateBadge kind="runtime" detail="Capacity from CiliumNode spec.ipam (written by the operator), usage from status.ipam (written by each agent)" /></Div>}>
                    <Div $flex={{ direction: "vertical", gap: "xxs" }}>
                      <Span>
                        <Span $font={{ bold: true }}>{totals.used.toLocaleString()}</Span> of {formatCount(totals.capacity)} addresses allocated to {totals.nodes} nodes are in use ({percent(totals.used, totals.capacity)})
                      </Span>
                      <UsageBar used={totals.used} total={Number(totals.capacity)} />
                      {totals.nodesWithErrors > 0 && <Span $color="critical">{totals.nodesWithErrors} nodes report an operator error.</Span>}
                    </Div>
                  </Section>

                  <Section title="Per node">
                    <DataTable<NodeIpam>
                      ariaLabel="IPAM per node"
                      rows={nodes}
                      rowKey={(node) => node.node}
                      initialSort={{ column: "node" }}
                      onRowClick={(node) => {
                        const resource = ciliumNodes.find((candidate) => candidate.metadata.name === node.node);

                        if (resource) nav.openRef(refOf(resource));
                      }}
                      columns={[
                        { id: "node", header: "Node", render: (node) => <Span $font={{ bold: true }}>{node.node}</Span>, sortValue: (node) => node.node },
                        {
                          id: "given",
                          header: "Allocated to node (spec)",
                          render: (node) =>
                            node.capacitySource === "pools" ? (
                              <Div $flex={{ direction: "vertical" }}>
                                {node.pools.map((pool) => (
                                  <span key={pool.pool}>
                                    {pool.pool}: <Mono>{pool.cidrs.join(", ")}</Mono> ({pool.used}/{formatCount(pool.capacity)})
                                  </span>
                                ))}
                              </Div>
                            ) : node.capacitySource === "podCIDRs" ? (
                              <Mono>{node.podCIDRs.join(", ")}</Mono>
                            ) : node.capacitySource === "pool" ? (
                              `${formatCount(node.capacity)} IPs in spec.ipam.pool`
                            ) : (
                              <Span $color="textMuted">nothing allocated</Span>
                            ),
                        },
                        { id: "capacity", header: "Addresses", render: (node) => formatCount(node.capacity), sortValue: (node) => Number(node.capacity) },
                        { id: "used", header: "In use (status)", render: (node) => node.used, sortValue: (node) => node.used },
                        {
                          id: "usage",
                          header: "Usage",
                          render: (node) => (
                            <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center" }}>
                              <Div $width={{ width: "11xl" }}>
                                <UsageBar used={node.used} total={Number(node.capacity)} />
                              </Div>
                              <span>{percent(node.used, node.capacity)}</span>
                            </Div>
                          ),
                          sortValue: (node) => (node.capacity > 0n ? node.used / Number(node.capacity) : 0),
                        },
                        {
                          id: "operator",
                          header: "Operator status",
                          render: (node) =>
                            node.operatorError ? (
                              <Span $color="critical">{node.operatorError}</Span>
                            ) : (
                              <Span $color="textMuted">{[node.releasing > 0 ? `${node.releasing} IPs being released` : "", node.preAllocate !== undefined ? `pre-allocate ${node.preAllocate}` : ""].filter(Boolean).join(" · ") || "ok"}</Span>
                            ),
                        },
                      ]}
                    />
                  </Section>
                </>
              )}

              {showPools && (
                <Section title="CiliumPodIPPools (multi-pool)">
                  {mode && mode.mode !== "multi-pool" && <Callout level="info">IPAM mode is {mode.mode}: these pools are only used in multi-pool mode.</Callout>}
                  {pools.length === 0 ? (
                    <Span $color="textMuted">{snapshot.notInstalled.includes("CiliumPodIPPool") ? "CiliumPodIPPool is not installed." : "No CiliumPodIPPool exists."}</Span>
                  ) : (
                    <DataTable<PodIpPoolUsage>
                      ariaLabel="Pod IP pools"
                      rows={pools}
                      rowKey={(pool) => pool.name}
                      initialSort={{ column: "name" }}
                      onRowClick={(pool) => nav.openRef({ kind: "CiliumPodIPPool", name: pool.name, group: "cilium.io" })}
                      columns={[
                        { id: "name", header: "Pool", render: (pool) => <Span $font={{ bold: true }}>{pool.name}</Span>, sortValue: (pool) => pool.name },
                        { id: "cidrs", header: "CIDRs (spec)", render: (pool) => <Mono>{pool.cidrs.join(", ") || "—"}</Mono> },
                        { id: "mask", header: "Per-node mask", render: (pool) => [pool.maskSizes.ipv4 !== undefined ? `/${pool.maskSizes.ipv4}` : "", pool.maskSizes.ipv6 !== undefined ? `/${pool.maskSizes.ipv6}` : ""].filter(Boolean).join(", ") || "—" },
                        { id: "size", header: "Addresses", render: (pool) => formatCount(pool.size) },
                        {
                          id: "allocated",
                          header: "Handed to nodes",
                          render: (pool) => (
                            <Div $flex={{ direction: "vertical", gap: "xxs" }}>
                              <span>
                                {formatCount(pool.allocatedToNodes)} on {pool.nodeCount} nodes
                              </span>
                              <UsageBar used={Number(pool.allocatedToNodes)} total={Number(pool.size)} />
                            </Div>
                          ),
                        },
                        { id: "used", header: "In use by pods", render: (pool) => `${pool.used} (${percent(pool.used, pool.allocatedToNodes)} of handed out)`, sortValue: (pool) => pool.used },
                      ]}
                    />
                  )}
                </Section>
              )}
            </Div>
          );
        }}
      </QueryView>
    </PageLayout>
  );
});

export const ipAllocationPageInjectable = getInjectable2({
  id: "cilium-ui-page-lb-ip-allocation",
  injectionToken: ciliumPageInjectionToken,
  instantiate: () => () => ({
    id: "ip-allocation",
    section: "lb" as const,
    title: "IP Address Allocation",
    orderNumber: 60,
    Component: IpAllocationPage,
    description: "Cilium pod IPAM per node and per pod IP pool",
  }),
});
