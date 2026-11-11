import { Badge } from "@k8slens/badge";
import { Div, Span } from "@k8slens/element-components";
import { CloseIcon } from "@k8slens/icon";
import { PlainButton, TextInput } from "@k8slens/input-components";
import { getInjectable2 } from "@k8slens/injectable";
import { observer } from "mobx-react";
import { useMemo, useState } from "react";
import { type Json } from "../common/json";
import { itemsOf, type SnapshotRequest } from "../kube/snapshot";
import { ciliumPageInjectionToken, type PageProps } from "../navigation/pages";
import { useViewState } from "../navigation/view-state.injectable";
import { ApplyPanel } from "../resources/apply-panel";
import {
  bgpAdvertisedServices,
  legacyAdvertisesService,
  parseAdvertisement,
  parseClusterConfig,
  parseLegacyPolicy,
  parsePeerConfig,
  resolveAdvertisements,
} from "../bgp/bgp-model";
import { Clickable, Mono, SnapshotProblems, StateBadge, useResourceNavigation } from "../bgp/shared";
import { Callout, EmptyState, FieldLabel, QueryView, Section, Select, StatusDot, UpdatedAt } from "../ui/components";
import { DataTable } from "../ui/data-table";
import { PageLayout } from "../ui/page-layout";
import { useSnapshot } from "../ui/use-cluster";
import {
  assignIpsToPools,
  buildServiceEdit,
  ciliumClasses,
  ciliumServiceAnnotations,
  isLoadBalancer,
  type LbService,
  parseL2Policy,
  parseLbService,
  parsePool,
  pendingReason,
  serviceEditErrors,
  serviceKey,
  servicesOfL2Policy,
} from "./lb-model";

const kinds = ["CiliumLoadBalancerIPPool", "CiliumL2AnnouncementPolicy", "CiliumBGPClusterConfig", "CiliumBGPPeerConfig", "CiliumBGPAdvertisement", "CiliumBGPPeeringPolicy"];
const request: SnapshotRequest = { kinds, builtins: ["services", "nodes"] };

interface Row {
  readonly service: LbService;
  readonly pools: readonly string[];
  readonly bgp: boolean;
  readonly l2: readonly string[];
  readonly pending?: string;
}

const EditService = observer(({ clusterId, service, onClose }: { clusterId: string; service: LbService; onClose: () => void }) => {
  const live: Json = service.resource;
  const [annotations, setAnnotations] = useState<Record<string, string>>(() =>
    Object.fromEntries(ciliumServiceAnnotations.map(({ key }) => [key, live?.metadata?.annotations?.[key] ?? ""])),
  );
  const [lbClass, setLbClass] = useState<string>("");
  const classLocked = Boolean(service.loadBalancerClass);
  const edit = { annotations, loadBalancerClass: classLocked ? undefined : lbClass || undefined };
  const errors = serviceEditErrors(edit);
  const document = useMemo(() => (errors.length === 0 ? buildServiceEdit(live, edit) : undefined), [JSON.stringify(edit), live, errors.length]);

  return (
    <Div $flex={{ direction: "vertical", gap: "m" }} $padding="m" $border={{ color: "borderPrimary", width: "xxs", radius: "m" }}>
      <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center" }}>
        <Span $font={{ bold: true }} $flexChild>
          Cilium settings of {service.namespace}/{service.name}
        </Span>
        <PlainButton Icon={CloseIcon} $onClick={onClose}>
          Close
        </PlainButton>
      </Div>
      <Div $flex={{ direction: "horizontal", gap: "m", wrap: true }}>
        {ciliumServiceAnnotations.map(({ key, label, help }) => (
          <Div key={key} $width={{ width: "11xl" }}>
            <FieldLabel label={label} help={`${key}: ${help}`}>
              <TextInput aria-label={label} value={annotations[key] ?? ""} onChange={(event) => setAnnotations({ ...annotations, [key]: event.target.value })} />
            </FieldLabel>
          </Div>
        ))}
        <Div $width={{ width: "11xl" }}>
          <FieldLabel
            label="loadBalancerClass"
            help={
              classLocked
                ? "Already set; Kubernetes does not allow changing it. Recreate the Service to use another class."
                : "Can be set once only: Kubernetes makes it immutable after that. Leave empty to keep it unset (any Cilium announcer may serve it)."
            }
          >
            {classLocked ? (
              <TextInput aria-label="loadBalancerClass" value={service.loadBalancerClass ?? ""} readOnly />
            ) : (
              <Select ariaLabel="loadBalancerClass" value={lbClass} options={[{ value: "", label: "Unset" }, ...ciliumClasses.map((value) => ({ value, label: value }))]} onChange={setLbClass} />
            )}
          </FieldLabel>
        </Div>
      </Div>
      {errors.length > 0 && (
        <Callout level="danger" title="Fix these first">
          {errors.map((error) => (
            <div key={error}>{error}</div>
          ))}
        </Callout>
      )}
      {document && (
        <ApplyPanel
          clusterId={clusterId}
          documents={[document]}
          originals={[live]}
          modes={["replace", "server-side-apply"]}
          description={`Change the Cilium settings of Service ${service.namespace}/${service.name}`}
          onApplied={onClose}
        />
      )}
    </Div>
  );
});

