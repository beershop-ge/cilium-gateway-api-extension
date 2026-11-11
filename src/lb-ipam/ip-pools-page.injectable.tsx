import { Badge } from "@k8slens/badge";
import { Div, Span } from "@k8slens/element-components";
import { AddIcon, EditIcon } from "@k8slens/icon";
import { PlainButton } from "@k8slens/input-components";
import { getInjectable2 } from "@k8slens/injectable";
import { observer } from "mobx-react";
import { formatCount, rangeContains } from "../common/cidr";
import { age } from "../common/format";
import { errorMessage, type Json } from "../common/json";
import { redactText } from "../common/redact";
import { describeSelector } from "../common/selectors";
import { itemsOf, type SnapshotRequest } from "../kube/snapshot";
import { ciliumPageInjectionToken, type PageProps } from "../navigation/pages";
import { refOf } from "../resources/resource-actions.injectable";
import { Clickable, Mono, SnapshotProblems, StateBadge, useResourceNavigation } from "../bgp/shared";
import { Callout, ConditionsList, EmptyState, QueryView, Section, UpdatedAt, UsageBar, uiStyles, useQueryState } from "../ui/components";
import { DataTable } from "../ui/data-table";
import { PageLayout } from "../ui/page-layout";
import { useCiliumInfo, useClusterContext, useSnapshot } from "../ui/use-cluster";
import {
  assignIpsToPools,
  type Assignments,
  findPoolOverlaps,
  isLoadBalancer,
  l2LeaseName,
  type L2Policy,
  type LbPool,
  type LbService,
  leaseHolders,
  nodesOfL2Policy,
  parseL2Policy,
  parseLbService,
  parsePool,
  type PoolAssignment,
  poolUsage,
  servicesOfL2Policy,
} from "./lb-model";

const kinds = ["CiliumLoadBalancerIPPool", "CiliumL2AnnouncementPolicy"];
const request: SnapshotRequest = { kinds, builtins: ["services", "nodes"] };

const ServiceLinks = ({ clusterId, services }: { clusterId: string; services: PoolAssignment["services"] }) => {
  const nav = useResourceNavigation(clusterId);

  return (
    <Div $flex={{ direction: "horizontal", gap: "s", wrap: true }}>
      {services.map((service) => (
        <Clickable key={`${service.namespace}/${service.name}`} onClick={() => nav.openRef({ kind: "Service", name: service.name, namespace: service.namespace })}>
          {service.namespace}/{service.name}
        </Clickable>
      ))}
    </Div>
  );
};

