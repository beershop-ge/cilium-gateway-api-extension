import { Div, Span } from "@k8slens/element-components";
import { getInjectable2 } from "@k8slens/injectable";
import { TextInput } from "@k8slens/input-components";
import { type LightWeightTab, LightWeightTabs } from "@k8slens/tabs-components";
import { observer } from "mobx-react";
import { redactObject } from "../common/redact";
import { toYaml } from "../common/yaml";
import { ciliumPageInjectionToken, type PageProps } from "../navigation/pages";
import { useViewState } from "../navigation/view-state.injectable";
import { Callout, ErrorState, Facts, Loading, QueryView, UpdatedAt, useQueryState } from "../ui/components";
import { CodeView } from "../ui/code-editor";
import { DataTable } from "../ui/data-table";
import { PageLayout } from "../ui/page-layout";
import { useCiliumInfo, useClusterContext } from "../ui/use-cluster";
import { loadCiliumHelmRelease } from "./helm";

type View = "config" | "helm";

const views: readonly LightWeightTab<View>[] = [
  { id: "config", label: "Agent configuration (cilium-config)" },
  { id: "helm", label: "Helm release values" },
];

const HelmValues = observer(({ clusterId, namespace }: { clusterId: string; namespace: string }) => {
  const context = useClusterContext(clusterId);
  const query = context.queries.get(`q:helm-release:${namespace}`, () => loadCiliumHelmRelease(context.kubectl, namespace));
  const state = useQueryState(query);

  if (state.value === undefined && state.status !== "ready") {
    return state.status === "error" ? (
      <ErrorState title="Could not read the Helm release" error={state.error} onRetry={() => void query.refresh()} />
    ) : (
      <Loading text="Reading the Helm release…" />
    );
  }

  const release = state.value;

  if (!release) {
    return <Callout level="info" title="No Helm release found">No Helm release named "cilium" in {namespace}. Cilium may have been installed by the cilium CLI, an operator or another tool; the agent configuration tab still shows its effective configuration.</Callout>;
  }

  return (
    <Div $flex={{ direction: "vertical", gap: "m" }}>
      <Facts
        rows={[
          ["Release", `${release.namespace}/${release.name}`],
          ["Revision", String(release.revision)],
          ["Status", release.status ?? "—"],
          ["Chart", release.chart ?? "—"],
          ["App version", release.appVersion ?? "—"],
          ["Deployed", release.updated ?? "—"],
        ]}
      />
      <Callout level="info">Only the values you supplied are shown (not the chart defaults), with anything secret-looking masked. Change them with Helm (or your GitOps tool), not here: the release would overwrite manual edits of its resources.</Callout>
      <CodeView value={Object.keys(release.userValues ?? {}).length ? toYaml(release.userValues) : "# no user-supplied values: the chart defaults apply\n"} />
    </Div>
  );
});

const HelmConfigPage = observer(({ clusterId, tabKey }: PageProps) => {
  const { state, refresh } = useCiliumInfo(clusterId);
  const [view, setView] = useViewState<View>(tabKey, "view", "config");
  const [search, setSearch] = useViewState(tabKey, "search", "");

  return (
    <PageLayout clusterId={clusterId} title="Helm Configuration" subtitle="Cilium's effective agent configuration and the values of its Helm release" actions={<UpdatedAt state={state} onRefresh={() => void refresh()} />}>
      <QueryView state={state} onRetry={() => void refresh()}>
        {(info) => (
          <Div $flex={{ direction: "vertical", gap: "m" }} $padding={{ horizontal: "l", bottom: "l" }}>
            {!info.namespace ? (
              <Callout level="warning" title="Cilium was not found">Set Cilium's namespace in Extension Settings if it runs somewhere the extension cannot find by its labels.</Callout>
            ) : (
              <>
                <LightWeightTabs tabs={views} selected={view} onSelect={(next) => next && setView(next)} />
                {view === "config" &&
                  (info.config ? (
                    <Div $flex={{ direction: "vertical", gap: "s" }}>
                      <Div $width={{ width: "11xl" }}>
                        <TextInput type="search" aria-label="Search configuration keys" placeholder="Search keys or values" value={search} onChange={(event) => setSearch(event.target.value)} />
                      </Div>
                      <DataTable
                        ariaLabel="cilium-config"
                        rows={Object.entries(redactObject(info.config) as Record<string, string>).filter(([key, value]) => `${key} ${value}`.toLowerCase().includes(search.toLowerCase()))}
                        rowKey={([key]) => key}
                        initialSort={{ column: "key" }}
                        columns={[
                          { id: "key", header: "Key", render: ([key]) => <Span $font={{ bold: true }}>{key}</Span>, sortValue: ([key]) => key },
                          { id: "value", header: "Value", render: ([, value]) => <Span $font={{ size: "s" }} $style={{ overflowWrap: "anywhere" }}>{value}</Span> },
                        ]}
                      />
                    </Div>
                  ) : (
                    <ErrorState title="cilium-config could not be read" error={new Error(info.configError ?? "unknown error")} />
                  ))}
                {view === "helm" && <HelmValues clusterId={clusterId} namespace={info.namespace} />}
              </>
            )}
          </Div>
        )}
      </QueryView>
    </PageLayout>
  );
});

export const helmConfigPageInjectable = getInjectable2({
  id: "cilium-ui-page-helm-config",
  injectionToken: ciliumPageInjectionToken,
  instantiate: () => () => ({
    id: "helm",
    section: "config" as const,
    title: "Helm Configuration",
    orderNumber: 30,
    Component: HelmConfigPage,
  }),
});
