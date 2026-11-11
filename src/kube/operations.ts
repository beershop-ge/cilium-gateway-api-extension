import { deepClone, type Json } from "../common/json";
import { toYamlDocuments } from "../common/yaml";
import type { Schema, SchemaDefinitions } from "../schema/schema";
import { KubeError, type KubectlClient } from "./kubectl";
import {
  apiVersionOf,
  builtinTypes,
  kubectlResourceName,
  type ResourceType,
  resourceTypesFromApiResources,
  resourceTypesFromCrds,
  schemaFromOpenApi,
} from "./resource-types";

export const fieldManager = "cilium-network-manager";

export type WriteMode = "create" | "replace" | "server-side-apply";

export interface WriteRequest {
  readonly documents: readonly Json[];
  readonly mode: WriteMode;
  readonly dryRun: boolean;
  /** Server-side apply only: take ownership of fields another manager owns. */
  readonly forceConflicts?: boolean;
}

export interface Discovery {
  readonly types: readonly ResourceType[];
  /** How the types were found: from the CRDs themselves (with schemas) or from API discovery alone. */
  readonly source: "crds" | "api-resources";
  readonly crds: readonly CrdSummary[];
  readonly warnings: readonly string[];
}

export interface CrdSummary {
  readonly name: string;
  readonly group: string;
  readonly kind: string;
  readonly scope: string;
  readonly versions: ReadonlyArray<{ readonly name: string; readonly served: boolean; readonly storage: boolean; readonly deprecated: boolean }>;
  readonly storedVersions: readonly string[];
  readonly established: boolean;
  readonly createdAt?: string;
  readonly bundleVersion?: string;
  readonly channel?: string;
}

const summarizeCrds = (crdList: Json): CrdSummary[] =>
  ((crdList?.items ?? []) as Json[]).map((crd) => ({
    name: crd.metadata.name,
    group: crd.spec.group,
    kind: crd.spec.names.kind,
    scope: crd.spec.scope,
    versions: ((crd.spec.versions ?? []) as Json[]).map((version) => ({
      name: version.name,
      served: version.served !== false,
      storage: version.storage === true,
      deprecated: version.deprecated === true,
    })),
    storedVersions: crd.status?.storedVersions ?? [],
    established: ((crd.status?.conditions ?? []) as Json[]).some((condition) => condition.type === "Established" && condition.status === "True"),
    createdAt: crd.metadata.creationTimestamp,
    bundleVersion: crd.metadata.annotations?.["gateway.networking.k8s.io/bundle-version"],
    channel: crd.metadata.annotations?.["gateway.networking.k8s.io/channel"],
  }));

