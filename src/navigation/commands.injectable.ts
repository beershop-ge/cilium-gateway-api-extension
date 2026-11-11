import { getCommandInjectableBunch } from "@k8slens/command-palette-contracts";
import { activeTabClusterIdInjectionToken } from "@k8slens/main-view-contracts";
import { notifyInjectable } from "../ui/notify.injectable";
import { openCiliumPageInjectable } from "./open-page.injectable";

const openPageCommand = (pageId: string, title: string) =>
  getCommandInjectableBunch({
    id: `cilium-ui.command.open-${pageId}`,
    title: `Cilium: ${title}`,
    action: {
      consumptions: [activeTabClusterIdInjectionToken],
      instantiate: (di) => {
        const activeTabClusterId = di.inject(activeTabClusterIdInjectionToken)();
        const openPage = di.inject(openCiliumPageInjectable)();
        const notify = di.inject(notifyInjectable)();

        return () => async () => {
          const clusterId = await activeTabClusterId();

          if (!clusterId) {
            notify.info("Open a view of a cluster first: the Cilium pages open for the cluster in front.");

            return;
          }

          await openPage(clusterId, pageId);
        };
      },
    },
  });

export const openOverviewCommand = openPageCommand("overview", "Open overview of this cluster");
export const openTopologyCommand = openPageCommand("topology", "Open network topology of this cluster");
export const openGatewayDesignerCommand = openPageCommand("gateway-designer", "Open Gateway designer for this cluster");
export const openPolicyBuilderCommand = openPageCommand("policy-builder", "Open network policy builder for this cluster");
export const openHubbleFlowsCommand = openPageCommand("hubble-flows", "Open Hubble flows of this cluster");
