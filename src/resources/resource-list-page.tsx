import { Badge } from "@k8slens/badge";
import { Div, Span } from "@k8slens/element-components";
import { AddIcon, FileDownloadIcon, UploadIcon } from "@k8slens/icon";
import { PlainButton, PrimaryButton, TextInput } from "@k8slens/input-components";
import { kubeResourcesInjectionToken } from "@k8slens/kubernetes-contracts";
import { useSubscribable } from "@k8slens/subscribable-react";
import { useInject, useSyncInject } from "@k8slens/use-inject";
import { observer } from "mobx-react";
import { Suspense, use, useMemo } from "react";
import { healthOfResource } from "../common/conditions";
import { age } from "../common/format";
import { detectManagers } from "../common/gitops";
import type { Json } from "../common/json";
import { evaluateJsonPath, formatJsonPathValue } from "../common/jsonpath";
import { cleanForExport, cloneManifest } from "../common/manifest";
import { toYamlDocuments } from "../common/yaml";
import { clusterContextInjectable } from "../kube/cluster-context.injectable";
import { dynamicKindOf } from "../kube/dynamic-kinds";
import { apiVersionOf, type ResourceType, versionOf } from "../kube/resource-types";
import { openCiliumPageInjectable } from "../navigation/open-page.injectable";
import { useViewState } from "../navigation/view-state.injectable";
import { skeletonFor } from "../schema/schema";
import { Callout, EmptyState, ErrorBoundary, HealthBadge, Loading, Select } from "../ui/components";
import { downloadText } from "../ui/code-editor";
import { type Column, DataTable } from "../ui/data-table";
import { notifyInjectable } from "../ui/notify.injectable";
import { PageLayout } from "../ui/page-layout";
import { ImportView } from "./import-view";
import { NamespaceSelect } from "./namespace-select";
import { usePermissions } from "./permissions";
import { ResourceDetails } from "./resource-details";
import { type EditorMode, ResourceEditor } from "./resource-editor";

/** Kinds with a visual tool of their own besides the generic editor. */
export const designerPageOfKind: Readonly<Record<string, { pageId: string; label: string }>> = {
  Gateway: { pageId: "gateway-designer", label: "Gateway designer" },
  HTTPRoute: { pageId: "gateway-designer", label: "Route designer" },
  GRPCRoute: { pageId: "gateway-designer", label: "Route designer" },
  TLSRoute: { pageId: "gateway-designer", label: "Route designer" },
  TCPRoute: { pageId: "gateway-designer", label: "Route designer" },
  UDPRoute: { pageId: "gateway-designer", label: "Route designer" },
  GatewayClass: { pageId: "gateway-designer", label: "Gateway designer" },
  ReferenceGrant: { pageId: "gateway-designer", label: "Gateway designer" },
  CiliumNetworkPolicy: { pageId: "policy-builder", label: "Policy builder" },
  CiliumClusterwideNetworkPolicy: { pageId: "policy-builder", label: "Policy builder" },
  NetworkPolicy: { pageId: "policy-builder", label: "Policy builder" },
};

interface EditorState {
  readonly mode: EditorMode;
  readonly initial: Json;
  readonly original?: Json;
}

const keyOf = (resource: Json) => `${resource.metadata?.namespace ?? ""}/${resource.metadata?.name}`;

const newResource = (type: ResourceType, version: string, namespace: string | undefined): Json => {
  const schema = versionOf(type, version)?.schema;
  const skeleton = schema ? skeletonFor(schema) : {};
  const { apiVersion: _a, kind: _k, metadata: _m, status: _s, ...body } = skeleton;

  return {
    apiVersion: apiVersionOf(type, version),
    kind: type.kind,
    metadata: { name: "", ...(type.namespaced ? { namespace: namespace || "default" } : {}) },
    ...body,
  };
};

const matchesSearch = (resource: Json, search: string) => {
  if (!search) {
    return true;
  }

  const haystack = [resource.metadata?.name, resource.metadata?.namespace, ...Object.entries(resource.metadata?.labels ?? {}).map(([key, value]) => `${key}=${value}`)].join(" ").toLowerCase();

  return search
    .toLowerCase()
    .split(/\s+/)
    .every((term) => haystack.includes(term));
};

interface RowsProps {
  readonly clusterId: string;
  readonly type: ResourceType;
  readonly version: string;
  readonly namespace: string;
  readonly tabKey: string;
  readonly openEditor: (editor: EditorState) => void;
}

