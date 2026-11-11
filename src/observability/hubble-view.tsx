import { Badge } from "@k8slens/badge";
import { ClickableDiv, Div, Span } from "@k8slens/element-components";
import { CloseIcon, FilterAltIcon, PlayArrowIcon, StopIcon } from "@k8slens/icon";
import { PlainButton, PrimaryButton, TextInput } from "@k8slens/input-components";
import { useInject } from "@k8slens/use-inject";
import { observer } from "mobx-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../common/json";
import type { QueryState } from "../common/query";
import { redactText } from "../common/redact";
import type { ClusterContext } from "../kube/cluster-context.injectable";
import type { CiliumInfo } from "../kube/cilium-info";
import { type ResourceRef, resourceActionsInjectable } from "../resources/resource-actions.injectable";
import { settingsStoreInjectable } from "../settings/settings.injectable";
import { CodeView } from "../ui/code-editor";
import { Callout, ErrorState, Facts, Loading, Section, Select, uiStyles, useQueryState } from "../ui/components";
import { PageLayout } from "../ui/page-layout";
import { useCiliumInfo, useClusterContext } from "../ui/use-cluster";
import { describeEndpoint, explainHubbleError, filterKey, type FlowFilterForm, l7Summary, latestTime, mergeFlows, protocolPort, sortableTime } from "./flow-logic";
import { endpointName, type Flow, type FlowEndpoint, type FlowFilter, type FlowResult, hubbleStatus, observeFlows, type Verdict } from "./hubble";
import styles from "./observability.module.scss";

export { styles as observabilityStyles };

export const useFlowLimit = () => useInject(settingsStoreInjectable)().get().flowLimit;
const useRelayOverride = () => useInject(settingsStoreInjectable)().get().hubbleRelayAddress || undefined;

/** What to set up for Hubble to work, shown wherever flows cannot be read. */
export const HubbleSetup = ({ title, reason, rbac }: { title: string; reason?: ReactNode; rbac?: boolean }) => (
  <Div $flex={{ direction: "vertical", gap: "m" }} $padding="l">
    <Callout level="warning" title={title}>
      {reason}
    </Callout>
    <Section title="How to enable Hubble">
      <Div $flex={{ direction: "vertical", gap: "xs" }}>
        <Span>Hubble runs inside every Cilium agent; Hubble Relay serves the flows of the whole cluster. With Helm:</Span>
        <CodeView value={"helm upgrade cilium cilium/cilium --namespace kube-system --reuse-values \\\n  --set hubble.enabled=true \\\n  --set hubble.relay.enabled=true"} />
        <Span $color="textMuted" $font={{ size: "s" }}>
          Without Relay, the flows of one node only are shown. If Relay is reachable under another address, set it in Configuration › Extension Settings (Hubble Relay address).
        </Span>
      </Div>
    </Section>
    <Section title="Permissions">
      <Span $color={rbac ? "warning" : undefined}>
        Flows are read by running <code>hubble observe</code> inside a Cilium agent pod through Lens&apos;s kubectl, as your Kubernetes user. Your RBAC needs <code>create</code> on <code>pods/exec</code> (and <code>get</code>/<code>list</code> on <code>pods</code>) in the
        Cilium namespace. Nothing is installed and no port is opened.
      </Span>
    </Section>
  </Div>
);

/**
 * Renders its children (which lay out their own page) once Cilium has been read and Hubble looks enabled; until then,
 * or when Hubble is missing, a page with the title explains what is going on.
 */
export const HubblePage = observer(({ clusterId, title, subtitle, children }: { clusterId: string; title: string; subtitle?: string; children: (info: CiliumInfo) => ReactNode }) => {
  const { state, refresh } = useCiliumInfo(clusterId);
  const info = state.value;
  const status = info ? hubbleStatus(info) : undefined;

  if (info && status?.available) return <>{children(info)}</>;

  return (
    <PageLayout clusterId={clusterId} title={title} subtitle={subtitle}>
      {info && status ? (
        <HubbleSetup title="Hubble is not available" reason={status.reason} />
      ) : state.status === "error" ? (
        <ErrorState title="Cilium could not be read" error={state.error} onRetry={() => void refresh()} />
      ) : (
        <Loading text="Finding Cilium…" />
      )}
    </PageLayout>
  );
});

