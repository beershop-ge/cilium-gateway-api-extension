import { isPlainObject, type Json, type Path, pathToString } from "../common/json";
import { effectiveType, resolveSchema, type Schema, type SchemaDefinitions } from "./schema";

export interface ValidationIssue {
  readonly path: Path;
  readonly message: string;
  /** Errors are refused by the API server; warnings (unknown fields that will be pruned) are not. */
  readonly severity: "error" | "warning";
}

const metadataFields = new Set(["apiVersion", "kind", "metadata", "status"]);

/**
 * Validates a value against a structural schema, as the API server would before admission:
 * types, required fields, enums, bounds, lengths, patterns and list uniqueness. CEL rules
 * (`x-kubernetes-validations`) are left to the server's dry-run, which evaluates them for real.
 */
export const validate = (value: Json, schema: Schema | undefined, definitions: SchemaDefinitions = {}, path: Path = [], issues: ValidationIssue[] = []): ValidationIssue[] => {
  if (!schema) {
    return issues;
  }

  const resolved = resolveSchema(schema, definitions);
  const error = (message: string) => issues.push({ path, message, severity: "error" });

  if (value === null || value === undefined) {
    if (value === null && !resolved.nullable && path.length > 0) {
      error("must not be null");
    }

    return issues;
  }

  if (resolved.oneOf || resolved.anyOf) {
    const alternatives = (resolved.oneOf ?? resolved.anyOf)!;
    const passing = alternatives.filter((alternative) => validate(value, alternative, definitions, path, []).filter((issue) => issue.severity === "error").length === 0);

    // Structural schemas use oneOf/anyOf only to require one of several fields; report it plainly.
    if (passing.length === 0 && alternatives.every((alternative) => alternative.required)) {
      error(`must set ${resolved.oneOf ? "exactly one" : "at least one"} of: ${alternatives.map((alternative) => alternative.required!.join("+")).join(", ")}`);
    }

    if (resolved.oneOf && passing.length > 1 && alternatives.every((alternative) => alternative.required)) {
      error(`must set only one of: ${alternatives.map((alternative) => alternative.required!.join("+")).join(", ")}`);
    }
  }

  const type = effectiveType(resolved);

  switch (type) {
    case "object": {
      if (!isPlainObject(value)) {
        error("must be an object");

        return issues;
      }

      for (const key of resolved.required ?? []) {
        if (value[key] === undefined) {
          issues.push({ path: [...path, key], message: "is required", severity: "error" });
        }
      }

      const count = Object.keys(value).length;

      if (resolved.minProperties !== undefined && count < resolved.minProperties) error(`must have at least ${resolved.minProperties} entries`);
      if (resolved.maxProperties !== undefined && count > resolved.maxProperties) error(`must have at most ${resolved.maxProperties} entries`);

      for (const [key, child] of Object.entries(value)) {
        const property = resolved.properties?.[key];

        if (property) {
          validate(child, property, definitions, [...path, key], issues);
        } else if (isPlainObject(resolved.additionalProperties)) {
          validate(child, resolved.additionalProperties, definitions, [...path, key], issues);
        } else if (
          resolved.properties &&
          !resolved["x-kubernetes-preserve-unknown-fields"] &&
          resolved.additionalProperties !== true &&
          !(path.length === 0 && metadataFields.has(key))
        ) {
          issues.push({ path: [...path, key], message: "is not in the schema and will be dropped by the API server", severity: "warning" });
        }
      }

      break;
    }

    case "array": {
      if (!Array.isArray(value)) {
        error("must be a list");

        return issues;
      }

      if (resolved.minItems !== undefined && value.length < resolved.minItems) error(`must have at least ${resolved.minItems} items`);
      if (resolved.maxItems !== undefined && value.length > resolved.maxItems) error(`must have at most ${resolved.maxItems} items`);

      if (resolved["x-kubernetes-list-type"] === "set") {
        const seen = new Set(value.map((item) => JSON.stringify(item)));

        if (seen.size !== value.length) error("must not contain duplicates");
      }

      const mapKeys = resolved["x-kubernetes-list-map-keys"];

      if (resolved["x-kubernetes-list-type"] === "map" && mapKeys) {
        const seen = new Set<string>();

        value.forEach((item, index) => {
          const keyValue = JSON.stringify(mapKeys.map((key) => item?.[key]));

          if (seen.has(keyValue)) {
            issues.push({ path: [...path, index], message: `duplicates ${mapKeys.join("/")} of another item`, severity: "error" });
          }

          seen.add(keyValue);
        });
      }

      value.forEach((item, index) => validate(item, resolved.items, definitions, [...path, index], issues));
      break;
    }

    case "string":
      if (typeof value !== "string") {
        error("must be a string");
        break;
      }

      if (resolved.minLength !== undefined && value.length < resolved.minLength) error(`must be at least ${resolved.minLength} characters`);
      if (resolved.maxLength !== undefined && value.length > resolved.maxLength) error(`must be at most ${resolved.maxLength} characters`);

      if (resolved.pattern) {
        try {
          if (!new RegExp(resolved.pattern, "u").test(value)) error(`must match ${resolved.pattern}`);
        } catch {
          // A pattern written for Go's RE2 that JavaScript cannot compile; the server checks it.
        }
      }

      break;

    case "integer":
    case "number":
      if (typeof value !== "number" || (type === "integer" && !Number.isInteger(value))) {
        error(`must be ${type === "integer" ? "an integer" : "a number"}`);
        break;
      }

      if (resolved.minimum !== undefined && (resolved.exclusiveMinimum ? value <= resolved.minimum : value < resolved.minimum)) error(`must be ${resolved.exclusiveMinimum ? ">" : "≥"} ${resolved.minimum}`);
      if (resolved.maximum !== undefined && (resolved.exclusiveMaximum ? value >= resolved.maximum : value > resolved.maximum)) error(`must be ${resolved.exclusiveMaximum ? "<" : "≤"} ${resolved.maximum}`);
      break;

    case "boolean":
      if (typeof value !== "boolean") error("must be true or false");
      break;

    case "int-or-string":
      if (typeof value !== "string" && !(typeof value === "number" && Number.isInteger(value))) error("must be an integer or a string");
      break;

    default:
      break;
  }

  if (resolved.enum && !resolved.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) {
    error(`must be one of: ${resolved.enum.map((option) => JSON.stringify(option)).join(", ")}`);
  }

  return issues;
};

