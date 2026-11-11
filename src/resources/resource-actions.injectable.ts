import { navigateToKubeResourceDetailsInjectionToken } from "@k8slens/details-panel-contracts";
import { getInjectable2 } from "@k8slens/injectable";
import { configMapKind, coreV1, discoveryV1, endpointSliceKind, namespaceKind, nodeKind, podKind, secretKind, serviceKind } from "@k8slens/kubernetes-contracts";
import { navigateToKubeResourceEditorInjectionToken } from "@k8slens/kubernetes-resources-contracts";
import { isNavigationSupersededError } from "@k8slens/navigation-contracts";
import { type Json } from "../common/json";
import { cleanForExport, resourceKey } from "../common/manifest";
import { assessChange } from "../common/risk";
import { toYamlDocuments } from "../common/yaml";
import { clusterContextInjectable } from "../kube/cluster-context.injectable";
import { dynamicKindOf } from "../kube/dynamic-kinds";
import { KubeError } from "../kube/kubectl";
import type { WriteMode } from "../kube/operations";
import { apiVersionOf, type ResourceType } from "../kube/resource-types";
import { openCiliumPageInjectable } from "../navigation/open-page.injectable";
import { resourcePageId } from "../navigation/pages";
import { backupStoreInjectable, settingsStoreInjectable } from "../settings/settings.injectable";
import { confirmInjectable } from "../ui/confirm-modal.injectable";
import { notifyInjectable } from "../ui/notify.injectable";

export interface ResourceRef {
  readonly kind: string;
  readonly name: string;
  readonly namespace?: string;
  readonly group?: string;
}

export const refOf = (resource: Json): ResourceRef => ({
  kind: resource?.kind,
  name: resource?.metadata?.name,
  namespace: resource?.metadata?.namespace,
  group: String(resource?.apiVersion ?? "").includes("/") ? String(resource.apiVersion).split("/")[0] : "",
});

const builtinDetails: Record<string, { kind: unknown; apiVersion: unknown }> = {
  Service: { kind: serviceKind, apiVersion: coreV1 },
  Pod: { kind: podKind, apiVersion: coreV1 },
  Secret: { kind: secretKind, apiVersion: coreV1 },
  ConfigMap: { kind: configMapKind, apiVersion: coreV1 },
  Namespace: { kind: namespaceKind, apiVersion: coreV1 },
  Node: { kind: nodeKind, apiVersion: coreV1 },
  EndpointSlice: { kind: endpointSliceKind, apiVersion: discoveryV1 },
};

export interface ApplyRequest {
  readonly documents: readonly Json[];
  /** What the documents replace, as read from the cluster, for the backup and the diff. */
  readonly originals?: readonly Json[];
  readonly mode: WriteMode;
  readonly forceConflicts?: boolean;
  readonly description: string;
}

