import { Badge } from "@k8slens/badge";
import { Div, Span } from "@k8slens/element-components";
import { AddIcon, CloseIcon, EditIcon } from "@k8slens/icon";
import { PlainButton, TextInput } from "@k8slens/input-components";
import { getInjectable2 } from "@k8slens/injectable";
import { observer } from "mobx-react";
import { useMemo, useState } from "react";
import { healthOf } from "../common/conditions";
import { describeSelector } from "../common/selectors";
import { itemsOf, type Snapshot, type SnapshotRequest } from "../kube/snapshot";
import { ciliumPageInjectionToken, type PageProps } from "../navigation/pages";
import { ApplyPanel } from "../resources/apply-panel";
import { refOf } from "../resources/resource-actions.injectable";
import { Callout, ConditionsList, EmptyState, FieldLabel, HealthBadge, QueryView, Section, Select, UpdatedAt, uiStyles } from "../ui/components";
import { DataTable } from "../ui/data-table";
import { PageLayout } from "../ui/page-layout";
import { useCiliumInfo, useSnapshot } from "../ui/use-cluster";
import {
  type Advertisement,
  advertisementsOfFamily,
  bgpSecretsNamespace,
  type ClusterConfig,
  type LegacyPolicy,
  newPeerErrors,
  type NewPeer,
  parseAdvertisement,
  parseClusterConfig,
  parseLegacyPolicy,
  parsePeerConfig,
  type PeerConfig,
  secretInfoOf,
  validateBgp,
  withAddedPeer,
} from "./bgp-model";
import { Clickable, IssueList, Mono, SnapshotProblems, StateBadge, useResourceNavigation } from "./shared";

const kinds = ["CiliumBGPClusterConfig", "CiliumBGPPeerConfig", "CiliumBGPAdvertisement", "CiliumBGPPeeringPolicy"];
const request: SnapshotRequest = { kinds, builtins: ["secrets"] };

const seconds = (value: number | undefined, fallback: string) => (value === undefined ? <Span $color="textMuted">{fallback}</Span> : `${value}s`);

interface Model {
  readonly clusterConfigs: ClusterConfig[];
  readonly peerConfigs: PeerConfig[];
  readonly advertisements: Advertisement[];
  readonly legacy: LegacyPolicy[];
  readonly secretsReadable: boolean;
}

const modelOf = (snapshot: Snapshot): Model => ({
  clusterConfigs: itemsOf(snapshot, "CiliumBGPClusterConfig").map(parseClusterConfig),
  peerConfigs: itemsOf(snapshot, "CiliumBGPPeerConfig").map(parsePeerConfig),
  advertisements: itemsOf(snapshot, "CiliumBGPAdvertisement").map(parseAdvertisement),
  legacy: itemsOf(snapshot, "CiliumBGPPeeringPolicy").map(parseLegacyPolicy),
  secretsReadable: !snapshot.errors.some((error) => error.what === "secrets"),
});

const AdvertisementSummary = ({ advertisement, onOpen }: { advertisement: Advertisement; onOpen: () => void }) => (
  <Div $flex={{ direction: "horizontal", gap: "xxs", wrap: true, verticalAlign: "center" }}>
    <Clickable onClick={onOpen}>{advertisement.name}</Clickable>
    {advertisement.entries.map((entry, index) => (
      <Badge key={index} small label={entry.advertisementType === "Service" ? `Service: ${entry.addresses.join(", ") || "no addresses"}` : entry.advertisementType} />
    ))}
  </Div>
);

