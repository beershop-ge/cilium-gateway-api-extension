import { Badge } from "@k8slens/badge";
import { Div, Span } from "@k8slens/element-components";
import { TextInput } from "@k8slens/input-components";
import { getInjectable2 } from "@k8slens/injectable";
import { useInject } from "@k8slens/use-inject";
import { observer } from "mobx-react";
import { age } from "../common/format";
import type { CrdSummary } from "../kube/operations";
import { openCiliumPageInjectable } from "../navigation/open-page.injectable";
import { ciliumPageInjectionToken, type PageProps, resourcePageId } from "../navigation/pages";
import { useViewState } from "../navigation/view-state.injectable";
import { Callout, QueryView, UpdatedAt } from "../ui/components";
import { DataTable } from "../ui/data-table";
import { PageLayout } from "../ui/page-layout";
import { useClusterContext, useDiscovery } from "../ui/use-cluster";

const InstalledCrdsPage = observer(({ clusterId, tabKey }: PageProps) => {
  const context = useClusterContext(clusterId);
  const discovery = useDiscovery(clusterId);
  const openPage = useInject(openCiliumPageInjectable)();
  const [search, setSearch] = useViewState(tabKey, "search", "");

  return (
    <PageLayout
      clusterId={clusterId}
      title="Installed CRDs"
      subtitle="Every Cilium and Gateway API CustomResourceDefinition on this cluster, with its versions"
      actions={<UpdatedAt state={discovery} onRefresh={() => void context.discovery.refresh()} />}
      toolbar={
        <Div $width={{ width: "11xl" }}>
          <TextInput type="search" aria-label="Search CRDs" placeholder="Search by name, group or kind" value={search} onChange={(event) => setSearch(event.target.value)} />
        </Div>
      }
    >
      <QueryView state={discovery} onRetry={() => void context.discovery.refresh()} loadingText="Discovering CRDs…">
        {(value) => (
          <Div $flex={{ direction: "vertical", gap: "m" }} $padding={{ horizontal: "l", bottom: "l" }}>
            {value.warnings.map((warning) => (
              <Callout key={warning} level="warning">
                {warning}
              </Callout>
            ))}
            {value.source === "api-resources" && (
              <Callout level="info">CRD details (stored versions, conditions, bundle versions) need permission to list CustomResourceDefinitions. The types below come from API discovery.</Callout>
            )}
            <DataTable<CrdSummary>
              ariaLabel="Installed CRDs"
              rows={value.crds.filter((crd) => `${crd.name} ${crd.kind}`.toLowerCase().includes(search.toLowerCase()))}
              rowKey={(crd) => crd.name}
              initialSort={{ column: "name" }}
              onRowClick={(crd) => {
                const type = value.types.find((candidate) => candidate.id === crd.name);

                if (type) void openPage(clusterId, resourcePageId(type));
              }}
              columns={[
                { id: "name", header: "Name", render: (crd) => <Span $font={{ bold: true }}>{crd.name}</Span>, sortValue: (crd) => crd.name },
                { id: "kind", header: "Kind", render: (crd) => crd.kind, sortValue: (crd) => crd.kind },
                { id: "scope", header: "Scope", render: (crd) => crd.scope, sortValue: (crd) => crd.scope },
                {
                  id: "versions",
                  header: "Versions",
                  render: (crd) => (
                    <Div $flex={{ direction: "horizontal", gap: "xxs", wrap: true }}>
                      {crd.versions.map((version) => (
                        <Badge
                          key={version.name}
                          small
                          label={`${version.name}${version.storage ? " ★" : ""}`}
                          $backgroundColor={!version.served ? "grey40" : version.deprecated ? "warning" : undefined}
                          $tooltip={`${version.served ? "served" : "not served"}${version.storage ? ", storage version" : ""}${version.deprecated ? ", deprecated" : ""}`}
                        />
                      ))}
                    </Div>
                  ),
                },
                { id: "stored", header: "Stored versions", render: (crd) => crd.storedVersions.join(", ") },
                {
                  id: "bundle",
                  header: "Gateway API bundle",
                  render: (crd) => (crd.bundleVersion ? `${crd.bundleVersion}${crd.channel ? ` (${crd.channel})` : ""}` : ""),
                  sortValue: (crd) => crd.bundleVersion ?? "",
                },
                { id: "established", header: "Established", render: (crd) => (crd.established ? "Yes" : <Span $color="critical">No</Span>) },
                { id: "age", header: "Age", render: (crd) => age(crd.createdAt), sortValue: (crd) => -new Date(crd.createdAt ?? 0).getTime() },
              ]}
            />
          </Div>
        )}
      </QueryView>
    </PageLayout>
  );
});

export const installedCrdsPageInjectable = getInjectable2({
  id: "cilium-ui-page-installed-crds",
  injectionToken: ciliumPageInjectionToken,
  instantiate: () => () => ({
    id: "installed-crds",
    section: "config" as const,
    title: "Installed CRDs",
    orderNumber: 10,
    Component: InstalledCrdsPage,
  }),
});
