import { clusterNavigatorItemKind } from "@k8slens/cluster-contracts";
import { DashboardIcon, FolderIcon, LayersIcon, NetworkIcon } from "@k8slens/icon";
import { NavigatorBranchIndicator, NavigatorItemIcon, NavigatorItemLabel, NavigatorLeafIndicator } from "@k8slens/navigator-components";
import {
  getNavigatorItemKind,
  getNavigatorItemKindInjectableBunch2,
  type NavigatorItemProps,
  noNavigatorItemActivation,
  useItemHasChildren,
  useItemIsOpen,
} from "@k8slens/navigator-contracts";
import { computed } from "mobx";
import { clusterContextInjectable } from "../kube/cluster-context.injectable";
import type { SectionId } from "../kube/resource-types";
import { ciliumPagesInjectable, openCiliumPageInjectable } from "./open-page.injectable";
import { type NavigatorPage, pagesOfSection, sections } from "./pages";

interface CiliumRootItem {
  readonly id: string;
  readonly name: string;
  readonly orderNumber: number;
}

interface SectionItem {
  readonly id: SectionId;
  readonly name: string;
  readonly orderNumber: number;
}

export const ciliumRootKind = getNavigatorItemKind<CiliumRootItem, [clusterId: string]>()("cilium-root");
export const ciliumTopPageKind = getNavigatorItemKind<NavigatorPage, [clusterId: string, rootId: string]>()("cilium-top-page");
export const ciliumSectionKind = getNavigatorItemKind<SectionItem, [clusterId: string, rootId: string]>()("cilium-section");
export const ciliumPageKind = getNavigatorItemKind<NavigatorPage, [clusterId: string, rootId: string, sectionId: string]>()("cilium-page");

const RootRow = ({ kind, ids, item }: NavigatorItemProps<CiliumRootItem, typeof clusterNavigatorItemKind>) => {
  const isOpen = useItemIsOpen(kind, ...ids);
  const hasChildren = useItemHasChildren(kind, ...ids);

  return (
    <>
      {hasChildren ? <NavigatorBranchIndicator isOpen={isOpen} /> : <NavigatorLeafIndicator />}
      <NavigatorItemIcon>
        <NetworkIcon />
      </NavigatorItemIcon>
      <NavigatorItemLabel>{item.name}</NavigatorItemLabel>
    </>
  );
};

const TopPageRow = ({ item }: NavigatorItemProps<NavigatorPage, typeof ciliumRootKind>) => (
  <>
    <NavigatorLeafIndicator />
    <NavigatorItemIcon>{item.id === "overview" ? <DashboardIcon /> : <LayersIcon />}</NavigatorItemIcon>
    <NavigatorItemLabel>{item.name}</NavigatorItemLabel>
  </>
);

const SectionRow = ({ kind, ids, item }: NavigatorItemProps<SectionItem, typeof ciliumRootKind>) => {
  const isOpen = useItemIsOpen(kind, ...ids);

  return (
    <>
      <NavigatorBranchIndicator isOpen={isOpen} />
      <NavigatorItemIcon>
        <FolderIcon />
      </NavigatorItemIcon>
      <NavigatorItemLabel>{item.name}</NavigatorItemLabel>
    </>
  );
};

const PageRow = ({ item }: NavigatorItemProps<NavigatorPage, typeof ciliumSectionKind>) => (
  <>
    <NavigatorLeafIndicator />
    <NavigatorItemLabel>{item.name}</NavigatorItemLabel>
  </>
);

export const ciliumRootBunch = getNavigatorItemKindInjectableBunch2({
  kind: ciliumRootKind,
  parentKind: clusterNavigatorItemKind,
  description: "The Cilium section of a cluster: networking, Gateway API, policies, BGP, IPAM and observability.",

  items: {
    instantiate: () => async () => computed((): CiliumRootItem[] => [{ id: "cilium", name: "Cilium", orderNumber: 75 }]),
  },

  activate: noNavigatorItemActivation,
  Component: RootRow,
});

export const ciliumTopPageBunch = getNavigatorItemKindInjectableBunch2({
  kind: ciliumTopPageKind,
  parentKind: ciliumRootKind,
  description: "The overview and the network topology of a cluster's Cilium.",

  items: {
    instantiate: (di) => {
      const pages = di.inject(ciliumPagesInjectable)();

      return async () =>
        computed((): NavigatorPage[] =>
          pages.filter((page) => page.section === "root").map((page) => ({ id: page.id, name: page.title, orderNumber: page.orderNumber })),
        );
    },
  },

  activate: {
    instantiate: (di) => {
      const openPage = di.inject(openCiliumPageInjectable)();

      return async (clusterId, _rootId, pageId) => {
        await openPage(clusterId, pageId);
      };
    },
  },

  Component: TopPageRow,
});

export const ciliumSectionBunch = getNavigatorItemKindInjectableBunch2({
  kind: ciliumSectionKind,
  parentKind: ciliumRootKind,
  description: "A group of Cilium pages, such as Gateway API or Network Security.",

  items: {
    instantiate: (di) => {
      const contextOf = di.inject(clusterContextInjectable)();
      const pages = di.inject(ciliumPagesInjectable)();

      return async (clusterId) => {
        const context = contextOf(clusterId);

        context.discovery.ensure();

        return computed((): SectionItem[] =>
          sections
            .filter((section) => pagesOfSection(section.id, pages, context.discovery.state().value?.types ?? []).length > 0)
            .map((section) => ({ id: section.id, name: section.title, orderNumber: section.orderNumber })),
        );
      };
    },
  },

  activate: noNavigatorItemActivation,
  Component: SectionRow,
});

export const ciliumPageBunch = getNavigatorItemKindInjectableBunch2({
  kind: ciliumPageKind,
  parentKind: ciliumSectionKind,
  description: "A page of the Cilium section: a resource list or a visual tool.",

  items: {
    instantiate: (di) => {
      const contextOf = di.inject(clusterContextInjectable)();
      const pages = di.inject(ciliumPagesInjectable)();

      return async (clusterId, _rootId, sectionId) => {
        const context = contextOf(clusterId);

        context.discovery.ensure();

        return computed(() => pagesOfSection(sectionId as SectionId, pages, context.discovery.state().value?.types ?? []));
      };
    },
  },

  activate: {
    instantiate: (di) => {
      const openPage = di.inject(openCiliumPageInjectable)();

      return async (clusterId, _rootId, _sectionId, pageId) => {
        await openPage(clusterId, pageId);
      };
    },
  },

  Component: PageRow,
});
