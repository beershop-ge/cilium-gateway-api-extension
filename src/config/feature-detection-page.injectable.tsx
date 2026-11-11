import { Badge } from "@k8slens/badge";
import { Div, Span } from "@k8slens/element-components";
import { getInjectable2 } from "@k8slens/injectable";
import { observer } from "mobx-react";
import { type Feature, detectFeatures, type FeatureState } from "../kube/cilium-info";
import { knownKinds } from "../kube/resource-types";
import { ciliumPageInjectionToken, type PageProps } from "../navigation/pages";
import { Callout, Facts, QueryView, Section, UpdatedAt } from "../ui/components";
import { DataTable } from "../ui/data-table";
import { PageLayout } from "../ui/page-layout";
import { useCiliumInfo, useClusterContext, useDiscovery } from "../ui/use-cluster";

const stateBadge: Record<FeatureState, { label: string; color: "success" | "grey40" | "warning" }> = {
  enabled: { label: "Enabled", color: "success" },
  disabled: { label: "Disabled", color: "grey40" },
  unknown: { label: "Unknown", color: "warning" },
};

const FeatureDetectionPage = observer(({ clusterId }: PageProps) => {
  const context = useClusterContext(clusterId);
  const discovery = useDiscovery(clusterId);
  const { state: info, refresh } = useCiliumInfo(clusterId);

  return (
    <PageLayout
      clusterId={clusterId}
      title="Feature Detection"
      subtitle="What this cluster's Cilium has enabled, from the agent configuration and the installed CRDs"
      actions={
        <UpdatedAt
          state={info}
          onRefresh={() => {
            void refresh();
            void context.discovery.refresh();
          }}
        />
      }
    >
      <QueryView state={info} onRetry={() => void refresh()} loadingText="Reading Cilium's configuration…">
        {(ciliumInfo) => {
          const types = discovery.value?.types ?? [];
          const features = detectFeatures(ciliumInfo, types);
          const installedKinds = new Set(types.map((type) => type.kind));

          return (
            <Div $flex={{ direction: "vertical", gap: "l" }} $padding={{ horizontal: "l", bottom: "l" }}>
              {!ciliumInfo.namespace && (
                <Callout level="warning" title="No Cilium agent found">
                  {ciliumInfo.podsError ?? "No pods labelled k8s-app=cilium were found. If Cilium runs under other labels or in a namespace you cannot list, set its namespace in Extension Settings."}
                </Callout>
              )}
              {ciliumInfo.configError && <Callout level="warning" title="The agent configuration (cilium-config) could not be read">{ciliumInfo.configError}</Callout>}

              <Facts
                rows={[
                  ["Cilium version", ciliumInfo.version ?? "unknown"],
                  ["Namespace", ciliumInfo.namespace ?? "—"],
                  ["Agents", `${ciliumInfo.agents.filter((agent) => agent.ready).length} of ${ciliumInfo.agents.length} ready`],
                  ["Operators", `${ciliumInfo.operators.filter((pod) => pod.ready).length} of ${ciliumInfo.operators.length} ready`],
                  ["Hubble Relay", ciliumInfo.relays.length ? `${ciliumInfo.relays.filter((pod) => pod.ready).length} of ${ciliumInfo.relays.length} ready` : "not deployed"],
                  ["Envoy DaemonSet", ciliumInfo.envoys.length ? `${ciliumInfo.envoys.length} pods` : "not deployed (embedded in the agent, or absent)"],
                ]}
              />

              <Section title="Features">
                <DataTable<Feature>
                  ariaLabel="Features"
                  rows={features}
                  rowKey={(feature) => feature.id}
                  columns={[
                    { id: "label", header: "Feature", render: (feature) => <Span $font={{ bold: true }}>{feature.label}</Span>, sortValue: (feature) => feature.label },
                    {
                      id: "state",
                      header: "State",
                      render: (feature) => <Badge small label={stateBadge[feature.state].label} $backgroundColor={stateBadge[feature.state].color} $color="white" />,
                      sortValue: (feature) => feature.state,
                    },
                    { id: "detail", header: "From", render: (feature) => <Span $font={{ size: "s" }}>{feature.detail}</Span> },
                    {
                      id: "missing",
                      header: "Missing CRDs",
                      render: (feature) => (feature.missingTypes.length ? <Span $color="warning">{feature.missingTypes.join(", ")}</Span> : ""),
                    },
                  ]}
                />
              </Section>

              <Section title="Resource types">
                <DataTable
                  ariaLabel="Resource types"
                  rows={knownKinds.filter((known) => known.kind !== "XListenerSet")}
                  rowKey={(known) => known.kind}
                  initialSort={{ column: "installed" }}
                  columns={[
                    { id: "kind", header: "Kind", render: (known) => known.kind, sortValue: (known) => known.kind },
                    { id: "section", header: "Section", render: (known) => known.section, sortValue: (known) => known.section },
                    {
                      id: "installed",
                      header: "Installed",
                      render: (known) =>
                        installedKinds.has(known.kind) ? (
                          <Badge small label={`Yes · ${types.find((type) => type.kind === known.kind)?.preferredVersion}`} $backgroundColor="success" $color="white" />
                        ) : (
                          <Badge small label="Not installed" $backgroundColor="grey40" $color="white" />
                        ),
                      sortValue: (known) => (installedKinds.has(known.kind) ? 0 : 1),
                    },
                    { id: "description", header: "What it is", render: (known) => <Span $font={{ size: "s" }} $color="textMuted">{known.description}</Span> },
                  ]}
                />
                {types.some((type) => type.section === "other") && (
                  <Span $color="textMuted" $font={{ size: "s" }}>
                    Also installed, under "Other Cilium Resources": {types.filter((type) => type.section === "other").map((type) => type.kind).join(", ")}
                  </Span>
                )}
              </Section>
            </Div>
          );
        }}
      </QueryView>
    </PageLayout>
  );
});

export const featureDetectionPageInjectable = getInjectable2({
  id: "cilium-ui-page-feature-detection",
  injectionToken: ciliumPageInjectionToken,
  instantiate: () => () => ({
    id: "features",
    section: "config" as const,
    title: "Feature Detection",
    orderNumber: 20,
    Component: FeatureDetectionPage,
  }),
});
