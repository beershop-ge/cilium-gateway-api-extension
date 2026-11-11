import { describe, expect, it } from "vitest";
import { parseCidr, rangeContains, rangeFromStartStop, rangeOfBlock, rangesOverlap, rangeSize } from "../src/common/cidr";
import { conditionsOf, healthOf, healthOfResource } from "../src/common/conditions";
import { diffLines, diffStats, toHunks } from "../src/common/diff";
import { detectManagers } from "../src/common/gitops";
import { deletePath, deepEqual, getPath, setPath } from "../src/common/json";
import { evaluateJsonPath, formatJsonPathValue } from "../src/common/jsonpath";
import { cleanForDiff, cleanForExport, cloneManifest } from "../src/common/manifest";
import { redactObject, redactText, redactedMarker } from "../src/common/redact";
import { assessChange } from "../src/common/risk";
import { describeSelector, parseCiliumLabelList, selectorMatches } from "../src/common/selectors";
import { parseSingleYaml, parseYamlDocuments, toYaml } from "../src/common/yaml";
import { kubernetesNameError } from "../src/common/format";

describe("json paths", () => {
  it("sets a nested value without touching siblings", () => {
    const original = { spec: { a: 1, keep: { deep: true } }, unknown: "x" };
    const next = setPath(original, ["spec", "b", "c"], 2);

    expect(next).toEqual({ spec: { a: 1, keep: { deep: true }, b: { c: 2 } }, unknown: "x" });
    expect(original.spec).not.toHaveProperty("b");
    expect(next.spec.keep).toBe(original.spec.keep);
  });

  it("creates arrays for numeric segments and deletes array elements", () => {
    const next = setPath({}, ["items", 0, "name"], "a");

    expect(next).toEqual({ items: [{ name: "a" }] });
    expect(deletePath({ items: ["a", "b", "c"] }, ["items", 1])).toEqual({ items: ["a", "c"] });
    expect(getPath(next, ["items", 0, "name"])).toBe("a");
  });

  it("compares deeply, ignoring undefined fields", () => {
    expect(deepEqual({ a: [1, { b: 2 }], c: undefined }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: [1] }, { a: [2] })).toBe(false);
  });
});

describe("yaml", () => {
  it("round-trips and parses several documents", () => {
    const text = `${toYaml({ kind: "A", metadata: { name: "a" } })}---\n${toYaml({ kind: "B" })}\n---\n`;
    const parsed = parseYamlDocuments(text);

    expect(parsed.errors).toEqual([]);
    expect(parsed.documents.map((document) => document.kind)).toEqual(["A", "B"]);
  });

  it("reports parse errors with a line", () => {
    const parsed = parseSingleYaml("a: 1\nb: [\n");

    expect(parsed.error).toBeDefined();
  });

  it("refuses more than one document where one is expected", () => {
    expect(parseSingleYaml("a: 1\n---\nb: 2").error).toMatch(/Expected one document/);
  });
});

describe("diff", () => {
  it("finds added and removed lines", () => {
    const lines = diffLines("a\nb\nc\n", "a\nB\nc\nd\n");

    expect(diffStats(lines)).toEqual({ added: 2, removed: 1 });
    expect(lines.filter((line) => line.type === "same").map((line) => line.text)).toEqual(["a", "c"]);
  });

  it("groups changes into hunks with context", () => {
    const before = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");
    const after = before.replace("line 2\n", "line two\n").replace("line 35", "line thirty-five");
    const hunks = toHunks(diffLines(before, after), 2);

    expect(hunks).toHaveLength(2);
  });

  it("finds no hunks for equal texts", () => {
    expect(toHunks(diffLines("same\n", "same\n"))).toEqual([]);
  });
});

