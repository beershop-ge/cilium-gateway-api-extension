import { describe, expect, it } from "vitest";
import { enumAt, resolveSchema, type Schema, schemaAt, schemaHasPath, skeletonFor } from "../src/schema/schema";
import { validate, validateResource } from "../src/schema/validate";

const poolSchema: Schema = {
  type: "object",
  properties: {
    apiVersion: { type: "string" },
    kind: { type: "string" },
    metadata: { type: "object" },
    spec: {
      type: "object",
      required: ["blocks"],
      properties: {
        blocks: {
          type: "array",
          minItems: 1,
          items: { type: "object", properties: { cidr: { type: "string", pattern: "^[0-9a-f:./]+$" }, start: { type: "string" }, stop: { type: "string" } } },
        },
        disabled: { type: "boolean", default: false },
        serviceSelector: { type: "object", properties: { matchLabels: { type: "object", additionalProperties: { type: "string" } } } },
        allowFirstLastIPs: { type: "string", enum: ["Yes", "No"] },
      },
    },
    status: { type: "object", "x-kubernetes-preserve-unknown-fields": true },
  },
  required: ["spec"],
};

describe("schema helpers", () => {
  it("finds nested schemas, enums and paths", () => {
    expect(schemaAt(poolSchema, ["spec", "blocks", 0, "cidr"])?.type).toBe("string");
    expect(schemaAt(poolSchema, ["spec", "serviceSelector", "matchLabels", "app"])?.type).toBe("string");
    expect(enumAt(poolSchema, ["spec", "allowFirstLastIPs"])).toEqual(["Yes", "No"]);
    expect(schemaHasPath(poolSchema, ["spec", "blocks", "cidr"])).toBe(true);
    expect(schemaHasPath(poolSchema, ["spec", "nope"])).toBe(false);
  });

  it("builds a skeleton of required fields", () => {
    expect(skeletonFor(poolSchema)).toEqual({ spec: { blocks: [] } });
  });

  it("resolves $ref and allOf against OpenAPI components", () => {
    const definitions: Record<string, Schema> = {
      Selector: { type: "object", properties: { matchLabels: { type: "object" } } },
      Base: { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
    };
    const resolved = resolveSchema({ allOf: [{ $ref: "#/components/schemas/Base" }, { properties: { b: { $ref: "#/components/schemas/Selector" } } }] }, definitions);

    expect(Object.keys(resolved.properties ?? {})).toEqual(["a", "b"]);
    expect(resolved.required).toEqual(["a"]);
    expect(schemaAt(resolved, ["b", "matchLabels"], definitions)?.type).toBe("object");
  });
});

describe("validation", () => {
  it("accepts a valid document", () => {
    const issues = validateResource({ apiVersion: "cilium.io/v2", kind: "CiliumLoadBalancerIPPool", metadata: { name: "pool" }, spec: { blocks: [{ cidr: "10.0.0.0/24" }] } }, poolSchema, { namespaced: false });

    expect(issues.filter((issue) => issue.severity === "error")).toEqual([]);
  });

  it("reports required, type, enum, pattern and minItems errors", () => {
    const issues = validate({ spec: { blocks: [], disabled: "yes", allowFirstLastIPs: "Maybe" } }, poolSchema);
    const messages = issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);

    expect(messages).toContain("spec.blocks: must have at least 1 items");
    expect(messages).toContain("spec.disabled: must be true or false");
    expect(messages.some((message) => message.startsWith("spec.allowFirstLastIPs: must be one of"))).toBe(true);

    const patternIssues = validate({ spec: { blocks: [{ cidr: "NOT A CIDR" }] } }, poolSchema);

    expect(patternIssues.some((issue) => /must match/.test(issue.message))).toBe(true);
  });

  it("warns about fields the server would prune, but not under preserve-unknown-fields", () => {
    const issues = validate({ spec: { blocks: [{ cidr: "10.0.0.0/8" }], typo: 1 }, status: { anything: true } }, poolSchema);

    expect(issues).toContainEqual(expect.objectContaining({ path: ["spec", "typo"], severity: "warning" }));
    expect(issues.some((issue) => issue.path[0] === "status")).toBe(false);
  });

  it("checks metadata every object needs", () => {
    const issues = validateResource({ kind: "X", metadata: { labels: { n: 1 } } }, undefined, { namespaced: true });
    const paths = issues.map((issue) => issue.path.join("."));

    expect(paths).toEqual(expect.arrayContaining(["apiVersion", "metadata.name", "metadata.labels.n"]));
  });

  it("explains oneOf requirements", () => {
    const schema: Schema = { type: "object", oneOf: [{ required: ["cidr"] }, { required: ["start"] }], properties: { cidr: { type: "string" }, start: { type: "string" } } };

    expect(validate({}, schema)[0]?.message).toMatch(/exactly one of: cidr, start/);
    expect(validate({ cidr: "a", start: "b" }, schema)[0]?.message).toMatch(/only one of/);
    expect(validate({ cidr: "a" }, schema)).toEqual([]);
  });

  it("detects duplicate keys in map lists", () => {
    const schema: Schema = { type: "array", "x-kubernetes-list-type": "map", "x-kubernetes-list-map-keys": ["name"], items: { type: "object", properties: { name: { type: "string" } } } };

    expect(validate([{ name: "a" }, { name: "a" }], schema)).toHaveLength(1);
  });
});
