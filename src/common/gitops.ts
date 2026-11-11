import type { Json } from "./json";

export interface GitOpsOwner {
  readonly tool: "Flux" | "Argo CD" | "Helm" | "Cilium" | "Other";
  readonly detail: string;
  /** Whether a controller will put back what is changed by hand. */
  readonly reconciles: boolean;
}

/** Finds the signs that a resource is managed by GitOps, Helm or a controller, and will be reconciled over manual edits. */
export const detectManagers = (resource: Json): GitOpsOwner[] => {
  const labels: Record<string, string> = resource?.metadata?.labels ?? {};
  const annotations: Record<string, string> = resource?.metadata?.annotations ?? {};
  const managers = ((resource?.metadata?.managedFields ?? []) as Json[]).map((field) => String(field.manager ?? ""));
  const owners: GitOpsOwner[] = [];

  const fluxKustomization = labels["kustomize.toolkit.fluxcd.io/name"];

  if (fluxKustomization) {
    owners.push({
      tool: "Flux",
      detail: `Kustomization ${labels["kustomize.toolkit.fluxcd.io/namespace"] ?? ""}/${fluxKustomization}`,
      reconciles: annotations["kustomize.toolkit.fluxcd.io/reconcile"] !== "disabled",
    });
  }

  const fluxHelm = labels["helm.toolkit.fluxcd.io/name"];

  if (fluxHelm) {
    owners.push({ tool: "Flux", detail: `HelmRelease ${labels["helm.toolkit.fluxcd.io/namespace"] ?? ""}/${fluxHelm}`, reconciles: true });
  }

  const argoTracking = annotations["argocd.argoproj.io/tracking-id"];
  const argoInstance = labels["argocd.argoproj.io/instance"];

  if (argoTracking || argoInstance) {
    owners.push({
      tool: "Argo CD",
      detail: `Application ${argoTracking ? argoTracking.split(":")[0] : argoInstance}`,
      reconciles: annotations["argocd.argoproj.io/sync-options"]?.includes("Prune=false") !== true,
    });
  }

  if (owners.length === 0 && (labels["app.kubernetes.io/managed-by"] === "Helm" || annotations["meta.helm.sh/release-name"])) {
    owners.push({
      tool: "Helm",
      detail: `Release ${annotations["meta.helm.sh/release-namespace"] ?? ""}/${annotations["meta.helm.sh/release-name"] ?? labels["app.kubernetes.io/instance"] ?? "?"}`,
      reconciles: false,
    });
  }

  if (owners.length === 0) {
    const controller = managers.find((manager) => /kustomize-controller|helm-controller|argocd/i.test(manager));

    if (controller) {
      owners.push({ tool: /argocd/i.test(controller) ? "Argo CD" : "Flux", detail: `Last written by ${controller}`, reconciles: true });
    }
  }

  const ownerRefs = (resource?.metadata?.ownerReferences ?? []) as Json[];
  const controllerRef = ownerRefs.find((ref) => ref.controller);

  if (controllerRef) {
    owners.push({
      tool: /cilium/i.test(String(controllerRef.apiVersion)) || controllerRef.kind === "Gateway" ? "Cilium" : "Other",
      detail: `Owned by ${controllerRef.kind} ${controllerRef.name}`,
      reconciles: true,
    });
  }

  return owners;
};

export const describeManagers = (owners: readonly GitOpsOwner[]) =>
  owners.map((owner) => `${owner.tool}: ${owner.detail}${owner.reconciles ? " (reconciled)" : ""}`).join("; ");
