/* eslint-disable @typescript-eslint/no-explicit-any -- Kubernetes objects are read defensively as untyped JSON */
export type Json = any;
export type JsonObject = Record<string, Json>;
export type Path = ReadonlyArray<string | number>;

export const isPlainObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const deepClone = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));

export const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) {
    return true;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a).filter((key) => a[key] !== undefined);
    const keysB = Object.keys(b).filter((key) => b[key] !== undefined);

    return keysA.length === keysB.length && keysA.every((key) => deepEqual(a[key], b[key]));
  }

  return false;
};

export const getPath = (value: Json, path: Path): Json => {
  let current = value;

  for (const segment of path) {
    if (current === null || current === undefined) {
      return undefined;
    }

    current = current[segment];
  }

  return current;
};

/**
 * Returns a copy of `root` with `value` at `path`, creating containers on the way.
 * Everything not on the path is kept as it was, so unknown fields survive form edits.
 */
export const setPath = (root: Json, path: Path, value: Json): Json => {
  if (path.length === 0) {
    return value;
  }

  const [head, ...rest] = path;
  const container = root ?? (typeof head === "number" ? [] : {});

  if (Array.isArray(container)) {
    const copy = [...container];
    const index = Number(head);

    copy[index] = setPath(copy[index], rest, value);

    return copy;
  }

  return { ...container, [head]: setPath(container[head], rest, value) };
};

/** Returns a copy of `root` without what is at `path`; removes the array element when the last segment indexes one. */
export const deletePath = (root: Json, path: Path): Json => {
  if (path.length === 0 || root === null || root === undefined) {
    return root;
  }

  const [head, ...rest] = path;

  if (rest.length === 0) {
    if (Array.isArray(root)) {
      return root.filter((_, index) => index !== Number(head));
    }

    const { [head]: _removed, ...others } = root;

    return others;
  }

  if (getPath(root, [head]) === undefined) {
    return root;
  }

  if (Array.isArray(root)) {
    const copy = [...root];

    copy[Number(head)] = deletePath(copy[Number(head)], rest);

    return copy;
  }

  return { ...root, [head]: deletePath(root[head], rest) };
};

/** Removes empty objects and arrays left behind by form edits, but never inside `keep` paths. */
export const pruneEmpty = (value: Json): Json => {
  if (Array.isArray(value)) {
    return value.map(pruneEmpty);
  }

  if (isPlainObject(value)) {
    const result: JsonObject = {};

    for (const [key, child] of Object.entries(value)) {
      const pruned = pruneEmpty(child);

      if (pruned === undefined) {
        continue;
      }

      result[key] = pruned;
    }

    return result;
  }

  return value;
};

export const pathToString = (path: Path) =>
  path.reduce<string>((text, segment) => (typeof segment === "number" ? `${text}[${segment}]` : text ? `${text}.${segment}` : segment), "");

export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
