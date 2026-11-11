import { Div, Span } from "@k8slens/element-components";
import { CloseIcon } from "@k8slens/icon";
import { PlainButton, TextInput } from "@k8slens/input-components";
import { type LightWeightTab, LightWeightTabs } from "@k8slens/tabs-components";
import { useInject } from "@k8slens/use-inject";
import { observer } from "mobx-react";
import { useMemo, useState } from "react";
import { kubernetesNameError } from "../common/format";
import { errorMessage, type Json, setPath } from "../common/json";
import { cleanForEdit } from "../common/manifest";
import { parseSingleYaml, toYaml } from "../common/yaml";
import { clusterContextInjectable } from "../kube/cluster-context.injectable";
import { apiVersionOf, type ResourceType, versionOf } from "../kube/resource-types";
import type { SchemaDefinitions, Schema } from "../schema/schema";
import { validateResource } from "../schema/validate";
import { settingsStoreInjectable } from "../settings/settings.injectable";
import { Callout, ErrorState, FieldLabel, Loading, Select, useQueryState } from "../ui/components";
import { CodeEditor } from "../ui/code-editor";
import { KeyValueEditor, labelKeyError } from "../ui/key-value-editor";
import { ApplyPanel } from "./apply-panel";
import { NamespaceSelect } from "./namespace-select";
import { SchemaForm } from "./schema-form";

export type EditorMode = "create" | "edit" | "clone";

export interface ResourceEditorProps {
  readonly clusterId: string;
  readonly type: ResourceType;
  readonly mode: EditorMode;
  readonly initial: Json;
  /** The resource as live in the cluster, when editing. */
  readonly original?: Json;
  readonly onClose: () => void;
  readonly onSaved?: (result: Json) => void;
}

type View = "form" | "yaml" | "json" | "apply";

const views: readonly LightWeightTab<View>[] = [
  { id: "form", label: "Form" },
  { id: "yaml", label: "YAML" },
  { id: "json", label: "JSON" },
  { id: "apply", label: "Review & apply" },
];

const bodyFields = (schema: Schema | undefined) => Object.keys(schema?.properties ?? {}).filter((key) => !["apiVersion", "kind", "metadata", "status"].includes(key));

/** The schema of a type's version: from discovery when it carried one, else loaded from OpenAPI v3 once. */
export const useSchema = (clusterId: string, type: ResourceType, version: string) => {
  const context = useInject(clusterContextInjectable)()(clusterId);
  const query = context.queries.get(`schema:${type.id}:${version}`, () => context.ops.schemaOf(type, version));

  return useQueryState(query);
};

