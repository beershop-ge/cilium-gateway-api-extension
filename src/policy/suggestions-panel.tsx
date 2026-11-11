import { Badge } from "@k8slens/badge";
import { Div, Span } from "@k8slens/element-components";
import { AddIcon, PlayArrowIcon } from "@k8slens/icon";
import { PlainButton, PrimaryButton } from "@k8slens/input-components";
import { observer } from "mobx-react";
import { useMemo, useState } from "react";
import { createQuery } from "../common/query";
import type { CiliumInfo } from "../kube/cilium-info";
import type { ClusterContext } from "../kube/cluster-context.injectable";
import { aggregateFlows, type FlowFilter, hubbleStatus, observeFlows } from "../observability/hubble";
import { Callout, Checkbox, Loading, QueryView, Select, useQueryState } from "../ui/components";
import { CodeView } from "../ui/code-editor";
import { DataTable } from "../ui/data-table";
import { useCiliumInfo, useClusterContext } from "../ui/use-cluster";
import type { PolicyModel } from "./model";
import type { SafetyContext } from "./safety";
import { applySuggestions, flowFilterFor, type Suggestion, suggestRules } from "./suggestions";

const windows = [
  { value: "5m", label: "Last 5 minutes" },
  { value: "15m", label: "Last 15 minutes" },
  { value: "1h", label: "Last hour" },
  { value: "6h", label: "Last 6 hours (as far as the buffer goes)" },
];

const describeFilter = (filter: FlowFilter) =>
  [filter.namespace ? `namespace ${filter.namespace}` : "all namespaces", filter.labels ? `labels ${filter.labels}` : "all workloads", filter.since ? `since ${filter.since}` : undefined, `at most ${filter.last} flows`]
    .filter(Boolean)
    .join(", ");

const FlowSuggestions = observer(
  ({ context, info, filter, model, onAdd, safetyContext }: { context: ClusterContext; info: CiliumInfo; filter: FlowFilter; model: PolicyModel; onAdd: (model: PolicyModel) => void; safetyContext: SafetyContext }) => {
    const query = useMemo(() => createQuery(() => observeFlows(context.kubectl, info, filter)), [context, info, filter]);
    const state = useQueryState(query);
    const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());

    return (
      <QueryView state={state} onRetry={() => void query.refresh()} loadingText="Reading observed flows from Hubble…" errorTitle="Could not read flows from Hubble">
        {(result) => {
          const suggestions = suggestRules(model, aggregateFlows(result.flows));
          const chosen = suggestions.filter((suggestion) => picked.has(suggestion.key));

          return (
            <Div $flex={{ direction: "vertical", gap: "s" }}>
              {result.warnings.map((warning) => (
                <Callout key={warning} level="warning">
                  {warning}
                </Callout>
              ))}
              <Span $color="textMuted" $font={{ size: "s" }}>
                {result.flows.length} flows read {result.scope.kind === "relay" ? `from Hubble Relay (${result.scope.address})` : `from node ${result.scope.node}`}; {suggestions.length} suggestion{suggestions.length === 1 ? "" : "s"} for the selected workloads.
              </Span>
              {suggestions.length === 0 ? (
                <Callout level="info">No traffic of the selected workloads was observed in this window. Widen the window, or check that the selector matches running pods.</Callout>
              ) : (
                <DataTable<Suggestion>
                  ariaLabel="Rule suggestions from observed flows"
                  rows={suggestions}
                  rowKey={(suggestion) => suggestion.key}
                  columns={[
                    {
                      id: "pick",
                      header: "Add",
                      render: (suggestion) => (
                        <Checkbox
                          checked={picked.has(suggestion.key)}
                          label={<Span $visuallyHidden>Add {suggestion.direction} rule for {suggestion.peerLabel}</Span>}
                          onChange={(checked) => {
                            const next = new Set(picked);

                            if (checked) next.add(suggestion.key);
                            else next.delete(suggestion.key);
                            setPicked(next);
                          }}
                        />
                      ),
                    },
                    { id: "direction", header: "Direction", render: (suggestion) => suggestion.direction, sortValue: (suggestion) => suggestion.direction },
                    { id: "peer", header: "Peer", render: (suggestion) => <Span $tooltip={suggestion.observed.join("\n")}>{suggestion.peerLabel}</Span>, sortValue: (suggestion) => suggestion.peerLabel },
                    { id: "ports", header: "Ports", render: (suggestion) => (suggestion.ports.length > 0 ? suggestion.ports.map((port) => `${port.port}/${port.protocol}`).join(", ") : "every port") },
                    {
                      id: "verdicts",
                      header: "Flows",
                      render: (suggestion) => (
                        <Div $flex={{ direction: "horizontal", gap: "xxs", wrap: true }}>
                          {suggestion.forwarded > 0 && <Badge small label={`${suggestion.forwarded} forwarded`} $backgroundColor="success" $color="white" />}
                          {suggestion.dropped > 0 && <Badge small label={`${suggestion.dropped} dropped`} $backgroundColor="critical" $color="white" $tooltip={suggestion.dropReasons.join("\n")} />}
                          {suggestion.other > 0 && <Badge small label={`${suggestion.other} other`} />}
                        </Div>
                      ),
                      sortValue: (suggestion) => -(suggestion.forwarded + suggestion.dropped + suggestion.other),
                    },
                    { id: "seen", header: "Last seen", render: (suggestion) => (suggestion.lastSeen ? new Date(suggestion.lastSeen).toLocaleTimeString() : "—"), sortValue: (suggestion) => suggestion.lastSeen },
                  ]}
                />
              )}
              {chosen.some((suggestion) => suggestion.peer.type === "fqdn") && (
                <Callout level="info">FQDN rules only work with DNS visibility: an egress rule to kube-dns with a DNS rule is added too, unless one exists.</Callout>
              )}
              <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center" }}>
                <PrimaryButton
                  Icon={AddIcon}
                  $enabled={chosen.length > 0}
                  $onClick={() => {
                    onAdd(applySuggestions(model, chosen, safetyContext));
                    setPicked(new Set());
                  }}
                >
                  {`Add ${chosen.length} rule${chosen.length === 1 ? "" : "s"} to the builder`}
                </PrimaryButton>
                <PlainButton $enabled={suggestions.length > 0} $onClick={() => setPicked(new Set(suggestions.filter((suggestion) => suggestion.dropped === 0 || suggestion.forwarded > 0).map((suggestion) => suggestion.key)))}>
                  Pick all observed as allowed
                </PlainButton>
                <Span $color="textMuted" $font={{ size: "s" }}>
                  Nothing is applied: rules go into the builder, where the YAML and a dry run come before applying.
                </Span>
              </Div>
            </Div>
          );
        }}
      </QueryView>
    );
  },
);