const Rows = observer(({ clusterId, type, version, namespace, tabKey, openEditor }: RowsProps) => {
  const kubeResources = useSyncInject(kubeResourcesInjectionToken);
  const { kind, apiVersion } = dynamicKindOf(type, version);
  const { value } = useSubscribable(kubeResources(kind, apiVersion, clusterId, type.namespaced && namespace ? namespace : undefined));
  const items = use(value).get() as readonly Json[];
  const [search] = useViewState(tabKey, "search", "");
  const [selected, setSelected] = useViewState<string | undefined>(tabKey, "selected", undefined);
  const permissions = usePermissions(clusterId, type, namespace || undefined);
  const openPage = useInject(openCiliumPageInjectable)();
  const printerColumns = (versionOf(type, version)?.printerColumns ?? []).filter((column) => !column.priority && column.name.toLowerCase() !== "age");
  const filtered = useMemo(() => items.filter((item) => matchesSearch(item, search)), [items, search]);
  const selectedResource = items.find((item) => keyOf(item) === selected);

  const columns: Column<Json>[] = [
    { id: "name", header: "Name", render: (row) => <Span $font={{ bold: true }}>{row.metadata.name}</Span>, sortValue: (row) => row.metadata.name },
    ...(type.namespaced && !namespace ? [{ id: "namespace", header: "Namespace", render: (row: Json) => row.metadata.namespace, sortValue: (row: Json) => row.metadata.namespace }] : []),
    ...printerColumns.slice(0, 5).map((column) => ({
      id: `col:${column.name}`,
      header: column.name,
      render: (row: Json) => <Span $font={{ size: "s" }}>{formatJsonPathValue(evaluateJsonPath(row, column.jsonPath)) || "—"}</Span>,
      sortValue: (row: Json) => formatJsonPathValue(evaluateJsonPath(row, column.jsonPath)),
    })),
    {
      id: "status",
      header: "Status",
      render: (row) => {
        const health = healthOfResource(row);

        return <HealthBadge health={health.health} reason={health.reason} />;
      },
      sortValue: (row) => healthOfResource(row).health,
    },
    {
      id: "managed",
      header: "Managed by",
      render: (row) => {
        const managers = detectManagers(row).filter((manager) => manager.tool !== "Other");

        return managers.length ? <Badge small label={managers.map((manager) => manager.tool).join(", ")} $tooltip={managers.map((manager) => manager.detail).join("\n")} /> : "";
      },
    },
    { id: "age", header: "Age", render: (row) => age(row.metadata.creationTimestamp), sortValue: (row) => -new Date(row.metadata.creationTimestamp ?? 0).getTime() },
  ];

  return (
    <Div $flex={{ direction: "horizontal" }} $height="full" $style={{ minHeight: 0 }}>
      <Div $flexChild $overflow="auto" $style={{ minWidth: 0 }}>
        <DataTable
          ariaLabel={type.title}
          rows={filtered}
          columns={columns}
          rowKey={keyOf}
          selectedKey={selected}
          onRowClick={(row) => setSelected(keyOf(row) === selected ? undefined : keyOf(row))}
          initialSort={{ column: "name" }}
          empty={
            <EmptyState
              title={items.length === 0 ? `No ${type.title} ${namespace ? `in ${namespace}` : "yet"}` : "Nothing matches the search"}
              text={items.length === 0 ? type.description : undefined}
            />
          }
        />
      </Div>
      {selectedResource && (
        <ResourceDetails
          clusterId={clusterId}
          type={type}
          resource={selectedResource}
          tabKey={tabKey}
          permissions={permissions}
          onClose={() => setSelected(undefined)}
          onEdit={() => openEditor({ mode: "edit", initial: selectedResource, original: selectedResource })}
          onClone={() => openEditor({ mode: "clone", initial: cloneManifest(selectedResource, `${selectedResource.metadata.name}-copy`) })}
          designer={
            designerPageOfKind[type.kind]
              ? {
                  label: `Open in ${designerPageOfKind[type.kind].label}`,
                  open: () => void openPage(clusterId, designerPageOfKind[type.kind].pageId, { name: selectedResource.metadata.name, namespace: selectedResource.metadata.namespace, kind: type.kind }),
                }
              : undefined
          }
        />
      )}
      {selected && !selectedResource && items.length > 0 && (
        <Div $padding="l" $width={{ width: "11xl" }}>
          <Callout level="info" title="Not found">
            {selected.replace(/^\//, "")} is not in this list (deleted, or in another namespace).
          </Callout>
        </Div>
      )}
    </Div>
  );
});

/** The generic page of any discovered Cilium or Gateway API kind: a live list, details, editors, import and export. */
export const ResourceListPage = observer(({ clusterId, type, tabKey }: { clusterId: string; type: ResourceType; tabKey: string }) => {
  const context = useInject(clusterContextInjectable)()(clusterId);
  const openPage = useInject(openCiliumPageInjectable)();
  const notify = useInject(notifyInjectable)();
  const [search, setSearch] = useViewState(tabKey, "search", "");
  const [namespace, setNamespace] = useViewState(tabKey, "namespace", "");
  const [version, setVersion] = useViewState(tabKey, "version", type.preferredVersion);
  const [editor, setEditor] = useViewState<EditorState | undefined>(tabKey, "editor", undefined);
  const [importing, setImporting] = useViewState(tabKey, "importing", false);
  const permissions = usePermissions(clusterId, type, namespace || undefined);
  const readOnly = context.isReadOnly();
  const servedVersions = type.versions.filter((candidate) => candidate.served);
  const designer = designerPageOfKind[type.kind];
  const effectiveVersion = servedVersions.some((candidate) => candidate.name === version) ? version : type.preferredVersion;

  if (editor) {
    return (
      <Div $height="full" $overflow="auto" $backgroundColor="backgroundSecondary">
        <ResourceEditor clusterId={clusterId} type={type} mode={editor.mode} initial={editor.initial} original={editor.original} onClose={() => setEditor(undefined)} />
      </Div>
    );
  }

  if (importing) {
    return (
      <Div $height="full" $overflow="auto" $backgroundColor="backgroundSecondary">
        <ImportView clusterId={clusterId} defaultNamespace={namespace || undefined} onClose={() => setImporting(false)} />
      </Div>
    );
  }

  const exportAll = async () => {
    try {
      const items = await context.ops.list(type, effectiveVersion, namespace || undefined);
      const shown = items.filter((item) => matchesSearch(item, search));

      downloadText(`${type.plural}${namespace ? `-${namespace}` : ""}.yaml`, toYamlDocuments(shown.map((item) => cleanForExport(item))));
    } catch (error) {
      notify.error(error, `Could not export ${type.title}`);
    }
  };

  return (
    <PageLayout
      clusterId={clusterId}
      title={type.title}
      subtitle={`${type.description ?? type.kind} · ${apiVersionOf(type, effectiveVersion)} · ${type.namespaced ? "namespaced" : "cluster-scoped"} · live`}
      scroll={false}
      actions={
        <>
          {designer && <PlainButton $onClick={() => void openPage(clusterId, designer.pageId)}>{designer.label}</PlainButton>}
          <PlainButton Icon={UploadIcon} $onClick={() => setImporting(true)} $enabled={!readOnly} $tooltip="Import manifests from a file or pasted text">
            Import
          </PlainButton>
          <PlainButton Icon={FileDownloadIcon} $onClick={() => void exportAll()} $tooltip="Save the listed resources as YAML">
            Export
          </PlainButton>
          <PrimaryButton
            Icon={AddIcon}
            $enabled={!readOnly && permissions.create}
            $tooltip={readOnly ? "Read-only mode is on" : permissions.create ? undefined : `Your user may not create ${type.title}${namespace ? ` in ${namespace}` : ""}`}
            $onClick={() => setEditor({ mode: "create", initial: newResource(type, effectiveVersion, namespace) })}
          >
            Create
          </PrimaryButton>
        </>
      }
      toolbar={
        <>
          <Div $width={{ width: "11xl" }}>
            <TextInput type="search" aria-label="Search by name, namespace or label" placeholder="Search by name, namespace or label=value" value={search} onChange={(event) => setSearch(event.target.value)} />
          </Div>
          {type.namespaced && <NamespaceFilter clusterId={clusterId} value={namespace} onChange={setNamespace} />}
          {servedVersions.length > 1 && (
            <Div $width={{ width: "9xl" }}>
              <Select ariaLabel="API version" value={effectiveVersion} options={servedVersions.map((candidate) => ({ value: candidate.name, label: `${candidate.name}${candidate.deprecated ? " (deprecated)" : ""}` }))} onChange={setVersion} />
            </Div>
          )}
          {!permissions.list && permissions.known && <Badge small label="No list permission" $backgroundColor="warning" $color="white" />}
        </>
      }
    >
      <ErrorBoundary key={`${effectiveVersion}/${namespace}`} title={`Could not watch ${type.title}`}>
        <Suspense fallback={<Loading text={`Reading ${type.title}…`} />}>
          <Rows clusterId={clusterId} type={type} version={effectiveVersion} namespace={namespace} tabKey={tabKey} openEditor={setEditor} />
        </Suspense>
      </ErrorBoundary>
    </PageLayout>
  );
});

const NamespaceFilter = ({ clusterId, value, onChange }: { clusterId: string; value: string; onChange: (namespace: string) => void }) => (
  <Div $width={{ width: "10xl" }}>
    <NamespaceSelect clusterId={clusterId} value={value || undefined} onChange={onChange} allowAll />
  </Div>
);

