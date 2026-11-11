import { Badge } from "@k8slens/badge";
import { Div, Span } from "@k8slens/element-components";
import { CloseIcon, EditIcon, ArrowOutwardIcon } from "@k8slens/icon";
import { PlainButton, TextInput } from "@k8slens/input-components";
import { getInjectable2 } from "@k8slens/injectable";
import { useInject } from "@k8slens/use-inject";
import { observer } from "mobx-react";
import { useMemo } from "react";
import { errorMessage, type Json } from "../common/json";
import type { Snapshot } from "../kube/snapshot";
import { openCiliumPageInjectable } from "../navigation/open-page.injectable";
import { ciliumPageInjectionToken, type PageProps } from "../navigation/pages";
import { useViewState } from "../navigation/view-state.injectable";
import { refOf, resourceActionsInjectable } from "../resources/resource-actions.injectable";
import { Callout, Checkbox, ConditionsList, EmptyState, QueryView, Section, Select, uiStyles, UpdatedAt } from "../ui/components";
import { DataTable } from "../ui/data-table";
import { PageLayout } from "../ui/page-layout";
import { useSnapshot } from "../ui/use-cluster";
import { parsePolicy } from "./manifest";
import type { PolicyModel } from "./model";
import { endpointsOfSnapshot, policiesOf, policySnapshotRequest } from "./policy-data";
import { coverageByNamespace, type EndpointInfo, modelSelectsEndpoint, type PolicyRef, policyRefOf, policyStatusOf } from "./selection";
import { type PolicySummary, summarizeModel } from "./summary";

interface PolicyRow {
  readonly ref: PolicyRef;
  readonly policy: Json;
  readonly model?: PolicyModel;
  readonly summary?: PolicySummary;
  readonly parseError?: string;
  readonly selected: readonly EndpointInfo[];
}

const shortKind: Record<string, string> = { CiliumNetworkPolicy: "CNP", CiliumClusterwideNetworkPolicy: "CCNP", NetworkPolicy: "NP" };

/** Matches every policy against every endpoint, once per snapshot. */
const analyse = (snapshot: Snapshot) => {
  const endpoints = endpointsOfSnapshot(snapshot);
  const selections = new Map<string, string[]>();
  const rows: PolicyRow[] = policiesOf(snapshot).map((policy) => {
    const ref = policyRefOf(policy);

    try {
      const model = parsePolicy(policy);
      const selected = endpoints.filter((endpoint) => modelSelectsEndpoint(model, endpoint));

      for (const endpoint of selected) selections.set(endpoint.key, [...(selections.get(endpoint.key) ?? []), ref.key]);

      return { ref, policy, model, summary: summarizeModel(model), selected };
    } catch (error) {
      return { ref, policy, parseError: errorMessage(error), selected: [] };
    }
  });

  return { endpoints, rows, selections, coverage: coverageByNamespace(endpoints, selections, rows.map((row) => row.ref)) };
};

const EnforcementBadge = ({ value, managed }: { value: boolean | undefined; managed: boolean }) =>
  !managed ? (
    <Badge small label="not managed" $tooltip="No CiliumEndpoint exists for this pod: Cilium does not enforce policy on it (yet)" />
  ) : value === undefined ? (
    <Span $color="textMuted">unknown</Span>
  ) : value ? (
    <Badge small label="enforcing" $backgroundColor="success" $color="white" />
  ) : (
    <Badge small label="allow all" $backgroundColor="grey40" $color="white" $tooltip="No policy puts this direction in default deny" />
  );