/** Why flows could not be read: what to set up when it is a setup problem, the error otherwise. */
export const FlowsError = ({ error, onRetry }: { error: unknown; onRetry?: () => void }) => {
  const problem = explainHubbleError(error);

  if (problem.kind === "other") return <ErrorState title={problem.title} error={error} onRetry={onRetry} />;

  return (
    <Div $flex={{ direction: "vertical" }}>
      <HubbleSetup title={problem.title} reason={redactText(problem.detail)} rbac={problem.kind === "rbac"} />
      {onRetry && (
        <Div $padding={{ horizontal: "l", bottom: "l" }}>
          <PlainButton $onClick={onRetry}>Try again</PlainButton>
        </Div>
      )}
    </Div>
  );
};

/** Where the flows came from, and everything observeFlows warned about. */
export const FlowScope = ({ result, count, limit }: { result: Pick<FlowResult, "scope" | "warnings">; count?: number; limit?: number }) => (
  <Div $flex={{ direction: "vertical", gap: "xs" }}>
    <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center", wrap: true }}>
      {result.scope.kind === "relay" ? (
        <Badge small label="Whole cluster (Hubble Relay)" $backgroundColor="success" $color="white" $tooltip={`Read through Hubble Relay at ${result.scope.address}`} />
      ) : (
        <Badge small label={`Node ${result.scope.node} only`} $backgroundColor="warning" $color="white" $tooltip={result.scope.reason ?? "Read from one agent"} />
      )}
      {count !== undefined && (
        <Span $color="textMuted" $font={{ size: "s" }}>
          {count} flows{limit && count >= limit ? ` (the newest ${limit}, as set by the flow limit setting)` : ""}
        </Span>
      )}
    </Div>
    {result.warnings.map((warning) => (
      <Callout key={warning} level="warning">
        {warning}
      </Callout>
    ))}
  </Div>
);

const loadFlows = async (context: ClusterContext, filter: FlowFilter, options: { relayOverride?: string; keepRaw?: boolean; signal?: AbortSignal }) => {
  let info = context.ciliumInfo.state().value;

  if (!info) {
    await context.ciliumInfo.refresh();
    info = context.ciliumInfo.state().value;
  }

  if (!info) throw context.ciliumInfo.state().error ?? new Error("Cilium could not be read");

  return observeFlows(context.kubectl, info, filter, options);
};

/**
 * Reads flows for a filter once when the page opens and again on refresh only. The key does not start with `q:`,
 * so writes elsewhere never re-run `hubble observe` in the background.
 */
export const useFlows = (clusterId: string, filter: FlowFilter, { keepRaw = false }: { keepRaw?: boolean } = {}): { state: QueryState<FlowResult>; refresh: () => Promise<void> } => {
  const context = useClusterContext(clusterId);
  const relayOverride = useRelayOverride();
  const query = context.queries.get(`obs:flows:${relayOverride ?? ""}:${keepRaw ? "raw:" : ""}${filterKey(filter)}`, () => loadFlows(context, filter, { relayOverride, keepRaw }));

  return { state: useQueryState(query), refresh: query.refresh };
};

export const followIntervalMs = 5000;

export interface FollowState {
  readonly following: boolean;
  /** Flows merged from the initial read and every follow read, while any follow read happened. */
  readonly flows?: readonly Flow[];
  readonly result?: Pick<FlowResult, "scope" | "warnings">;
  readonly error?: string;
  readonly start: () => void;
  readonly stop: () => void;
  readonly reset: () => void;
}

/**
 * Follow mode: reads again every few seconds with `--since` the newest flow seen, merges without duplicates and keeps the
 * newest `limit`. Stops on unmount, aborting the read in flight.
 */
