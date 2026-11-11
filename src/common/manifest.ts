import { deepClone, isPlainObject, type Json } from "./json";

const serverOwnedMetadata = ["managedFields", "resourceVersion", "uid", "creationTimestamp", "generation", "selfLink", "deletionTimestamp", "deletionGracePeriodSeconds"];

/** What a manifest looks like to export, clone or keep as a backup: no server-owned fields, no status. */
export const cleanForExport = (resource: Json, { keepStatus = false } = {}): Json => {
  const copy = deepClone(resource);

  if (!isPlainObject(copy)) {
    return copy;
  }

  if (isPlainObject(copy.metadata)) {
    for (const field of serverOwnedMetadata) {
      delete copy.metadata[field];
    }

    if (isPlainObject(copy.metadata.annotations)) {
      delete copy.metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"];

      if (Object.keys(copy.metadata.annotations).length === 0) {
        delete copy.metadata.annotations;
      }
    }

    // Owner references point at uids of one cluster; a copy elsewhere would be garbage-collected.
    delete copy.metadata.ownerReferences;
  }

  if (!keepStatus) {
    delete copy.status;
  }

  return copy;
};

/** What to compare when showing a diff: the managed bits removed, but the resourceVersion is noise too. */
export const cleanForDiff = (resource: Json): Json => {
  const copy = deepClone(resource);

  if (isPlainObject(copy?.metadata)) {
    delete copy.metadata.managedFields;
    delete copy.metadata.resourceVersion;
    delete copy.metadata.generation;
    delete copy.metadata.creationTimestamp;
    delete copy.metadata.uid;

    if (isPlainObject(copy.metadata.annotations)) {
      delete copy.metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"];
    }
  }

  return copy;
};

/** A copy to edit and save back: everything kept, except managedFields, which nobody should hand-edit. */
export const cleanForEdit = (resource: Json): Json => {
  const copy = deepClone(resource);

  if (isPlainObject(copy?.metadata)) {
    delete copy.metadata.managedFields;
  }

  return copy;
};

/** Prepares a clone: a new name, no identity, no status. */
export const cloneManifest = (resource: Json, name: string, namespace?: string): Json => {
  const copy = cleanForExport(resource);

  copy.metadata = { ...(copy.metadata ?? {}), name };
  delete copy.metadata.generateName;

  if (namespace !== undefined) {
    copy.metadata.namespace = namespace;
  }

  return copy;
};

export const resourceKey = (resource: Json) =>
  `${resource?.apiVersion}/${resource?.kind}/${resource?.metadata?.namespace ?? ""}/${resource?.metadata?.name ?? ""}`;