/** One peer config, resolved: timers, transport, authentication (secret name only) and what each family advertises. */
const PeerConfigFacts = ({ config, model, secretsNamespace, clusterId }: { config: PeerConfig; model: Model; secretsNamespace: string; clusterId: string }) => {
  const nav = useResourceNavigation(clusterId);

  return (
    <Div $flex={{ direction: "vertical", gap: "xxs" }} $font={{ size: "s" }}>
      <Span>
        Hold {seconds(config.holdTimeSeconds, "90s (default)")} · Keepalive {seconds(config.keepAliveTimeSeconds, "30s (default)")} · Connect retry {seconds(config.connectRetryTimeSeconds, "120s (default)")}
      </Span>
      <Span>
        eBGP multihop {config.ebgpMultihop ?? <Span $color="textMuted">1 (default)</Span>} · Graceful restart{" "}
        {config.gracefulRestart?.enabled ? `on${config.gracefulRestart.restartTimeSeconds !== undefined ? ` (${config.gracefulRestart.restartTimeSeconds}s)` : ""}` : "off"}
        {config.peerPort !== undefined && ` · Peer port ${config.peerPort}`}
      </Span>
      <Span>
        Authentication:{" "}
        {config.authSecretRef ? (
          <>
            <Clickable onClick={() => nav.openRef({ kind: "Secret", name: config.authSecretRef!, namespace: secretsNamespace })} title="Opens the secret in Lens; its value is never shown here">
              {secretsNamespace}/{config.authSecretRef}
            </Clickable>{" "}
            <Span $color="textMuted">(TCP-MD5 password; value not shown)</Span>
          </>
        ) : (
          <Span $color="textMuted">none</Span>
        )}
      </Span>
      {config.families.map((family) => {
        const selected = advertisementsOfFamily(family, model.advertisements);

        return (
          <Div key={`${family.afi}/${family.safi}`} $flex={{ direction: "horizontal", gap: "xs", wrap: true, verticalAlign: "center" }}>
            <Badge small label={`${family.afi}/${family.safi}`} />
            <Span $color="textMuted">{family.advertisements ? `selects ${describeSelector(family.advertisements)} →` : "no advertisement selector"}</Span>
            {family.advertisements && selected.length === 0 && <Span $color="warning">no advertisement matches</Span>}
            {selected.map((advertisement) => (
              <AdvertisementSummary key={advertisement.name} advertisement={advertisement} onOpen={() => nav.openRef(refOf(advertisement.resource))} />
            ))}
          </Div>
        );
      })}
    </Div>
  );
};

const AddPeerForm = observer(({ clusterId, config, model, onDone }: { clusterId: string; config: ClusterConfig; model: Model; onDone: () => void }) => {
  const [peer, setPeer] = useState<NewPeer>({ instance: config.instances[0]?.name ?? "", name: "", peerAddress: "", peerConfigRef: model.peerConfigs[0]?.name });
  const [asnText, setAsnText] = useState("");
  const asn = asnText.trim() === "" ? undefined : Number(asnText);
  const candidate: NewPeer = { ...peer, peerASN: asn };
  const errors = newPeerErrors(config, candidate);
  const valid = Object.keys(errors).length === 0;
  const document = useMemo(() => {
    if (!valid) return undefined;

    try {
      return withAddedPeer(config.resource, candidate);
    } catch {
      return undefined;
    }
  }, [valid, JSON.stringify(candidate), config.resource]);

  const set = (patch: Partial<NewPeer>) => setPeer({ ...peer, ...patch });

  return (
    <Div $flex={{ direction: "vertical", gap: "m" }} $padding="m" $border={{ color: "borderPrimary", width: "xxs", radius: "m" }}>
      <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center" }}>
        <Span $font={{ bold: true }} $flexChild>
          Add a peer to {config.name}
        </Span>
        <PlainButton Icon={CloseIcon} $onClick={onDone}>
          Cancel
        </PlainButton>
      </Div>
      <Div $flex={{ direction: "horizontal", gap: "m", wrap: true }}>
        <Div $width={{ width: "11xl" }}>
          <FieldLabel label="BGP instance" required error={errors.instance}>
            <Select ariaLabel="BGP instance" value={peer.instance} options={config.instances.map((instance) => ({ value: instance.name, label: `${instance.name} (ASN ${instance.localASN ?? "?"})` }))} onChange={(instance) => set({ instance })} />
          </FieldLabel>
        </Div>
        <Div $width={{ width: "11xl" }}>
          <FieldLabel label="Peer name" required error={peer.name ? errors.name : undefined}>
            <TextInput aria-label="Peer name" placeholder="tor-1" value={peer.name} onChange={(event) => set({ name: event.target.value.trim() })} />
          </FieldLabel>
        </Div>
        <Div $width={{ width: "11xl" }}>
          <FieldLabel label="Peer address" required error={peer.peerAddress ? errors.peerAddress : undefined} help="IPv4 or IPv6, no prefix length">
            <TextInput aria-label="Peer address" placeholder="10.0.0.1" value={peer.peerAddress} onChange={(event) => set({ peerAddress: event.target.value.trim() })} />
          </FieldLabel>
        </Div>
        <Div $width={{ width: "11xl" }}>
          <FieldLabel label="Peer ASN" error={errors.peerASN} help="Empty or 0: accept the ASN the peer announces">
            <TextInput aria-label="Peer ASN" placeholder="65000" value={asnText} onChange={(event) => setAsnText(event.target.value.trim())} />
          </FieldLabel>
        </Div>
        <Div $width={{ width: "11xl" }}>
          <FieldLabel label="Peer config" help={model.peerConfigs.length === 0 ? "No CiliumBGPPeerConfig exists yet: create one first for timers and advertisements" : "Timers, authentication and advertised families"}>
            <Select
              ariaLabel="Peer config"
              value={peer.peerConfigRef ?? ""}
              options={[{ value: "", label: "None (defaults, advertises nothing)" }, ...model.peerConfigs.map((peerConfig) => ({ value: peerConfig.name, label: peerConfig.name }))]}
              onChange={(value) => set({ peerConfigRef: value || undefined })}
            />
          </FieldLabel>
        </Div>
      </Div>
      {document ? (
        <ApplyPanel
          clusterId={clusterId}
          documents={[document]}
          originals={[config.resource]}
          modes={["replace", "server-side-apply"]}
          description={`Add BGP peer ${candidate.name} (${candidate.peerAddress}) to CiliumBGPClusterConfig ${config.name}`}
          onApplied={onDone}
        />
      ) : (
        <Span $color="textMuted" $font={{ size: "s" }}>
          Fill in the required fields to review the change.
        </Span>
      )}
    </Div>
  );
});