export const useFollow = (clusterId: string, filter: FlowFilter, base: readonly Flow[] | undefined, limit: number, { keepRaw = false }: { keepRaw?: boolean } = {}): FollowState => {
  const context = useClusterContext(clusterId);
  const relayOverride = useRelayOverride();
  const [following, setFollowing] = useState(false);
  const [flows, setFlows] = useState<readonly Flow[] | undefined>();
  const [result, setResult] = useState<Pick<FlowResult, "scope" | "warnings">>();
  const [error, setError] = useState<string>();
  const flowsRef = useRef<readonly Flow[] | undefined>(undefined);
  const baseRef = useRef(base);
  const key = filterKey(filter);

  baseRef.current = base;

  const reset = useCallback(() => {
    flowsRef.current = undefined;
    setFlows(undefined);
    setResult(undefined);
    setError(undefined);
  }, []);

  useEffect(() => {
    setFollowing(false);
    reset();
  }, [key, reset]);

  useEffect(() => {
    if (!following) return undefined;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      const current = flowsRef.current ?? baseRef.current ?? [];
      const since = latestTime(current) ?? "1m";

      try {
        const read = await loadFlows(context, { ...filter, since, until: undefined, last: limit }, { relayOverride, keepRaw, signal: controller.signal });

        if (controller.signal.aborted) return;

        const merged = mergeFlows(flowsRef.current ?? baseRef.current ?? [], read.flows, limit);

        flowsRef.current = merged;
        setFlows(merged);
        setResult({ scope: read.scope, warnings: read.warnings });
        setError(undefined);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setError(errorMessage(caught));
      }

      if (!controller.signal.aborted) timer = setTimeout(() => void tick(), followIntervalMs);
    };

    void tick();

    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
    // The filter is captured by its key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [following, key, context, relayOverride, keepRaw, limit]);

  return { following, flows, result, error, start: () => setFollowing(true), stop: () => setFollowing(false), reset };
};

export const verdictColor = (verdict: Verdict) =>
  verdict === "FORWARDED" || verdict === "REDIRECTED" || verdict === "TRANSLATED" ? "success" : verdict === "DROPPED" || verdict === "ERROR" ? "critical" : verdict === "AUDIT" ? "warning" : "grey40";

export const VerdictBadge = ({ verdict }: { verdict: Verdict }) => <Badge small label={verdict} $backgroundColor={verdictColor(verdict)} $color="white" />;

export const formatFlowTime = (time: string) => {
  const sortable = sortableTime(time);
  const parsed = Date.parse(time);

  return Number.isNaN(parsed) ? time : `${new Date(parsed).toLocaleTimeString(undefined, { hour12: false })}.${sortable.slice(20, 23)}`;
};

const refOfEndpoint = (endpoint: FlowEndpoint): ResourceRef | undefined => (endpoint.podName && endpoint.namespace ? { kind: "Pod", name: endpoint.podName, namespace: endpoint.namespace } : undefined);

/** One side of a flow: its name, linking to the pod when there is one, and the details under it. */
export const EndpointCell = ({ clusterId, endpoint }: { clusterId: string; endpoint: FlowEndpoint }) => {
  const actions = useInject(resourceActionsInjectable)();
  const { name, detail } = describeEndpoint(endpoint);
  const ref = refOfEndpoint(endpoint);

  return (
    <Div $flex={{ direction: "vertical" }}>
      {ref ? (
        // The wrapper keeps the click from also selecting the row.
        <span onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
          <ClickableDiv $color="link" $onClick={() => void actions.openRef(clusterId, ref)} $tooltip={`Open pod ${ref.namespace}/${ref.name}`}>
            {name}
          </ClickableDiv>
        </span>
      ) : (
        <Span>{name}</Span>
      )}
      {detail && (
        <Span $color="textMuted" $font={{ size: "xs" }}>
          {detail}
        </Span>
      )}
    </Div>
  );
};

/** The full flow in a panel on the right: facts, links to both pods, and the flow as Hubble printed it. */
export const FlowDrawer = ({ clusterId, flow, onClose }: { clusterId: string; flow: Flow; onClose: () => void }) => {
  const actions = useInject(resourceActionsInjectable)();
  const sourceRef = refOfEndpoint(flow.source);
  const destinationRef = refOfEndpoint(flow.destination);
  const endpointFacts = (endpoint: FlowEndpoint) =>
    [
      endpoint.namespace && endpoint.podName ? `${endpoint.namespace}/${endpoint.podName}` : undefined,
      endpoint.workload,
      endpoint.ip ? `${endpoint.ip}${endpoint.port ? `:${endpoint.port}` : ""}` : undefined,
      endpoint.identity !== undefined ? `identity ${endpoint.identity}` : undefined,
      endpoint.service ? `service ${endpoint.service}` : undefined,
      endpoint.names?.length ? endpoint.names.join(", ") : undefined,
    ]
      .filter(Boolean)
      .join("\n");

  return (
    <Div className={uiStyles.drawer} $flex={{ direction: "vertical" }} role="complementary" aria-label="Flow details">
      <Div className={uiStyles.scroll} $flex={{ direction: "vertical", gap: "m" }} $padding="l">
        <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "top" }}>
          <Div $flex={{ direction: "vertical", gap: "xxs" }} $flexChild>
            <Span $color="textMuted" $font={{ size: "s" }}>
              Flow · {flow.time}
            </Span>
            <Span $font={{ size: "l", bold: true }} className={uiStyles.wrap}>
              {endpointName(flow.source)} → {endpointName(flow.destination)}
            </Span>
          </Div>
          <PlainButton Icon={CloseIcon} $onClick={onClose} $tooltip="Close the details">
            <Span $visuallyHidden>Close</Span>
          </PlainButton>
        </Div>
        <Div $flex={{ direction: "horizontal", gap: "xs", wrap: true }}>
          {sourceRef && <PlainButton $onClick={() => void actions.openRef(clusterId, sourceRef)}>Source pod</PlainButton>}
          {destinationRef && <PlainButton $onClick={() => void actions.openRef(clusterId, destinationRef)}>Destination pod</PlainButton>}
        </Div>
        <Facts
          rows={[
            ["Verdict", <VerdictBadge key="verdict" verdict={flow.verdict} />],
            flow.dropReason ? ["Drop reason", flow.dropReason] : undefined,
            ["Type", flow.type],
            ["Protocol", protocolPort(flow)],
            flow.direction ? ["Direction", `${flow.direction}${flow.isReply ? " (reply)" : ""}`] : undefined,
            flow.tcpFlags ? ["TCP flags", flow.tcpFlags] : undefined,
            l7Summary(flow) ? ["L7", redactText(l7Summary(flow))] : undefined,
            flow.allowedBy?.length ? ["Allowed by", flow.allowedBy.join("\n")] : undefined,
            flow.deniedBy?.length ? ["Denied by", flow.deniedBy.join("\n")] : undefined,
            ["Node", flow.node],
            ["Source", endpointFacts(flow.source)],
            ["Destination", endpointFacts(flow.destination)],
            flow.source.labels.length ? ["Source labels", flow.source.labels.join("\n")] : undefined,
            flow.destination.labels.length ? ["Destination labels", flow.destination.labels.join("\n")] : undefined,
            flow.summary ? ["Summary", flow.summary] : undefined,
          ]}
        />
        <Section title="Flow (JSON)">
          <CodeView value={redactText(JSON.stringify(flow.raw ?? { ...flow, raw: undefined }, null, 2))} maxHeight={480} />
        </Section>
      </Div>
    </Div>
  );
};