const PoolCard = ({ clusterId, pool, assignments }: { clusterId: string; pool: LbPool; assignments: Assignments }) => {
  const nav = useResourceNavigation(clusterId);
  const assigned = assignments.byPool.get(pool.name) ?? [];
  const usage = poolUsage(pool, assigned);

  return (
    <Div className={uiStyles.card} $flex={{ direction: "vertical", gap: "s" }} $padding="m">
      <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center", wrap: true }}>
        <Span $font={{ size: "l", bold: true }}>{pool.name}</Span>
        {pool.disabled && <Badge small label="Disabled" $backgroundColor="grey40" $color="white" $tooltip="spec.disabled: no new addresses are assigned from this pool" />}
        {pool.conflict && <Badge small label="Conflict" $backgroundColor="critical" $color="white" $tooltip={pool.conflict} />}
        {pool.allowFirstLastIPs && <Badge small label="First/last IPs allowed" />}
        <Div $flexChild />
        <PlainButton Icon={EditIcon} $onClick={() => nav.openRef(refOf(pool.resource))}>
          Edit
        </PlainButton>
      </Div>
      <Span $font={{ size: "s" }}>
        <Span $color="textMuted">Services: </Span>
        {describeSelector(pool.serviceSelector) === "all" ? "every service (no selector)" : describeSelector(pool.serviceSelector)}
      </Span>
      <Div $flex={{ direction: "vertical", gap: "xxs" }}>
        <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center" }}>
          <Span $font={{ bold: true }}>
            {usage.used} of {formatCount(pool.usable)} assigned
          </Span>
          <Span $color="textMuted" $font={{ size: "s" }}>
            ({usage.percent.toFixed(usage.percent < 1 && usage.used > 0 ? 2 : 0)}%, counted from LoadBalancer Service status)
          </Span>
        </Div>
        <UsageBar used={usage.used} total={Number(pool.usable)} title={`${usage.used} of ${pool.usable} usable addresses assigned`} />
        {(pool.reported.total !== undefined || pool.reported.used !== undefined || pool.reported.available !== undefined) && (
          <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center" }} $font={{ size: "s" }}>
            <StateBadge kind="runtime" detail="Counts the operator writes to the pool's conditions" />
            <Span>
              Operator reports {pool.reported.used ?? "?"} used, {pool.reported.available ?? "?"} available, {pool.reported.total ?? "?"} total
            </Span>
          </Div>
        )}
      </Div>
      <DataTable
        ariaLabel={`Blocks of ${pool.name}`}
        rows={pool.blocks.map((block, index) => ({ block, index }))}
        rowKey={(row) => `${row.index}`}
        empty={<Span $color="warning">The pool has no blocks.</Span>}
        columns={[
          { id: "block", header: "Block", render: (row) => <Mono>{row.block.label}</Mono> },
          { id: "type", header: "Kind", render: (row) => (row.block.isCidr ? "CIDR" : "Range") },
          { id: "size", header: "Addresses", render: (row) => (row.block.error ? <Span $color="critical">{row.block.error}</Span> : formatCount(row.block.size)) },
          {
            id: "usable",
            header: "Assignable",
            render: (row) => (row.block.error ? "—" : <Span title={row.block.usable < row.block.size ? "The first and last address of a CIDR are skipped unless allowFirstLastIPs is Yes" : undefined}>{formatCount(row.block.usable)}</Span>),
          },
          {
            id: "assigned",
            header: "Assigned",
            render: (row) => (row.block.range ? assigned.filter((entry) => row.block.range !== undefined && rangeContains(row.block.range, entry.ip)).length : "—"),
          },
        ]}
      />
      {assigned.length > 0 && (
        <Section title={<Div $flex={{ direction: "horizontal", gap: "s" }}><span>Assigned addresses</span><StateBadge kind="runtime" detail="From the Services' status.loadBalancer.ingress" /></Div>}>
          <DataTable<PoolAssignment>
            ariaLabel={`Addresses assigned from ${pool.name}`}
            rows={assigned}
            rowKey={(entry) => entry.ip}
            columns={[
              { id: "ip", header: "IP", render: (entry) => <Mono>{entry.ip}</Mono> },
              { id: "services", header: "Services", render: (entry) => <ServiceLinks clusterId={clusterId} services={entry.services} /> },
              { id: "shared", header: "Shared", render: (entry) => (entry.services.length > 1 ? `by ${entry.services.length} services` : "") },
            ]}
          />
        </Section>
      )}
      {pool.conditions.length > 0 && (
        <Section title={<Div $flex={{ direction: "horizontal", gap: "s" }}><span>Conditions</span><StateBadge kind="runtime" /></Div>}>
          <ConditionsList conditions={pool.conditions} />
        </Section>
      )}
    </Div>
  );
};

/** The announcing node of each service, from the leases the agents elect it by; read separately as it needs its own RBAC. */
const useL2Leases = (clusterId: string, namespace: string | undefined) => {
  const context = useClusterContext(clusterId);
  const query = context.queries.get(`q:lb-ipam:l2-leases:${namespace ?? ""}`, async () => {
    if (!namespace) {
      throw new Error("The Cilium namespace is unknown: no agent pods were found.");
    }

    const result = await context.kubectl.json<Json>(["get", "leases.coordination.k8s.io", "--namespace", namespace, "--output", "json"]);

    return leaseHolders((result?.items ?? []) as Json[]);
  });

  return { state: useQueryState(query), refresh: query.refresh };
};