const ServicesLbPage = observer(({ clusterId, tabKey }: PageProps) => {
  const { state, refresh } = useSnapshot(clusterId, request);
  const nav = useResourceNavigation(clusterId);
  const [selected, setSelected] = useViewState(tabKey, "selected", "");
  const [search, setSearch] = useViewState(tabKey, "search", "");

  return (
    <PageLayout
      clusterId={clusterId}
      title="Services and LoadBalancer Status"
      subtitle="Every LoadBalancer Service: its address, the pool it came from, and how it is announced"
      actions={<UpdatedAt state={state} onRefresh={() => void refresh()} />}
      toolbar={
        <Div $width={{ width: "11xl" }}>
          <TextInput type="search" aria-label="Search services" placeholder="Search by namespace, name or IP" value={search} onChange={(event) => setSearch(event.target.value)} />
        </Div>
      }
    >
      <QueryView state={state} onRetry={() => void refresh()} loadingText="Reading services…">
        {(snapshot) => {
          const rawServices = itemsOf(snapshot, "services");
          const services = rawServices.filter(isLoadBalancer).map(parseLbService);
          const pools = itemsOf(snapshot, "CiliumLoadBalancerIPPool").map(parsePool);
          const assignments = assignIpsToPools(pools, services);
          const l2Policies = itemsOf(snapshot, "CiliumL2AnnouncementPolicy").map(parseL2Policy);
          const legacy = itemsOf(snapshot, "CiliumBGPPeeringPolicy").map(parseLegacyPolicy);
          const advertised = bgpAdvertisedServices(
            resolveAdvertisements({
              clusterConfigs: itemsOf(snapshot, "CiliumBGPClusterConfig").map(parseClusterConfig),
              peerConfigs: itemsOf(snapshot, "CiliumBGPPeerConfig").map(parsePeerConfig),
              advertisements: itemsOf(snapshot, "CiliumBGPAdvertisement").map(parseAdvertisement),
              services: rawServices,
              nodes: itemsOf(snapshot, "nodes"),
              ciliumNodes: [],
              podIPPools: [],
            }),
          );
          const lbIpamEnabled = !snapshot.notInstalled.includes("CiliumLoadBalancerIPPool");
          const rows: Row[] = services.map((service) => ({
            service,
            pools: assignments.poolsOfService.get(serviceKey(service)) ?? [],
            bgp: advertised.has(serviceKey(service)) || legacy.some((policy) => legacyAdvertisesService(policy, service.resource)),
            l2: l2Policies.filter((policy) => servicesOfL2Policy(policy, [service]).length > 0).map((policy) => policy.name),
            pending: pendingReason(service, pools, { lbIpamEnabled }),
          }));
          const needle = search.toLowerCase();
          const shown = rows.filter((row) => `${serviceKey(row.service)} ${row.service.ingressIPs.join(" ")}`.toLowerCase().includes(needle));
          const selectedService = services.find((service) => serviceKey(service) === selected);
          const pendingCount = rows.filter((row) => row.service.ingressIPs.length === 0 && row.service.ingressHostnames.length === 0).length;

          return (
            <Div $flex={{ direction: "vertical", gap: "l" }} $padding={{ horizontal: "l", bottom: "l" }}>
              <SnapshotProblems snapshot={snapshot} kinds={["CiliumLoadBalancerIPPool"]} />
              <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center", wrap: true }}>
                <StateBadge kind="runtime" detail="Addresses from the Services' status.loadBalancer.ingress" />
                <StateBadge kind="config" detail="Pools, classes, annotations and announcement coverage from specs" />
                <Span>
                  {services.length} LoadBalancer services, {pendingCount} without an address
                </Span>
              </Div>
              {services.length === 0 ? (
                <EmptyState title="No LoadBalancer services" text="No Service of type LoadBalancer exists on this cluster (or services are not readable)." />
              ) : (
                <Section title="LoadBalancer services">
                  <DataTable<Row>
                    ariaLabel="LoadBalancer services"
                    rows={shown}
                    rowKey={(row) => serviceKey(row.service)}
                    selectedKey={selected}
                    onRowClick={(row) => setSelected(serviceKey(row.service) === selected ? "" : serviceKey(row.service))}
                    initialSort={{ column: "name" }}
                    columns={[
                      {
                        id: "name",
                        header: "Service",
                        render: (row) => (
                          <Clickable onClick={() => nav.openRef({ kind: "Service", name: row.service.name, namespace: row.service.namespace })}>
                            {row.service.namespace}/{row.service.name}
                          </Clickable>
                        ),
                        sortValue: (row) => serviceKey(row.service),
                      },
                      {
                        id: "ips",
                        header: "External IPs",
                        render: (row) =>
                          row.service.ingressIPs.length + row.service.ingressHostnames.length > 0 ? (
                            <Div $flex={{ direction: "horizontal", gap: "xs", verticalAlign: "center" }}>
                              <StatusDot health="ok" title="Address assigned" />
                              <Mono>{[...row.service.ingressIPs, ...row.service.ingressHostnames].join(", ")}</Mono>
                            </Div>
                          ) : (
                            <Div $flex={{ direction: "horizontal", gap: "xs", verticalAlign: "center" }}>
                              <StatusDot health="warn" title="Pending" />
                              <Span $color="warning">pending</Span>
                            </Div>
                          ),
                        sortValue: (row) => row.service.ingressIPs[0] ?? "",
                      },
                      { id: "pool", header: "Pool", render: (row) => (row.pools.length > 0 ? row.pools.join(", ") : row.service.ingressIPs.length > 0 ? <Span $color="textMuted">none (outside pools)</Span> : "—"), sortValue: (row) => row.pools.join(",") },
                      { id: "class", header: "loadBalancerClass", render: (row) => row.service.loadBalancerClass ?? <Span $color="textMuted">unset</Span>, sortValue: (row) => row.service.loadBalancerClass ?? "" },
                      {
                        id: "annotations",
                        header: "Cilium annotations",
                        render: (row) => (
                          <Div $flex={{ direction: "horizontal", gap: "xxs", wrap: true }}>
                            {Object.entries(row.service.ciliumAnnotations).map(([key, value]) => (
                              <Badge key={key} small label={`${key.replace("lbipam.cilium.io/", "")}=${value}`} $tooltip={`${key}=${value}`} />
                            ))}
                          </Div>
                        ),
                      },
                      { id: "bgp", header: "BGP", render: (row) => (row.bgp ? <Badge small label="advertised" $backgroundColor="success" $color="white" /> : <Span $color="textMuted">no</Span>), sortValue: (row) => (row.bgp ? 1 : 0) },
                      { id: "l2", header: "L2", render: (row) => (row.l2.length > 0 ? <Badge small label="announced" $backgroundColor="success" $color="white" $tooltip={`By ${row.l2.join(", ")}`} /> : <Span $color="textMuted">no</Span>), sortValue: (row) => row.l2.length },
                      { id: "why", header: "Why pending", render: (row) => (row.pending ? <Span $font={{ size: "s" }}>{row.pending}</Span> : row.service.ingressIPs.length === 0 && row.service.ingressHostnames.length === 0 ? <Span $color="textMuted">not known</Span> : "") },
                    ]}
                  />
                  <Span $color="textMuted" $font={{ size: "s" }}>
                    Select a service to edit its Cilium annotations or set its loadBalancerClass.
                  </Span>
                </Section>
              )}
              {selectedService && <EditService key={selected} clusterId={clusterId} service={selectedService} onClose={() => setSelected("")} />}
            </Div>
          );
        }}
      </QueryView>
    </PageLayout>
  );
});

export const servicesLbPageInjectable = getInjectable2({
  id: "cilium-ui-page-lb-services",
  injectionToken: ciliumPageInjectionToken,
  instantiate: () => () => ({
    id: "services-lb",
    section: "lb" as const,
    title: "Services and LoadBalancer Status",
    orderNumber: 70,
    Component: ServicesLbPage,
    description: "LoadBalancer services, their pools, classes, annotations and announcement",
  }),
});
