import { describe, expect, it } from "vitest";
import { detectFeatures, loadCiliumInfo, versionFromImage } from "../src/kube/cilium-info";
import { classifyKubectlError, createKubectlClient, KubeError, type RunKubectl } from "../src/kube/kubectl";
import { createResourceOperations } from "../src/kube/operations";
import { compareVersions, kubectlResourceName, resourceTypesFromApiResources, resourceTypesFromCrds, schemaFromOpenApi } from "../src/kube/resource-types";

const crd = (group: string, kind: string, plural: string, versions: Array<{ name: string; served?: boolean; storage?: boolean }>, scope = "Namespaced") => ({
  metadata: { name: `${plural}.${group}`, annotations: { "gateway.networking.k8s.io/bundle-version": "v1.3.0" } },
  spec: {
    group,
    scope,
    names: { kind, plural, singular: kind.toLowerCase() },
    versions: versions.map((version) => ({
      name: version.name,
      served: version.served ?? true,
      storage: version.storage ?? false,
      schema: { openAPIV3Schema: { type: "object", properties: { spec: { type: "object" } } } },
      additionalPrinterColumns: [{ name: "Ready", type: "string", jsonPath: ".status.ready" }],
    })),
  },
  status: { storedVersions: ["v2"], conditions: [{ type: "Established", status: "True" }] },
});

/** A fake kubectl answering by the joined arguments, recording every call. */
const fakeKubectl = (answers: Record<string, string | Error>) => {
  const calls: Array<{ args: string[]; input?: string }> = [];
  const run: RunKubectl = async (args, options) => {
    calls.push({ args, input: options?.input });

    const key = Object.keys(answers).find((candidate) => args.join(" ").startsWith(candidate));

    if (!key) {
      throw new Error(`Error from server (NotFound): unexpected ${args.join(" ")}`);
    }

    const answer = answers[key];

    if (answer instanceof Error) {
      throw answer;
    }

    return answer;
  };

  return { run, calls };
};

describe("resource types", () => {
  it("keeps only Cilium and Gateway API CRDs, choosing the preferred version", () => {
    const types = resourceTypesFromCrds({
      items: [
        crd("cilium.io", "CiliumNetworkPolicy", "ciliumnetworkpolicies", [{ name: "v2", storage: true }, { name: "v2alpha1" }]),
        crd("gateway.networking.k8s.io", "HTTPRoute", "httproutes", [{ name: "v1beta1" }, { name: "v1", storage: true }]),
        crd("cert-manager.io", "Certificate", "certificates", [{ name: "v1", storage: true }]),
        crd("cilium.io", "CiliumSomethingNew", "ciliumsomethingnews", [{ name: "v2alpha1", storage: true }], "Cluster"),
      ],
    });

    expect(types.map((type) => type.kind).sort()).toEqual(["CiliumNetworkPolicy", "CiliumSomethingNew", "HTTPRoute"]);
    expect(types.find((type) => type.kind === "HTTPRoute")?.preferredVersion).toBe("v1");
    expect(types.find((type) => type.kind === "CiliumNetworkPolicy")?.section).toBe("security");
    expect(types.find((type) => type.kind === "CiliumSomethingNew")).toMatchObject({ section: "other", namespaced: false });
    expect(types.find((type) => type.kind === "CiliumNetworkPolicy")?.versions[0].printerColumns[0].jsonPath).toBe(".status.ready");
  });

  it("skips versions that are not served", () => {
    const [type] = resourceTypesFromCrds({ items: [crd("cilium.io", "CiliumNode", "ciliumnodes", [{ name: "v2", served: false }, { name: "v2alpha1" }], "Cluster")] });

    expect(type.preferredVersion).toBe("v2alpha1");
  });

  it("orders versions the way Kubernetes does", () => {
    expect(["v1alpha1", "v2", "v1beta2", "v1", "v1beta1"].sort(compareVersions)).toEqual(["v2", "v1", "v1beta2", "v1beta1", "v1alpha1"]);
  });

  it("names a type and version for kubectl", () => {
    expect(kubectlResourceName({ group: "cilium.io", plural: "ciliumnodes" }, "v2")).toBe("ciliumnodes.v2.cilium.io");
    expect(kubectlResourceName({ group: "", plural: "services" }, "v1")).toBe("services");
  });

  it("parses api-resources output when listing CRDs is forbidden", () => {
    const output = [
      "ciliumnetworkpolicies   cnp,ciliumnp   cilium.io/v2   true   CiliumNetworkPolicy   [delete get list]",
      "ciliumnodes   cn   cilium.io/v2   false   CiliumNode   [get list]",
      "pods   po   v1   true   Pod   [get]",
    ].join("\n");
    const types = resourceTypesFromApiResources(output);

    expect(types.map((type) => [type.kind, type.namespaced, type.shortNames[0]])).toEqual([
      ["CiliumNetworkPolicy", true, "cnp"],
      ["CiliumNode", false, "cn"],
    ]);
  });

  it("finds a built-in schema in an OpenAPI v3 document", () => {
    const document = { components: { schemas: { "io.k8s.api.networking.v1.NetworkPolicy": { type: "object", "x-kubernetes-group-version-kind": [{ group: "networking.k8s.io", version: "v1", kind: "NetworkPolicy" }] } } } };

    expect(schemaFromOpenApi(document, "networking.k8s.io", "v1", "NetworkPolicy").schema).toBeDefined();
    expect(schemaFromOpenApi(document, "networking.k8s.io", "v1", "Ingress").schema).toBeUndefined();
  });
});

