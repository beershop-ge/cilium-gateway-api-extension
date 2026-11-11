import { Badge } from "@k8slens/badge";
import { Div, Span } from "@k8slens/element-components";
import { TextInput } from "@k8slens/input-components";
import { getInjectable2 } from "@k8slens/injectable";
import { observer } from "mobx-react";
import { useMemo, useState } from "react";
import { ciliumPageInjectionToken, type PageProps } from "../navigation/pages";
import { useViewState } from "../navigation/view-state.injectable";
import { Callout, Checkbox, EmptyState, Section, uiStyles, UpdatedAt } from "../ui/components";
import { CodeView } from "../ui/code-editor";
import { DataTable } from "../ui/data-table";
import { PageLayout } from "../ui/page-layout";
import { buildFlowFilter, emptyFilterForm, flowKey, type FlowFilterForm, sortableTime } from "./flow-logic";
import { type DnsClientStats, type DnsQuery, dnsStats, isDnsResponse } from "./flow-stats";
import { CountList, EndpointCell, FlowDrawer, FlowFilterBar, FlowScope, FlowsView, formatFlowTime, HubblePage, observabilityStyles as styles, useFlowLimit, useFlows } from "./hubble-view";

const rcodeColor = (rcode: string | undefined) => (rcode === "NOERROR" ? "success" : rcode === "NXDOMAIN" ? "warning" : rcode === undefined ? "grey40" : "critical");

const dnsVisibilityExample = `apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: dns-visibility
  namespace: my-namespace
spec:
  endpointSelector: {}
  egress:
    - toEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: kube-system
            k8s:k8s-app: kube-dns
      toPorts:
        - ports:
            - port: "53"
              protocol: ANY
          rules:
            dns:
              - matchPattern: "*"
    # Keep the rest of the egress allowed, or this policy starts denying it:
    - toEntities: [all]`;

const NoDnsFlows = () => (
  <Div $flex={{ direction: "vertical", gap: "m" }}>
    <Callout level="info" title="No DNS flows">
      Hubble sees DNS queries and answers only where Cilium&apos;s DNS proxy handles them: for pods selected by a CiliumNetworkPolicy (or CiliumClusterwideNetworkPolicy) with a DNS rule (
      <code>toPorts.rules.dns</code>) on port 53. Without one, DNS is visible only as UDP/53 packets on the Hubble Flows page, without names or response codes.
    </Callout>
    <Section title="Example: DNS visibility for a namespace">
      <CodeView value={dnsVisibilityExample} />
      <Span $color="textMuted" $font={{ size: "s" }}>
        An egress rule puts the selected pods into default-deny for egress, which is why the example also allows all other egress. Review it on the policy pages with a dry run before applying.
      </Span>
    </Section>
  </Div>
);