describe("cidr", () => {
  it("parses IPv4 and IPv6 blocks", () => {
    expect(rangeSize(parseCidr("10.0.0.0/24")!)).toBe(256n);
    expect(rangeSize(parseCidr("2001:db8::/120")!)).toBe(256n);
    expect(parseCidr("10.0.0.0/33")).toBeUndefined();
    expect(parseCidr("300.0.0.0/8")).toBeUndefined();
  });

  it("normalises a CIDR with host bits set", () => {
    expect(rangeContains(parseCidr("10.0.0.77/24")!, "10.0.0.1")).toBe(true);
  });

  it("detects overlaps between blocks and ranges, per family", () => {
    expect(rangesOverlap(parseCidr("10.0.0.0/24")!, parseCidr("10.0.0.128/25")!)).toBe(true);
    expect(rangesOverlap(parseCidr("10.0.0.0/25")!, parseCidr("10.0.0.128/25")!)).toBe(false);
    expect(rangesOverlap(rangeFromStartStop("10.0.1.10", "10.0.1.20")!, parseCidr("10.0.1.16/28")!)).toBe(true);
    expect(rangesOverlap(parseCidr("::/0")!, parseCidr("0.0.0.0/0")!)).toBe(false);
  });

  it("reads Cilium pool blocks of both shapes", () => {
    expect(rangeOfBlock({ cidr: "192.168.0.0/30" })?.label).toBe("192.168.0.0/30");
    expect(rangeSize(rangeOfBlock({ start: "192.168.1.10", stop: "192.168.1.19" })!)).toBe(10n);
    expect(rangeContains(rangeOfBlock({ start: "fd00::1" })!, "fd00::1")).toBe(true);
  });

  it("parses compressed and embedded IPv6 forms", () => {
    expect(rangeContains(parseCidr("::ffff:10.0.0.0/120")!, "::ffff:10.0.0.5")).toBe(true);
  });
});

describe("selectors", () => {
  it("matches Kubernetes and Cilium-prefixed keys", () => {
    const labels = { app: "web", "io.kubernetes.pod.namespace": "prod" };

    expect(selectorMatches({ matchLabels: { "k8s:app": "web" } }, labels)).toBe(true);
    expect(selectorMatches({ matchLabels: { "any:app": "web", "k8s:io.kubernetes.pod.namespace": "prod" } }, labels)).toBe(true);
    expect(selectorMatches({ matchLabels: { app: "api" } }, labels)).toBe(false);
  });

  it("evaluates expressions", () => {
    const labels = { tier: "backend" };

    expect(selectorMatches({ matchExpressions: [{ key: "tier", operator: "In", values: ["backend", "db"] }] }, labels)).toBe(true);
    expect(selectorMatches({ matchExpressions: [{ key: "tier", operator: "NotIn", values: ["backend"] }] }, labels)).toBe(false);
    expect(selectorMatches({ matchExpressions: [{ key: "env", operator: "DoesNotExist" }] }, labels)).toBe(true);
    expect(selectorMatches({}, labels)).toBe(true);
  });

  it("describes and parses label lists", () => {
    expect(describeSelector({ matchLabels: { app: "web" } })).toBe("app=web");
    expect(describeSelector({})).toBe("all");
    expect(parseCiliumLabelList(["k8s:app=web", "reserved:host"])).toEqual({ app: "web", "reserved:host": "" });
  });
});

describe("conditions", () => {
  it("is healthy only when required conditions are true", () => {
    const conditions = conditionsOf({ conditions: [{ type: "Accepted", status: "True" }, { type: "Programmed", status: "False", reason: "Pending" }] });

    expect(healthOf(conditions, ["Accepted", "Programmed"]).health).toBe("error");
    expect(healthOf(conditions, ["Accepted"]).health).toBe("ok");
    expect(healthOf([], ["Accepted"]).health).toBe("unknown");
  });

  it("treats True on negative conditions as bad", () => {
    expect(healthOfResource({ status: { conditions: [{ type: "cilium.io/PoolConflict", status: "True" }] } }).health).toBe("error");
    expect(healthOfResource({ status: { conditions: [{ type: "cilium.io/PoolConflict", status: "False" }] } }).health).toBe("ok");
  });

  it("reads route parent conditions and plain states", () => {
    expect(healthOfResource({ status: { parents: [{ conditions: [{ type: "Accepted", status: "True" }] }] } }).health).toBe("ok");
    expect(healthOfResource({ status: { state: "ready" } }).health).toBe("ok");
  });
});

describe("redaction", () => {
  it("masks tokens and passwords in text", () => {
    const text = redactText("Authorization: Bearer abc.def.ghi password=hunter2 --token=xyz");

    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("xyz");
    expect(text).not.toContain("abc.def.ghi");
  });

  it("masks Secret data and secret-named fields", () => {
    const redacted = redactObject({ kind: "Secret", data: { password: "c2VjcmV0" }, metadata: { name: "x" } });

    expect(redacted.data.password).toBe(redactedMarker);
    expect(redacted.metadata.name).toBe("x");
    expect(redactObject({ config: { apiKey: "k", name: "n" } })).toEqual({ config: { apiKey: redactedMarker, name: "n" } });
  });
});

