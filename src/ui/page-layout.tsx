import { Badge } from "@k8slens/badge";
import { clusterNameReactiveInjectionToken } from "@k8slens/cluster-contracts";
import { Div, Span } from "@k8slens/element-components";
import { useInject, useSyncInject } from "@k8slens/use-inject";
import { observer } from "mobx-react";
import { type ReactNode, Suspense, use } from "react";
import { settingsStoreInjectable } from "../settings/settings.injectable";
import { ErrorBoundary } from "./components";
import styles from "./ui.module.scss";

const ClusterBadge = observer(({ clusterId }: { clusterId: string }) => {
  const name = use(useSyncInject(clusterNameReactiveInjectionToken, clusterId));

  return <Badge small label={`Cluster: ${name.get()}`} $tooltip="Every read and change on this page goes to this cluster only" />;
});

export const ReadOnlyBadge = observer(({ clusterId }: { clusterId: string }) => {
  const settings = useInject(settingsStoreInjectable)();

  return settings.isReadOnly(clusterId) ? (
    <Badge small label="Read-only" $backgroundColor="notice" $color="white" $tooltip="Changes are turned off for this cluster in the extension settings" />
  ) : null;
});

export interface PageLayoutProps {
  readonly clusterId: string;
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly actions?: ReactNode;
  readonly toolbar?: ReactNode;
  readonly children: ReactNode;
  /** A panel on the right, such as a resource's details. */
  readonly drawer?: ReactNode;
  /** Whether the content scrolls inside the page (the default) or manages its own scrolling. */
  readonly scroll?: boolean;
}

export const PageLayout = ({ clusterId, title, subtitle, actions, toolbar, children, drawer, scroll = true }: PageLayoutProps) => (
  <Div className={styles.page} $flex={{ direction: "vertical" }}>
    <Div $flex={{ direction: "horizontal", gap: "m", verticalAlign: "center", wrap: true }} $padding={{ horizontal: "l", top: "m", bottom: "s" }}>
      <Div $flex={{ direction: "vertical", gap: "xxs" }} $flexChild>
        <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center", wrap: true }}>
          <Span $font={{ size: "xl", bold: true }} role="heading" aria-level={1}>
            {title}
          </Span>
          <Suspense fallback={null}>
            <ClusterBadge clusterId={clusterId} />
          </Suspense>
          <ReadOnlyBadge clusterId={clusterId} />
        </Div>
        {subtitle && <Span $color="textMuted">{subtitle}</Span>}
      </Div>
      {actions && <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center", wrap: true }}>{actions}</Div>}
    </Div>
    {toolbar && (
      <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center", wrap: true }} $padding={{ horizontal: "l", bottom: "s" }}>
        {toolbar}
      </Div>
    )}
    <Div $flex={{ direction: "horizontal" }} $flexChild className={styles.scroll} $style={{ minHeight: 0 }}>
      <Div $flexChild className={scroll ? styles.scroll : undefined} $style={{ minHeight: 0, minWidth: 0 }} $flex={scroll ? undefined : { direction: "vertical" }}>
        <ErrorBoundary>{children}</ErrorBoundary>
      </Div>
      {drawer}
    </Div>
  </Div>
);
