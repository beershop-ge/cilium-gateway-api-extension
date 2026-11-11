import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodeHelmReleaseSecret } from "../src/config/helm";
import { redactedMarker } from "../src/common/redact";
import { pagesOfSection, parseTabId, resourcePageId, tabIdOf, typeIdOfPage } from "../src/navigation/pages";
import { resourceTypesFromCrds } from "../src/kube/resource-types";
import { createQuery, createQueryCache } from "../src/common/query";

const helmSecret = (release: object, gzip = true) => {
  const json = Buffer.from(JSON.stringify(release));
  const helmEncoded = (gzip ? gzipSync(json) : json).toString("base64");

  return { data: { release: Buffer.from(helmEncoded).toString("base64") } };
};

describe("helm release secrets", () => {
  const release = {
    name: "cilium",
    namespace: "kube-system",
    version: 7,
    info: { status: "deployed", last_deployed: "2026-11-01T00:00:00Z" },
    chart: { metadata: { name: "cilium", version: "1.18.2", appVersion: "1.18.2" } },
    config: { gatewayAPI: { enabled: true }, clustermesh: { apiserver: { tls: { ca: { key: "PRIVATE" } } } }, hubble: { relay: { enabled: true } } },
  };

  it("decodes a gzipped release and masks secret values", async () => {
    const decoded = await decodeHelmReleaseSecret(helmSecret(release));

    expect(decoded).toMatchObject({ name: "cilium", revision: 7, status: "deployed", chart: "cilium-1.18.2" });
    expect(decoded.userValues.gatewayAPI.enabled).toBe(true);
    expect(decoded.userValues.clustermesh.apiserver.tls.ca.key).toBe(redactedMarker);
  });

  it("decodes an uncompressed release", async () => {
    expect((await decodeHelmReleaseSecret(helmSecret(release, false))).revision).toBe(7);
  });

  it("refuses a Secret that is not a release", async () => {
    await expect(decodeHelmReleaseSecret({ data: {} })).rejects.toThrow(/no Helm release/);
  });
});

describe("navigation", () => {
  it("round-trips tab ids", () => {
    expect(parseTabId(tabIdOf("abc123", "res:ciliumnodes.cilium.io"))).toEqual({ clusterId: "abc123", pageId: "res:ciliumnodes.cilium.io" });
    expect(typeIdOfPage("res:ciliumnodes.cilium.io")).toBe("ciliumnodes.cilium.io");
    expect(typeIdOfPage("overview")).toBeUndefined();
  });

  it("lists a section's static pages and discovered types together", () => {
    const types = resourceTypesFromCrds({
      items: [
        {
          metadata: { name: "ciliumloadbalancerippools.cilium.io" },
          spec: { group: "cilium.io", scope: "Cluster", names: { kind: "CiliumLoadBalancerIPPool", plural: "ciliumloadbalancerippools" }, versions: [{ name: "v2", served: true, storage: true }] },
        },
      ],
    });
    const pages = pagesOfSection("lb", [{ id: "ip-pools", section: "lb", title: "LB IP Pool Usage", orderNumber: 5, Component: () => null }], types);

    expect(pages.map((page) => page.id)).toEqual(["ip-pools", resourcePageId(types[0])]);
    expect(pagesOfSection("bgp", [], types)).toEqual([]);
  });
});

describe("queries", () => {
  it("loads once, keeps the value while refreshing, and keeps it after a failure", async () => {
    let calls = 0;
    const query = createQuery(async () => {
      calls++;

      if (calls === 2) throw new Error("boom");

      return calls;
    });

    query.ensure();
    query.ensure();
    await query.refresh();
    expect(calls).toBe(1);
    expect(query.state()).toMatchObject({ status: "ready", value: 1 });

    await query.refresh();
    expect(query.state()).toMatchObject({ status: "error", value: 1 });
    expect(query.state().error?.message).toBe("boom");

    await query.refresh();
    expect(query.state()).toMatchObject({ status: "ready", value: 3 });
  });

  it("shares queries by key and refreshes loaded ones by prefix", async () => {
    const cache = createQueryCache();
    let loads = 0;
    const query = cache.get("q:a", async () => ++loads);

    expect(cache.get("q:a", async () => 0)).toBe(query);
    await query.refresh();
    cache.invalidate("q:");
    await query.refresh();
    expect(loads).toBe(2);
  });
});
