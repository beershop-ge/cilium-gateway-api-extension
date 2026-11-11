import { Badge } from "@k8slens/badge";
import { Div } from "@k8slens/element-components";
import { getInjectable2 } from "@k8slens/injectable";
import { observer } from "mobx-react";
import { ciliumPageInjectionToken, type PageProps } from "../navigation/pages";
import { Callout, QueryView, UpdatedAt } from "../ui/components";
import { PageLayout } from "../ui/page-layout";
import { useClusterContext, useDiscovery, useSnapshot } from "../ui/use-cluster";
import { gatewaySnapshotRequest } from "./data";
import { Designer } from "./designer";
import { bundleInfoOf } from "./features";

const GatewayDesignerPage = observer(({ clusterId, tabKey }: PageProps) => {
  const context = useClusterContext(clusterId);
  const discovery = useDiscovery(clusterId);
  const { state, refresh } = useSnapshot(clusterId, gatewaySnapshotRequest);
  const bundle = bundleInfoOf(discovery.value?.types ?? []);

  return (
    <PageLayout
      clusterId={clusterId}
      title="Gateway Designer"
      subtitle="Build GatewayClasses, Gateways, routes and ReferenceGrants visually, check their references, and apply them after a server dry run"
      actions={
        <>
          {bundle.version && <Badge small label={`Gateway API ${bundle.version}${bundle.channel ? ` (${bundle.channel})` : ""}`} $tooltip="From the bundle-version and channel annotations of the installed CRDs" />}
          <UpdatedAt
            state={state}
            onRefresh={() => {
              void context.discovery.refresh();
              void refresh();
            }}
          />
        </>
      }
    >
      <QueryView state={discovery} onRetry={() => void context.discovery.refresh()} loadingText="Discovering Gateway API types…">
        {(value) => (
          <QueryView state={state} onRetry={() => void refresh()} loadingText="Reading Gateway API resources…">
            {(snapshot) => (
              <Div $flex={{ direction: "vertical", gap: "m" }}>
                {bundle.mixed.length > 0 && (
                  <Div $padding={{ horizontal: "l" }}>
                    <Callout level="warning" title="Mixed Gateway API bundle versions">
                      The installed CRDs come from different bundles ({bundle.mixed.join(", ")}). Finish the upgrade so every CRD has the same version.
                    </Callout>
                  </Div>
                )}
                <Designer clusterId={clusterId} tabKey={tabKey} types={value.types} snapshot={snapshot} />
              </Div>
            )}
          </QueryView>
        )}
      </QueryView>
    </PageLayout>
  );
});

export const gatewayDesignerPageInjectable = getInjectable2({
  id: "cilium-ui-page-gateway-designer",
  injectionToken: ciliumPageInjectionToken,
  instantiate: () => () => ({
    id: "gateway-designer",
    section: "gateway" as const,
    title: "Gateway Designer",
    orderNumber: 5,
    Component: GatewayDesignerPage,
    description: "Visual builders for the Gateway API with reference checks and status.",
  }),
});
