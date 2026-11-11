import { clusterGroupNavigatorItemKind } from "@k8slens/cluster-contracts";
import { NetworkIcon } from "@k8slens/icon";
import { NavigatorItemIcon, NavigatorItemLabel, NavigatorLeafIndicator } from "@k8slens/navigator-components";
import { getNavigatorItemKind, getNavigatorItemKindInjectableBunch2, type NavigatorItemProps } from "@k8slens/navigator-contracts";
import { computed } from "mobx";
import { showGatewayMapInjectable } from "./gateway-map-tab.injectable";

interface GatewayMapItem {
  readonly id: string;
  readonly name: string;
  readonly orderNumber: number;
}

export const gatewayMapNavigatorItemKind = getNavigatorItemKind<GatewayMapItem, [clusterId: string, groupId: string]>()("gateway-map");

const GatewayMapRow = ({ item }: NavigatorItemProps<GatewayMapItem, typeof clusterGroupNavigatorItemKind>) => (
  <>
    <NavigatorLeafIndicator />
    <NavigatorItemIcon>
      <NetworkIcon />
    </NavigatorItemIcon>
    <NavigatorItemLabel>{item.name}</NavigatorItemLabel>
  </>
);

export default getNavigatorItemKindInjectableBunch2({
  kind: gatewayMapNavigatorItemKind,
  parentKind: clusterGroupNavigatorItemKind,
  description: "The map of a cluster's Cilium Gateway API resources, under its Network group.",

  items: {
    instantiate: () => async (_clusterId, groupId) =>
      computed((): GatewayMapItem[] => (groupId === "network" ? [{ id: "gateway-map", name: "Gateway API Map", orderNumber: 1000 }] : [])),
  },

  activate: {
    instantiate: (di) => {
      const showGatewayMap = di.inject(showGatewayMapInjectable)();

      return async (clusterId) => {
        await showGatewayMap(clusterId);
      };
    },
  },

  Component: GatewayMapRow,
});
