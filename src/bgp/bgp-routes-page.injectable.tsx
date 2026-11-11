import { Badge } from "@k8slens/badge";
import { Div, Span } from "@k8slens/element-components";
import { getInjectable2 } from "@k8slens/injectable";
import { observer } from "mobx-react";
import { describeSelector } from "../common/selectors";
import type { AgentPod } from "../kube/cilium-info";
import { ciliumDbg, parseJsonOutput } from "../kube/cilium-exec";
import type { KubectlClient } from "../kube/kubectl";
import { itemsOf, type SnapshotRequest } from "../kube/snapshot";
import { ciliumPageInjectionToken, type PageProps } from "../navigation/pages";
import { Callout, EmptyState, QueryView, Section, UpdatedAt, uiStyles } from "../ui/components";
import { DataTable } from "../ui/data-table";
import { PageLayout } from "../ui/page-layout";
import { useCiliumInfo, useSnapshot } from "../ui/use-cluster";
import {
  type AgentRoute,
  enabledFamilies,
  formatDuration,
  parseAdvertisement,
  parseAgentRoutes,
  parseClusterConfig,
  parsePeerConfig,
  type ResolvedEntry,
  type ResolvedPrefix,
  resolveAdvertisements,
} from "./bgp-model";
import { Clickable, LiveAgentSection, Mono, SnapshotProblems, StateBadge, useResourceNavigation } from "./shared";

const kinds = ["CiliumBGPClusterConfig", "CiliumBGPPeerConfig", "CiliumBGPAdvertisement", "CiliumNode", "CiliumPodIPPool"];
const request: SnapshotRequest = { kinds, builtins: ["services", "nodes"] };

const EntryCard = ({ clusterId, resolved }: { clusterId: string; resolved: ResolvedEntry }) => {
  const nav = useResourceNavigation(clusterId);
  const { entry } = resolved;
  const communities = entry.communities ? [...entry.communities.standard, ...entry.communities.wellKnown, ...entry.communities.large] : [];

  return (
    <Div className={uiStyles.card} $flex={{ direction: "vertical", gap: "s" }} $padding="m">
      <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center", wrap: true }}>
        <Clickable onClick={() => nav.openRef({ kind: "CiliumBGPAdvertisement", name: resolved.advertisement, group: "cilium.io" })}>
          <Span $font={{ bold: true }}>{resolved.advertisement}</Span>
        </Clickable>
        <Span $color="textMuted">entry {resolved.index + 1}</Span>
        <Badge small label={entry.advertisementType} />
        {entry.advertisementType === "Service" && <Span $font={{ size: "s" }}>{entry.addresses.join(", ") || "no address types"}</Span>}
        {entry.selector && <Span $color="textMuted" $font={{ size: "s" }}>selector {describeSelector(entry.selector)}</Span>}
        {communities.length > 0 && <Badge small label={`communities ${communities.join(" ")}`} />}
        {entry.localPreference !== undefined && <Badge small label={`local-pref ${entry.localPreference}`} />}
      </Div>
      <Span $font={{ size: "s" }}>
        <Span $color="textMuted">Sent to peers using: </Span>
        {resolved.usedBy.length > 0 ? resolved.usedBy.map((use) => `${use.peerConfig} (${use.family})`).join(", ") : <Span $color="warning">no peer config</Span>}
        <Span $color="textMuted"> · from nodes: </Span>
        {resolved.nodes.length > 0 ? resolved.nodes.join(", ") : <Span $color="warning">none</Span>}
      </Span>
      {resolved.notes.map((note, index) => (
        <Callout key={index} level="info">
          {note}
        </Callout>
      ))}
      {resolved.prefixes.length > 0 && (
        <DataTable<ResolvedPrefix>
          ariaLabel={`Prefixes of ${resolved.advertisement} entry ${resolved.index + 1}`}
          rows={resolved.prefixes}
          rowKey={(prefix) => `${prefix.prefix}/${prefix.origin}`}
          initialSort={{ column: "prefix" }}
          onRowClick={(prefix) =>
            nav.openRef(
              prefix.originKind === "Service"
                ? { kind: "Service", name: prefix.originName, namespace: prefix.originNamespace }
                : { kind: prefix.originKind, name: prefix.originName, group: "cilium.io" },
            )
          }
          columns={[
            { id: "prefix", header: "Prefix", render: (prefix) => <Mono>{prefix.prefix}</Mono>, sortValue: (prefix) => prefix.prefix },
            { id: "origin", header: "From", render: (prefix) => prefix.origin, sortValue: (prefix) => prefix.origin },
            { id: "note", header: "Note", render: (prefix) => prefix.note ?? "" },
          ]}
        />
      )}
    </Div>
  );
};

const runRoutes = (families: readonly string[]) => async (kubectl: KubectlClient, pod: AgentPod) => {
  const results = await Promise.all(
    families.map(async (afi) => parseAgentRoutes(parseJsonOutput(await ciliumDbg(kubectl, pod, ["bgp", "routes", "advertised", afi, "unicast", "-o", "json"]))).map((route) => ({ ...route, family: route.family ?? `${afi}/unicast` }))),
  );

  return results.flat();
};