export const createResourceOperations = (kubectl: KubectlClient) => {
  const namespaceArgs = (type: Pick<ResourceType, "namespaced">, namespace?: string) =>
    type.namespaced ? (namespace ? ["--namespace", namespace] : ["--all-namespaces"]) : [];

  const discover = async (): Promise<Discovery> => {
    const warnings: string[] = [];

    try {
      const crdList = await kubectl.json<Json>(["get", "customresourcedefinitions.apiextensions.k8s.io", "--output", "json"], { timeoutMs: 60_000 });
      const relevant = { items: ((crdList?.items ?? []) as Json[]).filter((crd) => resourceTypesFromCrds({ items: [crd] }).length > 0) };

      return { types: [...resourceTypesFromCrds(crdList), ...builtinTypes], source: "crds", crds: summarizeCrds(relevant), warnings };
    } catch (error) {
      if (!(error instanceof KubeError) || error.kind !== "Forbidden") {
        throw error;
      }

      warnings.push("Listing CustomResourceDefinitions is forbidden for your user: resource types come from API discovery, and forms fall back to the OpenAPI schema.");
    }

    const output = await kubectl.run(["api-resources", "--output", "wide", "--no-headers"]);

    return { types: [...resourceTypesFromApiResources(output), ...builtinTypes], source: "api-resources", crds: [], warnings };
  };

  /** The schema of one version of a type: from the CRD when discovery had it, else from the API server's OpenAPI v3. */
  const schemaOf = async (type: ResourceType, version: string): Promise<{ schema?: Schema; definitions?: SchemaDefinitions }> => {
    const known = type.versions.find((candidate) => candidate.name === version);

    if (known?.schema) {
      return { schema: known.schema, definitions: known.definitions };
    }

    const path = type.group ? `/openapi/v3/apis/${type.group}/${version}` : `/openapi/v3/api/${version}`;
    const document = await kubectl.json<Json>(["get", "--raw", path], { timeoutMs: 60_000 });

    return schemaFromOpenApi(document, type.group, version, type.kind);
  };

  const get = (type: ResourceType, version: string, name: string, namespace?: string): Promise<Json> =>
    kubectl.json(["get", kubectlResourceName(type, version), name, ...(type.namespaced && namespace ? ["--namespace", namespace] : []), "--output", "json"]);

  const list = async (type: ResourceType, version: string, namespace?: string): Promise<Json[]> => {
    const result = await kubectl.json<Json>(["get", kubectlResourceName(type, version), ...namespaceArgs(type, namespace), "--output", "json"], { timeoutMs: 60_000 });

    return result?.items ?? [];
  };

  /** Lists one type, treating "not installed" as empty: for views that combine many optional types. */
  const listIfServed = async (type: ResourceType | undefined, namespace?: string): Promise<{ items: Json[]; error?: KubeError }> => {
    if (!type) {
      return { items: [] };
    }

    try {
      return { items: await list(type, type.preferredVersion, namespace) };
    } catch (error) {
      const kubeError = error instanceof KubeError ? error : new KubeError("Other", String(error));

      return { items: [], error: kubeError.kind === "NotServed" ? undefined : kubeError };
    }
  };

  /**
   * Creates, replaces or server-side applies documents, optionally as a server dry-run, and returns
   * what the server made of them. A replace carries the resourceVersion that was read, so the
   * server refuses it as a conflict when the resource changed in between.
   */
  const write = async ({ documents, mode, dryRun, forceConflicts }: WriteRequest): Promise<Json[]> => {
    if (documents.length === 0) {
      return [];
    }

    const args =
      mode === "create"
        ? ["create"]
        : mode === "replace"
          ? ["replace"]
          : ["apply", "--server-side", `--field-manager=${fieldManager}`, ...(forceConflicts ? ["--force-conflicts"] : [])];

    const result = await kubectl.json<Json>([...args, ...(dryRun ? ["--dry-run=server"] : []), "--filename", "-", "--output", "json"], {
      input: toYamlDocuments(documents),
      timeoutMs: 60_000,
    });

    return result?.kind === "List" ? (result.items ?? []) : [result];
  };

  const remove = async (type: ResourceType, version: string, name: string, namespace: string | undefined, { dryRun = false } = {}) => {
    await kubectl.run([
      "delete",
      kubectlResourceName(type, version),
      name,
      ...(type.namespaced && namespace ? ["--namespace", namespace] : []),
      "--wait=false",
      ...(dryRun ? ["--dry-run=server"] : []),
    ]);
  };

  /** Merge-patches a resource, guarded by its uid so a recreated namesake is never patched instead. */
  const mergePatch = async (type: ResourceType, version: string, resource: Json, patch: Json, { dryRun = false } = {}): Promise<Json> => {
    const guarded = deepClone(patch);

    guarded.metadata = { ...(guarded.metadata ?? {}), uid: resource.metadata.uid };

    return kubectl.json([
      "patch",
      kubectlResourceName(type, version),
      resource.metadata.name,
      ...(type.namespaced ? ["--namespace", resource.metadata.namespace] : []),
      "--type=merge",
      "--patch",
      JSON.stringify(guarded),
      ...(dryRun ? ["--dry-run=server"] : []),
      "--output",
      "json",
    ]);
  };

  const events = async (resource: Json): Promise<Json[]> => {
    const uid = resource?.metadata?.uid;

    if (!uid) {
      return [];
    }

    const result = await kubectl.json<Json>(["get", "events", "--all-namespaces", "--field-selector", `involvedObject.uid=${uid}`, "--output", "json"]);

    return ((result?.items ?? []) as Json[]).sort((a, b) =>
      String(b.lastTimestamp ?? b.eventTime ?? b.metadata?.creationTimestamp ?? "").localeCompare(String(a.lastTimestamp ?? a.eventTime ?? a.metadata?.creationTimestamp ?? "")),
    );
  };

  /** Asks the API server whether the user may do something, the way `kubectl auth can-i` does. */
  const canI = async (verb: string, type: Pick<ResourceType, "group" | "plural" | "namespaced">, namespace?: string): Promise<boolean> => {
    const resource = type.group ? `${type.plural}.${type.group}` : type.plural;

    try {
      const output = await kubectl.run(["auth", "can-i", verb, resource, ...(type.namespaced ? (namespace ? ["--namespace", namespace] : ["--all-namespaces"]) : [])]);

      return output.trim().startsWith("yes");
    } catch (error) {
      // `can-i` exits non-zero to say no.
      if (error instanceof KubeError && /^no\b/m.test(error.message)) {
        return false;
      }

      if (error instanceof KubeError && error.kind === "Other" && error.message.trim() === "") {
        return false;
      }

      return false;
    }
  };

  return { discover, schemaOf, get, list, listIfServed, write, remove, mergePatch, events, canI, apiVersionOf };
};

export type ResourceOperations = ReturnType<typeof createResourceOperations>;
