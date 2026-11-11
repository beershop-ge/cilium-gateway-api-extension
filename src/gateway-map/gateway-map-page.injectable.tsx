import { getInjectable2 } from "@k8slens/injectable";
import { ciliumPageInjectionToken, type PageProps } from "../navigation/pages";
import { GatewayMap } from "./gateway-map";

const GatewayMapPage = ({ clusterId }: PageProps) => <GatewayMap clusterId={clusterId} />;

export const gatewayMapPageInjectable = getInjectable2({
  id: "cilium-ui-page-gateway-map",
  injectionToken: ciliumPageInjectionToken,
  instantiate: () => () => ({
    id: "gateway-map",
    section: "gateway" as const,
    title: "Gateway Map",
    orderNumber: 6,
    Component: GatewayMapPage,
    description: "Gateway → Listener → Route → Backend, with health.",
  }),
});