describe("kubectl client", () => {
  it("classifies kubectl errors", () => {
    expect(classifyKubectlError('Error from server (Forbidden): ciliumnetworkpolicies.cilium.io is forbidden: User "x" cannot list')).toBe("Forbidden");
    expect(classifyKubectlError("Error from server (Conflict): the object has been modified; please apply your changes")).toBe("Conflict");
    expect(classifyKubectlError('error: the server doesn\'t have a resource type "ciliumnodes"')).toBe("NotServed");
    expect(classifyKubectlError('Error from server (NotFound): ciliumnodes.cilium.io "x" not found')).toBe("NotFound");
    expect(classifyKubectlError("Unable to connect to the server: dial tcp 10.0.0.1:6443: i/o timeout")).toBe("Timeout");
    expect(classifyKubectlError("The CiliumNetworkPolicy \"x\" is invalid: spec.endpointSelector: Required value")).toBe("Invalid");
  });

  it("adds a request timeout to API calls but not to exec, and redacts errors", async () => {
    const fake = fakeKubectl({ "get pods": "{}", exec: "ok", "get secret": new Error("token=supersecret failed") });
    const client = createKubectlClient(fake.run);

    await client.run(["get", "pods"]);
    await client.run(["exec", "pod", "--", "ls"]);
    await expect(client.run(["get", "secret"])).rejects.toThrow(KubeError);
    await expect(client.run(["get", "secret"])).rejects.not.toThrow(/supersecret/);

    expect(fake.calls[0].args).toContain("--request-timeout=30s");
    expect(fake.calls[1].args).not.toContain("--request-timeout=30s");
  });

  it("times out a call that never answers", async () => {
    const client = createKubectlClient((_args, options) => new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("aborted")))), { defaultTimeoutMs: 20 });

    await expect(client.run(["get", "pods"])).rejects.toMatchObject({ kind: "Timeout" });
  });
});

