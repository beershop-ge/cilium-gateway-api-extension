import { Badge } from "@k8slens/badge";
import { Div, Span } from "@k8slens/element-components";
import { AddIcon, CheckIcon, PolicyIcon } from "@k8slens/icon";
import { PlainButton, TextInput } from "@k8slens/input-components";
import { getInjectable2 } from "@k8slens/injectable";
import { useInject } from "@k8slens/use-inject";
import { action } from "mobx";
import { observer } from "mobx-react";
import { useEffect, useMemo, useState } from "react";
import { errorMessage, type Json } from "../common/json";
import type { Risk } from "../common/risk";
import { toYaml } from "../common/yaml";
import { itemsOf } from "../kube/snapshot";
import { versionOf } from "../kube/resource-types";
import { ciliumPageInjectionToken, type PageProps } from "../navigation/pages";
import { useViewState, viewStateInjectable } from "../navigation/view-state.injectable";
import { ApplyPanel } from "../resources/apply-panel";
import { NamespaceSelect } from "../resources/namespace-select";
import type { ValidationIssue } from "../schema/validate";
import { validateResource } from "../schema/validate";
import { Callout, FieldLabel, Section, Select, UpdatedAt } from "../ui/components";
import { CodeView } from "../ui/code-editor";
import { PageLayout } from "../ui/page-layout";
import { useCiliumInfo, useClusterContext, useDiscovery, useSnapshot } from "../ui/use-cluster";
import { buildManifest, changeKind, isSameResource, parsePolicy } from "./manifest";
import { directionsFor, isCiliumKind, isNamespacedKind, newPolicyModel, palettePeerTypes, type PolicyKind, type PolicyModel } from "./model";
import { endpointsOfSnapshot, findPolicy, kubectlResourceOfKind, podCidrsOf, policiesOf, policySnapshotRequest } from "./policy-data";
import { Lane, PaletteChip, type BuilderEnv } from "./rule-editor";
import { applyFix, policyModelIssues, policySafetyFindings, type SafetyContext } from "./safety";
import { modelSelectsEndpoint } from "./selection";
import { SelectorEditor } from "./selector-editor";
import { SuggestionsPanel } from "./suggestions-panel";
import { summarizeModel } from "./summary";
import styles from "./policy.module.scss";

const kindLabels: Record<PolicyKind, string> = {
  CiliumNetworkPolicy: "CiliumNetworkPolicy (namespaced)",
  CiliumClusterwideNetworkPolicy: "CiliumClusterwideNetworkPolicy (cluster-wide)",
  NetworkPolicy: "Kubernetes NetworkPolicy",
};

const policyKeyOf = (policy: Json) => `${policy.kind}|${policy.metadata?.namespace ?? ""}|${policy.metadata?.name}`;