const ClusterConfigCard = observer(({ clusterId, config, model, secretsNamespace }: { clusterId: string; config: ClusterConfig; model: Model; secretsNamespace: string }) => {
  const nav = useResourceNavigation(clusterId);
  const [adding, setAdding] = useState(false);
  const health = healthOf(config.conditions);

  return (
    <Div className={uiStyles.card} $flex={{ direction: "vertical", gap: "s" }} $padding="m">
      <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center", wrap: true }}>
        <Span $font={{ size: "l", bold: true }}>{config.name}</Span>
        <Badge small label="CiliumBGPClusterConfig" />
        {config.conditions.length > 0 && <HealthBadge health={health.health} reason={health.reason} />}
        <Div $flexChild />
        <PlainButton Icon={AddIcon} $onClick={() => setAdding(true)} $enabled={!adding && config.instances.length > 0}>
          Add peer
        </PlainButton>
        <PlainButton Icon={EditIcon} $onClick={() => nav.openRef(refOf(config.resource))}>
          Edit
        </PlainButton>
      </Div>
      <Span $font={{ size: "s" }}>
        <Span $color="textMuted">Nodes: </Span>
        {describeSelector(config.nodeSelector) === "all" ? "every node" : describeSelector(config.nodeSelector)}
      </Span>
      {config.instances.map((instance) => (
        <Div key={instance.name} $flex={{ direction: "vertical", gap: "xs" }} $padding={{ left: "m" }}>
          <Span>
            <Span $font={{ bold: true }}>Instance {instance.name}</Span> <Span $color="textMuted">local ASN</Span> {instance.localASN ?? <Span $color="critical">not set</Span>}
            {instance.localPort !== undefined && <Span $color="textMuted"> · listens on port {instance.localPort}</Span>}
          </Span>
          <DataTable
            ariaLabel={`Peers of ${instance.name}`}
            rows={instance.peers}
            rowKey={(peer) => peer.name}
            empty={<Span $color="textMuted">No peers.</Span>}
            columns={[
              { id: "name", header: "Peer", render: (peer) => peer.name, sortValue: (peer) => peer.name },
              { id: "address", header: "Address", render: (peer) => (peer.peerAddress ? <Mono>{peer.peerAddress}</Mono> : peer.autoDiscovery ? `auto-discovery (${peer.autoDiscovery})` : "—") },
              { id: "asn", header: "Peer ASN", render: (peer) => (peer.peerASN ? peer.peerASN : <Span $color="textMuted">from peer</Span>) },
              {
                id: "config",
                header: "Peer config",
                render: (peer) => {
                  if (!peer.peerConfigRef) return <Span $color="textMuted">defaults</Span>;

                  const peerConfig = model.peerConfigs.find((candidate) => candidate.name === peer.peerConfigRef);

                  return peerConfig ? (
                    <Div $flex={{ direction: "vertical", gap: "xxs" }}>
                      <Clickable onClick={() => nav.openRef(refOf(peerConfig.resource))}>{peer.peerConfigRef}</Clickable>
                      <PeerConfigFacts config={peerConfig} model={model} secretsNamespace={secretsNamespace} clusterId={clusterId} />
                    </Div>
                  ) : (
                    <Span $color="critical">{peer.peerConfigRef} (missing)</Span>
                  );
                },
              },
            ]}
          />
        </Div>
      ))}
      {config.conditions.length > 0 && (
        <Section title={<Div $flex={{ direction: "horizontal", gap: "s" }}><span>Conditions</span><StateBadge kind="runtime" /></Div>}>
          <ConditionsList conditions={config.conditions} />
        </Section>
      )}
      {adding && <AddPeerForm clusterId={clusterId} config={config} model={model} onDone={() => setAdding(false)} />}
    </Div>
  );
});

