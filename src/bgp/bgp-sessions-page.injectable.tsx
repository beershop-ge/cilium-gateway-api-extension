import { Div, Span } from "@k8slens/element-components";
import { getInjectable2 } from "@k8slens/injectable";
import { observer } from "mobx-react";
import { ciliumDbg, parseJsonOutput } from "../kube/cilium-exec";
import { itemsOf, type SnapshotRequest } from "../kube/snapshot";
import { ciliumPageInjectionToken, type PageProps } from "../navigation/pages";
import { refOf } from "../resources/resource-actions.injectable";
import { Callout, EmptyState, QueryView, Section, StatusDot, UpdatedAt } from "../ui/components";
import { DataTable } from "../ui/data-table";
import { PageLayout } from "../ui/page-layout";
import { useCiliumInfo, useSnapshot } from "../ui/use-cluster";
import { formatDuration, parseAgentPeers, type PeerSession, sessionsFromNodeConfig, sumRoutes } from "./bgp-model";
import { LiveAgentSection, Mono, SnapshotProblems, StateBadge, useResourceNavigation } from "./shared";

const request: SnapshotRequest = { kinds: ["CiliumBGPNodeConfig", "CiliumBGPClusterConfig", "CiliumBGPPeeringPolicy"] };

const routeCell = (session: PeerSession) => {
  const received = sumRoutes(session.routes, "received");
  const advertised = sumRoutes(session.routes, "advertised");

  if (received === undefined && advertised === undefined) {
    return <Span $color="textMuted">—</Span>;
  }

  return (
    <Span title={session.routes.map((route) => `${route.afi}/${route.safi}: received ${route.received ?? "?"}${route.accepted !== undefined ? `, accepted ${route.accepted}` : ""}, advertised ${route.advertised ?? "?"}`).join("\n")}>
      {received ?? "?"} / {advertised ?? "?"}
    </Span>
  );
};

const stateCell = (session: PeerSession) => (
  <Div $flex={{ direction: "horizontal", gap: "xs", verticalAlign: "center" }}>
    <StatusDot health={session.established ? "ok" : session.state ? "error" : "unknown"} title={session.state ?? "unknown"} />
    <Span $color={session.established ? undefined : "critical"}>{session.state ?? "unknown"}</Span>
  </Div>
);

const timersCell = (session: PeerSession) =>
  session.holdTimeSeconds === undefined && session.keepAliveSeconds === undefined ? (
    <Span $color="textMuted">—</Span>
  ) : (
    `${session.holdTimeSeconds ?? "?"}s / ${session.keepAliveSeconds ?? "?"}s${session.connectRetrySeconds !== undefined ? ` / ${session.connectRetrySeconds}s` : ""}`
  );

const SessionTable = ({ sessions, showNode = true, onNode }: { sessions: readonly PeerSession[]; showNode?: boolean; onNode?: (node: string) => void }) => (
  <DataTable<PeerSession>
    ariaLabel="BGP sessions"
    rows={sessions}
    rowKey={(session) => `${session.node}/${session.instance ?? ""}/${session.peerName ?? ""}/${session.peerAddress ?? ""}`}
    initialSort={{ column: showNode ? "node" : "peer" }}
    empty={<Span $color="textMuted">No peers reported.</Span>}
    onRowClick={onNode ? (session) => onNode(session.node) : undefined}
    columns={[
      ...(showNode ? [{ id: "node", header: "Node", render: (session: PeerSession) => <Span $font={{ bold: true }}>{session.node}</Span>, sortValue: (session: PeerSession) => session.node }] : []),
      ...(sessions.some((session) => session.instance) ? [{ id: "instance", header: "Instance", render: (session: PeerSession) => session.instance ?? "—", sortValue: (session: PeerSession) => session.instance }] : []),
      { id: "peer", header: "Peer IP", render: (session) => <Mono>{session.peerAddress ?? "—"}</Mono>, sortValue: (session) => session.peerAddress },
      ...(sessions.some((session) => session.peerName) ? [{ id: "name", header: "Peer", render: (session: PeerSession) => session.peerName ?? "—", sortValue: (session: PeerSession) => session.peerName }] : []),
      { id: "local", header: "Local ASN", render: (session) => session.localASN ?? "—", sortValue: (session) => session.localASN },
      { id: "remote", header: "Remote ASN", render: (session) => session.peerASN ?? "—", sortValue: (session) => session.peerASN },
      { id: "state", header: "Session", render: stateCell, sortValue: (session) => (session.established ? 1 : 0) },
      { id: "uptime", header: "Uptime", render: (session) => formatDuration(session.uptimeSeconds), sortValue: (session) => session.uptimeSeconds ?? -1 },
      { id: "timers", header: "Hold / keepalive", render: timersCell },
      { id: "routes", header: "Routes received / advertised", render: routeCell, sortValue: (session) => sumRoutes(session.routes, "received") ?? -1 },
    ]}
  />
);

