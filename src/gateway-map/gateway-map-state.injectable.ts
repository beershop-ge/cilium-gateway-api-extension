import { navigateToKubeResourceDetailsInjectionToken } from "@k8slens/details-panel-contracts";
import { getInjectable2 } from "@k8slens/injectable";
import { isNavigationSupersededError } from "@k8slens/navigation-contracts";
import { showErrorNotificationInjectionToken } from "@k8slens/notifications-contracts";
import { action, observable } from "mobx";
import { kindsByName } from "./kinds";
import type { ResourceRef } from "./topology";

export interface GatewayMapState {
  readonly selectedId: () => string | undefined;
  readonly select: (id: string | undefined) => void;
  readonly search: () => string;
  readonly setSearch: (search: string) => void;
}

/** What the user picked and searched for on the map of one cluster, kept while Lens runs. */
export const gatewayMapStateInjectable = getInjectable2({
  id: "cilium-ui-gateway-map-state",

  instantiate: () => {
    const states = new Map<string, GatewayMapState>();

    return () => (clusterId: string): GatewayMapState => {
      const existing = states.get(clusterId);

      if (existing) {
        return existing;
      }

      const selectedId = observable.box<string | undefined>(undefined);
      const search = observable.box("");

      const state: GatewayMapState = {
        selectedId: () => selectedId.get(),
        select: action((id) => selectedId.set(id === selectedId.get() ? undefined : id)),
        search: () => search.get(),
        setSearch: action((value) => search.set(value)),
      };

      states.set(clusterId, state);

      return state;
    };
  },
});

/** Shows one of the map's resources in Lens's own details panel. */
export const openGatewayResourceInjectable = getInjectable2({
  id: "cilium-ui-open-gateway-resource",
  consumptions: [navigateToKubeResourceDetailsInjectionToken, showErrorNotificationInjectionToken],

  instantiate: (di) => {
    const navigateToKubeResourceDetails = di.inject(navigateToKubeResourceDetailsInjectionToken)();
    const showErrorNotification = di.inject(showErrorNotificationInjectionToken)();

    return () => async (clusterId: string, ref: ResourceRef) => {
      try {
        await navigateToKubeResourceDetails({
          clusterId,
          ...kindsByName[ref.kind],
          ref: ref.namespace ? { name: ref.name, namespace: ref.namespace } : { name: ref.name },
        });
      } catch (error) {
        if (!isNavigationSupersededError(error)) {
          showErrorNotification(error as Error);
        }
      }
    };
  },
});