const LegacyPolicyCard = ({ clusterId, policy, secretsNamespace }: { clusterId: string; policy: LegacyPolicy; secretsNamespace: string }) => {
  const nav = useResourceNavigation(clusterId);

  return (
    <Div className={uiStyles.card} $flex={{ direction: "vertical", gap: "s" }} $padding="m">
      <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center" }}>
        <Span $font={{ size: "l", bold: true }}>{policy.name}</Span>
        <Badge small label="Legacy v1" $backgroundColor="warning" $color="white" $tooltip="CiliumBGPPeeringPolicy is deprecated in favour of the v2 BGP resources" />
        <Div $flexChild />
        <PlainButton Icon={EditIcon} $onClick={() => nav.openRef(refOf(policy.resource))}>
          Edit
        </PlainButton>
      </Div>
      <Span $font={{ size: "s" }}>
        <Span $color="textMuted">Nodes: </Span>
        {describeSelector(policy.nodeSelector) === "all" ? "every node" : describeSelector(policy.nodeSelector)}
      </Span>
      {policy.virtualRouters.map((router, index) => (
        <Div key={index} $flex={{ direction: "vertical", gap: "xs" }} $padding={{ left: "m" }}>
          <Span $font={{ size: "s" }}>
            <Span $font={{ bold: true }}>Virtual router {index + 1}</Span> · local ASN {router.localASN ?? "not set"} · pod CIDR {router.exportPodCIDR ? "exported" : "not exported"}
            {router.serviceSelector && ` · services ${describeSelector(router.serviceSelector)} (${router.serviceAdvertisements.join(", ")})`}
            {router.podIPPoolSelector && ` · pod IP pools ${describeSelector(router.podIPPoolSelector)}`}
          </Span>
          <DataTable
            ariaLabel={`Neighbors of virtual router ${index + 1}`}
            rows={router.neighbors}
            rowKey={(neighbor) => neighbor.peerAddress ?? ""}
            columns={[
              { id: "address", header: "Peer address", render: (neighbor) => <Mono>{neighbor.peerAddress ?? "—"}</Mono> },
              { id: "asn", header: "Peer ASN", render: (neighbor) => neighbor.peerASN ?? "—" },
              { id: "timers", header: "Hold / keepalive / retry", render: (neighbor) => `${neighbor.holdTimeSeconds ?? 90}s / ${neighbor.keepAliveTimeSeconds ?? 30}s / ${neighbor.connectRetryTimeSeconds ?? 120}s` },
              { id: "multihop", header: "Multihop", render: (neighbor) => neighbor.eBGPMultihopTTL ?? 1 },
              { id: "gr", header: "Graceful restart", render: (neighbor) => (neighbor.gracefulRestart?.enabled ? "on" : "off") },
              { id: "auth", header: "Auth secret", render: (neighbor) => (neighbor.authSecretRef ? `${secretsNamespace}/${neighbor.authSecretRef}` : "—") },
              { id: "families", header: "Families", render: (neighbor) => neighbor.families.join(", ") || "ipv4/unicast, ipv6/unicast" },
            ]}
          />
        </Div>
      ))}
    </Div>
  );
};