const runPeers = async (kubectl: Parameters<typeof ciliumDbg>[0], pod: Parameters<typeof ciliumDbg>[1]) => parseAgentPeers(parseJsonOutput(await ciliumDbg(kubectl, pod, ["bgp", "peers", "-o", "json"])), pod.node ?? pod.name);

const BgpSessionsPage = observer(({ clusterId }: PageProps) => {
  const { state, refresh } = useSnapshot(clusterId, request);
  const cilium = useCiliumInfo(clusterId);
  const nav = useResourceNavigation(clusterId);
  const config = cilium.state.value?.config;
  const bgpDisabled = config !== undefined && config["enable-bgp-control-plane"] !== "true";

  return (
    <PageLayout
      clusterId={clusterId}
      title="BGP Session Status"
      subtitle="Every BGP session per node and peer, as the agents report it"
      actions={<UpdatedAt state={state} onRefresh={() => void refresh()} />}
    >
      <QueryView state={state} onRetry={() => void refresh()} loadingText="Reading BGP node status…">
        {(snapshot) => {
          const nodeConfigs = itemsOf(snapshot, "CiliumBGPNodeConfig");
          const sessions = nodeConfigs.flatMap((nodeConfig) => sessionsFromNodeConfig(nodeConfig));
          const established = sessions.filter((session) => session.established).length;
          const noStatus = nodeConfigs.filter((nodeConfig) => !nodeConfig?.status?.bgpInstances);
          const v2Installed = !snapshot.notInstalled.includes("CiliumBGPNodeConfig");
          const legacyOnly = !v2Installed && !snapshot.notInstalled.includes("CiliumBGPPeeringPolicy");

          return (
            <Div $flex={{ direction: "vertical", gap: "l" }} $padding={{ horizontal: "l", bottom: "l" }}>
              {bgpDisabled && (
                <Callout level="warning" title="BGP control plane is not enabled">
                  cilium-config has enable-bgp-control-plane={config?.["enable-bgp-control-plane"] ?? "(not set)"}, so no agent runs BGP sessions.
                </Callout>
              )}
              <SnapshotProblems snapshot={snapshot} kinds={["CiliumBGPNodeConfig"]} />

              <Section
                title={
                  <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center" }}>
                    <span>Sessions from CiliumBGPNodeConfig status</span>
                    <StateBadge kind="runtime" detail="Written by each agent to its CiliumBGPNodeConfig status; may lag the live state by a few seconds" />
                  </Div>
                }
              >
                {legacyOnly ? (
                  <Callout level="info">This cluster has only the legacy v1 BGP control plane, which reports no session status in resources. Read sessions live from the agents below.</Callout>
                ) : !v2Installed ? null : nodeConfigs.length === 0 ? (
                  <EmptyState title="No CiliumBGPNodeConfig" text="The operator creates one per node selected by a CiliumBGPClusterConfig. None exists, so no node runs BGP." />
                ) : (
                  <>
                    <Div $flex={{ direction: "horizontal", gap: "m", verticalAlign: "center" }}>
                      <StatusDot health={sessions.length === 0 ? "unknown" : established === sessions.length ? "ok" : established === 0 ? "error" : "warn"} />
                      <Span $font={{ bold: true }}>
                        {established} of {sessions.length} sessions established
                      </Span>
                      <Span $color="textMuted">on {nodeConfigs.length} nodes</Span>
                    </Div>
                    {noStatus.length > 0 && (
                      <Callout level="info">
                        No status reported yet for {noStatus.map((nodeConfig) => nodeConfig.metadata.name).join(", ")}. Status needs Cilium 1.17 or later, and the agent writes it once its BGP instances run.
                      </Callout>
                    )}
                    <SessionTable
                      sessions={sessions}
                      onNode={(node) => {
                        const nodeConfig = nodeConfigs.find((candidate) => candidate.metadata.name === node);

                        if (nodeConfig) nav.openRef(refOf(nodeConfig));
                      }}
                    />
                  </>
                )}
              </Section>

              <LiveAgentSection
                clusterId={clusterId}
                title="Live sessions per node"
                description="The sessions each agent's BGP speaker holds right now."
                command="cilium-dbg bgp peers -o json"
                unavailable={bgpDisabled ? "BGP is disabled in cilium-config, so the agents have no BGP speaker to ask." : undefined}
                run={runPeers}
                render={(peers) => <SessionTable sessions={peers} showNode={false} />}
              />
            </Div>
          );
        }}
      </QueryView>
    </PageLayout>
  );
});

export const bgpSessionsPageInjectable = getInjectable2({
  id: "cilium-ui-page-bgp-sessions",
  injectionToken: ciliumPageInjectionToken,
  instantiate: () => () => ({
    id: "bgp-sessions",
    section: "bgp" as const,
    title: "BGP Session Status",
    orderNumber: 70,
    Component: BgpSessionsPage,
    description: "Session state, uptime, timers and route counts per node and peer",
  }),
});
