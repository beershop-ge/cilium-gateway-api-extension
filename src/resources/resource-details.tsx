import { Badge } from "@k8slens/badge";
import { Div, Span } from "@k8slens/element-components";
import { CloseIcon, ContentCopyIcon, DeleteIcon, EditIcon, FileDownloadIcon, OpenInBrowserIcon } from "@k8slens/icon";
import { DangerButton, PlainButton, PrimaryButton } from "@k8slens/input-components";
import { type LightWeightTab, LightWeightTabs } from "@k8slens/tabs-components";
import { useInject } from "@k8slens/use-inject";
import { observer } from "mobx-react";
import { useState } from "react";
import { conditionsOf, healthOfResource } from "../common/conditions";
import { age } from "../common/format";
import { detectManagers } from "../common/gitops";
import type { Json } from "../common/json";
import { evaluateJsonPath, formatJsonPathValue } from "../common/jsonpath";
import { cleanForEdit, cleanForExport } from "../common/manifest";
import { toYaml } from "../common/yaml";
import { clusterContextInjectable } from "../kube/cluster-context.injectable";
import { type ResourceType, versionOf } from "../kube/resource-types";
import { useViewState } from "../navigation/view-state.injectable";
import { Callout, ConditionsList, ErrorState, Facts, HealthBadge, LabelBadges, Loading, Section, useQueryState } from "../ui/components";
import { CodeView, downloadText } from "../ui/code-editor";
import styles from "../ui/ui.module.scss";
import { findReferences } from "./references";
import { resourceActionsInjectable } from "./resource-actions.injectable";

type Tab = "overview" | "yaml" | "events" | "related";

const tabs: readonly LightWeightTab<Tab>[] = [
  { id: "overview", label: "Overview" },
  { id: "yaml", label: "YAML" },
  { id: "events", label: "Events" },
  { id: "related", label: "Related" },
];

export interface ResourceDetailsProps {
  readonly clusterId: string;
  readonly type: ResourceType;
  readonly resource: Json;
  readonly tabKey: string;
  readonly permissions: { readonly update: boolean; readonly create: boolean; readonly delete: boolean };
  readonly onClose: () => void;
  readonly onEdit: () => void;
  readonly onClone: () => void;
  /** A visual tool for this kind, opened with this resource loaded. */
  readonly designer?: { readonly label: string; readonly open: () => void };
}

const Events = observer(({ clusterId, resource }: { clusterId: string; resource: Json }) => {
  const context = useInject(clusterContextInjectable)()(clusterId);
  const query = context.queries.get(`q:events:${resource.metadata.uid}`, () => context.ops.events(resource));
  const state = useQueryState(query, 15);

  if (state.value === undefined) {
    return state.status === "error" ? <ErrorState title="Could not read events" error={state.error} onRetry={() => void query.refresh()} /> : <Loading text="Reading events…" />;
  }

  if (state.value.length === 0) {
    return <Span $color="textMuted">No events (Kubernetes keeps events for about an hour).</Span>;
  }

  return (
    <Div $flex={{ direction: "vertical", gap: "s" }}>
      {state.value.map((event: Json) => (
        <Div key={event.metadata.uid} $flex={{ direction: "vertical", gap: "xxs" }}>
          <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center" }}>
            <Badge small label={event.type ?? "Normal"} $backgroundColor={event.type === "Warning" ? "warning" : "grey40"} $color="white" />
            <Span $font={{ bold: true }}>{event.reason}</Span>
            <Span $color="textMuted" $font={{ size: "s" }}>
              {age(event.lastTimestamp ?? event.eventTime ?? event.metadata.creationTimestamp)} ago{event.count > 1 ? ` · ×${event.count}` : ""} · {event.source?.component ?? event.reportingComponent ?? ""}
            </Span>
          </Div>
          <Span className={styles.wrap} $font={{ size: "s" }}>
            {event.message}
          </Span>
        </Div>
      ))}
    </Div>
  );
});