describe("resource operations (integration with a fake kubectl)", () => {
  const types = resourceTypesFromCrds({ items: [crd("cilium.io", "CiliumNetworkPolicy", "ciliumnetworkpolicies", [{ name: "v2", storage: true }])] });
  const cnp = types[0];

  it("discovers from CRDs and falls back to api-resources when forbidden", async () => {
    const allowed = createResourceOperations(createKubectlClient(fakeKubectl({ "get customresourcedefinitions.apiextensions.k8s.io": JSON.stringify({ items: [crd("cilium.io", "CiliumNode", "ciliumnodes", [{ name: "v2", storage: true }], "Cluster")] }) }).run));
    const discovered = await allowed.discover();

    expect(discovered.source).toBe("crds");
    expect(discovered.types.map((type) => type.kind)).toContain("CiliumNode");
    expect(discovered.types.map((type) => type.kind)).toContain("NetworkPolicy");
    expect(discovered.crds[0]).toMatchObject({ name: "ciliumnodes.cilium.io", established: true, bundleVersion: "v1.3.0" });

    const forbidden = createResourceOperations(
      createKubectlClient(
        fakeKubectl({
          "get customresourcedefinitions.apiextensions.k8s.io": new Error('Error from server (Forbidden): customresourcedefinitions.apiextensions.k8s.io is forbidden: User "dev" cannot list resource'),
          "api-resources": "ciliumnodes   cn   cilium.io/v2   false   CiliumNode   [get list]",
        }).run,
      ),
    );
    const fallback = await forbidden.discover();

    expect(fallback.source).toBe("api-resources");
    expect(fallback.warnings[0]).toMatch(/forbidden/);
  });

  it("writes as a server dry run with the manifest on stdin", async () => {
    const fake = fakeKubectl({ apply: JSON.stringify({ kind: "CiliumNetworkPolicy", metadata: { name: "p" } }) });
    const ops = createResourceOperations(createKubectlClient(fake.run));
    const results = await ops.write({ documents: [{ apiVersion: "cilium.io/v2", kind: "CiliumNetworkPolicy", metadata: { name: "p", namespace: "ns" } }], mode: "server-side-apply", dryRun: true, forceConflicts: true });

    expect(results).toHaveLength(1);
    expect(fake.calls[0].args).toEqual(expect.arrayContaining(["apply", "--server-side", "--field-manager=cilium-network-manager", "--force-conflicts", "--dry-run=server", "--filename", "-", "--output", "json"]));
    expect(fake.calls[0].input).toContain("kind: CiliumNetworkPolicy");
  });

  it("replaces with the resourceVersion read, so a concurrent change is a conflict", async () => {
    const fake = fakeKubectl({ replace: new Error('Error from server (Conflict): Operation cannot be fulfilled on ciliumnetworkpolicies.cilium.io "p": the object has been modified') });
    const ops = createResourceOperations(createKubectlClient(fake.run));

    await expect(ops.write({ documents: [{ kind: "CiliumNetworkPolicy", metadata: { name: "p", resourceVersion: "41" } }], mode: "replace", dryRun: false })).rejects.toMatchObject({ kind: "Conflict" });
    expect(fake.calls[0].input).toContain('resourceVersion: "41"');
  });

  it("splits List results into items", async () => {
    const fake = fakeKubectl({ create: JSON.stringify({ kind: "List", items: [{ kind: "A" }, { kind: "B" }] }) });
    const ops = createResourceOperations(createKubectlClient(fake.run));

    expect(await ops.write({ documents: [{ kind: "A" }, { kind: "B" }], mode: "create", dryRun: false })).toHaveLength(2);
  });

  it("deletes by fully qualified name and namespace, optionally as a dry run", async () => {
    const fake = fakeKubectl({ delete: "deleted" });
    const ops = createResourceOperations(createKubectlClient(fake.run));

    await ops.remove(cnp, "v2", "p", "ns", { dryRun: true });

    expect(fake.calls[0].args.slice(0, 5)).toEqual(["delete", "ciliumnetworkpolicies.v2.cilium.io", "p", "--namespace", "ns"]);
    expect(fake.calls[0].args).toContain("--dry-run=server");
  });

  it("guards merge patches with the uid", async () => {
    const fake = fakeKubectl({ patch: "{}" });
    const ops = createResourceOperations(createKubectlClient(fake.run));

    await ops.mergePatch(cnp, "v2", { metadata: { name: "p", namespace: "ns", uid: "uid-1" } }, { metadata: { labels: { a: "b" } } });

    const patch = JSON.parse(fake.calls[0].args[fake.calls[0].args.indexOf("--patch") + 1]);

    expect(patch).toEqual({ metadata: { labels: { a: "b" }, uid: "uid-1" } });
  });

  it("answers can-i, treating a refusal as no", async () => {
    const yes = createResourceOperations(createKubectlClient(fakeKubectl({ "auth can-i": "yes" }).run));
    const no = createResourceOperations(createKubectlClient(fakeKubectl({ "auth can-i": new Error("no") }).run));

    expect(await yes.canI("create", cnp, "ns")).toBe(true);
    expect(await no.canI("create", cnp, "ns")).toBe(false);
  });

  it("treats a kind that is not served as empty in composite reads", async () => {
    const ops = createResourceOperations(createKubectlClient(fakeKubectl({ get: new Error('error: the server doesn\'t have a resource type "ciliumnetworkpolicies"') }).run));
    const result = await ops.listIfServed(cnp);

    expect(result).toEqual({ items: [] });
  });
});

