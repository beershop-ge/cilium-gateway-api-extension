import { Badge } from "@k8slens/badge";
import { Div, Span } from "@k8slens/element-components";
import { AddIcon, CloseIcon, NetworkIcon, RefreshIcon } from "@k8slens/icon";
import { PlainButton, PrimaryButton } from "@k8slens/input-components";
import { type LightWeightTab, LightWeightTabs } from "@k8slens/tabs-components";
import { useInject } from "@k8slens/use-inject";
import { observer } from "mobx-react";
import { action } from "mobx";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { healthOfResource } from "../common/conditions";
import { errorMessage, type Json, setPath } from "../common/json";
import { cleanForEdit } from "../common/manifest";
import type { Risk } from "../common/risk";
import { parseSingleYaml, toYaml } from "../common/yaml";
import { gatewayMapStateInjectable, mapNodeIdOf } from "../gateway-map/gateway-map-state.injectable";
import type { ResourceType } from "../kube/resource-types";
import { itemsOf, type Snapshot } from "../kube/snapshot";
import { openCiliumPageInjectable } from "../navigation/open-page.injectable";
import { viewStateInjectable } from "../navigation/view-state.injectable";
import { ApplyPanel } from "../resources/apply-panel";
import { resourceActionsInjectable } from "../resources/resource-actions.injectable";
import { type ValidationIssue, validateResource } from "../schema/validate";
import { settingsStoreInjectable } from "../settings/settings.injectable";
import { Callout, EmptyState, HealthBadge, Section } from "../ui/components";
import { CodeEditor } from "../ui/code-editor";
import { DataTable } from "../ui/data-table";
import { useClusterContext } from "../ui/use-cluster";
import { apiVersionsOf, type BuilderProps, type DesignerContext, useGatewaySchemas } from "./data";
import { gatewayStyles, ReferenceChecks } from "./fields";
import { type DesignerKind, designerKinds, gatewayClassForDocument, gatewayFeaturesOf, isDesignerKind, isRouteKind, supportedFeaturesOf } from "./features";
import { GatewayBuilder } from "./gateway-builder";
import { GatewayClassBuilder } from "./gateway-class-builder";
import { newDocument, resourceKeyOf } from "./manifest";
import { ReferenceGrantBuilder } from "./reference-grant-builder";
import { RouteBuilder } from "./route-builder";
import { StatusView } from "./status-view";
import { inventoryFromSnapshot, validateGatewayResource } from "./validation";

interface Editing {
  /** `namespace/name` of the resource being edited, or undefined for a new one. */
  readonly key?: string;
  readonly document: Json;
  /** The resource as read from the cluster, for the diff, the backup and conflict detection. */
  readonly original?: Json;
}

type View = "visual" | "yaml";

const views: readonly LightWeightTab<View>[] = [
  { id: "visual", label: "Visual builder" },
  { id: "yaml", label: "Advanced YAML" },
];

const builders: Record<DesignerKind, (props: BuilderProps) => ReactNode> = {
  GatewayClass: GatewayClassBuilder,
  Gateway: GatewayBuilder,
  HTTPRoute: RouteBuilder,
  GRPCRoute: RouteBuilder,
  TLSRoute: RouteBuilder,
  TCPRoute: RouteBuilder,
  UDPRoute: RouteBuilder,
  ReferenceGrant: ReferenceGrantBuilder,
};

