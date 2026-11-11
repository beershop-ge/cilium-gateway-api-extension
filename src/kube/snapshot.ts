import type { Json } from "../common/json";
import type { ClusterContext } from "./cluster-context.injectable";
import { KubeError } from "./kubectl";

/** Built-in resources composite views read beside the CRDs, by the name kubectl knows them as. */
export type BuiltinResource = "services" | "endpointslices.discovery.k8s.io" | "pods" | "nodes" | "namespaces" | "secrets" | "networkpolicies.networking.k8s.io" | "configmaps";

export interface SnapshotRequest {
  /** Cilium or Gateway API kinds, read only when the cluster serves them. */
  readonly kinds?: readonly string[];
  readonly builtins?: readonly BuiltinResource[];
  /** Narrows namespaced reads to one namespace. */
  readonly namespace?: string;
  /** For secrets: read names only (`-o name` is not enough for namespaces), so values never leave the cluster in full. */
  readonly metadataOnlySecrets?: boolean;
}

export interface Snapshot {
  /** Items by kind (for CRDs) or by builtin resource name. */
  readonly items: Readonly<Record<string, readonly Json[]>>;
  readonly notInstalled: readonly string[];
  readonly errors: ReadonlyArray<{ readonly what: string; readonly message: string; readonly forbidden: boolean }>;
  readonly loadedAt: number;
}

export const snapshotQueryKey = (request: SnapshotRequest) =>
  `q:snapshot:${(request.kinds ?? []).join(",")}|${(request.builtins ?? []).join(",")}|${request.namespace ?? ""}`;

export const emptyItems: readonly Json[] = [];

/** Reads several kinds at once, tolerating ones that are not installed or not allowed, so one gap never blanks a whole view. */
export const loadSnapshot = async (context: ClusterContext, request: SnapshotRequest): Promise<Snapshot> => {
  const discovery = context.discovery.state().value ?? (await context.discovery.refresh(), context.discovery.state().value);

  if (!discovery) {
    throw context.discovery.state().error ?? new KubeError("Other", "Discovery failed");
  }

  const items: Record<string, readonly Json[]> = {};
  const notInstalled: string[] = [];
  const errors: Array<{ what: string; message: string; forbidden: boolean }> = [];
  const scope = request.namespace ? ["--namespace", request.namespace] : ["--all-namespaces"];

  await Promise.all([
    ...(request.kinds ?? []).map(async (kind) => {
      const type = context.typeOfKind(kind);

      if (!type) {
        notInstalled.push(kind);
        items[kind] = emptyItems;

        return;
      }

      const { items: listed, error } = await context.ops.listIfServed(type, type.namespaced ? request.namespace : undefined);

      items[kind] = listed;

      if (error) {
        errors.push({ what: type.title, message: error.message, forbidden: error.kind === "Forbidden" });
      }
    }),
    ...(request.builtins ?? []).map(async (resource) => {
      const clusterScoped = resource === "nodes" || resource === "namespaces";

      try {
        const result = await context.kubectl.json<Json>(["get", resource, ...(clusterScoped ? [] : scope), "--output", "json"], { timeoutMs: 60_000 });
        let listed: Json[] = result?.items ?? [];

        if (resource === "secrets") {
          // Keep what references are checked against; drop every value.
          listed = listed.map((secret) => ({ kind: "Secret", metadata: { name: secret.metadata.name, namespace: secret.metadata.namespace }, type: secret.type, keys: Object.keys(secret.data ?? {}) }));
        }

        items[resource] = listed;
      } catch (error) {
        items[resource] = emptyItems;
        errors.push({ what: resource, message: error instanceof Error ? error.message : String(error), forbidden: error instanceof KubeError && error.kind === "Forbidden" });
      }
    }),
  ]);

  return { items, notInstalled, errors, loadedAt: Date.now() };
};

export const itemsOf = (snapshot: Snapshot | undefined, what: string): readonly Json[] => snapshot?.items[what] ?? emptyItems;