const StatusBadge = ({ policy }: { policy: Json }) => {
  const status = policyStatusOf(policy);

  if (status.valid) {
    return <Badge small label={status.valid.ok ? "Valid" : "Invalid"} $backgroundColor={status.valid.ok ? "success" : "critical"} $color="white" $tooltip={status.valid.message} />;
  }

  if (status.nodes) {
    return (
      <Badge
        small
        label={`${status.nodes.ok}/${status.nodes.total} nodes OK`}
        $backgroundColor={status.nodes.errors.length > 0 ? "critical" : "success"}
        $color="white"
        $tooltip={status.nodes.errors.join("\n") || `${status.nodes.enforcing} enforcing`}
      />
    );
  }

  return <Span $color="textMuted">{policy.kind === "NetworkPolicy" ? "—" : "not reported"}</Span>;
};

const ruleCounts = (summary: PolicySummary | undefined) =>
  summary
    ? summary.sections
        .filter((section) => section.enabled)
        .map((section) => (section.defaultDeny ? `${section.direction}: deny all` : `${section.rules.length} ${section.direction}`))
        .join(", ") || "no restrictions"
    : "—";

const PolicyDetails = observer(({ clusterId, row, onClose }: { clusterId: string; row: PolicyRow; onClose: () => void }) => {
  const actions = useInject(resourceActionsInjectable)();
  const openPage = useInject(openCiliumPageInjectable)();
  const status = policyStatusOf(row.policy);

  return (
    <Div className={uiStyles.drawer} $flex={{ direction: "vertical" }}>
      <Div className={uiStyles.scroll} $padding="l" $flex={{ direction: "vertical", gap: "m" }} $flexChild>
        <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center" }}>
          <Badge small label={shortKind[row.ref.kind] ?? row.ref.kind} />
          <Span $font={{ size: "l", bold: true }} $flexChild>
            {row.ref.namespace ? `${row.ref.namespace}/` : ""}
            {row.ref.name}
          </Span>
          <PlainButton Icon={CloseIcon} $onClick={onClose} $tooltip="Close">
            <Span $visuallyHidden>Close details</Span>
          </PlainButton>
        </Div>
        <Div $flex={{ direction: "horizontal", gap: "s", wrap: true }}>
          <PlainButton Icon={ArrowOutwardIcon} $onClick={() => void actions.openRef(clusterId, refOf(row.policy))}>
            Open resource
          </PlainButton>
          <PlainButton Icon={EditIcon} $onClick={() => void openPage(clusterId, "policy-builder", { name: row.ref.name, namespace: row.ref.namespace, kind: row.ref.kind })}>
            Edit in builder
          </PlainButton>
        </Div>
        {row.parseError && <Callout level="warning">{row.parseError}</Callout>}
        {row.summary && (
          <Section title="APPLIES TO">
            <Span>{row.summary.subject}</Span>
          </Section>
        )}
        {row.summary && (
          <Section title="RULES">
            {row.summary.sections.every((section) => !section.enabled) && <Span $color="textMuted">This policy restricts nothing.</Span>}
            {row.summary.sections
              .filter((section) => section.enabled)
              .map((section) => (
                <Div key={section.direction} $flex={{ direction: "vertical", gap: "xxs" }}>
                  <Div $flex={{ direction: "horizontal", gap: "xs", verticalAlign: "center" }}>
                    <Span $font={{ bold: true }}>{section.direction}</Span>
                    {section.defaultDeny && <Badge small label="default deny" $backgroundColor="warning" $color="white" />}
                  </Div>
                  {section.rules.map((rule) => (
                    <Span key={rule.id} $font={{ size: "s" }} className={uiStyles.wrap}>
                      • {rule.text}
                    </Span>
                  ))}
                </Div>
              ))}
          </Section>
        )}
        <Section title="STATUS">
          {status.conditions.length > 0 ? <ConditionsList conditions={status.conditions} /> : <Span $color="textMuted">No conditions reported{row.ref.kind === "NetworkPolicy" ? " (NetworkPolicies have no status)" : ""}.</Span>}
          {status.nodes && (
            <Span $font={{ size: "s" }}>
              Nodes: {status.nodes.ok} of {status.nodes.total} OK, {status.nodes.enforcing} enforcing
              {status.nodes.errors.length > 0 ? `; ${status.nodes.errors.join("; ")}` : ""}
            </Span>
          )}
        </Section>
        <Section title={`SELECTED ENDPOINTS (${row.selected.length})`}>
          {row.model?.subject === "nodes" ? (
            <Span $color="textMuted">A host policy: it selects nodes, not endpoints.</Span>
          ) : row.selected.length === 0 ? (
            <Span $color="textMuted">No running endpoint matches the selector.</Span>
          ) : (
            <DataTable<EndpointInfo>
              ariaLabel="Selected endpoints"
              rows={row.selected}
              rowKey={(endpoint) => endpoint.key}
              initialSort={{ column: "name" }}
              columns={[
                { id: "name", header: "Endpoint", render: (endpoint) => endpoint.key, sortValue: (endpoint) => endpoint.key },
                { id: "ingress", header: "Ingress", render: (endpoint) => <EnforcementBadge value={endpoint.enforcement?.ingress} managed={endpoint.managed} /> },
                { id: "egress", header: "Egress", render: (endpoint) => <EnforcementBadge value={endpoint.enforcement?.egress} managed={endpoint.managed} /> },
              ]}
            />
          )}
        </Section>
      </Div>
    </Div>
  );
});

