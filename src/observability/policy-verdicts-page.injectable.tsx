import { Badge } from "@k8slens/badge";
import { Div, Span } from "@k8slens/element-components";
import { CloseIcon } from "@k8slens/icon";
import { PlainButton, TextInput } from "@k8slens/input-components";
import { getInjectable2 } from "@k8slens/injectable";
import { observer } from "mobx-react";
import { useMemo, useState } from "react";
import { ciliumPageInjectionToken, type PageProps } from "../navigation/pages";
import { useViewState } from "../navigation/view-state.injectable";
import { EmptyState, Facts, Section, uiStyles, UpdatedAt } from "../ui/components";
import { DataTable } from "../ui/data-table";
import { PageLayout } from "../ui/page-layout";
import { buildFlowFilter, emptyFilterForm, flowKey, type FlowFilterForm, sortableTime } from "./flow-logic";
import { verdictStats, verdictTotals, type VerdictRow } from "./flow-stats";
import type { Flow } from "./hubble";
import { CountList, FlowDrawer, FlowFilterBar, FlowScope, FlowsView, formatFlowTime, HubblePage, useFlowLimit, useFlows, VerdictBadge } from "./hubble-view";

const RowDetails = ({ clusterId, row, onClose }: { clusterId: string; row: VerdictRow; onClose: () => void }) => {
  const [selected, setSelected] = useState<string>();
  const selectedFlow = selected ? row.flows.find((flow) => flowKey(flow) === selected) : undefined;

  if (selectedFlow) return <FlowDrawer clusterId={clusterId} flow={selectedFlow} onClose={() => setSelected(undefined)} />;

  return (
    <Div className={uiStyles.drawer} $flex={{ direction: "vertical" }} role="complementary" aria-label="Policy verdicts">
      <Div className={uiStyles.scroll} $flex={{ direction: "vertical", gap: "m" }} $padding="l">
        <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "top" }}>
          <Span $font={{ size: "l", bold: true }} className={uiStyles.wrap} $flexChild>
            {row.source} → {row.destination} ({row.port})
          </Span>
          <PlainButton Icon={CloseIcon} $onClick={onClose} $tooltip="Close">
            <Span $visuallyHidden>Close</Span>
          </PlainButton>
        </Div>
        <Facts
          rows={[
            ["Direction", row.direction || "—"],
            ["Allowed", row.allowed],
            ["Denied", row.denied],
            row.audit > 0 ? ["Audit", row.audit] : undefined,
            ["Allowed by", row.policies.length ? row.policies.join("\n") : "not reported (Hubble before 1.15, or allowed by default)"],
            row.deniedBy.length ? ["Denied by", row.deniedBy.join("\n")] : undefined,
            row.dropReasons.length ? ["Drop reasons", row.dropReasons.join("\n")] : undefined,
          ]}
        />
        <Section title="Verdicts">
          <DataTable<Flow>
            ariaLabel="Verdict flows"
            rows={row.flows}
            rowKey={flowKey}
            onRowClick={(flow) => setSelected(flowKey(flow))}
            initialSort={{ column: "time", descending: true }}
            columns={[
              { id: "time", header: "Time", render: (flow) => formatFlowTime(flow.time), sortValue: (flow) => sortableTime(flow.time) },
              { id: "verdict", header: "Verdict", render: (flow) => <VerdictBadge verdict={flow.verdict} /> },
              { id: "match", header: "Match", render: (flow) => flow.policyMatch ?? "" },
              { id: "node", header: "Node", render: (flow) => flow.node ?? "" },
            ]}
          />
        </Section>
      </Div>
    </Div>
  );
};