const RouteTable = ({ routes }: { routes: readonly AgentRoute[] }) => (
  <DataTable<AgentRoute>
    ariaLabel="Advertised routes"
    rows={routes}
    rowKey={(route) => `${route.neighbor ?? ""}/${route.prefix}/${route.family ?? ""}/${route.best ?? ""}`}
    initialSort={{ column: "prefix" }}
    empty={<Span $color="textMuted">The agent advertises no routes.</Span>}
    columns={[
      { id: "prefix", header: "Prefix", render: (route) => <Mono>{route.prefix}</Mono>, sortValue: (route) => route.prefix },
      { id: "neighbor", header: "To peer", render: (route) => route.neighbor ?? "—", sortValue: (route) => route.neighbor },
      { id: "family", header: "Family", render: (route) => route.family ?? "—", sortValue: (route) => route.family },
      { id: "asn", header: "Router ASN", render: (route) => route.routerAsn ?? "—" },
      { id: "best", header: "Best", render: (route) => (route.best === undefined ? "—" : route.best ? "yes" : "no") },
      { id: "age", header: "Age", render: (route) => formatDuration(route.ageSeconds), sortValue: (route) => route.ageSeconds ?? -1 },
    ]}
  />
);

const BgpRoutesPage = observer(({ clusterId }: PageProps) => {
  const { state, refresh } = useSnapshot(clusterId, request);
  const cilium = useCiliumInfo(clusterId);
  const config = cilium.state.value?.config;
  const families = enabledFamilies(config);
  const bgpDisabled = config !== undefined && config["enable-bgp-control-plane"] !== "true";

  return (
    <PageLayout
      clusterId={clusterId}
      title="Route Advertisements"
      subtitle="What each advertisement selects (services, pod CIDRs, pod IP pools) and what the agents actually advertise"
      actions={<UpdatedAt state={state} onRefresh={() => void refresh()} />}
    >
      <QueryView state={state} onRetry={() => void refresh()} loadingText="Reading advertisements…">
        {(snapshot) => {
          const advertisements = itemsOf(snapshot, "CiliumBGPAdvertisement").map(parseAdvertisement);
          const resolved = resolveAdvertisements({
            clusterConfigs: itemsOf(snapshot, "CiliumBGPClusterConfig").map(parseClusterConfig),
            peerConfigs: itemsOf(snapshot, "CiliumBGPPeerConfig").map(parsePeerConfig),
            advertisements,
            services: itemsOf(snapshot, "services"),
            nodes: itemsOf(snapshot, "nodes"),
            ciliumNodes: itemsOf(snapshot, "CiliumNode"),
            podIPPools: itemsOf(snapshot, "CiliumPodIPPool"),
            ipamMode: config?.ipam,
          });

          return (
            <Div $flex={{ direction: "vertical", gap: "l" }} $padding={{ horizontal: "l", bottom: "l" }}>
              {bgpDisabled && (
                <Callout level="warning" title="BGP control plane is not enabled">
                  cilium-config has enable-bgp-control-plane={config?.["enable-bgp-control-plane"] ?? "(not set)"}: nothing below is advertised.
                </Callout>
              )}
              <SnapshotProblems snapshot={snapshot} kinds={kinds.filter((kind) => kind !== "CiliumPodIPPool")} />

              <Section
                title={
                  <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center" }}>
                    <span>Configured advertisements, resolved</span>
                    <StateBadge kind="config" detail="Computed from the advertisement, peer config and cluster config specs and the current services and nodes; the agent decides what it really sends" />
                  </Div>
                }
              >
                {advertisements.length === 0 ? (
                  <EmptyState title="No CiliumBGPAdvertisement" text={snapshot.notInstalled.includes("CiliumBGPAdvertisement") ? "The v2 BGP resources are not installed." : "Nothing is configured to be advertised."} />
                ) : (
                  <Div $flex={{ direction: "vertical", gap: "m" }}>
                    {resolved.map((entry) => (
                      <EntryCard key={`${entry.advertisement}/${entry.index}`} clusterId={clusterId} resolved={entry} />
                    ))}
                  </Div>
                )}
              </Section>

              <LiveAgentSection
                clusterId={clusterId}
                title="Routes advertised per node"
                description={`The routes each agent advertises to its peers, for ${families.map((family) => `${family} unicast`).join(" and ")}.`}
                command={families.map((family) => `cilium-dbg bgp routes advertised ${family} unicast -o json`).join("; ")}
                unavailable={bgpDisabled ? "BGP is disabled in cilium-config, so the agents advertise nothing." : undefined}
                run={runRoutes(families)}
                render={(routes) => <RouteTable routes={routes} />}
              />
            </Div>
          );
        }}
      </QueryView>
    </PageLayout>
  );
});

export const bgpRoutesPageInjectable = getInjectable2({
  id: "cilium-ui-page-bgp-routes",
  injectionToken: ciliumPageInjectionToken,
  instantiate: () => () => ({
    id: "bgp-routes",
    section: "bgp" as const,
    title: "Route Advertisements",
    orderNumber: 80,
    Component: BgpRoutesPage,
    description: "What each BGP advertisement selects, and the routes the agents advertise",
  }),
});
