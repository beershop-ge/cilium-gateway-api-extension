import { Badge } from "@k8slens/badge";
import { ClickableDiv, Div, Span } from "@k8slens/element-components";
import { getInjectable2 } from "@k8slens/injectable";
import { useInject } from "@k8slens/use-inject";
import { observer } from "mobx-react";
import { healthOfResource } from "../common/conditions";
import type { Json } from "../common/json";
import { type AgentPod, detectFeatures } from "../kube/cilium-info";
import { itemsOf } from "../kube/snapshot";
import { openCiliumPageInjectable } from "../navigation/open-page.injectable";
import { ciliumPageInjectionToken, type PageProps, resourcePageId } from "../navigation/pages";
import { resourceActionsInjectable } from "../resources/resource-actions.injectable";
import { Callout, HealthBadge, Loading, QueryView, Section, StatusDot, UpdatedAt } from "../ui/components";
import { PageLayout } from "../ui/page-layout";
import styles from "../ui/ui.module.scss";
import { useCiliumInfo, useClusterContext, useDiscovery, useSnapshot } from "../ui/use-cluster";

/** Kinds the overview counts and checks for problems, in the order they are shown. */
const overviewKinds = [
  "Gateway",
  "HTTPRoute",
  "GRPCRoute",
  "CiliumNetworkPolicy",
  "CiliumClusterwideNetworkPolicy",
  "CiliumLoadBalancerIPPool",
  "CiliumL2AnnouncementPolicy",
  "CiliumBGPClusterConfig",
  "CiliumBGPPeeringPolicy",
  "CiliumBGPNodeConfig",
  "CiliumEgressGatewayPolicy",
  "CiliumNode",
  "CiliumEndpoint",
  "CiliumIdentity",
] as const;

/** Features whose value, not just on/off, is worth showing. */
const valueFeatures = ["policy-enforcement", "ipam", "routing", "kube-proxy-replacement"];

const podSummary = (pods: readonly AgentPod[]) => ({ ready: pods.filter((pod) => pod.ready).length, total: pods.length, restarts: pods.reduce((sum, pod) => sum + pod.restarts, 0) });

const ComponentCard = ({ title, pods, missing }: { title: string; pods: readonly AgentPod[]; missing: string }) => {
  const summary = podSummary(pods);
  const health = summary.total === 0 ? "unknown" : summary.ready === summary.total ? "ok" : summary.ready === 0 ? "error" : "warn";

  return (
    <Div className={styles.card} $padding="m" $flex={{ direction: "vertical", gap: "xs" }}>
      <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center" }}>
        <StatusDot health={health} />
        <Span $font={{ bold: true }}>{title}</Span>
      </Div>
      <Span $font={{ size: "xl", bold: true }}>{summary.total === 0 ? "—" : `${summary.ready}/${summary.total}`}</Span>
      <Span $color="textMuted" $font={{ size: "s" }}>
        {summary.total === 0 ? missing : `ready${summary.restarts ? ` · ${summary.restarts} restarts` : ""}`}
      </Span>
    </Div>
  );
};