describe("manifests", () => {
  const live = {
    apiVersion: "cilium.io/v2",
    kind: "CiliumNetworkPolicy",
    metadata: { name: "p", namespace: "ns", uid: "u", resourceVersion: "5", managedFields: [{}], creationTimestamp: "t", annotations: { "kubectl.kubernetes.io/last-applied-configuration": "{}" }, ownerReferences: [{ uid: "o" }] },
    spec: { endpointSelector: {} },
    status: { ok: true },
  };

  it("strips server fields for export", () => {
    const exported = cleanForExport(live);

    expect(exported.metadata).toEqual({ name: "p", namespace: "ns" });
    expect(exported.status).toBeUndefined();
    expect(live.metadata.uid).toBe("u");
  });

  it("keeps identity out of diffs but keeps the body", () => {
    expect(cleanForDiff(live).metadata.resourceVersion).toBeUndefined();
    expect(cleanForDiff(live).spec).toEqual(live.spec);
  });

  it("clones under a new name", () => {
    expect(cloneManifest(live, "q", "other").metadata).toEqual({ name: "q", namespace: "other" });
  });
});

describe("gitops", () => {
  it("detects Flux and Argo CD", () => {
    expect(detectManagers({ metadata: { labels: { "kustomize.toolkit.fluxcd.io/name": "infra", "kustomize.toolkit.fluxcd.io/namespace": "flux-system" } } })[0]).toMatchObject({ tool: "Flux", reconciles: true });
    expect(detectManagers({ metadata: { annotations: { "argocd.argoproj.io/tracking-id": "app:cilium.io/CiliumNetworkPolicy:ns/p" } } })[0]).toMatchObject({ tool: "Argo CD", detail: "Application app" });
    expect(detectManagers({ metadata: { labels: { "app.kubernetes.io/managed-by": "Helm" }, annotations: { "meta.helm.sh/release-name": "cilium" } } })[0]).toMatchObject({ tool: "Helm", reconciles: false });
    expect(detectManagers({ metadata: {} })).toEqual([]);
  });
});

describe("risk", () => {
  it("warns about cluster-wide empty selectors and deletions", () => {
    const policy = { kind: "CiliumClusterwideNetworkPolicy", metadata: { name: "p" }, spec: { endpointSelector: {} } };

    expect(assessChange(undefined, policy).some((risk) => risk.level === "danger")).toBe(true);
    expect(assessChange(policy, undefined).some((risk) => /Deleting a policy/.test(risk.message))).toBe(true);
  });

  it("notices removed pool blocks", () => {
    const before = { kind: "CiliumLoadBalancerIPPool", metadata: { name: "p" }, spec: { blocks: [{ cidr: "10.0.0.0/24" }, { cidr: "10.0.1.0/24" }] } };
    const after = { ...before, spec: { blocks: [{ cidr: "10.0.0.0/24" }] } };

    expect(assessChange(before, after).map((risk) => risk.message).join()).toMatch(/10\.0\.1\.0\/24/);
  });
});

describe("jsonpath", () => {
  const resource = { status: { conditions: [{ type: "Ready", status: "True" }, { type: "Other", status: "False" }] }, spec: { items: [{ n: 1 }, { n: 2 }] } };

  it("evaluates the printer-column subset", () => {
    expect(formatJsonPathValue(evaluateJsonPath(resource, '.status.conditions[?(@.type=="Ready")].status'))).toBe("True");
    expect(evaluateJsonPath(resource, ".spec.items[*].n")).toEqual([1, 2]);
    expect(evaluateJsonPath(resource, ".spec.items[1].n")).toEqual([2]);
    expect(evaluateJsonPath(resource, ".missing.field")).toEqual([]);
  });
});

describe("names", () => {
  it("validates DNS subdomain names", () => {
    expect(kubernetesNameError("web-1")).toBeUndefined();
    expect(kubernetesNameError("Web")).toBeDefined();
    expect(kubernetesNameError("")).toBeDefined();
  });
});
