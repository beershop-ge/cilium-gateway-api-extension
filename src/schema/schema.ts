import { isPlainObject, type Json, type Path } from "../common/json";

/** The subset of OpenAPI v3 / JSON Schema that Kubernetes structural schemas use. */
export interface Schema {
  readonly type?: "object" | "array" | "string" | "integer" | "number" | "boolean";
  readonly description?: string;
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly additionalProperties?: Schema | boolean;
  readonly items?: Schema;
  readonly required?: readonly string[];
  readonly enum?: readonly Json[];
  readonly default?: Json;
  readonly format?: string;
  readonly pattern?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: boolean;
  readonly exclusiveMaximum?: boolean;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minProperties?: number;
  readonly maxProperties?: number;
  readonly nullable?: boolean;
  readonly oneOf?: readonly Schema[];
  readonly anyOf?: readonly Schema[];
  readonly allOf?: readonly Schema[];
  readonly not?: Schema;
  readonly $ref?: string;
  readonly "x-kubernetes-preserve-unknown-fields"?: boolean;
  readonly "x-kubernetes-int-or-string"?: boolean;
  readonly "x-kubernetes-embedded-resource"?: boolean;
  readonly "x-kubernetes-list-type"?: string;
  readonly "x-kubernetes-list-map-keys"?: readonly string[];
  readonly "x-kubernetes-map-type"?: string;
  readonly "x-kubernetes-validations"?: ReadonlyArray<{ readonly rule: string; readonly message?: string }>;
}

export type SchemaDefinitions = Readonly<Record<string, Schema>>;

/**
 * Resolves `$ref` (OpenAPI v3 components) and folds `allOf` into one schema, so the form and the
 * validator see one flat node. `oneOf`/`anyOf` are kept for the validator to consider.
 */
export const resolveSchema = (schema: Schema | undefined, definitions: SchemaDefinitions = {}, depth = 0): Schema => {
  if (!schema || depth > 32) {
    return {};
  }

  let resolved: Schema = schema;

  if (schema.$ref) {
    const name = schema.$ref.replace(/^#\/components\/schemas\//, "").replace(/^#\/definitions\//, "");
    const target = definitions[name];
    const { $ref: _ref, ...rest } = schema;

    resolved = { ...resolveSchema(target, definitions, depth + 1), ...rest };
  }

  if (resolved.allOf && resolved.allOf.length > 0) {
    const { allOf, ...rest } = resolved;

    resolved = allOf.reduce<Schema>((merged, part) => mergeSchemas(merged, resolveSchema(part, definitions, depth + 1)), rest);
  }

  return resolved;
};

const mergeSchemas = (a: Schema, b: Schema): Schema => ({
  ...a,
  ...b,
  properties: a.properties || b.properties ? { ...(a.properties ?? {}), ...(b.properties ?? {}) } : undefined,
  required: a.required || b.required ? [...new Set([...(a.required ?? []), ...(b.required ?? [])])] : undefined,
});

export const childSchema = (schema: Schema, key: string | number, definitions: SchemaDefinitions = {}): Schema | undefined => {
  const resolved = resolveSchema(schema, definitions);

  if (typeof key === "number") {
    return resolved.items ? resolveSchema(resolved.items, definitions) : undefined;
  }

  const property = resolved.properties?.[key];

  if (property) {
    return resolveSchema(property, definitions);
  }

  if (isPlainObject(resolved.additionalProperties)) {
    return resolveSchema(resolved.additionalProperties, definitions);
  }

  return resolved["x-kubernetes-preserve-unknown-fields"] ? {} : undefined;
};

/** The schema at a path of the document, or undefined when the schema does not describe it. */
export const schemaAt = (schema: Schema | undefined, path: Path, definitions: SchemaDefinitions = {}): Schema | undefined => {
  let current: Schema | undefined = schema ? resolveSchema(schema, definitions) : undefined;

  for (const segment of path) {
    if (!current) {
      return undefined;
    }

    current = childSchema(current, segment, definitions);
  }

  return current;
};

/** Whether the installed schema has a field: how the UI decides whether a feature exists in this cluster's CRD version. */
export const schemaHasPath = (schema: Schema | undefined, path: readonly string[], definitions: SchemaDefinitions = {}) => {
  let current: Schema | undefined = schema ? resolveSchema(schema, definitions) : undefined;

  for (const segment of path) {
    if (!current) {
      return false;
    }

    const resolved: Schema = current.type === "array" && current.items ? resolveSchema(current.items, definitions) : current;

    current = resolved.properties?.[segment] ? resolveSchema(resolved.properties[segment], definitions) : undefined;
  }

  return current !== undefined;
};

/** The enum values of a field in the installed schema, for options such as listener protocols. */
export const enumAt = (schema: Schema | undefined, path: readonly string[], definitions: SchemaDefinitions = {}): readonly Json[] | undefined => {
  let current: Schema | undefined = schema ? resolveSchema(schema, definitions) : undefined;

  for (const segment of path) {
    if (!current) {
      return undefined;
    }

    const resolved: Schema = current.type === "array" && current.items ? resolveSchema(current.items, definitions) : current;

    current = resolved.properties?.[segment] ? resolveSchema(resolved.properties[segment], definitions) : undefined;
  }

  const final = current?.type === "array" && current.items ? resolveSchema(current.items, definitions) : current;

  return final?.enum;
};

export const typeOfValue = (value: Json): Schema["type"] | "null" | undefined => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "object") return "object";

  return undefined;
};

/** The effective type of a schema node, inferring object/array from its keywords when `type` is absent. */
export const effectiveType = (schema: Schema): Schema["type"] | "int-or-string" | "any" => {
  if (schema["x-kubernetes-int-or-string"]) return "int-or-string";
  if (schema.type) return schema.type;
  if (schema.properties || schema.additionalProperties || schema.required) return "object";
  if (schema.items) return "array";
  if (schema.enum && schema.enum.every((value) => typeof value === "string")) return "string";

  return "any";
};

/** A minimal value for a new field: the default, or an empty value of the right type. */
export const emptyValueFor = (schema: Schema, definitions: SchemaDefinitions = {}): Json => {
  const resolved = resolveSchema(schema, definitions);

  if (resolved.default !== undefined) {
    return resolved.default;
  }

  switch (effectiveType(resolved)) {
    case "object":
      return skeletonFor(resolved, definitions);
    case "array":
      return [];
    case "boolean":
      return false;
    case "integer":
    case "number":
      return resolved.minimum ?? 0;
    case "string":
      return resolved.enum?.[0] ?? "";
    case "int-or-string":
      return "";
    default:
      return {};
  }
};

/** An object holding only its required fields, recursively: the starting point of a new resource. */
export const skeletonFor = (schema: Schema, definitions: SchemaDefinitions = {}, depth = 0): Json => {
  const resolved = resolveSchema(schema, definitions);
  const result: Record<string, Json> = {};

  if (depth > 8) {
    return result;
  }

  for (const key of resolved.required ?? []) {
    const property = resolved.properties?.[key];

    if (property) {
      const child = resolveSchema(property, definitions);

      result[key] = effectiveType(child) === "object" ? skeletonFor(child, definitions, depth + 1) : emptyValueFor(child, definitions);
    }
  }

  return result;
};

export const shortDescription = (schema: Schema | undefined): string | undefined => {
  const text = schema?.description?.trim();

  if (!text) {
    return undefined;
  }

  const firstParagraph = text.split(/\n\s*\n/)[0].replace(/\s+/g, " ");

  return firstParagraph.length > 400 ? `${firstParagraph.slice(0, 399)}…` : firstParagraph;
};