/** Proposes rules from what Hubble saw the selected workloads do; the user picks which to add. */
export const SuggestionsPanel = observer(({ clusterId, model, onAdd, safetyContext }: { clusterId: string; model: PolicyModel; onAdd: (model: PolicyModel) => void; safetyContext: SafetyContext }) => {
  const context = useClusterContext(clusterId);
  const cilium = useCiliumInfo(clusterId);
  const [since, setSince] = useState("15m");
  const [run, setRun] = useState<{ key: number; filter: FlowFilter }>();
  const info = cilium.state.value;

  if (!info) {
    return cilium.state.status === "error" ? <Callout level="warning" title="Cilium could not be read">{cilium.state.error?.message}</Callout> : <Loading text="Looking for Cilium and Hubble…" />;
  }

  const status = hubbleStatus(info);

  if (!status.available) {
    return (
      <Div $flex={{ direction: "vertical", gap: "s" }}>
        <Callout level="warning" title="Hubble is not available, so no traffic can be read">
          {status.reason}
        </Callout>
        <Span $font={{ size: "s" }}>Enable Hubble and Hubble Relay (for the whole cluster's flows) with Helm, then come back:</Span>
        <CodeView value={"helm upgrade cilium cilium/cilium --namespace " + (info.namespace ?? "kube-system") + " --reuse-values \\\n  --set hubble.enabled=true \\\n  --set hubble.relay.enabled=true"} />
      </Div>
    );
  }

  const filter = flowFilterFor(model, { since });

  return (
    <Div $flex={{ direction: "vertical", gap: "s" }}>
      <Span $color="textMuted" $font={{ size: "s" }}>
        Reads flows with the hubble CLI in a Cilium agent pod (needs pods/exec on it). Filter: {describeFilter(filter)}.
      </Span>
      {info.relays.length === 0 && <Callout level="info">No Hubble Relay runs, so only one node's flows can be read. Enable it with the Helm value hubble.relay.enabled=true.</Callout>}
      <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center" }}>
        <Div $width={{ width: "11xl" }}>
          <Select ariaLabel="Time window" value={since} options={windows} onChange={setSince} />
        </Div>
        <PlainButton Icon={PlayArrowIcon} $onClick={() => setRun({ key: Date.now(), filter })}>
          {run ? "Read again" : "Read observed flows"}
        </PlainButton>
      </Div>
      {run && <FlowSuggestions key={run.key} context={context} info={info} filter={run.filter} model={model} onAdd={onAdd} safetyContext={safetyContext} />}
    </Div>
  );
});