const OverviewPage = observer(({ clusterId }: PageProps) => {
  const context = useClusterContext(clusterId);
  const discovery = useDiscovery(clusterId);
  const { state: info, refresh: refreshInfo } = useCiliumInfo(clusterId);
  const { state: snapshot, refresh } = useSnapshot(clusterId, { kinds: overviewKinds });
  const openPage = useInject(openCiliumPageInjectable)();
  const actions = useInject(resourceActionsInjectable)();

  return (
    <PageLayout
      clusterId={clusterId}
      title="Cilium Overview"
      subtitle="Health of Cilium's components, what is enabled, and what needs attention"
      actions={
        <UpdatedAt
          state={snapshot}
          onRefresh={() => {
            void refresh();
            void refreshInfo();
            void context.discovery.refresh();
          }}
        />
      }
    >
      <QueryView state={info} onRetry={() => void refreshInfo()} loadingText="Looking for Cilium…">
        {(ciliumInfo) => {
          const types = discovery.value?.types ?? [];
          const features = detectFeatures(ciliumInfo, types);
          const versions = [...new Set([...ciliumInfo.agents, ...ciliumInfo.operators].map((pod) => pod.image?.split(":").pop()?.split("@")[0]).filter(Boolean))];

          const problems = overviewKinds
            .filter((kind) => !["CiliumEndpoint", "CiliumIdentity"].includes(kind))
            .flatMap((kind) =>
              itemsOf(snapshot.value, kind)
                .map((item: Json) => ({ kind, item, ...healthOfResource(item) }))
                .filter((entry) => entry.health === "error" || entry.health === "warn"),
            );

          return (
            <Div $flex={{ direction: "vertical", gap: "l" }} $padding={{ horizontal: "l", bottom: "l" }}>
              {!ciliumInfo.namespace && (
                <Callout level="warning" title="Cilium was not found on this cluster">
                  {ciliumInfo.podsError ?? "No pods labelled k8s-app=cilium are visible. Install Cilium, or set its namespace in Configuration › Extension Settings if your user may only see that namespace."}
                </Callout>
              )}
              {versions.length > 1 && <Callout level="warning" title="Mixed Cilium versions">Agents and operators run {versions.join(", ")}: an upgrade may be in progress or stuck.</Callout>}

              <Div className={styles.cardGrid}>
                <Div className={styles.card} $padding="m" $flex={{ direction: "vertical", gap: "xs" }}>
                  <Span $font={{ bold: true }}>Cilium</Span>
                  <Span $font={{ size: "xl", bold: true }}>{ciliumInfo.version ?? "unknown"}</Span>
                  <Span $color="textMuted" $font={{ size: "s" }}>
                    {ciliumInfo.namespace ? `in ${ciliumInfo.namespace}` : "not found"}
                    {ciliumInfo.config?.["cluster-name"] ? ` · cluster ${ciliumInfo.config["cluster-name"]}` : ""}
                  </Span>
                </Div>
                <ComponentCard title="Agents" pods={ciliumInfo.agents} missing="none found" />
                <ComponentCard title="Operator" pods={ciliumInfo.operators} missing="none found" />
                <ComponentCard title="Hubble Relay" pods={ciliumInfo.relays} missing="not deployed" />
                {ciliumInfo.envoys.length > 0 && <ComponentCard title="Envoy" pods={ciliumInfo.envoys} missing="" />}
              </Div>

              <Section title="Enabled features">
                <Div $flex={{ direction: "horizontal", gap: "xs", wrap: true }}>
                  {features.map((feature) => (
                    <Badge
                      key={feature.id}
                      small
                      label={valueFeatures.includes(feature.id) && feature.state === "enabled" ? `${feature.label}: ${feature.detail.split(" (")[0]}` : feature.label}
                      $backgroundColor={feature.state === "enabled" ? "success" : feature.state === "unknown" ? "warning" : "grey40"}
                      $color="white"
                      $tooltip={feature.detail}
                    />
                  ))}
                </Div>
                {ciliumInfo.configError && <Span $color="warning" $font={{ size: "s" }}>The agent configuration could not be read: {ciliumInfo.configError}</Span>}
              </Section>

              <Section title="Resources">
                {snapshot.value === undefined ? (
                  <Loading text="Counting resources…" />
                ) : (
                  <Div className={styles.cardGrid}>
                    {overviewKinds
                      .map((kind) => ({ kind, type: context.typeOfKind(kind) }))
                      .filter(({ type }) => type)
                      .map(({ kind, type }) => {
                        const items = itemsOf(snapshot.value, kind);
                        const failing = items.filter((item: Json) => healthOfResource(item).health === "error").length;

                        return (
                          <ClickableDiv key={kind} className={styles.card} $padding="m" $flex={{ direction: "vertical", gap: "xxs" }} $onClick={() => void openPage(clusterId, resourcePageId(type!))} $tooltip={`Open ${type!.title}`}>
                            <Span $color="textMuted" $font={{ size: "s" }}>
                              {type!.title}
                            </Span>
                            <Span $font={{ size: "xl", bold: true }}>{items.length}</Span>
                            {failing > 0 && (
                              <Span $color="critical" $font={{ size: "s" }}>
                                {failing} failing
                              </Span>
                            )}
                          </ClickableDiv>
                        );
                      })}
                  </Div>
                )}
                {snapshot.value?.errors.map((error) => (
                  <Span key={error.what} $color="warning" $font={{ size: "s" }}>
                    Could not read {error.what}: {error.forbidden ? "permission denied" : error.message}
                  </Span>
                ))}
              </Section>

              <Section title={`Needs attention (${problems.length})`}>
                {problems.length === 0 ? (
                  <Span $color="textMuted">{snapshot.value ? "No resource reports a failing or pending condition." : "…"}</Span>
                ) : (
                  <Div $flex={{ direction: "vertical", gap: "xs" }}>
                    {problems.slice(0, 50).map(({ kind, item, health, reason }) => (
                      <ClickableDiv
                        key={`${kind}/${item.metadata.namespace}/${item.metadata.name}`}
                        $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center" }}
                        $padding={{ vertical: "xxs" }}
                        $onClick={() => void actions.openRef(clusterId, { kind, name: item.metadata.name, namespace: item.metadata.namespace })}
                      >
                        <HealthBadge health={health} />
                        <Span $font={{ bold: true }}>
                          {kind} {item.metadata.namespace ? `${item.metadata.namespace}/` : ""}
                          {item.metadata.name}
                        </Span>
                        <Span $color="textMuted" $font={{ size: "s" }} className={styles.truncate}>
                          {reason}
                        </Span>
                      </ClickableDiv>
                    ))}
                  </Div>
                )}
              </Section>
            </Div>
          );
        }}
      </QueryView>
    </PageLayout>
  );
});

export const overviewPageInjectable = getInjectable2({
  id: "cilium-ui-page-overview",
  injectionToken: ciliumPageInjectionToken,
  instantiate: () => () => ({
    id: "overview",
    section: "root" as const,
    title: "Overview",
    orderNumber: 10,
    Component: OverviewPage,
  }),
});
