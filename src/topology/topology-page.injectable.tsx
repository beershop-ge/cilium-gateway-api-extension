import { getInjectable2 } from "@k8slens/injectable";
import { observer } from "mobx-react";
import { ciliumPageInjectionToken, type PageProps } from "../navigation/pages";
import { QueryView, UpdatedAt } from "../ui/components";
import { PageLayout } from "../ui/page-layout";
import { useSnapshot } from "../ui/use-cluster";
import { topologyBuiltins, topologyKinds } from "./kinds";
import { TopologyBody } from "./topology-view";

const request = { kinds: topologyKinds, builtins: topologyBuiltins };

const TopologyPage = observer(({ clusterId, tabKey }: PageProps) => {
  const { state, refresh } = useSnapshot(clusterId, request);

  return (
    <PageLayout
      clusterId={clusterId}
      title="Network Topology"
      subtitle="How traffic reaches workloads, and which policies, identities, BGP, IP pools and Envoy configs apply, from the resources in the cluster"
      actions={<UpdatedAt state={state} onRefresh={() => void refresh()} />}
      scroll={false}
    >
      <QueryView state={state} onRetry={() => void refresh()} loadingText="Reading the cluster's network resources…">
        {(snapshot) => <TopologyBody clusterId={clusterId} tabKey={tabKey} snapshot={snapshot} />}
      </QueryView>
    </PageLayout>
  );
});

export const topologyPageInjectable = getInjectable2({
  id: "cilium-ui-page-topology",
  injectionToken: ciliumPageInjectionToken,
  instantiate: () => () => ({
    id: "topology",
    section: "root" as const,
    title: "Network Topology",
    orderNumber: 20,
    Component: TopologyPage,
    description: "Interactive graph of gateways, routes, services, endpoints, pods, nodes and the Cilium resources around them",
  }),
});