/** Everything that reads or changes a resource on behalf of the user, gated by read-only mode and backed up first. */
export const resourceActionsInjectable = getInjectable2({
  id: "cilium-ui-resource-actions",
  consumptions: [navigateToKubeResourceDetailsInjectionToken, navigateToKubeResourceEditorInjectionToken],

  instantiate: (di) => {
    const contextOf = di.inject(clusterContextInjectable)();
    const settings = di.inject(settingsStoreInjectable)();
    const backups = di.inject(backupStoreInjectable)();
    const notify = di.inject(notifyInjectable)();
    const confirm = di.inject(confirmInjectable)();
    const openPage = di.inject(openCiliumPageInjectable)();
    const navigateToDetails = di.inject(navigateToKubeResourceDetailsInjectionToken)();
    const navigateToEditor = di.inject(navigateToKubeResourceEditorInjectionToken)();

    const assertWritable = (clusterId: string) => {
      if (settings.isReadOnly(clusterId)) {
        throw new KubeError("Forbidden", "Read-only mode is on for this cluster. Turn it off in Configuration › Extension Settings to make changes.");
      }
    };

    const backup = async (clusterId: string, action: string, resources: readonly Json[]) => {
      const existing = resources.filter((resource) => resource?.metadata?.uid);

      if (existing.length > 0) {
        await backups.add(clusterId, {
          action,
          summary: existing.map((resource) => `${resource.kind} ${resource.metadata.namespace ? `${resource.metadata.namespace}/` : ""}${resource.metadata.name}`).join(", "),
          yaml: toYamlDocuments(existing.map((resource) => cleanForExport(resource))),
        });
      }
    };

    const dryRun = async (clusterId: string, request: Pick<ApplyRequest, "documents" | "mode" | "forceConflicts">) =>
      contextOf(clusterId).ops.write({ documents: request.documents, mode: request.mode, dryRun: true, forceConflicts: request.forceConflicts });

    const apply = async (clusterId: string, request: ApplyRequest) => {
      assertWritable(clusterId);

      const context = contextOf(clusterId);

      await backup(clusterId, request.description, request.originals ?? []);

      const results = await context.ops.write({ documents: request.documents, mode: request.mode, dryRun: false, forceConflicts: request.forceConflicts });

      context.invalidate();
      notify.success(`${request.description}: ${results.length === 1 ? `${results[0]?.kind} ${results[0]?.metadata?.name} saved` : `${results.length} resources saved`}`);

      return results;
    };

    const deleteResource = async (clusterId: string, type: ResourceType, resource: Json): Promise<boolean> => {
      assertWritable(clusterId);

      const name = resource.metadata.name;
      const namespace = resource.metadata.namespace;
      const ok = await confirm({
        title: `Delete ${type.kind}`,
        message: `Delete ${type.kind} "${namespace ? `${namespace}/` : ""}${name}" from this cluster? A backup of its manifest is kept under Configuration › Backups.`,
        confirmLabel: "Delete",
        danger: true,
        typeToConfirm: settings.get().confirmDeleteByTyping ? name : undefined,
        risks: assessChange(resource, undefined),
      });

      if (!ok) {
        return false;
      }

      const context = contextOf(clusterId);
      const version = String(resource.apiVersion ?? "").split("/").pop() ?? type.preferredVersion;

      try {
        // A dry run first, so admission webhooks and finalizer problems surface before anything is lost.
        await context.ops.remove(type, version, name, namespace, { dryRun: true });
        await backup(clusterId, `Delete ${type.kind}`, [resource]);
        await context.ops.remove(type, version, name, namespace);
        context.invalidate();
        notify.success(`${type.kind} ${name} deleted`);

        return true;
      } catch (error) {
        notify.error(error, `Could not delete ${type.kind} ${name}`);

        return false;
      }
    };

    const showError = (error: unknown) => {
      if (!isNavigationSupersededError(error)) {
        notify.error(error);
      }
    };

    /** Opens a referenced resource: in this extension's page when it is a Cilium or Gateway API kind, else in Lens's details. */
    const openRef = async (clusterId: string, ref: ResourceRef) => {
      const context = contextOf(clusterId);
      const type = context.typeOfKind(ref.kind, ref.group || undefined) ?? context.typeOfKind(ref.kind);

      try {
        if (type) {
          await openPage(clusterId, resourcePageId(type), { name: ref.name, namespace: type.namespaced ? ref.namespace : undefined });
        } else if (builtinDetails[ref.kind]) {
          const builtin = builtinDetails[ref.kind];

          await navigateToDetails({
            clusterId,
            kind: builtin.kind,
            apiVersion: builtin.apiVersion,
            ref: ref.namespace ? { name: ref.name, namespace: ref.namespace } : { name: ref.name },
          } as never);
        } else {
          notify.info(`${ref.kind} ${ref.name} is not a kind this cluster serves or Lens can show.`);
        }
      } catch (error) {
        showError(error);
      }
    };

    const openInLensDetails = async (clusterId: string, type: ResourceType, resource: Json) => {
      const { kind, apiVersion } = dynamicKindOf(type, String(resource.apiVersion ?? apiVersionOf(type, type.preferredVersion)).split("/").pop()!);

      try {
        await navigateToDetails({ clusterId, kind, apiVersion, ref: type.namespaced ? { name: resource.metadata.name, namespace: resource.metadata.namespace } : { name: resource.metadata.name } } as never);
      } catch (error) {
        showError(error);
      }
    };

    const openInLensEditor = async (clusterId: string, type: ResourceType, resource: Json) => {
      const { kind, apiVersion } = dynamicKindOf(type, String(resource.apiVersion ?? "").split("/").pop() ?? type.preferredVersion);

      try {
        await navigateToEditor({ clusterId, kind, apiVersion, ref: type.namespaced ? { name: resource.metadata.name, namespace: resource.metadata.namespace } : { name: resource.metadata.name } } as never);
      } catch (error) {
        showError(error);
      }
    };

    return () => ({ assertWritable, dryRun, apply, deleteResource, openRef, openInLensDetails, openInLensEditor, backup, resourceKey });
  },
});

export type ResourceActions = ReturnType<ReturnType<(typeof resourceActionsInjectable)["instantiate"]>>;
