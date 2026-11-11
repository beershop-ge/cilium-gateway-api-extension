import { Badge } from "@k8slens/badge";
import { Div, Span } from "@k8slens/element-components";
import { RefreshIcon } from "@k8slens/icon";
import { PlainButton, PrimaryButton } from "@k8slens/input-components";
import { getInjectable2 } from "@k8slens/injectable";
import { useInject } from "@k8slens/use-inject";
import { observer } from "mobx-react";
import { errorMessage } from "../common/json";
import type { Query } from "../common/query";
import { redactText } from "../common/redact";
import type { ClusterContext } from "../kube/cluster-context.injectable";
import type { AgentPod } from "../kube/cilium-info";
import { ciliumDbg, parseJsonOutput } from "../kube/cilium-exec";
import { KubeError } from "../kube/kubectl";
import { ciliumPageInjectionToken, type PageProps } from "../navigation/pages";
import { resourceActionsInjectable } from "../resources/resource-actions.injectable";
import { CodeView } from "../ui/code-editor";
import { Callout, ErrorState, Facts, HealthBadge, QueryView, Section, StatusDot, uiStyles, UpdatedAt } from "../ui/components";
import { DataTable } from "../ui/data-table";
import { PageLayout } from "../ui/page-layout";
import { useCiliumInfo, useClusterContext } from "../ui/use-cluster";
import { type AgentStatusSummary, type ComponentPod, jsonOutputUnsupported, parseAgentStatus, summarizeComponents } from "./agent-status";

type AgentStatusResult = { readonly kind: "json"; readonly summary: AgentStatusSummary } | { readonly kind: "brief"; readonly text: string; readonly reason: string };

/** Reads one agent's status with its debug CLI: JSON when it can, the brief text otherwise. */
const readAgentStatus = async (context: ClusterContext, pod: AgentPod): Promise<AgentStatusResult> => {
  try {
    const output = await ciliumDbg(context.kubectl, pod, ["status", "-o", "json"], { timeoutMs: 30_000 });

    return { kind: "json", summary: parseAgentStatus(parseJsonOutput(output)) };
  } catch (error) {
    if (error instanceof KubeError && (error.kind === "Forbidden" || error.kind === "Unauthorized" || error.kind === "Aborted")) throw error;

    const reason = errorMessage(error);

    try {
      const text = await ciliumDbg(context.kubectl, pod, ["status", "--brief"], { timeoutMs: 30_000 });

      return { kind: "brief", text, reason: jsonOutputUnsupported(reason) ? "This agent's CLI does not print its status as JSON." : `The JSON status failed: ${reason.split("\n")[0]}` };
    } catch (briefError) {
      throw new KubeError(error instanceof KubeError ? error.kind : "Other", `${reason}\n\ncilium-dbg status --brief: ${errorMessage(briefError)}`);
    }
  }
};

/** Read on demand only: the query is never ensured by rendering, only by the buttons. */
const statusQuery = (context: ClusterContext, pod: AgentPod): Query<AgentStatusResult> => context.queries.get(`obs:agent-status:${pod.namespace}/${pod.name}`, () => readAgentStatus(context, pod));

const componentLabel: Record<ComponentPod["component"], string> = { agent: "Agent", operator: "Operator", relay: "Hubble Relay", envoy: "cilium-envoy" };