describe("cilium info", () => {
  const pod = (name: string, labels: string, image: string, ready = true) => ({
    metadata: { name, namespace: "kube-system", labels },
    spec: { nodeName: "node-1", containers: [{ name: "cilium-agent", image }] },
    status: { phase: "Running", containerStatuses: [{ ready, restartCount: 2 }] },
  });

  it("finds the agents, reads the config and the version", async () => {
    const fake = fakeKubectl({
      "get pods --all-namespaces --selector k8s-app=cilium": JSON.stringify({ items: [pod("cilium-abc", "", "quay.io/cilium/cilium:v1.18.2@sha256:abc")] }),
      "get pods --all-namespaces --selector io.cilium/app=operator": JSON.stringify({ items: [] }),
      "get pods --all-namespaces --selector k8s-app=hubble-relay": JSON.stringify({ items: [pod("hubble-relay-1", "", "quay.io/cilium/hubble-relay:v1.18.2")] }),
      "get pods --all-namespaces --selector k8s-app=cilium-envoy": JSON.stringify({ items: [] }),
      "get configmap cilium-config": JSON.stringify({ data: { "enable-gateway-api": "true", "enable-hubble": "true", "enable-bgp-control-plane": "false", ipam: "kubernetes" } }),
    });
    const info = await loadCiliumInfo(createKubectlClient(fake.run));

    expect(info).toMatchObject({ namespace: "kube-system", version: "v1.18.2" });
    expect(info.agents[0]).toMatchObject({ ready: true, restarts: 2, node: "node-1" });

    const types = resourceTypesFromCrds({
      items: [crd("gateway.networking.k8s.io", "GatewayClass", "gatewayclasses", [{ name: "v1", storage: true }], "Cluster"), crd("gateway.networking.k8s.io", "Gateway", "gateways", [{ name: "v1", storage: true }]), crd("gateway.networking.k8s.io", "HTTPRoute", "httproutes", [{ name: "v1", storage: true }])],
    });
    const features = detectFeatures(info, types);

    expect(features.find((feature) => feature.id === "gateway-api")?.state).toBe("enabled");
    expect(features.find((feature) => feature.id === "bgp")?.state).toBe("disabled");
    expect(features.find((feature) => feature.id === "ipam")?.detail).toMatch(/kubernetes/);
    expect(features.find((feature) => feature.id === "hubble")?.detail).toMatch(/Relay running/);
  });

  it("reads versions from image references", () => {
    expect(versionFromImage("quay.io/cilium/cilium:v1.16.0")).toBe("v1.16.0");
    expect(versionFromImage("registry:5000/cilium/cilium")).toBeUndefined();
  });

  it("says the configuration is unknown when it cannot be read", () => {
    expect(detectFeatures(undefined, []).every((feature) => feature.state === "unknown")).toBe(true);
  });
});