/** The YAML view of the generated manifest: edits that parse flow back into the builder. */
const YamlView = ({ document, onChange, kind }: { document: Json; onChange: (document: Json) => void; kind: string }) => {
  const [text, setText] = useState(() => toYaml(document));
  const [error, setError] = useState<string>();

  // When the document changes from outside (a reload, an apply), show it, unless the text is what produced it.
  useEffect(() => {
    const parsed = parseSingleYaml(text);

    if (parsed.error || JSON.stringify(parsed.value) !== JSON.stringify(document)) {
      setText(toYaml(document));
      setError(undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only an outside change of the document resets the text
  }, [document]);

  const errorLine = error ? Number(/line (\d+)/.exec(error)?.[1]) : undefined;

  return (
    <Div $flex={{ direction: "vertical", gap: "s" }}>
      {error && (
        <Callout level="danger" title="The YAML does not parse; the builder keeps the last valid version">
          {error}
        </Callout>
      )}
      <CodeEditor
        ariaLabel={`${kind} manifest as YAML`}
        value={text}
        minHeight={360}
        errorLines={errorLine ? [errorLine] : []}
        onChange={(next) => {
          setText(next);

          const parsed = parseSingleYaml(next);

          if (parsed.error) {
            setError(parsed.error);
          } else if (parsed.value?.kind !== kind) {
            setError(`The kind must stay ${kind}; use the tabs above to build another kind`);
          } else {
            setError(undefined);
            onChange(parsed.value);
          }
        }}
      />
    </Div>
  );
};

const statusOfRow = (resource: Json) => {
  const { health, reason } = healthOfResource(resource);

  return <HealthBadge health={health} reason={reason} />;
};

export interface DesignerProps {
  readonly clusterId: string;
  readonly tabKey: string;
  readonly types: readonly ResourceType[];
  readonly snapshot: Snapshot;
}

export const Designer = observer(({ clusterId, tabKey, types, snapshot }: DesignerProps) => {
  const context = useClusterContext(clusterId);
  const settings = useInject(settingsStoreInjectable)();
  const tabState = useInject(viewStateInjectable)()(tabKey);
  const viewState = { get: (field: string) => tabState.get(field), set: action((field: string, value: unknown) => void tabState.set(field, value)) };
  const openPage = useInject(openCiliumPageInjectable)();
  const actions = useInject(resourceActionsInjectable)();
  const mapState = useInject(gatewayMapStateInjectable)()(clusterId);
  const schemasState = useGatewaySchemas(clusterId, types);
  const schemas = schemasState.value ?? {};
  const [view, setView] = useState<View>("visual");
  const [reloadError, setReloadError] = useState<string>();

  const apiVersions = useMemo(() => apiVersionsOf(types), [types]);
  const baseFeatures = gatewayFeaturesOf(types, schemas);
  const installedKinds = designerKinds.filter((kind) => baseFeatures.installed[kind]);
  const requestedKind = viewState.get("selectedKind") as string | undefined;
  const kind: DesignerKind | undefined = isDesignerKind(requestedKind) && baseFeatures.installed[requestedKind] ? requestedKind : installedKinds.includes("Gateway") ? "Gateway" : installedKinds[0];
  const selected = (viewState.get("selected") as string | undefined) ?? "";
  const editing = kind ? (viewState.get(`editing:${kind}`) as Editing | undefined) : undefined;
  const items = kind ? itemsOf(snapshot, kind) : [];
  const live = editing?.key ? items.find((item) => resourceKeyOf(item) === editing.key) : undefined;

  const setEditing = (target: DesignerKind, next: Editing | undefined) => viewState.set(`editing:${target}`, next);

  const edit = (target: DesignerKind, draft: Json, original?: Json) => {
    const key = original ? resourceKeyOf(original) : undefined;

    setEditing(target, { key, document: draft, original });
    viewState.set("selectedKind", target);
    viewState.set("selected", key ?? "");
    setView("visual");
  };

  // A resource chosen from elsewhere (a list page, the map) loads into its builder.
  useEffect(() => {
    if (!kind || !selected || editing?.key === selected) {
      return;
    }

    const item = items.find((candidate) => resourceKeyOf(candidate) === selected);

    if (item) {
      setEditing(kind, { key: selected, document: cleanForEdit(item), original: item });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to the selection and to the resources loading
  }, [kind, selected, items]);

  if (!kind) {
    return (
      <EmptyState title="This cluster does not serve the Gateway API" text="Install the Gateway API CRDs (standard channel, plus experimental for TLSRoute and TCPRoute) and enable Cilium's gateway controller (gatewayAPI.enabled=true)." />
    );
  }

  const inventory = inventoryFromSnapshot(snapshot, apiVersions);
  const document = editing?.document;
  const gatewayClass = document ? gatewayClassForDocument(document, itemsOf(snapshot, "GatewayClass"), itemsOf(snapshot, "Gateway")) : undefined;
  const supported = supportedFeaturesOf(gatewayClass);
  const features = gatewayFeaturesOf(types, schemas, supported);
  const issues = document ? validateGatewayResource(document, inventory) : [];
  const type = features.installed[kind]!;
  const kindSchema = schemas[kind];
  const schemaIssues: ValidationIssue[] = document && kindSchema?.schema ? validateResource(document, kindSchema.schema, { namespaced: type.namespaced, definitions: kindSchema.definitions ?? {} }) : [];
  const referenceErrors: ValidationIssue[] = issues.filter((issue) => issue.severity === "error").map((issue) => ({ path: issue.path, message: issue.message, severity: "error" }));
  const referenceRisks: Risk[] = issues.filter((issue) => issue.severity === "warning").map((issue) => ({ level: "warning", message: issue.message }));
  const namespaces = (inventory.namespaces ?? []).map((namespace) => String(namespace.metadata.name));

  const ctx: DesignerContext = { clusterId, snapshot, inventory, features, apiVersions, issues, namespaces, edit };
  const Builder = builders[kind];
  const isNew = !editing?.key;

  const selectKind = (next: DesignerKind | undefined) => {
    if (!next) return;

    viewState.set("selectedKind", next);
    viewState.set("selected", (viewState.get(`editing:${next}`) as Editing | undefined)?.key ?? "");
  };

  const startNew = () => {
    const namespace = (document?.metadata?.namespace as string | undefined) ?? "default";

    edit(kind, newDocument(kind, apiVersions, { namespace, gatewayClasses: itemsOf(snapshot, "GatewayClass"), gateways: itemsOf(snapshot, "Gateway"), existing: items }));
  };

  const reload = async () => {
    if (!editing?.key || !document) return;

    try {
      const version = String(document.apiVersion ?? "").split("/").pop() ?? type.preferredVersion;
      const latest = await context.ops.get(type, version, document.metadata.name, document.metadata.namespace);

      setEditing(kind, { ...editing, original: latest, document: setPath(document, ["metadata", "resourceVersion"], latest.metadata.resourceVersion) });
      setReloadError(undefined);
    } catch (error) {
      setReloadError(errorMessage(error));
    }
  };

  const mapNode = document ? mapNodeIdOf(kind, document.metadata?.name, document.metadata?.namespace) : undefined;

  return (
    <Div $flex={{ direction: "vertical", gap: "m" }} $padding={{ horizontal: "l", bottom: "l" }}>
      <LightWeightTabs
        tabs={designerKinds.map((candidate) => ({
          id: candidate,
          label: candidate,
          badge: baseFeatures.installed[candidate] ? String(itemsOf(snapshot, candidate).length) : undefined,
          disabled: !baseFeatures.installed[candidate],
          tooltip: baseFeatures.installed[candidate] ? undefined : `The ${candidate} CRD is not installed on this cluster${candidate === "TLSRoute" || candidate === "TCPRoute" || candidate === "UDPRoute" ? " (it is in the experimental channel)" : ""}`,
        }))}
        selected={kind}
        onSelect={selectKind}
      />

      {snapshot.errors.map((error) => (
        <Callout key={error.what} level="warning" title={`Could not read ${error.what}`}>
          {error.forbidden ? "Your user may not list them; checks that need them are skipped." : error.message}
        </Callout>
      ))}

      <div className={gatewayStyles.split}>
        <div className={gatewayStyles.listColumn}>
          <Section
            title={`${type.title} (${items.length})`}
            actions={
              <PrimaryButton Icon={AddIcon} $onClick={startNew}>
                New
              </PrimaryButton>
            }
          >
            <DataTable<Json>
              ariaLabel={type.title}
              rows={items}
              rowKey={resourceKeyOf}
              selectedKey={editing?.key}
              initialSort={{ column: "name" }}
              onRowClick={(item) => {
                if (resourceKeyOf(item) !== editing?.key) {
                  setEditing(kind, { key: resourceKeyOf(item), document: cleanForEdit(item), original: item });
                  viewState.set("selected", resourceKeyOf(item));
                }
              }}
              empty={<Span $color="textMuted">None yet. Use New to build one.</Span>}
              columns={[
                { id: "name", header: "Name", render: (item) => item.metadata.name, sortValue: (item) => item.metadata.name },
                ...(type.namespaced ? [{ id: "namespace", header: "Namespace", render: (item: Json) => item.metadata.namespace, sortValue: (item: Json) => item.metadata.namespace }] : []),
                { id: "status", header: "Status", render: statusOfRow },
              ]}
            />
          </Section>
        </div>

        <Div $flex={{ direction: "vertical", gap: "m" }} $style={{ minWidth: 0 }}>
          {selected && editing?.key !== selected && !items.some((item) => resourceKeyOf(item) === selected) && (
            <Callout level="warning">{`${kind} ${selected.replace(/^\//, "")} was not found on this cluster.`}</Callout>
          )}

          {!document ? (
            <EmptyState title={`Build a ${kind}`} text="Pick one on the left to edit it, or start a new one.">
              <Div>
                <PrimaryButton Icon={AddIcon} $onClick={startNew}>
                  New {kind}
                </PrimaryButton>
              </Div>
            </EmptyState>
          ) : (
            <>
              <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center", wrap: true }}>
                <Span $font={{ size: "l", bold: true }} $flexChild>
                  {isNew ? `New ${kind}` : `Edit ${kind} ${editing?.key?.replace(/^\//, "")}`}
                </Span>
                {gatewayClass && supported && (
                  <Badge small label={`${supported.size} features reported by ${gatewayClass.metadata.name}`} $tooltip={[...supported].sort().join("\n")} />
                )}
                {mapNode && !isNew && (
                  <PlainButton
                    Icon={NetworkIcon}
                    $onClick={() => {
                      mapState.focus(mapNode);
                      void openPage(clusterId, "gateway-map");
                    }}
                  >
                    Show on map
                  </PlainButton>
                )}
                {!isNew && (
                  <PlainButton Icon={RefreshIcon} $tooltip="Discard your changes and start again from what the cluster holds" $onClick={() => live && setEditing(kind, { key: editing?.key, document: cleanForEdit(live), original: live })}>
                    Discard changes
                  </PlainButton>
                )}
                {!isNew && live && (
                  <PlainButton $onClick={() => void actions.openRef(clusterId, { kind, name: live.metadata.name, namespace: live.metadata.namespace, group: type.group })}>Resource page</PlainButton>
                )}
                <PlainButton
                  Icon={CloseIcon}
                  $onClick={() => {
                    setEditing(kind, undefined);
                    viewState.set("selected", "");
                  }}
                >
                  Close
                </PlainButton>
              </Div>

              {reloadError && <Callout level="danger" title="Could not reload">{reloadError}</Callout>}
              {schemasState.status === "loading" && <Span $color="textMuted">Reading the installed schemas…</Span>}
              {!isNew && live && <StatusView resource={live} />}
              {!isNew && !live && <Callout level="warning">This resource is no longer on the cluster. Applying creates it again.</Callout>}

              <LightWeightTabs tabs={views} selected={view} onSelect={(next) => next && setView(next)} />

              {view === "visual" ? (
                <Builder ctx={ctx} document={document} isNew={isNew} onChange={(next) => setEditing(kind, { ...editing!, document: next })} />
              ) : (
                <YamlView kind={kind} document={document} onChange={(next) => setEditing(kind, { ...editing!, document: next })} />
              )}

              <ReferenceChecks issues={issues} onCreateGrant={features.installed.ReferenceGrant ? (grant) => edit("ReferenceGrant", grant) : undefined} />
              {!features.installed.ReferenceGrant && issues.some((issue) => issue.grant) && (
                <Callout level="warning">The ReferenceGrant CRD is not installed, so cross-namespace references cannot be allowed on this cluster.</Callout>
              )}

              <Section title="Review and apply">
                <ApplyPanel
                  clusterId={clusterId}
                  documents={[document]}
                  originals={editing?.original ? [editing.original] : []}
                  issues={[...schemaIssues, ...referenceErrors]}
                  extraRisks={referenceRisks}
                  modes={isNew ? ["create", "server-side-apply"] : ["replace", "server-side-apply"]}
                  defaultMode={isNew ? "create" : settings.get().defaultWriteMode}
                  description={`${isNew ? "Create" : "Update"} ${kind} ${document.metadata?.name ?? ""}`}
                  onReload={isNew ? undefined : () => void reload()}
                  onApplied={(results) => {
                    const result = results[0];

                    if (result?.metadata?.name) {
                      setEditing(kind, { key: resourceKeyOf(result), document: cleanForEdit(result), original: result });
                      viewState.set("selected", resourceKeyOf(result));
                    }
                  }}
                />
              </Section>
            </>
          )}
        </Div>
      </div>

      {isRouteKind(kind) && !features.installed.Gateway && <Callout level="warning">The Gateway CRD is not installed, so routes have nothing to attach to.</Callout>}
    </Div>
  );
});
