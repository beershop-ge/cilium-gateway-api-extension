import { getInjectionToken2 } from "@k8slens/injectable";
import type { ComponentType } from "react";
import type { ResourceType, SectionId } from "../kube/resource-types";

export interface PageProps {
  readonly clusterId: string;
  readonly pageId: string;
  /** Identifies the tab, for state that should survive switching tabs. */
  readonly tabKey: string;
}

/** A page of the Cilium section. Modules contribute pages by binding to the token from a `*.injectable.ts(x)` file. */
export interface CiliumPage {
  readonly id: string;
  /** `root` places the page directly under "Cilium", beside the sections. */
  readonly section: SectionId | "root";
  readonly title: string;
  readonly orderNumber: number;
  readonly Component: ComponentType<PageProps>;
  readonly description?: string;
}

export const ciliumPageInjectionToken = getInjectionToken2<{ singleFactory: () => CiliumPage }>({
  id: "cilium-ui-page",
  cardinality: "zero-or-many",
})();

export interface Section {
  readonly id: SectionId;
  readonly title: string;
  readonly orderNumber: number;
}

export const sections: readonly Section[] = [
  { id: "gateway", title: "Gateway API", orderNumber: 30 },
  { id: "security", title: "Network Security", orderNumber: 40 },
  { id: "bgp", title: "BGP & Routing", orderNumber: 50 },
  { id: "lb", title: "Load Balancing & IPAM", orderNumber: 60 },
  { id: "networking", title: "Networking", orderNumber: 70 },
  { id: "observability", title: "Observability", orderNumber: 80 },
  { id: "config", title: "Configuration", orderNumber: 90 },
  { id: "other", title: "Other Cilium Resources", orderNumber: 95 },
];

export const resourcePageId = (type: Pick<ResourceType, "id">) => `res:${type.id}`;

export const typeIdOfPage = (pageId: string) => (pageId.startsWith("res:") ? pageId.slice(4) : undefined);

const separator = "::";

export const tabIdOf = (clusterId: string, pageId: string) => `${clusterId}${separator}${pageId}`;

export const parseTabId = (tabId: string) => {
  const index = tabId.indexOf(separator);

  return index < 0 ? { clusterId: tabId, pageId: "overview" } : { clusterId: tabId.slice(0, index), pageId: tabId.slice(index + separator.length) };
};

/** Where a page sits in the navigator, for static pages and discovered resource types alike. */
export interface NavigatorPage {
  readonly id: string;
  readonly name: string;
  readonly orderNumber: number;
}

export const pagesOfSection = (sectionId: SectionId, staticPages: readonly CiliumPage[], types: readonly ResourceType[]): NavigatorPage[] => [
  ...staticPages.filter((page) => page.section === sectionId).map((page) => ({ id: page.id, name: page.title, orderNumber: page.orderNumber })),
  ...types
    .filter((type) => type.section === sectionId)
    .map((type) => ({ id: resourcePageId(type), name: type.title, orderNumber: 100 + type.order })),
];
