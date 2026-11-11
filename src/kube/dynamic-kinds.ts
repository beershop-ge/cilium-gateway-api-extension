/* eslint-disable @typescript-eslint/no-explicit-any -- kinds discovered at runtime have no compile-time shape */
import { getKubeResourceKind, getKubernetesApiVersion } from "@k8slens/kubernetes-contracts";
import { apiVersionOf, type ResourceType } from "./resource-types";

const cache = new Map<string, { kind: any; apiVersion: any }>();

/**
 * Lens's kinds and API versions are typed names, so a kind discovered at runtime can be named
 * the same way and used with every Lens contract that takes one: watching, details, the editor.
 */
export const dynamicKindOf = (type: Pick<ResourceType, "kind" | "group">, version: string): { kind: any; apiVersion: any } => {
  const apiVersion = apiVersionOf(type, version);
  const key = `${apiVersion}/${type.kind}`;
  let entry = cache.get(key);

  if (!entry) {
    entry = { kind: getKubeResourceKind<Record<string, any>>(type.kind), apiVersion: getKubernetesApiVersion(apiVersion) };
    cache.set(key, entry);
  }

  return entry;
};
