import { getInjectable2 } from "@k8slens/injectable";
import { mainViewTabHostKind } from "@k8slens/main-view-contracts";
import { focusTabInjectionToken, getTabKind, openTabInjectionToken, tabIsOpenInjectionToken } from "@k8slens/tab-contracts";
import { action } from "mobx";
import { ciliumPageInjectionToken, tabIdOf } from "./pages";
import { viewStateInjectable } from "./view-state.injectable";

// One tab per cluster and page, opened by an id that says both, so it needs no input of its own.
export const ciliumTabKind = getTabKind()("cilium-page");

export interface FocusTarget {
  readonly name: string;
  readonly namespace?: string;
  /** For pages that handle several kinds, such as the designers: which kind the name is of. */
  readonly kind?: string;
}

/** All pages modules contribute. */
export const ciliumPagesInjectable = getInjectable2({
  id: "cilium-ui-pages",
  consumptions: [ciliumPageInjectionToken],

  instantiate: (di) => {
    const pages = di.injectMany(ciliumPageInjectionToken);

    return () => pages();
  },
});

/** Opens a page of the Cilium section for a cluster, or brings it to the front, optionally selecting a resource in it. */
export const openCiliumPageInjectable = getInjectable2({
  id: "cilium-ui-open-page",
  consumptions: [openTabInjectionToken, focusTabInjectionToken, tabIsOpenInjectionToken],

  instantiate: (di) => {
    const openTab = di.inject(openTabInjectionToken.for(mainViewTabHostKind).for(ciliumTabKind).for(di.scopeIds))();
    const focusTab = di.inject(focusTabInjectionToken.for(mainViewTabHostKind).for(ciliumTabKind).for(di.scopeIds))();
    const isOpen = di.inject(tabIsOpenInjectionToken.for(mainViewTabHostKind).for(ciliumTabKind).for(di.scopeIds))();
    const viewState = di.inject(viewStateInjectable)();

    return () => async (clusterId: string, pageId: string, focus?: FocusTarget) => {
      const tabId = tabIdOf(clusterId, pageId);

      if (focus) {
        action(() => {
          const state = viewState(tabId);

          state.set("selected", `${focus.namespace ?? ""}/${focus.name}`);
          state.set("selectedKind", focus.kind);
          state.set("search", "");
        })();
      }

      if (await isOpen({ tabId })) {
        await focusTab({ tabId });
      } else {
        await openTab({ tabId });
      }
    };
  },
});