const L2Section = observer(({ clusterId, policies, services, nodes }: { clusterId: string; policies: readonly L2Policy[]; services: readonly LbService[]; nodes: readonly Json[] }) => {
  const nav = useResourceNavigation(clusterId);
  const cilium = useCiliumInfo(clusterId);
  const leases = useL2Leases(clusterId, cilium.state.value?.namespace);
  const config = cilium.state.value?.config;

  return (
    <Section
      title="L2 announcements"
      actions={
        <>
          {nav.hasKind("CiliumL2AnnouncementPolicy") && (
            <PlainButton Icon={AddIcon} $onClick={() => nav.openKind("CiliumL2AnnouncementPolicy")}>
              L2AnnouncementPolicy
            </PlainButton>
          )}
          <UpdatedAt state={leases.state} onRefresh={() => void leases.refresh()} />
        </>
      }
    >
      {config && config["enable-l2-announcements"] !== "true" && (
        <Callout level="warning" title="L2 announcements are not enabled">
          cilium-config has enable-l2-announcements={config["enable-l2-announcements"] ?? "(not set)"}: these policies have no effect.
        </Callout>
      )}
      {leases.state.status === "error" && leases.state.value === undefined && (
        <Callout level="info" title="Announcing nodes are not known">
          The leases in the Cilium namespace could not be read: {redactText(errorMessage(leases.state.error))}
        </Callout>
      )}
      {policies.map((policy) => {
        const selectedServices = servicesOfL2Policy(policy, services);
        const selectedNodes = nodesOfL2Policy(policy, nodes);

        return (
          <Div key={policy.name} className={uiStyles.card} $flex={{ direction: "vertical", gap: "s" }} $padding="m">
            <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center", wrap: true }}>
              <Span $font={{ size: "l", bold: true }}>{policy.name}</Span>
              {policy.loadBalancerIPs && <Badge small label="LoadBalancer IPs" />}
              {policy.externalIPs && <Badge small label="External IPs" />}
              {!policy.loadBalancerIPs && !policy.externalIPs && <Badge small label="Announces nothing" $backgroundColor="warning" $color="white" $tooltip="Neither loadBalancerIPs nor externalIPs is true" />}
              <Div $flexChild />
              <PlainButton Icon={EditIcon} $onClick={() => nav.openRef(refOf(policy.resource))}>
                Edit
              </PlainButton>
            </Div>
            <Span $font={{ size: "s" }}>
              <Span $color="textMuted">Services: </Span>
              {describeSelector(policy.serviceSelector) === "all" ? "every service" : describeSelector(policy.serviceSelector)}
              <Span $color="textMuted"> · Nodes: </Span>
              {describeSelector(policy.nodeSelector) === "all" ? "every node" : describeSelector(policy.nodeSelector)}
              <Span $color="textMuted"> · Interfaces: </Span>
              {policy.interfaces.length > 0 ? policy.interfaces.join(", ") : "all"}
            </Span>
            <Span $font={{ size: "s" }}>
              <Span $color="textMuted">Eligible nodes ({selectedNodes.length}): </Span>
              {selectedNodes.length > 0 ? selectedNodes.join(", ") : <Span $color="warning">none</Span>}
            </Span>
            <DataTable<LbService>
              ariaLabel={`Services announced by ${policy.name}`}
              rows={selectedServices}
              rowKey={(service) => `${service.namespace}/${service.name}`}
              onRowClick={(service) => nav.openRef({ kind: "Service", name: service.name, namespace: service.namespace })}
              empty={<Span $color="textMuted">No service with an address is selected.</Span>}
              columns={[
                { id: "service", header: "Service", render: (service) => `${service.namespace}/${service.name}`, sortValue: (service) => `${service.namespace}/${service.name}` },
                { id: "ips", header: "Announced IPs", render: (service) => <Mono>{[...(policy.loadBalancerIPs ? service.ingressIPs : []), ...(policy.externalIPs ? service.externalIPs : [])].join(", ")}</Mono> },
                {
                  id: "holder",
                  header: (
                    <Div $flex={{ direction: "horizontal", gap: "xs" }}>
                      <span>Announcing node</span>
                      <StateBadge kind="runtime" detail="The holder of the lease cilium-l2announce-<namespace>-<service> in the Cilium namespace" />
                    </Div>
                  ),
                  render: (service) => {
                    if (!leases.state.value) return <Span $color="textMuted">unknown</Span>;

                    const lease = leases.state.value.get(l2LeaseName(service));

                    return lease?.holder ? (
                      <Span title={lease.renewTime ? `Renewed ${age(lease.renewTime)} ago` : undefined}>{lease.holder}</Span>
                    ) : (
                      <Span $color="warning">no lease holder</Span>
                    );
                  },
                },
              ]}
            />
          </Div>
        );
      })}
    </Section>
  );
});