export const ResourceEditor = observer(({ clusterId, type, mode, initial, original: initialOriginal, onClose, onSaved }: ResourceEditorProps) => {
  const context = useInject(clusterContextInjectable)()(clusterId);
  const settings = useInject(settingsStoreInjectable)();
  const [document, setDocument] = useState<Json>(() => cleanForEdit(initial));
  const [original, setOriginal] = useState<Json | undefined>(initialOriginal);
  const [view, setView] = useState<View>("form");
  const [text, setText] = useState<string>("");
  const [textError, setTextError] = useState<string>();
  const version = String(document?.apiVersion ?? apiVersionOf(type, type.preferredVersion)).split("/").pop()!;
  const schemaState = useSchema(clusterId, type, version);
  const schema = schemaState.value?.schema;
  const definitions: SchemaDefinitions = schemaState.value?.definitions ?? {};
  const readOnly = context.isReadOnly();

  const issues = useMemo(() => validateResource(document, schema, { namespaced: type.namespaced, definitions }), [document, schema, definitions, type.namespaced]);
  const nameError = mode === "edit" ? undefined : kubernetesNameError(document?.metadata?.name ?? "");

  const switchView = (next: View | undefined) => {
    if (!next || next === view) {
      return;
    }

    if ((view === "yaml" || view === "json") && textError) {
      return;
    }

    if (next === "yaml") setText(toYaml(document));
    if (next === "json") setText(JSON.stringify(document, null, 2));
    setTextError(undefined);
    setView(next);
  };

  const editText = (next: string) => {
    setText(next);

    const parsed = view === "json" ? (() => {
      try {
        return { value: JSON.parse(next) as Json };
      } catch (error) {
        return { error: errorMessage(error) };
      }
    })() : parseSingleYaml(next);

    if (parsed.error) {
      setTextError(parsed.error);
    } else {
      setTextError(undefined);
      setDocument(parsed.value);
    }
  };

  const reload = async () => {
    try {
      const latest = await context.ops.get(type, version, document.metadata.name, document.metadata.namespace);

      setOriginal(latest);
      setDocument(setPath(document, ["metadata", "resourceVersion"], latest.metadata.resourceVersion));
    } catch (error) {
      setTextError(`Could not reload: ${errorMessage(error)}`);
    }
  };

  const servedVersions = type.versions.filter((candidate) => candidate.served);
  const title = mode === "create" ? `New ${type.kind}` : mode === "clone" ? `Clone ${type.kind}` : `Edit ${type.kind} ${document?.metadata?.name}`;
  const errorLine = textError ? Number(/line (\d+)/.exec(textError)?.[1]) : undefined;

  return (
    <Div $flex={{ direction: "vertical", gap: "m" }} $padding="l" $height="full">
      <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center" }}>
        <Span $font={{ size: "l", bold: true }} $flexChild>
          {title}
        </Span>
        <PlainButton Icon={CloseIcon} $onClick={onClose}>
          Close editor
        </PlainButton>
      </Div>

      {versionOf(type, version)?.deprecated && (
        <Callout level="warning" title={`${apiVersionOf(type, version)} is deprecated`}>
          {versionOf(type, version)?.deprecationWarning ?? "Prefer a newer served version."}
        </Callout>
      )}

      <LightWeightTabs tabs={views} selected={view} onSelect={switchView} />

      {textError && (view === "yaml" || view === "json") && <Callout level="danger" title="The text does not parse">{textError}</Callout>}

      {view === "form" && (
        <Div $flex={{ direction: "vertical", gap: "l" }}>
          <Div $flex={{ direction: "horizontal", gap: "m", wrap: true }}>
            <Div $width={{ width: "11xl" }}>
              <FieldLabel label="Name" required error={nameError}>
                <TextInput
                  aria-label="Name"
                  value={document?.metadata?.name ?? ""}
                  readOnly={mode === "edit"}
                  onChange={(event) => setDocument(setPath(document, ["metadata", "name"], event.target.value))}
                />
              </FieldLabel>
            </Div>
            {type.namespaced && (
              <Div $width={{ width: "11xl" }}>
                <FieldLabel label="Namespace" required>
                  {mode === "edit" ? (
                    <TextInput aria-label="Namespace" value={document?.metadata?.namespace ?? ""} readOnly />
                  ) : (
                    <NamespaceSelect clusterId={clusterId} value={document?.metadata?.namespace} onChange={(namespace) => setDocument(setPath(document, ["metadata", "namespace"], namespace))} />
                  )}
                </FieldLabel>
              </Div>
            )}
            {servedVersions.length > 1 && (
              <Div $width={{ width: "10xl" }}>
                <FieldLabel label="API version" help={mode === "edit" ? "The server converts between served versions" : undefined}>
                  <Select
                    ariaLabel="API version"
                    value={version}
                    disabled={mode === "edit"}
                    options={servedVersions.map((candidate) => ({ value: candidate.name, label: `${apiVersionOf(type, candidate.name)}${candidate.storage ? " (storage)" : ""}${candidate.deprecated ? " (deprecated)" : ""}` }))}
                    onChange={(next) => setDocument(setPath(document, ["apiVersion"], apiVersionOf(type, next)))}
                  />
                </FieldLabel>
              </Div>
            )}
          </Div>

          <Div $flex={{ direction: "horizontal", gap: "l", wrap: true }}>
            <Div $flexChild $width={{ min: "11xl" }}>
              <FieldLabel label="Labels">
                <KeyValueEditor ariaLabel="labels" value={document?.metadata?.labels} validateKey={labelKeyError} onChange={(labels) => setDocument(setPath(document, ["metadata", "labels"], labels))} />
              </FieldLabel>
            </Div>
            <Div $flexChild $width={{ min: "11xl" }}>
              <FieldLabel label="Annotations">
                <KeyValueEditor ariaLabel="annotations" value={document?.metadata?.annotations} onChange={(annotations) => setDocument(setPath(document, ["metadata", "annotations"], annotations))} />
              </FieldLabel>
            </Div>
          </Div>

          {schemaState.value === undefined && schemaState.status === "error" ? (
            <ErrorState title="Could not load the schema; edit as YAML instead" error={schemaState.error} />
          ) : schemaState.value === undefined ? (
            <Loading text="Loading the schema…" />
          ) : !schema ? (
            <Callout level="info">The API server publishes no schema for this kind; use the YAML editor.</Callout>
          ) : (
            <SchemaForm value={document} onChange={setDocument} schema={schema} definitions={definitions} fields={bodyFields(schema)} issues={issues} />
          )}
        </Div>
      )}

      {(view === "yaml" || view === "json") && (
        <Div $flexChild $flex={{ direction: "vertical" }} $style={{ minHeight: 360 }}>
          <CodeEditor value={text} onChange={editText} ariaLabel={`${type.kind} as ${view.toUpperCase()}`} errorLines={errorLine ? [errorLine] : []} minHeight={360} />
        </Div>
      )}

      {view === "apply" && (
        <ApplyPanel
          clusterId={clusterId}
          documents={[document]}
          originals={original ? [original] : []}
          issues={[...issues, ...(nameError ? [{ path: ["metadata", "name"], message: nameError, severity: "error" as const }] : [])]}
          modes={mode === "edit" ? ["replace", "server-side-apply"] : ["create", "server-side-apply"]}
          defaultMode={mode === "edit" ? settings.get().defaultWriteMode : "create"}
          description={mode === "edit" ? `Update ${type.kind} ${document?.metadata?.name}` : `Create ${type.kind} ${document?.metadata?.name}`}
          onReload={mode === "edit" ? () => void reload() : undefined}
          onApplied={(results) => {
            onSaved?.(results[0]);
            onClose();
          }}
        />
      )}

      {view !== "apply" && (
        <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center" }}>
          <Span $color={issues.some((issue) => issue.severity === "error") || nameError ? "critical" : "textMuted"} $font={{ size: "s" }} $flexChild>
            {issues.filter((issue) => issue.severity === "error").length + (nameError ? 1 : 0)} error(s) against the {schema ? "installed schema" : "metadata rules"}
            {readOnly ? " · read-only mode" : ""}
          </Span>
          <PlainButton $onClick={() => switchView("apply")} $enabled={!textError}>
            Review & apply →
          </PlainButton>
        </Div>
      )}
    </Div>
  );
});