const PolicyVerdictsContent = observer(({ clusterId, tabKey }: PageProps) => {
  const limit = useFlowLimit();
  const [form, setForm] = useViewState<FlowFilterForm>(tabKey, "form", emptyFilterForm);
  const [applied, setApplied] = useViewState<FlowFilterForm>(tabKey, "applied", emptyFilterForm);
  const [search, setSearch] = useViewState(tabKey, "search", "");
  const [deniedOnly, setDeniedOnly] = useViewState(tabKey, "deniedOnly", "all");
  const [selected, setSelected] = useState<string>();
  const [errors, setErrors] = useState<readonly string[]>([]);
  const { filter } = useMemo(() => buildFlowFilter({ ...applied, type: "policy-verdict" }, limit), [applied, limit]);
  const { state, refresh } = useFlows(clusterId, filter ?? { last: limit, type: "policy-verdict" }, { keepRaw: true });
  const rows = useMemo(() => verdictStats(state.value?.flows ?? []), [state.value]);
  const totals = useMemo(() => verdictTotals(rows), [rows]);
  const needle = search.trim().toLowerCase();
  const shown = rows.filter(
    (row) => (deniedOnly === "all" || row.denied > 0) && (!needle || [row.source, row.destination, row.port, ...row.policies, ...row.deniedBy, ...row.dropReasons].join(" ").toLowerCase().includes(needle)),
  );
  const selectedRow = selected ? rows.find((row) => row.key === selected) : undefined;

  return (
    <PageLayout
      clusterId={clusterId}
      title="Policy Verdicts"
      subtitle="What network policies allowed and denied, by source, destination and port (hubble observe --type policy-verdict)"
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
          fields={["namespace", "pod", "labels", "verdict", "port", "time"]}
          extra={
            <>
              <Div $width={{ width: "11xl" }}>
                <TextInput type="search" aria-label="Search verdicts" placeholder="Search endpoints, policies, reasons" value={search} onChange={(event) => setSearch(event.target.value)} />
              </Div>
              <PlainButton $onClick={() => setDeniedOnly(deniedOnly === "all" ? "denied" : "all")} $tooltip="Show only the pairs with denied traffic, or all">
                {deniedOnly === "all" ? "Denied only" : "Show all"}
              </PlainButton>
            </>
          }
        />
      }
      drawer={selectedRow && <RowDetails key={selectedRow.key} clusterId={clusterId} row={selectedRow} onClose={() => setSelected(undefined)} />}
    >
      <FlowsView state={state} onRetry={() => void refresh()}>
        {(result) => (
          <Div $flex={{ direction: "vertical", gap: "m" }} $padding={{ horizontal: "l", bottom: "l" }}>
            <FlowScope result={result} count={result.flows.length} limit={limit} />
            <Div $flex={{ direction: "horizontal", gap: "s", wrap: true }}>
              <Badge label={`${totals.allowed} allowed`} $backgroundColor="success" $color="white" />
              <Badge label={`${totals.denied} denied`} $backgroundColor="critical" $color="white" />
              {totals.audit > 0 && <Badge label={`${totals.audit} audit`} $backgroundColor="warning" $color="white" />}
            </Div>
            {totals.dropReasons.length > 0 && (
              <Section title="Drop reasons">
                <CountList items={totals.dropReasons} />
              </Section>
            )}
            <DataTable<VerdictRow>
              ariaLabel="Policy verdicts by source, destination and port"
              rows={shown}
              rowKey={(row) => row.key}
              selectedKey={selected}
              onRowClick={(row) => setSelected(row.key)}
              empty={
                <EmptyState
                  title="No policy verdicts"
                  text={rows.length > 0 ? "Nothing matches the search." : "Hubble reported no policy verdict for these filters. Verdicts are emitted when traffic is first evaluated against policy; endpoints without any policy selecting them in default enforcement mode produce few."}
                />
              }
              columns={[
                { id: "source", header: "Source", render: (row) => row.source, sortValue: (row) => row.source },
                { id: "destination", header: "Destination", render: (row) => row.destination, sortValue: (row) => row.destination },
                { id: "port", header: "Port", render: (row) => row.port, sortValue: (row) => row.port },
                { id: "direction", header: "Direction", render: (row) => row.direction, sortValue: (row) => row.direction },
                { id: "allowed", header: "Allowed", render: (row) => (row.allowed ? <Span $color="success">{row.allowed}</Span> : "0"), sortValue: (row) => row.allowed },
                { id: "denied", header: "Denied", render: (row) => (row.denied ? <Span $color="critical">{row.denied}</Span> : "0"), sortValue: (row) => row.denied },
                { id: "policies", header: "Policies", render: (row) => [...row.policies, ...row.deniedBy.map((policy) => `✗ ${policy}`)].join(", ") },
                { id: "reasons", header: "Drop reasons", render: (row) => row.dropReasons.join(", ") },
                { id: "last", header: "Last seen", render: (row) => formatFlowTime(row.lastSeen), sortValue: (row) => sortableTime(row.lastSeen) },
              ]}
            />
          </Div>
        )}
      </FlowsView>
    </PageLayout>
  );
});

const PolicyVerdictsPage = observer((props: PageProps) => (
  <HubblePage clusterId={props.clusterId} title="Policy Verdicts">
    {() => <PolicyVerdictsContent {...props} />}
  </HubblePage>
));

export const policyVerdictsPageInjectable = getInjectable2({
  id: "cilium-ui-page-policy-verdicts",
  injectionToken: ciliumPageInjectionToken,
  instantiate: () => () => ({
    id: "policy-verdicts",
    section: "observability" as const,
    title: "Policy Verdicts",
    orderNumber: 30,
    Component: PolicyVerdictsPage,
    description: "Allowed and denied traffic by source, destination and port, with matching policies",
  }),
});