const BgpOverviewPage = observer(({ clusterId }: PageProps) => {
  const { state, refresh } = useSnapshot(clusterId, request);
  const cilium = useCiliumInfo(clusterId);
  const nav = useResourceNavigation(clusterId);
  const config = cilium.state.value?.config;
  const secretsNamespace = bgpSecretsNamespace(config);
  const bgpFlag = config?.["enable-bgp-control-plane"];

  return (
    <PageLayout
      clusterId={clusterId}
      title="BGP Configuration"
      subtitle="The BGP control plane as configured: cluster configs, their instances and peers, peer settings and what each peer is sent"
      actions={
        <>
          {(["CiliumBGPClusterConfig", "CiliumBGPPeerConfig", "CiliumBGPAdvertisement"] as const).map(
            (kind) =>
              nav.hasKind(kind) && (
                <PlainButton key={kind} Icon={AddIcon} $onClick={() => nav.openKind(kind)} $tooltip={`Opens the ${kind} list, where you can create one`}>
                  {kind.replace("CiliumBGP", "")}
                </PlainButton>
              ),
          )}
          <UpdatedAt state={state} onRefresh={() => void refresh()} />
        </>
      }
    >
      <QueryView state={state} onRetry={() => void refresh()} loadingText="Reading BGP resources…">
        {(snapshot) => {
          const model = modelOf(snapshot);
          const issues = validateBgp({
            clusterConfigs: model.clusterConfigs,
            peerConfigs: model.peerConfigs,
            advertisements: model.advertisements,
            legacyPolicies: model.legacy,
            secrets: model.secretsReadable ? itemsOf(snapshot, "secrets").map(secretInfoOf) : undefined,
            secretsNamespace,
          });
          const v2Installed = !snapshot.notInstalled.includes("CiliumBGPClusterConfig");
          const nothing = model.clusterConfigs.length === 0 && model.legacy.length === 0;

          return (
            <Div $flex={{ direction: "vertical", gap: "l" }} $padding={{ horizontal: "l", bottom: "l" }}>
              <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center" }}>
                <StateBadge kind="config" />
                <Span $color="textMuted" $font={{ size: "s" }}>
                  Everything on this page is the configured state. Session state is under BGP Session Status, advertised routes under Route Advertisements.
                </Span>
              </Div>
              {config && bgpFlag !== "true" && (
                <Callout level="warning" title="BGP control plane is not enabled">
                  cilium-config has enable-bgp-control-plane={bgpFlag ?? "(not set)"}: the agents ignore these resources.
                </Callout>
              )}
              {!config && cilium.state.value && <Callout level="info">The agent configuration (cilium-config) is not readable{cilium.state.value.configError ? `: ${cilium.state.value.configError}` : ""}. Whether BGP is enabled is unknown.</Callout>}
              <SnapshotProblems snapshot={snapshot} kinds={v2Installed ? kinds.filter((kind) => kind !== "CiliumBGPPeeringPolicy") : kinds} />
              {!model.secretsReadable && <Callout level="info">Secrets are not readable, so authentication secret references cannot be checked. Only names are ever read; values are dropped.</Callout>}

              {nothing ? (
                <EmptyState title="No BGP configuration" text="There is no CiliumBGPClusterConfig (or legacy CiliumBGPPeeringPolicy) on this cluster.">
                  {nav.hasKind("CiliumBGPClusterConfig") && (
                    <Div>
                      <PlainButton Icon={AddIcon} $onClick={() => nav.openKind("CiliumBGPClusterConfig")}>
                        Create a CiliumBGPClusterConfig
                      </PlainButton>
                    </Div>
                  )}
                </EmptyState>
              ) : (
                <Section title="Validation">
                  <IssueList
                    issues={issues}
                    onOpen={(issue) => {
                      const resource = [...model.clusterConfigs, ...model.peerConfigs, ...model.advertisements, ...model.legacy].find((item) => item.resource?.kind === issue.kind && item.name === issue.name);

                      if (resource) nav.openRef(refOf(resource.resource));
                    }}
                  />
                </Section>
              )}

              {model.clusterConfigs.length > 0 && (
                <Section title="Cluster configs → instances → peers → peer configs → advertisements">
                  <Div $flex={{ direction: "vertical", gap: "m" }}>
                    {model.clusterConfigs.map((clusterConfig) => (
                      <ClusterConfigCard key={clusterConfig.name} clusterId={clusterId} config={clusterConfig} model={model} secretsNamespace={secretsNamespace} />
                    ))}
                  </Div>
                </Section>
              )}

              {model.peerConfigs.length > 0 && (
                <Section title="Peer configs">
                  <DataTable<PeerConfig>
                    ariaLabel="Peer configs"
                    rows={model.peerConfigs}
                    rowKey={(peerConfig) => peerConfig.name}
                    onRowClick={(peerConfig) => nav.openRef(refOf(peerConfig.resource))}
                    initialSort={{ column: "name" }}
                    columns={[
                      { id: "name", header: "Name", render: (peerConfig) => <Span $font={{ bold: true }}>{peerConfig.name}</Span>, sortValue: (peerConfig) => peerConfig.name },
                      {
                        id: "used",
                        header: "Used by peers",
                        render: (peerConfig) => {
                          const users = model.clusterConfigs.flatMap((clusterConfig) => clusterConfig.instances.flatMap((instance) => instance.peers.filter((peer) => peer.peerConfigRef === peerConfig.name).map((peer) => `${clusterConfig.name}/${peer.name}`)));

                          return users.length > 0 ? users.join(", ") : <Span $color="textMuted">none</Span>;
                        },
                      },
                      { id: "details", header: "Settings and advertisements", render: (peerConfig) => <PeerConfigFacts config={peerConfig} model={model} secretsNamespace={secretsNamespace} clusterId={clusterId} /> },
                    ]}
                  />
                </Section>
              )}

              {model.advertisements.length > 0 && (
                <Section title="Advertisements">
                  <DataTable
                    ariaLabel="Advertisements"
                    rows={model.advertisements.flatMap((advertisement) => advertisement.entries.map((entry, index) => ({ advertisement, entry, index })))}
                    rowKey={(row) => `${row.advertisement.name}/${row.index}`}
                    onRowClick={(row) => nav.openRef(refOf(row.advertisement.resource))}
                    columns={[
                      { id: "name", header: "Advertisement", render: (row) => <Span $font={{ bold: true }}>{row.advertisement.name}</Span>, sortValue: (row) => row.advertisement.name },
                      { id: "labels", header: "Labels", render: (row) => Object.entries(row.advertisement.labels).map(([key, value]) => `${key}=${value}`).join(", ") || "—" },
                      { id: "type", header: "Type", render: (row) => row.entry.advertisementType, sortValue: (row) => row.entry.advertisementType },
                      { id: "addresses", header: "Addresses", render: (row) => (row.entry.advertisementType === "Service" ? row.entry.addresses.join(", ") || "none" : row.entry.interfaceName ?? "—") },
                      { id: "selector", header: "Selector", render: (row) => (row.entry.selector ? describeSelector(row.entry.selector) : row.entry.advertisementType === "PodCIDR" ? "—" : <Span $color="warning">none (selects nothing)</Span>) },
                      {
                        id: "attributes",
                        header: "Attributes",
                        render: (row) =>
                          [
                            row.entry.communities && [...row.entry.communities.standard, ...row.entry.communities.wellKnown, ...row.entry.communities.large].length > 0
                              ? `communities ${[...row.entry.communities.standard, ...row.entry.communities.wellKnown, ...row.entry.communities.large].join(" ")}`
                              : undefined,
                            row.entry.localPreference !== undefined ? `local-pref ${row.entry.localPreference}` : undefined,
                          ]
                            .filter(Boolean)
                            .join(" · ") || "—",
                      },
                      {
                        id: "used",
                        header: "Selected by",
                        render: (row) => {
                          const users = model.peerConfigs.flatMap((peerConfig) =>
                            (peerConfig.familiesDefaulted ? [] : peerConfig.families).filter((family) => advertisementsOfFamily(family, [row.advertisement]).length > 0).map((family) => `${peerConfig.name} (${family.afi})`),
                          );

                          return users.length > 0 ? users.join(", ") : <Span $color="warning">no peer config</Span>;
                        },
                      },
                    ]}
                  />
                </Section>
              )}

              {model.legacy.length > 0 && (
                <Section title="Legacy peering policies (CiliumBGPPeeringPolicy, v1 control plane)">
                  <Callout level="warning">The v1 BGP control plane is deprecated; migrate to CiliumBGPClusterConfig, CiliumBGPPeerConfig and CiliumBGPAdvertisement.</Callout>
                  {model.legacy.map((policy) => (
                    <LegacyPolicyCard key={policy.name} clusterId={clusterId} policy={policy} secretsNamespace={secretsNamespace} />
                  ))}
                </Section>
              )}
            </Div>
          );
        }}
      </QueryView>
    </PageLayout>
  );
});

export const bgpOverviewPageInjectable = getInjectable2({
  id: "cilium-ui-page-bgp-overview",
  injectionToken: ciliumPageInjectionToken,
  instantiate: () => () => ({
    id: "bgp-overview",
    section: "bgp" as const,
    title: "BGP Configuration",
    orderNumber: 5,
    Component: BgpOverviewPage,
    description: "Cluster configs, peers, peer configs and advertisements of the BGP control plane, with validation",
  }),
});