const StatusDetails = ({ summary }: { summary: AgentStatusSummary }) => (
  <Div $flex={{ direction: "vertical", gap: "s" }}>
    <Div $flex={{ direction: "horizontal", gap: "s", wrap: true }}>
      {summary.checks.map((check) => (
        <Div key={check.id} $flex={{ direction: "horizontal", gap: "xs", verticalAlign: "center" }} $tooltip={check.message ?? check.state}>
          <StatusDot health={check.health} title={`${check.label}: ${check.state}`} />
          <Span $font={{ size: "s" }}>
            {check.label}: {check.state}
          </Span>
        </Div>
      ))}
    </Div>
    <Facts
      rows={[
        summary.clusterHealth ? ["Cluster health", `${summary.clusterHealth.state}${summary.clusterHealth.message ? ` — ${summary.clusterHealth.message}` : ""}`] : undefined,
        summary.nodes.length ? ["Nodes known", `${summary.nodes.length}${summary.self ? ` (this agent: ${summary.self})` : ""}`] : undefined,
        ["Controllers", `${summary.controllers.total} (${summary.controllers.failing.length} failing)`],
        summary.ipam ? ["IPAM", `${summary.ipam.allocated} allocated${summary.ipam.detail ? ` (${summary.ipam.detail})` : ""}`] : undefined,
        summary.hubble ? ["Hubble flows", `${summary.hubble.currentFlows ?? "?"} / ${summary.hubble.maxFlows ?? "?"} in buffer, ${summary.hubble.seenFlows ?? "?"} seen${summary.hubble.uptime ? `, up ${summary.hubble.uptime}` : ""}`] : undefined,
        summary.encryption ? ["Encryption", summary.encryption] : undefined,
        summary.kubeProxyReplacement ? ["kube-proxy replacement", summary.kubeProxyReplacement] : undefined,
      ]}
    />
    {summary.errors.length > 0 && (
      <Callout level={summary.health === "error" ? "danger" : "warning"} title={`${summary.errors.length} problem${summary.errors.length === 1 ? "" : "s"}`}>
        <Div $flex={{ direction: "vertical", gap: "xxs" }}>
          {summary.errors.map((error) => (
            <Span key={error} className={uiStyles.wrap}>
              {redactText(error)}
            </Span>
          ))}
        </Div>
      </Callout>
    )}
  </Div>
);

const AgentCard = observer(({ context, pod }: { context: ClusterContext; pod: AgentPod }) => {
  const query = statusQuery(context, pod);
  const state = query.state();

  return (
    <Div className={uiStyles.card} $padding="m" $flex={{ direction: "vertical", gap: "s" }}>
      <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center" }}>
        <Div $flex={{ direction: "vertical" }} $flexChild>
          <Span $font={{ bold: true }}>{pod.node ?? "(unscheduled)"}</Span>
          <Span $color="textMuted" $font={{ size: "xs" }}>
            {pod.name}
          </Span>
        </Div>
        {state.value?.kind === "json" && <HealthBadge health={state.value.summary.health} />}
        <PlainButton Icon={RefreshIcon} $onClick={() => void query.refresh()} $enabled={!state.refreshing} $tooltip="Run cilium-dbg status in this agent">
          {state.status === "idle" ? "Read status" : state.refreshing ? "Reading…" : "Read again"}
        </PlainButton>
      </Div>
      {state.status === "idle" ? (
        <Span $color="textMuted" $font={{ size: "s" }}>
          Not read yet.
        </Span>
      ) : state.status === "error" && !state.refreshing ? (
        <ErrorState title="Status could not be read" error={state.error} />
      ) : state.value?.kind === "json" ? (
        <StatusDetails summary={state.value.summary} />
      ) : state.value?.kind === "brief" ? (
        <Div $flex={{ direction: "vertical", gap: "xs" }}>
          <Span $color="textMuted" $font={{ size: "s" }}>
            {state.value.reason} Showing <code>cilium-dbg status --brief</code>:
          </Span>
          <CodeView value={redactText(state.value.text)} maxHeight={200} />
        </Div>
      ) : (
        <Span $color="textMuted" $font={{ size: "s" }}>
          Reading…
        </Span>
      )}
    </Div>
  );
});

const readAll = async (context: ClusterContext, pods: readonly AgentPod[], concurrency = 4) => {
  const queue = [...pods];

  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let pod = queue.shift(); pod; pod = queue.shift()) await statusQuery(context, pod).refresh();
    }),
  );
};