const PolicyBuilderPage = observer(({ clusterId, tabKey }: PageProps) => {
  const context = useClusterContext(clusterId);
  const discovery = useDiscovery(clusterId);
  const snapshot = useSnapshot(clusterId, policySnapshotRequest);
  const cilium = useCiliumInfo(clusterId);
  const viewState = useInject(viewStateInjectable)()(tabKey);
  const ciliumInstalled = context.typeOfKind("CiliumNetworkPolicy") !== undefined;
  const [model, setModel] = useViewState<PolicyModel>(tabKey, "policyModel", newPolicyModel(discovery.value && !ciliumInstalled ? "NetworkPolicy" : "CiliumNetworkPolicy"));
  const [showSuggestions, setShowSuggestions] = useViewState(tabKey, "showSuggestions", false);
  const [loadMessage, setLoadMessage] = useState<string>();
  const [appliedAt, setAppliedAt] = useState<number>();
  const selected = viewState.get("selected") as string | undefined;
  const selectedKind = viewState.get("selectedKind") as string | undefined;
  const value = snapshot.state.value;

  // A policy picked elsewhere ("Edit in builder") is loaded once its list is here; then the request is cleared.
  useEffect(() => {
    if (!selected || !value) return;

    const policy = findPolicy(value, selected, selectedKind);

    action(() => {
      viewState.delete("selected");
      viewState.delete("selectedKind");
    })();

    if (policy) {
      setModel(parsePolicy(policy));
      setLoadMessage(undefined);
    } else {
      setLoadMessage(`${selectedKind ?? "Policy"} ${selected} was not found in the policies this cluster lists.`);
    }
  }, [selected, selectedKind, value]);

  const kinds: PolicyKind[] = [
    ...(ciliumInstalled ? (["CiliumNetworkPolicy"] as const) : []),
    ...(context.typeOfKind("CiliumClusterwideNetworkPolicy") ? (["CiliumClusterwideNetworkPolicy"] as const) : []),
    "NetworkPolicy",
  ];
  const cidrGroupsInstalled = context.typeOfKind("CiliumCIDRGroup") !== undefined;
  const env: BuilderEnv = {
    clusterId,
    cidrGroupsInstalled,
    cidrGroups: cidrGroupsInstalled && value ? itemsOf(value, "CiliumCIDRGroup").map((group) => String(group.metadata?.name)) : undefined,
  };

  const endpoints = useMemo(() => (value ? endpointsOfSnapshot(value) : undefined), [value]);
  const safetyContext: SafetyContext = useMemo(
    () => ({ ciliumNamespace: cilium.state.value?.namespace, podCIDRs: value ? podCidrsOf(value) : undefined, endpoints: endpoints && endpoints.length > 0 ? endpoints : undefined }),
    [cilium.state.value, value, endpoints],
  );

  const manifest = useMemo(() => buildManifest(model), [model]);
  const yaml = useMemo(() => toYaml(manifest), [manifest]);
  const modelIssues = useMemo(() => policyModelIssues(model, { cidrGroups: cidrGroupsInstalled }), [model, cidrGroupsInstalled]);
  const findings = useMemo(() => policySafetyFindings(model, safetyContext), [model, safetyContext]);
  const summary = useMemo(() => summarizeModel(model), [model]);
  const type = context.typeOfKind(model.kind);
  const schemaIssues = useMemo(() => {
    if (!type) return [];

    const version = versionOf(type, String(manifest.apiVersion).split("/").pop());

    return validateResource(manifest, version?.schema, { namespaced: type.namespaced, definitions: version?.definitions });
  }, [manifest, type]);
  const issues: ValidationIssue[] = [...schemaIssues, ...modelIssues.map((issue) => ({ path: [], message: issue.message, severity: issue.level }))];
  const risks: Risk[] = findings.map((finding) => ({ level: finding.level, message: finding.message }));
  const same = isSameResource(model);
  const selectedEndpoints = endpoints?.filter((endpoint) => modelSelectsEndpoint(model, endpoint));
  const existing = value ? policiesOf(value) : [];

  const reload = async () => {
    const base = model.base;

    if (!base) return;

    try {
      const fresh = await context.kubectl.json<Json>(["get", kubectlResourceOfKind[base.kind as PolicyKind], base.metadata.name, ...(base.metadata.namespace ? ["--namespace", base.metadata.namespace] : []), "--output", "json"]);

      setModel(parsePolicy(fresh));
      setLoadMessage("Reloaded the latest version from the cluster; your unapplied changes were discarded.");
    } catch (error) {
      setLoadMessage(`Could not reload: ${errorMessage(error)}`);
    }
  };

  return (
    <PageLayout
      clusterId={clusterId}
      title="Policy Rule Builder"
      subtitle="Build CiliumNetworkPolicies, CiliumClusterwideNetworkPolicies and NetworkPolicies by dragging peers onto rule lanes; review the YAML, the checks and a dry run before applying"
      actions={
        <>
          <Div $width={{ width: "11xl" }}>
            <Select
              ariaLabel="Load an existing policy"
              value={undefined}
              placeholder={existing.length > 0 ? "Edit an existing policy…" : "No existing policies listed"}
              disabled={existing.length === 0}
              options={existing.map((policy) => ({ value: policyKeyOf(policy), label: `${policy.kind === "NetworkPolicy" ? "NP" : policy.kind === "CiliumNetworkPolicy" ? "CNP" : "CCNP"} ${policy.metadata?.namespace ? `${policy.metadata.namespace}/` : ""}${policy.metadata?.name}` }))}
              onChange={(key) => {
                const policy = existing.find((candidate) => policyKeyOf(candidate) === key);

                if (policy) {
                  setModel(parsePolicy(policy));
                  setLoadMessage(undefined);
                }
              }}
            />
          </Div>
          <PlainButton
            Icon={AddIcon}
            $onClick={() => {
              setModel(newPolicyModel(kinds[0], isNamespacedKind(model.kind) ? model.namespace : "default"));
              setLoadMessage(undefined);
            }}
          >
            New policy
          </PlainButton>
          <UpdatedAt state={snapshot.state} onRefresh={() => void snapshot.refresh()} />
        </>
      }
    >
      <Div $flex={{ direction: "vertical", gap: "m" }} $padding={{ horizontal: "l", bottom: "l" }}>
        {loadMessage && <Callout level="info">{loadMessage}</Callout>}
        {appliedAt && <Callout level="success">Applied at {new Date(appliedAt).toLocaleTimeString()}. The builder now edits the applied version.</Callout>}
        {value?.errors.map((error) => (
          <Callout key={error.what} level="warning" title={`${error.what} could not be read${error.forbidden ? " (not allowed)" : ""}`}>
            {error.message.split("\n")[0]}. Checks and previews that depend on it are limited.
          </Callout>
        ))}
        {model.base && (
          <Callout level="info">
            Editing {model.base.kind} {model.base.metadata?.namespace ? `${model.base.metadata.namespace}/` : ""}
            {model.base.metadata?.name}
            {same ? "" : " as a new resource (kind, name or namespace changed)"}. Fields the builder does not model are kept as they are.
          </Callout>
        )}

        <div className={styles.builderGrid}>
          <Div $flex={{ direction: "vertical", gap: "l" }}>
            <Section title="POLICY">
              <Div $flex={{ direction: "horizontal", gap: "m", wrap: true }}>
                <Div $width={{ width: "11xl" }}>
                  <FieldLabel label="Kind" required>
                    <Select<PolicyKind> ariaLabel="Policy kind" value={model.kind} options={kinds.map((kind) => ({ value: kind, label: kindLabels[kind] }))} onChange={(kind) => setModel(changeKind(model, kind))} />
                  </FieldLabel>
                </Div>
                <Div $width={{ width: "11xl" }}>
                  <FieldLabel label="Name" required>
                    <TextInput aria-label="Policy name" placeholder="allow-web" value={model.name} onChange={(event) => setModel({ ...model, name: event.target.value.trim() })} />
                  </FieldLabel>
                </Div>
                {isNamespacedKind(model.kind) && (
                  <Div $width={{ width: "11xl" }}>
                    <FieldLabel label="Namespace" required>
                      <NamespaceSelect clusterId={clusterId} value={model.namespace || undefined} onChange={(namespace) => setModel({ ...model, namespace })} />
                    </FieldLabel>
                  </Div>
                )}
              </Div>
              {isCiliumKind(model.kind) && (
                <FieldLabel label="Description">
                  <TextInput aria-label="Policy description" placeholder="What this policy is for" value={model.description} onChange={(event) => setModel({ ...model, description: event.target.value })} />
                </FieldLabel>
              )}
            </Section>

            <Section title={model.subject === "nodes" ? "APPLIES TO NODES" : model.kind === "NetworkPolicy" ? "APPLIES TO PODS" : "APPLIES TO ENDPOINTS"}>
              {model.kind === "CiliumClusterwideNetworkPolicy" && (
                <Div $width={{ width: "11xl" }}>
                  <Select
                    ariaLabel="Policy subject"
                    value={model.subject}
                    options={[
                      { value: "endpoints", label: "Endpoints (endpointSelector)" },
                      { value: "nodes", label: "Nodes: host policy (nodeSelector)" },
                    ]}
                    onChange={(subject) => setModel({ ...model, subject })}
                  />
                </Div>
              )}
              <SelectorEditor
                ariaLabel={model.subject === "nodes" ? "Node selector" : "Endpoint selector"}
                value={model.selector}
                onChange={(selector) => setModel({ ...model, selector })}
                help={model.subject === "nodes" ? "node labels; empty selects every node" : "empty selects everything in scope"}
              />
              <Span $font={{ size: "s" }} $color="textMuted">
                {summary.subject}
                {selectedEndpoints && model.subject === "endpoints"
                  ? ` — selects ${selectedEndpoints.length} running endpoint${selectedEndpoints.length === 1 ? "" : "s"} now${selectedEndpoints.length > 0 ? `: ${selectedEndpoints.slice(0, 8).map((endpoint) => endpoint.key).join(", ")}${selectedEndpoints.length > 8 ? ", …" : ""}` : ""}`
                  : ""}
              </Span>
            </Section>

            <Section title="RULES">
              <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center", wrap: true }}>
                <Span $font={{ size: "s" }} $color="textMuted">
                  Drag a peer type onto a lane (new rule) or onto a rule (adds a peer):
                </Span>
                <div className={styles.palette} role="list" aria-label="Peer types">
                  {palettePeerTypes
                    .filter((type) => (model.kind === "NetworkPolicy" ? type === "endpoint" || type === "namespace" || type === "cidr" : type !== "cidrGroup" || cidrGroupsInstalled))
                    .map((type) => (
                      <PaletteChip key={type} type={type} />
                    ))}
                </div>
              </Div>
              <div className={styles.lanes}>
                {directionsFor(model.kind).map((direction) => (
                  <Lane key={direction} model={model} direction={direction} onChange={setModel} env={env} />
                ))}
              </div>
            </Section>

            <Section
              title="SUGGESTIONS FROM OBSERVED TRAFFIC"
              actions={
                <PlainButton Icon={PolicyIcon} $onClick={() => setShowSuggestions(!showSuggestions)}>
                  {showSuggestions ? "Hide" : "Show"}
                </PlainButton>
              }
            >
              {showSuggestions ? (
                <SuggestionsPanel clusterId={clusterId} model={model} onAdd={setModel} safetyContext={safetyContext} />
              ) : (
                <Span $font={{ size: "s" }} $color="textMuted">
                  Propose rules from the flows Hubble observed for the selected workloads. You pick which to add; nothing is applied.
                </Span>
              )}
            </Section>
          </Div>

          <div className={styles.sideColumn}>
            <Div $flex={{ direction: "vertical", gap: "l" }}>
              <Section title={`CHECKS (${modelIssues.length + findings.length})`}>
                {modelIssues.length === 0 && findings.length === 0 && <Callout level="success">No problems found.</Callout>}
                {modelIssues.map((issue, index) => (
                  <Callout key={`issue-${index}`} level={issue.level === "error" ? "danger" : "warning"}>
                    {issue.message}
                  </Callout>
                ))}
                {findings.map((finding) => (
                  <Callout key={finding.id} level={finding.level}>
                    <Div $flex={{ direction: "vertical", gap: "xs" }}>
                      <span>{finding.message}</span>
                      {finding.fix === "allow-dns" && (
                        <Div>
                          <PlainButton Icon={CheckIcon} $onClick={() => setModel(applyFix(model, "allow-dns", safetyContext))}>
                            Allow DNS to kube-dns{model.kind === "NetworkPolicy" ? "" : " (with a DNS rule)"}
                          </PlainButton>
                        </Div>
                      )}
                    </Div>
                  </Callout>
                ))}
              </Section>

              <Section title="SUMMARY">
                <Span $font={{ size: "s" }}>Applies to {summary.subject}.</Span>
                {summary.sections
                  .filter((section) => section.enabled)
                  .map((section) => (
                    <Div key={section.direction} $flex={{ direction: "vertical", gap: "xxs" }}>
                      <Div $flex={{ direction: "horizontal", gap: "xs", verticalAlign: "center" }}>
                        <Span $font={{ bold: true, size: "s" }}>{section.direction}</Span>
                        {section.defaultDeny && <Badge small label="default deny" $backgroundColor="warning" $color="white" />}
                      </Div>
                      {section.rules.map((rule) => (
                        <Span key={rule.id} $font={{ size: "s" }}>
                          • {rule.text}
                        </Span>
                      ))}
                    </Div>
                  ))}
                {summary.sections.every((section) => !section.enabled) && (
                  <Span $font={{ size: "s" }} $color="textMuted">
                    No section is restricted: this policy changes nothing yet.
                  </Span>
                )}
              </Section>

              <Section title="GENERATED YAML">
                <CodeView value={yaml} maxHeight={420} />
              </Section>

              <Section title="APPLY">
                <ApplyPanel
                  clusterId={clusterId}
                  documents={[manifest]}
                  originals={same && model.base ? [model.base] : []}
                  issues={issues}
                  modes={same ? ["replace", "server-side-apply"] : ["create", "server-side-apply"]}
                  description={`${same ? "Update" : "Create"} ${model.kind} ${isNamespacedKind(model.kind) ? `${model.namespace}/` : ""}${model.name}`}
                  extraRisks={risks}
                  onReload={model.base ? () => void reload() : undefined}
                  onApplied={(results) => {
                    if (results[0]) setModel(parsePolicy(results[0]));
                    setAppliedAt(Date.now());
                    void snapshot.refresh();
                  }}
                />
              </Section>
            </Div>
          </div>
        </div>
      </Div>
    </PageLayout>
  );
});

export const policyBuilderPageInjectable = getInjectable2({
  id: "cilium-ui-page-policy-builder",
  injectionToken: ciliumPageInjectionToken,
  instantiate: () => () => ({
    id: "policy-builder",
    section: "security" as const,
    title: "Policy Rule Builder",
    orderNumber: 50,
    Component: PolicyBuilderPage,
    description: "Build and edit network policies visually, with safety checks and flow-based suggestions",
  }),
});
