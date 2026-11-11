import { getInjectable2 } from "@k8slens/injectable";
import { action, observable } from "mobx";

export interface GatewayMapState {
  readonly selectedId: () => string | undefined;
  /** Selects a node, or clears the selection when it is selected already. */
  readonly select: (id: string | undefined) => void;
  /** Selects a node without toggling, for opening the map on one resource. */
  readonly focus: (id: string) => void;
  readonly search: () => string;
  readonly setSearch: (search: string) => void;
}

/** The id of a resource's node on the map, for focusing it from elsewhere. */
export const mapNodeIdOf = (kind: string, name: string, namespace?: string): string | undefined => {
  const key = namespace ? `${namespace}/${name}` : name;

  if (kind === "GatewayClass") return `class:${name}`;
  if (kind === "Gateway") return `gateway:${key}`;
  if (["HTTPRoute", "GRPCRoute", "TLSRoute", "TCPRoute", "UDPRoute"].includes(kind)) return `route:${kind}:${key}`;

  return undefined;
};

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
        focus: action((id) => {
          selectedId.set(id);
          search.set("");
        }),
        search: () => search.get(),
        setSearch: action((value) => search.set(value)),
      };

      states.set(clusterId, state);

      return state;
    };
  },
});