export type FilterField = keyof Omit<FlowFilterForm, "timeMode" | "last" | "since" | "until"> | "time";

const verdictOptions = [
  { value: "", label: "Any verdict" },
  { value: "FORWARDED", label: "Allowed (forwarded)" },
  { value: "DROPPED", label: "Dropped" },
  { value: "ERROR", label: "Error" },
  { value: "AUDIT", label: "Audit" },
] as const;

const typeOptions = [
  { value: "", label: "Any type" },
  { value: "l7", label: "L7" },
  { value: "policy-verdict", label: "Policy verdict" },
  { value: "drop", label: "Drop" },
  { value: "trace", label: "Trace" },
] as const;

const Field = ({ wide, children }: { wide?: boolean; children: ReactNode }) => <div className={wide ? styles.filterFieldWide : styles.filterField}>{children}</div>;

/** The hubble filters as a toolbar; nothing is read until Apply. */
export const FlowFilterBar = ({
  form,
  onChange,
  onApply,
  onClear,
  errors,
  fields,
  extra,
}: {
  form: FlowFilterForm;
  onChange: (form: FlowFilterForm) => void;
  onApply: () => void;
  onClear: () => void;
  errors: readonly string[];
  fields: readonly FilterField[];
  extra?: ReactNode;
}) => {
  const has = (field: FilterField) => fields.includes(field);
  const text = (field: keyof FlowFilterForm, label: string, placeholder: string, wide = false) => (
    <Field wide={wide}>
      <TextInput
        aria-label={label}
        placeholder={placeholder}
        value={form[field] as string}
        onChange={(event) => onChange({ ...form, [field]: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === "Enter") onApply();
        }}
      />
    </Field>
  );

  return (
    <Div $flex={{ direction: "vertical", gap: "xs" }} $width="full">
      <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center", wrap: true }}>
        {has("namespace") && text("namespace", "Namespace", "Namespace")}
        {has("pod") && text("pod", "Pod", "Pod (namespace/name)")}
        {has("labels") && text("labels", "Labels", "Labels (app=web)", true)}
        {has("verdict") && <Select ariaLabel="Verdict" value={form.verdict} options={verdictOptions} onChange={(verdict) => onChange({ ...form, verdict })} />}
        {has("protocol") && text("protocol", "Protocol", "Protocol (tcp, udp, http…)")}
        {has("port") && text("port", "Port", "Port")}
        {has("type") && <Select ariaLabel="Event type" value={form.type} options={typeOptions} onChange={(type) => onChange({ ...form, type })} />}
        {has("httpStatus") && text("httpStatus", "HTTP status", "HTTP status (404, 5+)")}
        {has("time") && (
          <>
            <Select
              ariaLabel="Time range"
              value={form.timeMode}
              options={[
                { value: "last", label: "Newest flows" },
                { value: "range", label: "Time range" },
              ]}
              onChange={(timeMode) => onChange({ ...form, timeMode })}
            />
            {text("last", "Number of flows", "How many (default: flow limit)")}
            {form.timeMode === "range" && text("since", "Since", "Since (15m or RFC 3339)")}
            {form.timeMode === "range" && text("until", "Until", "Until (5m or RFC 3339)")}
          </>
        )}
        <PrimaryButton Icon={FilterAltIcon} $onClick={onApply} $tooltip="Read the flows again with these filters">
          Apply
        </PrimaryButton>
        <PlainButton $onClick={onClear}>Clear</PlainButton>
        {extra}
      </Div>
      {errors.map((error) => (
        <Span key={error} $color="critical" $font={{ size: "s" }}>
          {error}
        </Span>
      ))}
    </Div>
  );
};