/** Validates a whole Kubernetes object: its own schema, plus the metadata every object needs. */
export const validateResource = (resource: Json, schema: Schema | undefined, options: { namespaced: boolean; definitions?: SchemaDefinitions }): ValidationIssue[] => {
  const issues: ValidationIssue[] = [];

  if (!isPlainObject(resource)) {
    return [{ path: [], message: "The document must be an object", severity: "error" }];
  }

  if (!resource.apiVersion) issues.push({ path: ["apiVersion"], message: "is required", severity: "error" });
  if (!resource.kind) issues.push({ path: ["kind"], message: "is required", severity: "error" });
  if (!resource.metadata?.name && !resource.metadata?.generateName) issues.push({ path: ["metadata", "name"], message: "is required", severity: "error" });

  if (options.namespaced === false && resource.metadata?.namespace) {
    issues.push({ path: ["metadata", "namespace"], message: "is ignored: this kind is cluster-scoped", severity: "warning" });
  }

  for (const [field, map] of [["labels", resource.metadata?.labels], ["annotations", resource.metadata?.annotations]] as const) {
    for (const [key, value] of Object.entries((map ?? {}) as Record<string, unknown>)) {
      if (typeof value !== "string") {
        issues.push({ path: ["metadata", field, key], message: "must be a string (quote numbers and booleans)", severity: "error" });
      }

      if (field === "labels" && typeof value === "string" && value.length > 63) {
        issues.push({ path: ["metadata", field, key], message: "label values are at most 63 characters", severity: "error" });
      }
    }
  }

  const { apiVersion: _apiVersion, kind: _kind, metadata: _metadata, status: _status, ...body } = resource;
  const bodySchema = schema ? resolveSchema(schema, options.definitions) : undefined;

  if (bodySchema?.properties) {
    const { apiVersion: _a, kind: _k, metadata: _m, status: _s, ...bodyProperties } = bodySchema.properties;
    const required = (bodySchema.required ?? []).filter((key) => !["apiVersion", "kind", "metadata", "status"].includes(key));

    validate(body, { ...bodySchema, properties: bodyProperties, required }, options.definitions ?? {}, [], issues);
  }

  return issues;
};

export const formatIssue = (issue: ValidationIssue) => `${pathToString(issue.path) || "(document)"} ${issue.message}`;