/** The details of one resource beside its list: status, YAML, events, related resources and the actions on it. */
export const ResourceDetails = observer(({ clusterId, type, resource, tabKey, permissions, onClose, onEdit, onClone, designer }: ResourceDetailsProps) => {
  const actions = useInject(resourceActionsInjectable)();
  const context = useInject(clusterContextInjectable)()(clusterId);
  const [tab, setTab] = useViewState<Tab>(tabKey, "detailsTab", "overview");
  const [showManaged, setShowManaged] = useState(false);
  const health = healthOfResource(resource);
  const conditions = [...conditionsOf(resource.status), ...((resource.status?.parents ?? []) as Json[]).flatMap((parent) => conditionsOf(parent).map((condition) => ({ ...condition, type: `${condition.type} (${parent.parentRef?.name ?? "parent"}${parent.parentRef?.sectionName ? `#${parent.parentRef.sectionName}` : ""})` })))];
  const managers = detectManagers(resource);
  const references = findReferences(resource);
  const version = String(resource.apiVersion ?? "").split("/").pop() ?? type.preferredVersion;
  const columns = versionOf(type, version)?.printerColumns ?? [];
  const readOnly = context.isReadOnly();
  const name = resource.metadata.name;
  const fileName = `${type.kind.toLowerCase()}-${resource.metadata.namespace ? `${resource.metadata.namespace}-` : ""}${name}.yaml`;

  return (
    <Div className={styles.drawer} $flex={{ direction: "vertical" }} role="complementary" aria-label={`${type.kind} ${name}`}>
      <Div $flex={{ direction: "vertical", gap: "s" }} $padding="l">
        <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "top" }}>
          <Div $flex={{ direction: "vertical", gap: "xxs" }} $flexChild>
            <Span $color="textMuted" $font={{ size: "s" }}>
              {type.kind} · {resource.apiVersion}
            </Span>
            <Span $font={{ size: "l", bold: true }} className={styles.wrap}>
              {name}
            </Span>
            {resource.metadata.namespace && <Span $color="textMuted">{resource.metadata.namespace}</Span>}
          </Div>
          <PlainButton Icon={CloseIcon} $onClick={onClose} $tooltip="Close the details">
            <Span $visuallyHidden>Close</Span>
          </PlainButton>
        </Div>
        <Div $flex={{ direction: "horizontal", gap: "xs", wrap: true }}>
          <PrimaryButton Icon={EditIcon} $onClick={onEdit} $enabled={!readOnly && permissions.update} $tooltip={readOnly ? "Read-only mode" : permissions.update ? "Edit with the form, YAML or JSON" : "Your user may not update this kind here"}>
            Edit
          </PrimaryButton>
          {designer && <PlainButton $onClick={designer.open}>{designer.label}</PlainButton>}
          <PlainButton Icon={ContentCopyIcon} $onClick={onClone} $enabled={!readOnly && permissions.create} $tooltip={permissions.create ? "Create a copy under another name" : "Your user may not create this kind here"}>
            Clone
          </PlainButton>
          <PlainButton Icon={FileDownloadIcon} $onClick={() => downloadText(fileName, toYaml(cleanForExport(resource)))} $tooltip="Save the manifest without server fields">
            Export
          </PlainButton>
          <PlainButton Icon={OpenInBrowserIcon} $onClick={() => void actions.openInLensDetails(clusterId, type, resource)} $tooltip="Open in Lens's own details panel">
            Lens
          </PlainButton>
          <DangerButton Icon={DeleteIcon} $onClick={() => void actions.deleteResource(clusterId, type, resource).then((deleted) => deleted && onClose())} $enabled={!readOnly && permissions.delete} $tooltip={permissions.delete ? "Delete, after confirmation and a backup" : "Your user may not delete this kind here"}>
            Delete
          </DangerButton>
        </Div>
        <LightWeightTabs tabs={tabs} selected={tab} onSelect={(next) => next && setTab(next)} />
      </Div>

      <Div $flexChild className={styles.scroll} $padding={{ horizontal: "l", bottom: "l" }} $flex={{ direction: "vertical", gap: "l" }}>
        {tab === "overview" && (
          <>
            {managers.length > 0 && (
              <Callout level={managers.some((manager) => manager.reconciles) ? "warning" : "info"} title="Managed elsewhere">
                {managers.map((manager) => (
                  <div key={manager.detail}>
                    {manager.tool}: {manager.detail}
                    {manager.reconciles ? " — manual edits may be reverted on the next reconciliation" : ""}
                  </div>
                ))}
              </Callout>
            )}
            <Facts
              rows={[
                ["Status", <HealthBadge key="health" health={health.health} reason={health.reason} />],
                health.reason ? ["Reason", health.reason] : undefined,
                ["Created", `${age(resource.metadata.creationTimestamp)} ago (${resource.metadata.creationTimestamp ?? "?"})`],
                ["Generation", `${resource.metadata.generation ?? "—"}${resource.status?.observedGeneration !== undefined ? ` (observed ${resource.status.observedGeneration})` : ""}`],
                ...columns
                  .filter((column) => column.name.toLowerCase() !== "age")
                  .map((column) => [column.name, formatJsonPathValue(evaluateJsonPath(resource, column.jsonPath)) || "—"] as const),
                ["Labels", <LabelBadges key="labels" labels={resource.metadata.labels} limit={20} />],
                ["Annotations", <LabelBadges key="annotations" labels={Object.fromEntries(Object.entries(resource.metadata.annotations ?? {}).filter(([key]) => key !== "kubectl.kubernetes.io/last-applied-configuration")) as Record<string, string>} limit={10} />],
              ]}
            />
            <Section title="Conditions">
              <ConditionsList conditions={conditions} />
            </Section>
          </>
        )}

        {tab === "yaml" && (
          <Div $flex={{ direction: "vertical", gap: "s" }}>
            <PlainButton $onClick={() => setShowManaged(!showManaged)}>{showManaged ? "Hide managedFields" : "Show managedFields"}</PlainButton>
            <CodeView value={toYaml(showManaged ? resource : cleanForEdit(resource))} />
          </Div>
        )}

        {tab === "events" && <Events clusterId={clusterId} resource={resource} />}

        {tab === "related" && (
          <Div $flex={{ direction: "vertical", gap: "s" }}>
            {references.length === 0 && <Span $color="textMuted">This resource references nothing this extension recognises.</Span>}
            {references.map((reference, index) => (
              <Div key={index} $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center" }}>
                <Div $flex={{ direction: "vertical" }} $flexChild>
                  <Span $color="textMuted" $font={{ size: "xs" }}>
                    {reference.label} · {reference.kind}
                  </Span>
                  <Span className={styles.wrap}>
                    {reference.namespace ? `${reference.namespace}/` : ""}
                    {reference.name}
                  </Span>
                </Div>
                <PlainButton $onClick={() => void actions.openRef(clusterId, reference)}>Open</PlainButton>
              </Div>
            ))}
          </Div>
        )}
      </Div>
    </Div>
  );
});