const IpPoolsPage = observer(({ clusterId }: PageProps) => {
  const { state, refresh } = useSnapshot(clusterId, request);
  const nav = useResourceNavigation(clusterId);

  return (
    <PageLayout
      clusterId={clusterId}
      title="LB IP Pool Usage"
      subtitle="LoadBalancer IP pools, how full they are, which services hold their addresses, and L2 announcements"
      actions={
        <>
          {nav.hasKind("CiliumLoadBalancerIPPool") && (
            <PlainButton Icon={AddIcon} $onClick={() => nav.openKind("CiliumLoadBalancerIPPool")}>
              IP pool
            </PlainButton>
          )}
          <UpdatedAt state={state} onRefresh={() => void refresh()} />
        </>
      }
    >
      <QueryView state={state} onRetry={() => void refresh()} loadingText="Reading pools and services…">
        {(snapshot) => {
          const pools = itemsOf(snapshot, "CiliumLoadBalancerIPPool").map(parsePool);
          const services = itemsOf(snapshot, "services").filter(isLoadBalancer).map(parseLbService);
          const assignments = assignIpsToPools(pools, services);
          const overlaps = findPoolOverlaps(pools);
          const policies = itemsOf(snapshot, "CiliumL2AnnouncementPolicy").map(parseL2Policy);
          const totalUsable = pools.filter((pool) => !pool.disabled).reduce((sum, pool) => sum + pool.usable, 0n);
          const totalAssigned = new Set(pools.flatMap((pool) => (assignments.byPool.get(pool.name) ?? []).map((entry) => entry.ip))).size;

          return (
            <Div $flex={{ direction: "vertical", gap: "l" }} $padding={{ horizontal: "l", bottom: "l" }}>
              <SnapshotProblems snapshot={snapshot} />
              {pools.length === 0 ? (
                <EmptyState
                  title="No LoadBalancer IP pools"
                  text={snapshot.notInstalled.includes("CiliumLoadBalancerIPPool") ? "CiliumLoadBalancerIPPool is not installed: LB IPAM is not available." : "Create a CiliumLoadBalancerIPPool for Cilium to assign LoadBalancer addresses."}
                />
              ) : (
                <>
                  <Div $flex={{ direction: "horizontal", gap: "m", verticalAlign: "center", wrap: true }}>
                    <StateBadge kind="config" detail="Pool sizes come from the pool specs" />
                    <Span>
                      {pools.length} pools, {formatCount(totalUsable)} assignable addresses in enabled pools, {totalAssigned} assigned
                    </Span>
                  </Div>
                  {overlaps.map((overlap, index) => (
                    <Callout key={index} level="danger" title="Overlapping pool blocks">
                      {overlap.poolA === overlap.poolB ? `Pool ${overlap.poolA}` : `Pools ${overlap.poolA} and ${overlap.poolB}`}: {overlap.blockA} overlaps {overlap.blockB}. Cilium marks the newer pool as conflicting and assigns nothing from it.
                    </Callout>
                  ))}
                  {assignments.outsidePools.length > 0 && (
                    <Callout level="info" title="LoadBalancer addresses outside every pool">
                      {assignments.outsidePools.map((entry) => `${entry.ip} (${entry.services.map((service) => `${service.namespace}/${service.name}`).join(", ")})`).join("; ")}. They were assigned by another controller, or from a pool that no longer exists.
                    </Callout>
                  )}
                  <Div $flex={{ direction: "vertical", gap: "m" }}>
                    {pools.map((pool) => (
                      <PoolCard key={pool.name} clusterId={clusterId} pool={pool} assignments={assignments} />
                    ))}
                  </Div>
                </>
              )}
              {policies.length > 0 && <L2Section clusterId={clusterId} policies={policies} services={services} nodes={itemsOf(snapshot, "nodes")} />}
            </Div>
          );
        }}
      </QueryView>
    </PageLayout>
  );
});

export const ipPoolsPageInjectable = getInjectable2({
  id: "cilium-ui-page-lb-ip-pools",
  injectionToken: ciliumPageInjectionToken,
  instantiate: () => () => ({
    id: "ip-pools",
    section: "lb" as const,
    title: "LB IP Pool Usage",
    orderNumber: 5,
    Component: IpPoolsPage,
    description: "LoadBalancer IP pool sizes, assigned addresses, overlaps and L2 announcements",
  }),
});