const PolicyVisualizationPage = observer(({ clusterId, tabKey }: PageProps) => {
  const snapshot = useSnapshot(clusterId, policySnapshotRequest);
  const openPage = useInject(openCiliumPageInjectable)();
  const actions = useInject(resourceActionsInjectable)();
  const [search, setSearch] = useViewState(tabKey, "search", "");
  const [namespace, setNamespace] = useViewState(tabKey, "namespace", "");
  const [onlyUnprotected, setOnlyUnprotected] = useViewState(tabKey, "onlyUnprotected", false);
  const [selectedKey, setSelectedKey] = useViewState<string | undefined>(tabKey, "selectedPolicy", undefined);
  const value = snapshot.state.value;
  const analysis = useMemo(() => (value ? analyse(value) : undefined), [value]);
  const selectedRow = analysis?.rows.find((row) => row.ref.key === selectedKey);
  const needle = search.toLowerCase();
  const namespaces = analysis ? [...new Set([...analysis.endpoints.map((endpoint) => endpoint.namespace), ...analysis.rows.map((row) => row.ref.namespace).filter((ns): ns is string => Boolean(ns))])].sort() : [];

  return (
    <PageLayout
      clusterId={clusterId}
      title="Policy Visualization"
      subtitle="Which endpoints each network policy selects, what its rules allow or deny, whether Cilium enforces them, and which endpoints no policy covers"
      actions={
        <>
          <PlainButton Icon={EditIcon} $onClick={() => void openPage(clusterId, "policy-builder")}>
            Policy builder
          </PlainButton>
          <UpdatedAt state={snapshot.state} onRefresh={() => void snapshot.refresh()} />
        </>
      }
      toolbar={
        <>
          <Div $width={{ width: "11xl" }}>
            <TextInput type="search" aria-label="Search policies and endpoints" placeholder="Search policies and endpoints" value={search} onChange={(event) => setSearch(event.target.value)} />
          </Div>
          <Div $width={{ width: "11xl" }}>
            <Select ariaLabel="Namespace" value={namespace} options={[{ value: "", label: "All namespaces" }, ...namespaces.map((ns) => ({ value: ns, label: ns }))]} onChange={setNamespace} />
          </Div>
          <Checkbox checked={onlyUnprotected} onChange={setOnlyUnprotected} label="Only endpoints without a policy" />
        </>
      }
      drawer={selectedRow && <PolicyDetails clusterId={clusterId} row={selectedRow} onClose={() => setSelectedKey(undefined)} />}
    >
      <QueryView state={snapshot.state} onRetry={() => void snapshot.refresh()} loadingText="Reading policies and endpoints…">
        {(loaded) => {
          const { rows, coverage, endpoints } = analysis!;
          const shownRows = rows.filter(
            (row) =>
              (!namespace || !row.ref.namespace || row.ref.namespace === namespace) &&
              (!needle || `${row.ref.kind} ${row.ref.namespace ?? ""}/${row.ref.name} ${row.summary?.subject ?? ""}`.toLowerCase().includes(needle)),
          );
          const shownCoverage = coverage
            .filter((group) => !namespace || group.namespace === namespace)
            .map((group) => ({
              ...group,
              rows: group.rows.filter(
                (entry) => (!onlyUnprotected || entry.policies.length === 0) && (!needle || `${entry.endpoint.key} ${entry.policies.map((policy) => policy.name).join(" ")}`.toLowerCase().includes(needle)),
              ),
            }))
            .filter((group) => group.rows.length > 0);
          const unprotected = coverage.reduce((sum, group) => sum + group.unprotected, 0);

          return (
            <Div $flex={{ direction: "vertical", gap: "l" }} $padding={{ horizontal: "l", bottom: "l" }}>
              {loaded.errors.map((error) => (
                <Callout key={error.what} level="warning" title={`${error.what} could not be read${error.forbidden ? " (not allowed)" : ""}`}>
                  {error.message.split("\n")[0]}
                </Callout>
              ))}
              {loaded.notInstalled.includes("CiliumNetworkPolicy") && <Callout level="info">Cilium's policy CRDs are not installed on this cluster: only Kubernetes NetworkPolicies are shown.</Callout>}
              {loaded.notInstalled.includes("CiliumEndpoint") && <Callout level="info">CiliumEndpoint is not served, so enforcement status cannot be shown.</Callout>}

              <Section title={`POLICIES (${rows.length})`}>
                {rows.length === 0 ? (
                  <EmptyState title="No network policies" text="No policy restricts traffic on this cluster: every endpoint allows all traffic.">
                    <Div>
                      <PlainButton Icon={EditIcon} $onClick={() => void openPage(clusterId, "policy-builder")}>
                        Create one in the builder
                      </PlainButton>
                    </Div>
                  </EmptyState>
                ) : (
                  <DataTable<PolicyRow>
                    ariaLabel="Network policies"
                    rows={shownRows}
                    rowKey={(row) => row.ref.key}
                    selectedKey={selectedKey}
                    onRowClick={(row) => setSelectedKey(row.ref.key === selectedKey ? undefined : row.ref.key)}
                    initialSort={{ column: "name" }}
                    columns={[
                      { id: "kind", header: "Kind", render: (row) => <Badge small label={shortKind[row.ref.kind] ?? row.ref.kind} $tooltip={row.ref.kind} />, sortValue: (row) => row.ref.kind },
                      { id: "name", header: "Policy", render: (row) => <Span $font={{ bold: true }}>{`${row.ref.namespace ? `${row.ref.namespace}/` : ""}${row.ref.name}`}</Span>, sortValue: (row) => `${row.ref.namespace ?? ""}/${row.ref.name}` },
                      { id: "subject", header: "Applies to", render: (row) => row.summary?.subject ?? <Span $color="warning">{row.parseError}</Span> },
                      {
                        id: "selects",
                        header: "Selects",
                        render: (row) => (row.model?.subject === "nodes" ? "nodes" : `${row.selected.length} endpoint${row.selected.length === 1 ? "" : "s"}`),
                        sortValue: (row) => row.selected.length,
                      },
                      { id: "rules", header: "Rules", render: (row) => ruleCounts(row.summary) },
                      { id: "status", header: "Status", render: (row) => <StatusBadge policy={row.policy} /> },
                      {
                        id: "actions",
                        header: "",
                        render: (row) => (
                          <Div $flex={{ direction: "horizontal", gap: "xxs" }} onClick={(event) => event.stopPropagation()}>
                            <PlainButton Icon={ArrowOutwardIcon} $tooltip="Open the resource" $onClick={() => void actions.openRef(clusterId, refOf(row.policy))}>
                              <Span $visuallyHidden>Open {row.ref.name}</Span>
                            </PlainButton>
                            <PlainButton Icon={EditIcon} $tooltip="Edit in the policy builder" $onClick={() => void openPage(clusterId, "policy-builder", { name: row.ref.name, namespace: row.ref.namespace, kind: row.ref.kind })}>
                              <Span $visuallyHidden>Edit {row.ref.name} in the builder</Span>
                            </PlainButton>
                          </Div>
                        ),
                      },
                    ]}
                    empty={<Span $color="textMuted">No policy matches the filter.</Span>}
                  />
                )}
              </Section>

              <Section title={`ENDPOINTS BY NAMESPACE (${endpoints.length} endpoints, ${unprotected} without any policy)`}>
                {endpoints.length === 0 && <Span $color="textMuted">No endpoints could be listed (pods and CiliumEndpoints unreadable or none running).</Span>}
                {shownCoverage.map((group) => (
                  <Div key={group.namespace} $flex={{ direction: "vertical", gap: "xs" }}>
                    <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center" }}>
                      <Span $font={{ bold: true }}>{group.namespace}</Span>
                      {group.unprotected > 0 ? (
                        <Badge small label={`${group.unprotected} without policy`} $backgroundColor="warning" $color="white" />
                      ) : (
                        <Badge small label="all covered" $backgroundColor="success" $color="white" />
                      )}
                    </Div>
                    <DataTable
                      ariaLabel={`Endpoints of ${group.namespace}`}
                      rows={group.rows}
                      rowKey={(entry) => entry.endpoint.key}
                      initialSort={{ column: "endpoint" }}
                      columns={[
                        { id: "endpoint", header: "Endpoint", render: (entry) => entry.endpoint.name, sortValue: (entry) => entry.endpoint.name },
                        {
                          id: "policies",
                          header: "Selected by",
                          render: (entry) =>
                            entry.policies.length === 0 ? (
                              <Span $color="warning">no policy: all traffic allowed</Span>
                            ) : (
                              <Div $flex={{ direction: "horizontal", gap: "xxs", wrap: true }}>
                                {entry.policies.map((policy) => (
                                  <PlainButton key={policy.key} $onClick={() => setSelectedKey(policy.key)} $tooltip={`${policy.kind} ${policy.namespace ? `${policy.namespace}/` : ""}${policy.name}`}>
                                    {`${shortKind[policy.kind] ?? policy.kind} ${policy.name}`}
                                  </PlainButton>
                                ))}
                              </Div>
                            ),
                          sortValue: (entry) => entry.policies.length,
                        },
                        { id: "ingress", header: "Ingress", render: (entry) => <EnforcementBadge value={entry.endpoint.enforcement?.ingress} managed={entry.endpoint.managed} /> },
                        { id: "egress", header: "Egress", render: (entry) => <EnforcementBadge value={entry.endpoint.enforcement?.egress} managed={entry.endpoint.managed} /> },
                        { id: "identity", header: "Identity", render: (entry) => entry.endpoint.identity ?? "—", sortValue: (entry) => entry.endpoint.identity ?? 0 },
                      ]}
                    />
                  </Div>
                ))}
              </Section>
            </Div>
          );
        }}
      </QueryView>
    </PageLayout>
  );
});

export const policyVisualizationPageInjectable = getInjectable2({
  id: "cilium-ui-page-policy-visualization",
  injectionToken: ciliumPageInjectionToken,
  instantiate: () => () => ({
    id: "policy-visualization",
    section: "security" as const,
    title: "Policy Visualization",
    orderNumber: 40,
    Component: PolicyVisualizationPage,
    description: "Which endpoints each policy selects, its rules and enforcement, and endpoints without a policy",
  }),
});