export const FollowButton = ({ follow, enabled, disabledReason }: { follow: FollowState; enabled: boolean; disabledReason?: string }) =>
  follow.following ? (
    <PlainButton Icon={StopIcon} $onClick={follow.stop} $tooltip="Stop reading new flows">
      Stop following
    </PlainButton>
  ) : (
    <PlainButton Icon={PlayArrowIcon} $onClick={follow.start} $enabled={enabled} $tooltip={enabled ? `Read new flows every ${followIntervalMs / 1000} seconds while this page is open` : disabledReason}>
      Follow
    </PlainButton>
  );

/** The loading and error states around a flow read, handing the loaded result to its children. */
export const FlowsView = observer(({ state, onRetry, children }: { state: QueryState<FlowResult>; onRetry: () => void; children: (result: FlowResult) => ReactNode }) => {
  if (state.value !== undefined) return <>{children(state.value)}</>;
  if (state.status === "error") return <FlowsError error={state.error} onRetry={onRetry} />;

  return <Loading text="Reading flows from Hubble…" />;
});

export const CountList = ({ items, empty = "None", limit = 10 }: { items: ReadonlyArray<{ value: string; count: number }>; empty?: string; limit?: number }) =>
  items.length === 0 ? (
    <Span $color="textMuted">{empty}</Span>
  ) : (
    <Div $flex={{ direction: "vertical", gap: "xxs" }}>
      {items.slice(0, limit).map((item) => (
        <Div key={item.value} $flex={{ direction: "horizontal", gap: "s" }}>
          <Span className={`${styles.count} ${uiStyles.mono}`} $style={{ minWidth: 48, textAlign: "right" }}>
            {item.count}
          </Span>
          <Span className={uiStyles.wrap}>{item.value}</Span>
        </Div>
      ))}
      {items.length > limit && <Span $color="textMuted" $font={{ size: "s" }}>and {items.length - limit} more</Span>}
    </Div>
  );