const DnsContent = observer(({ clusterId, tabKey }: PageProps) => {
  const limit = useFlowLimit();
  const [form, setForm] = useViewState<FlowFilterForm>(tabKey, "form", emptyFilterForm);
  const [applied, setApplied] = useViewState<FlowFilterForm>(tabKey, "applied", emptyFilterForm);
  const [search, setSearch] = useViewState(tabKey, "search", "");
  const [failingOnly, setFailingOnly] = useViewState(tabKey, "failingOnly", false);
  const [selected, setSelected] = useState<string>();
  const [errors, setErrors] = useState<readonly string[]>([]);
  const { filter } = useMemo(() => buildFlowFilter({ ...applied, protocol: "dns" }, limit), [applied, limit]);
  const { state, refresh } = useFlows(clusterId, filter ?? { last: limit, protocol: "dns" }, { keepRaw: true });
  const stats = useMemo(() => dnsStats(state.value?.flows ?? []), [state.value]);
  const needle = search.trim().toLowerCase();
  const shown = stats.queries.filter((query) => (!failingOnly || (query.rcode !== undefined && query.rcode !== "NOERROR")) && (!needle || `${query.name} ${query.client} ${query.ips.join(" ")} ${query.rcode ?? ""}`.toLowerCase().includes(needle)));
  const selectedFlow = selected ? stats.queries.find((query) => query.key === selected)?.flow : undefined;

  return (
    <PageLayout
      clusterId={clusterId}
      title="DNS Visibility"
      subtitle="DNS queries and answers seen by Cilium's DNS proxy (hubble observe --protocol dns)"
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
          fields={["namespace", "pod", "labels", "verdict", "time"]}
          extra={
            <Div $width={{ width: "11xl" }}>
              <TextInput type="search" aria-label="Search DNS" placeholder="Search names, clients, IPs, codes" value={search} onChange={(event) => setSearch(event.target.value)} />
            </Div>
          }
        />
      }
      drawer={selectedFlow && <FlowDrawer key={flowKey(selectedFlow)} clusterId={clusterId} flow={selectedFlow} onClose={() => setSelected(undefined)} />}
    >
      <FlowsView state={state} onRetry={() => void refresh()}>
        {(result) => (
          <Div $flex={{ direction: "vertical", gap: "m" }} $padding={{ horizontal: "l", bottom: "l" }}>
            <FlowScope result={result} count={result.flows.length} limit={limit} />
            {stats.total === 0 ? (
              <NoDnsFlows />
            ) : (
              <>
                <div className={uiStyles.cardGrid}>
                  <Div className={uiStyles.card} $padding="m" $flex={{ direction: "vertical", gap: "s" }}>
                    <Span $font={{ bold: true }}>Response codes</Span>
                    <Div $flex={{ direction: "horizontal", gap: "xs", wrap: true }}>
                      {stats.rcodes.length === 0 ? <Span $color="textMuted">No answers observed</Span> : stats.rcodes.map((rcode) => <Badge key={rcode.value} small label={`${rcode.value} ${rcode.count}`} $backgroundColor={rcodeColor(rcode.value)} $color="white" />)}
                    </Div>
                  </Div>
                  <Div className={uiStyles.card} $padding="m" $flex={{ direction: "vertical", gap: "s" }}>
                    <Span $font={{ bold: true }}>Top queried names</Span>
                    <CountList items={stats.topNames} limit={8} />
                  </Div>
                  <Div className={uiStyles.card} $padding="m" $flex={{ direction: "vertical", gap: "s" }}>
                    <Span $font={{ bold: true }}>Failing queries</Span>
                    <CountList items={stats.failing} limit={8} empty="Every answer was NOERROR" />
                  </Div>
                </div>
                <Section title="By client workload">
                  <DataTable<DnsClientStats>
                    ariaLabel="DNS by client"
                    rows={stats.byClient}
                    rowKey={(client) => client.client}
                    initialSort={{ column: "failures", descending: true }}
                    columns={[
                      { id: "client", header: "Client", render: (client) => client.client, sortValue: (client) => client.client },
                      { id: "queries", header: "Queries", render: (client) => <span className={styles.count}>{client.queries}</span>, sortValue: (client) => client.queries },
                      { id: "failures", header: "Failed answers", render: (client) => (client.failures ? <Span $color="critical">{client.failures}</Span> : "0"), sortValue: (client) => client.failures },
                      { id: "names", header: "Names", render: (client) => (client.names.length > 5 ? `${client.names.slice(0, 5).join(", ")} +${client.names.length - 5}` : client.names.join(", ")) },
                    ]}
                  />
                </Section>
                <Section
                  title="Queries and answers"
                  actions={
                    <Checkbox checked={failingOnly} onChange={setFailingOnly} label="Failing only" />
                  }
                >
                  <DataTable<DnsQuery>
                    ariaLabel="DNS queries"
                    rows={shown}
                    rowKey={(query) => query.key}
                    selectedKey={selected}
                    onRowClick={(query) => setSelected(query.key)}
                    initialSort={{ column: "time", descending: true }}
                    empty={<EmptyState title="Nothing matches" />}
                    columns={[
                      { id: "time", header: "Time", render: (query) => formatFlowTime(query.time), sortValue: (query) => sortableTime(query.time) },
                      { id: "client", header: "Client", render: (query) => <EndpointCell clusterId={clusterId} endpoint={isDnsResponse(query.flow) ? query.flow.destination : query.flow.source} />, sortValue: (query) => query.client },
                      { id: "name", header: "Name", render: (query) => query.name, sortValue: (query) => query.name },
                      { id: "type", header: "Type", render: (query) => query.qtypes.join(", ") },
                      { id: "rcode", header: "Response", render: (query) => (query.rcode ? <Badge small label={query.rcode} $backgroundColor={rcodeColor(query.rcode)} $color="white" /> : <Span $color="textMuted">no answer seen</Span>), sortValue: (query) => query.rcode ?? "" },
                      { id: "ips", header: "Answer IPs", render: (query) => query.ips.join(", ") },
                      { id: "server", header: "Server", render: (query) => query.server },
                    ]}
                  />
                </Section>
              </>
            )}
          </Div>
        )}
      </FlowsView>
    </PageLayout>
  );
});

const DnsPage = observer((props: PageProps) => (
  <HubblePage clusterId={props.clusterId} title="DNS Visibility">
    {() => <DnsContent {...props} />}
  </HubblePage>
));

export const dnsPageInjectable = getInjectable2({
  id: "cilium-ui-page-dns",
  injectionToken: ciliumPageInjectionToken,
  instantiate: () => () => ({
    id: "dns",
    section: "observability" as const,
    title: "DNS Visibility",
    orderNumber: 40,
    Component: DnsPage,
    description: "DNS queries, response codes and answers by client",
  }),
});
