import { Div, Span } from "@k8slens/element-components";
import { TextInput } from "@k8slens/input-components";
import { getInjectable2 } from "@k8slens/injectable";
import { observer } from "mobx-react";
import { useMemo, useState } from "react";
import { redactText } from "../common/redact";
import { ciliumPageInjectionToken, type PageProps } from "../navigation/pages";
import { useViewState } from "../navigation/view-state.injectable";
import { Callout, EmptyState, UpdatedAt } from "../ui/components";
import { DataTable } from "../ui/data-table";
import { PageLayout } from "../ui/page-layout";
import { buildFlowFilter, emptyFilterForm, flowKey, type FlowFilterForm, l7Summary, protocolPort, searchFlows, sortableTime } from "./flow-logic";
import type { CiliumInfo } from "../kube/cilium-info";
import type { Flow } from "./hubble";
import { EndpointCell, FlowDrawer, FlowFilterBar, FlowScope, FlowsView, FollowButton, formatFlowTime, HubblePage, useFlowLimit, useFlows, useFollow, VerdictBadge } from "./hubble-view";

const FlowsContent = observer(({ clusterId, tabKey }: PageProps & { info: CiliumInfo }) => {
  const limit = useFlowLimit();
  const [form, setForm] = useViewState<FlowFilterForm>(tabKey, "form", emptyFilterForm);
  const [applied, setApplied] = useViewState<FlowFilterForm>(tabKey, "applied", emptyFilterForm);
  const [search, setSearch] = useViewState(tabKey, "search", "");
  const [selected, setSelected] = useState<string>();
  const [errors, setErrors] = useState<readonly string[]>([]);
  const { filter } = useMemo(() => buildFlowFilter(applied, limit), [applied, limit]);
  const effectiveFilter = filter ?? { last: limit };
  const { state, refresh } = useFlows(clusterId, effectiveFilter, { keepRaw: true });
  const follow = useFollow(clusterId, effectiveFilter, state.value?.flows, limit, { keepRaw: true });
  const flows = follow.flows ?? state.value?.flows ?? [];
  const shown = useMemo(() => searchFlows(flows, search), [flows, search]);
  const selectedFlow = selected ? flows.find((flow) => flowKey(flow) === selected) : undefined;

  const apply = () => {
    const built = buildFlowFilter(form, limit);

    setErrors(built.errors);
    if (built.filter) setApplied(form);
  };

  return (
    <PageLayout
      clusterId={clusterId}
      title="Hubble Flows"
      subtitle="Network flows observed by Hubble, as recent as its ring buffer keeps"
      actions={
        <>
          <FollowButton follow={follow} enabled={state.value !== undefined && !effectiveFilter.until} disabledReason={effectiveFilter.until ? "Follow reads new flows, so it cannot be combined with an end time" : "Wait for the first read"} />
          <UpdatedAt
            state={state}
            onRefresh={() => {
              follow.reset();
              void refresh();
            }}
          />
        </>
      }
      toolbar={
        <FlowFilterBar
          form={form}
          onChange={setForm}
          onApply={apply}
          onClear={() => {
            setForm(emptyFilterForm);
            setApplied(emptyFilterForm);
            setErrors([]);
          }}
          errors={errors}
          fields={["namespace", "pod", "labels", "verdict", "protocol", "port", "type", "httpStatus", "time"]}
          extra={
            <Div $width={{ width: "11xl" }}>
              <TextInput type="search" aria-label="Search the flows shown" placeholder="Search the flows shown" value={search} onChange={(event) => setSearch(event.target.value)} />
            </Div>
          }
        />
      }
      drawer={selectedFlow && <FlowDrawer clusterId={clusterId} flow={selectedFlow} onClose={() => setSelected(undefined)} />}
    >
      <FlowsView state={state} onRetry={() => void refresh()}>
        {(result) => (
          <Div $flex={{ direction: "vertical", gap: "m" }} $padding={{ horizontal: "l", bottom: "l" }}>
            <FlowScope result={follow.result ?? result} count={flows.length} limit={limit} />
            {follow.following && (
              <Span $color="textMuted" $font={{ size: "s" }} role="status">
                Following: new flows are read every few seconds and merged in.
              </Span>
            )}
            {follow.error && <Callout level="warning" title="The last follow read failed">{redactText(follow.error)}</Callout>}
            <DataTable<Flow>
              ariaLabel="Flows"
              rows={shown}
              rowKey={flowKey}
              selectedKey={selected}
              onRowClick={(flow) => setSelected(flowKey(flow))}
              initialSort={{ column: "time", descending: true }}
              empty={<EmptyState title="No flows" text={flows.length > 0 ? "No flow matches the search." : "Hubble returned no flow for these filters within its buffer. Widen the filters or the time range."} />}
              columns={[
                { id: "time", header: "Time", render: (flow) => formatFlowTime(flow.time), sortValue: (flow) => sortableTime(flow.time), width: 110 },
                { id: "source", header: "Source", render: (flow) => <EndpointCell clusterId={clusterId} endpoint={flow.source} /> },
                { id: "destination", header: "Destination", render: (flow) => <EndpointCell clusterId={clusterId} endpoint={flow.destination} /> },
                { id: "protocol", header: "Protocol / port", render: (flow) => protocolPort(flow), sortValue: protocolPort },
                { id: "verdict", header: "Verdict", render: (flow) => <VerdictBadge verdict={flow.verdict} />, sortValue: (flow) => flow.verdict },
                { id: "drop", header: "Drop reason", render: (flow) => flow.dropReason ?? "", sortValue: (flow) => flow.dropReason ?? "" },
                { id: "l7", header: "L7", render: (flow) => redactText(l7Summary(flow)) },
                { id: "node", header: "Node", render: (flow) => flow.node ?? "", sortValue: (flow) => flow.node ?? "" },
              ]}
            />
          </Div>
        )}
      </FlowsView>
    </PageLayout>
  );
});

const HubbleFlowsPage = observer((props: PageProps) => (
  <HubblePage clusterId={props.clusterId} title="Hubble Flows">
    {(info) => <FlowsContent {...props} info={info} />}
  </HubblePage>
));

export const hubbleFlowsPageInjectable = getInjectable2({
  id: "cilium-ui-page-hubble-flows",
  injectionToken: ciliumPageInjectionToken,
  instantiate: () => () => ({
    id: "hubble-flows",
    section: "observability" as const,
    title: "Hubble Flows",
    orderNumber: 10,
    Component: HubbleFlowsPage,
    description: "Flows observed by Hubble, with filters, follow mode and details",
  }),
});
