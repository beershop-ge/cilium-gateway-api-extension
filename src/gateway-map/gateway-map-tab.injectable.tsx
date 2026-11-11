import { clusterNameReactiveInjectionToken } from "@k8slens/cluster-contracts";
import { Div, Span } from "@k8slens/element-components";
import { NetworkIcon } from "@k8slens/icon";
import { getInjectable2 } from "@k8slens/injectable";
import { mainViewTabHostKind } from "@k8slens/main-view-contracts";
import {
  focusTabInjectionToken,
  getTabKind,
  getTabKindInjectableBunch,
  openTabInjectionToken,
  tabIsOpenInjectionToken,
  type TabProps,
} from "@k8slens/tab-contracts";
import { useSyncInject } from "@k8slens/use-inject";
import { observer } from "mobx-react";
import { Suspense, use } from "react";
import { GatewayMap } from "./gateway-map";

// One tab per cluster, opened by the cluster's id, so it needs no input of its own.
export const gatewayMapTabKind = getTabKind()("gateway-map");

const ClusterName = observer(({ clusterId }: { clusterId: string }) => {
  const clusterName = use(useSyncInject(clusterNameReactiveInjectionToken, clusterId));

  return <>{clusterName.get()}</>;
});

const GatewayMapTitle = ({ tabId }: TabProps<typeof mainViewTabHostKind>) => (
  <Div $flex={{ direction: "horizontal", gap: "xs", verticalAlign: "center" }}>
    <NetworkIcon $size="s" />
    <Span>
      Gateway API ·{" "}
      <Suspense fallback="…">
        <ClusterName clusterId={tabId} />
      </Suspense>
    </Span>
  </Div>
);

const GatewayMapTab = ({ tabId }: TabProps<typeof mainViewTabHostKind>) => <GatewayMap clusterId={tabId} />;

export default getTabKindInjectableBunch({
  tabHostKind: mainViewTabHostKind,
  kind: gatewayMapTabKind,
  Component: GatewayMapTab,
  Title: GatewayMapTitle,
});

/** Shows the Gateway API map of a cluster, opening its tab the first time. */
export const showGatewayMapInjectable = getInjectable2({
  id: "cilium-ui-show-gateway-map",
  consumptions: [openTabInjectionToken, focusTabInjectionToken, tabIsOpenInjectionToken],

  instantiate: (di) => {
    const openTab = di.inject(openTabInjectionToken.for(mainViewTabHostKind).for(gatewayMapTabKind).for(di.scopeIds))();
    const focusTab = di.inject(focusTabInjectionToken.for(mainViewTabHostKind).for(gatewayMapTabKind).for(di.scopeIds))();
    const isOpen = di.inject(tabIsOpenInjectionToken.for(mainViewTabHostKind).for(gatewayMapTabKind).for(di.scopeIds))();

    return () => async (clusterId: string) => {
      if (await isOpen({ tabId: clusterId })) {
        await focusTab({ tabId: clusterId });
      } else {
        await openTab({ tabId: clusterId });
      }
    };
  },
});