const AgentHealthPage = observer(({ clusterId }: PageProps) => {
  const context = useClusterContext(clusterId);
  const { state, refresh } = useCiliumInfo(clusterId);
  const actions = useInject(resourceActionsInjectable)();

  return (
    <PageLayout clusterId={clusterId} title="Agent Health" subtitle="Cilium agents, operators, Hubble Relay and cilium-envoy, with each agent's own status on demand" actions={<UpdatedAt state={state} onRefresh={() => void refresh()} />}>
      <QueryView state={state} onRetry={() => void refresh()} loadingText="Finding Cilium…">
        {(info) => {
          const summary = summarizeComponents(info);

          return (
            <Div $flex={{ direction: "vertical", gap: "l" }} $padding={{ horizontal: "l", bottom: "l" }}>
              {info.podsError && <Callout level="danger" title="Cilium's pods could not be listed">{redactText(info.podsError)}</Callout>}
              {info.agents.length === 0 && !info.podsError && <Callout level="warning" title="No Cilium agent pods found">No pod with the label k8s-app=cilium was found. Cilium may not be installed, or it runs under other labels.</Callout>}
              {summary.mixedVersions && (
                <Callout level="warning" title="Mixed Cilium versions">
                  Agents and operators run {summary.versions.join(", ")}. This is expected during an upgrade; otherwise roll every component to one version.
                </Callout>
              )}
              <Div $flex={{ direction: "horizontal", gap: "s", wrap: true }}>
                <Badge label={`${info.agents.length} agents`} />
                <Badge label={`${info.operators.length} operators`} />
                <Badge label={`${info.relays.length} relays`} />
                <Badge label={`${info.envoys.length} envoys`} />
                {summary.notReady > 0 && <Badge label={`${summary.notReady} not ready`} $backgroundColor="critical" $color="white" />}
                {summary.versions.length === 1 && <Badge label={`Cilium ${summary.versions[0]}`} $backgroundColor="primary" $color="white" />}
              </Div>
              <Section title="Pods">
                <DataTable<ComponentPod>
                  ariaLabel="Cilium component pods"
                  rows={summary.pods}
                  rowKey={(pod) => `${pod.namespace}/${pod.name}`}
                  initialSort={{ column: "component" }}
                  onRowClick={(pod) => void actions.openRef(clusterId, { kind: "Pod", name: pod.name, namespace: pod.namespace })}
                  columns={[
                    { id: "component", header: "Component", render: (pod) => componentLabel[pod.component], sortValue: (pod) => ["agent", "operator", "relay", "envoy"].indexOf(pod.component) },
                    { id: "name", header: "Pod", render: (pod) => pod.name, sortValue: (pod) => pod.name },
                    { id: "node", header: "Node", render: (pod) => pod.node ?? "", sortValue: (pod) => pod.node ?? "" },
                    { id: "ready", header: "Ready", render: (pod) => <HealthBadge health={pod.ready ? "ok" : "error"} label={pod.ready ? "Ready" : (pod.phase ?? "Not ready")} />, sortValue: (pod) => (pod.ready ? 1 : 0) },
                    { id: "restarts", header: "Restarts", render: (pod) => (pod.restarts > 0 ? <Span $color="warning">{pod.restarts}</Span> : "0"), sortValue: (pod) => pod.restarts },
                    {
                      id: "version",
                      header: "Version",
                      render: (pod) =>
                        summary.mixedVersions && (pod.component === "agent" || pod.component === "operator") ? <Span $color="warning">{pod.version ?? "?"}</Span> : (pod.version ?? ""),
                      sortValue: (pod) => pod.version ?? "",
                    },
                    { id: "image", header: "Image", render: (pod) => <Span className={uiStyles.wrap} $font={{ size: "xs" }}>{pod.image ?? ""}</Span> },
                  ]}
                />
              </Section>
              {info.agents.length > 0 && (
                <Section
                  title="Agent status (cilium-dbg status, per node)"
                  actions={
                    <PrimaryButton Icon={RefreshIcon} $onClick={() => void readAll(context, info.agents)} $tooltip="Run cilium-dbg status in every agent, four at a time">
                      Read all
                    </PrimaryButton>
                  }
                >
                  <Span $color="textMuted" $font={{ size: "s" }}>
                    Runs <code>cilium-dbg status -o json</code> in the agent pod through kubectl exec, as your user (needs create on pods/exec). Nothing is read until you ask.
                  </Span>
                  <div className={uiStyles.cardGrid} style={{ gridTemplateColumns: "repeat(auto-fill, minmax(380px, 1fr))" }}>
                    {[...info.agents]
                      .sort((a, b) => (a.node ?? a.name).localeCompare(b.node ?? b.name))
                      .map((pod) => (
                        <AgentCard key={pod.name} context={context} pod={pod} />
                      ))}
                  </div>
                </Section>
              )}
            </Div>
          );
        }}
      </QueryView>
    </PageLayout>
  );
});

export const agentHealthPageInjectable = getInjectable2({
  id: "cilium-ui-page-agent-health",
  injectionToken: ciliumPageInjectionToken,
  instantiate: () => () => ({
    id: "agent-health",
    section: "observability" as const,
    title: "Agent Health",
    orderNumber: 60,
    Component: AgentHealthPage,
    description: "Cilium component pods, versions and per-agent status",
  }),
});
