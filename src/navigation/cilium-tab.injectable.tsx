import { clusterNameReactiveInjectionToken } from "@k8slens/cluster-contracts";
import { Div, Span } from "@k8slens/element-components";
import { NetworkIcon } from "@k8slens/icon";
import { mainViewTabHostKind } from "@k8slens/main-view-contracts";
import { getTabKindInjectableBunch, type TabProps } from "@k8slens/tab-contracts";
import { useInject, useSyncInject } from "@k8slens/use-inject";
import { observer } from "mobx-react";
import { Suspense, use } from "react";
import { clusterContextInjectable } from "../kube/cluster-context.injectable";
import { ResourceListPage } from "../resources/resource-list-page";
import { EmptyState, ErrorBoundary, ErrorState, Loading, useQueryState } from "../ui/components";
import { ciliumPagesInjectable, ciliumTabKind } from "./open-page.injectable";
import { parseTabId, typeIdOfPage } from "./pages";

const ClusterName = observer(({ clusterId }: { clusterId: string }) => {
  const clusterName = use(useSyncInject(clusterNameReactiveInjectionToken, clusterId));

  return <>{clusterName.get()}</>;
});

const PageTitle = observer(({ clusterId, pageId }: { clusterId: string; pageId: string }) => {
  const pages = useInject(ciliumPagesInjectable)();
  const context = useInject(clusterContextInjectable)()(clusterId);
  const typeId = typeIdOfPage(pageId);
  const title = typeId ? (context.typeById(typeId)?.title ?? typeId.split(".")[0]) : (pages.find((page) => page.id === pageId)?.title ?? pageId);

  return <>{title}</>;
});

const CiliumTabTitle = ({ tabId }: TabProps<typeof mainViewTabHostKind>) => {
  const { clusterId, pageId } = parseTabId(tabId);

  return (
    <Div $flex={{ direction: "horizontal", gap: "xs", verticalAlign: "center" }}>
      <NetworkIcon $size="s" />
      <Span>
        <PageTitle clusterId={clusterId} pageId={pageId} /> ·{" "}
        <Suspense fallback="…">
          <ClusterName clusterId={clusterId} />
        </Suspense>
      </Span>
    </Div>
  );
};

const PageContent = observer(({ clusterId, pageId, tabKey }: { clusterId: string; pageId: string; tabKey: string }) => {
  const pages = useInject(ciliumPagesInjectable)();
  const context = useInject(clusterContextInjectable)()(clusterId);
  const discovery = useQueryState(context.discovery);
  const typeId = typeIdOfPage(pageId);

  if (typeId) {
    if (discovery.value === undefined) {
      return discovery.status === "error" ? (
        <ErrorState title="Could not discover Cilium resources" error={discovery.error} onRetry={() => void context.discovery.refresh()} />
      ) : (
        <Loading text="Discovering Cilium and Gateway API resources…" />
      );
    }

    const type = context.typeById(typeId);

    return type ? (
      <ResourceListPage clusterId={clusterId} type={type} tabKey={tabKey} />
    ) : (
      <EmptyState title="Not installed on this cluster" text={`The cluster does not serve ${typeId}. Install its CRD, or pick another page.`} />
    );
  }

  const page = pages.find((candidate) => candidate.id === pageId);

  if (!page) {
    return <EmptyState title="Unknown page" text={pageId} />;
  }

  return <page.Component clusterId={clusterId} pageId={pageId} tabKey={tabKey} />;
});

const CiliumTab = ({ tabId }: TabProps<typeof mainViewTabHostKind>) => {
  const { clusterId, pageId } = parseTabId(tabId);

  return (
    <Div $height="full" $flex={{ direction: "vertical" }} $backgroundColor="backgroundSecondary">
      <ErrorBoundary key={tabId}>
        <PageContent clusterId={clusterId} pageId={pageId} tabKey={tabId} />
      </ErrorBoundary>
    </Div>
  );
};

export default getTabKindInjectableBunch({
  tabHostKind: mainViewTabHostKind,
  kind: ciliumTabKind,
  Component: CiliumTab,
  Title: CiliumTabTitle,
});
