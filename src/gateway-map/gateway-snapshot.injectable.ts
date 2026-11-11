import { runKubectlInjectionToken } from "@k8slens/kubectl-contracts";
import { getSubscribableInjectableBunch } from "@k8slens/subscribable";
import { type Snapshot, type SnapshotResource, snapshotResources } from "./topology";

export interface GatewaySnapshot {
  readonly snapshot: Snapshot;
  /** Resource types the cluster does not serve, such as TLSRoute without the experimental channel. */
  readonly notServed: readonly SnapshotResource[];
  /** Resource types the cluster serves but could not be listed, with kubectl's reason: RBAC, say. */
  readonly failures: ReadonlyArray<{ readonly resource: SnapshotResource; readonly message: string }>;
  readonly loadedAt: number;
}

const notServedRetries = 2;

const isNotServed = (message: string) =>
  /doesn't have a resource type|the server could not find the requested resource|no matches for kind/i.test(message);

export const gatewaySnapshotBunch = getSubscribableInjectableBunch<GatewaySnapshot, [clusterId: string]>()({
  id: "cilium-ui-gateway-snapshot",

  load: {
    consumptions: [runKubectlInjectionToken],

    instantiate: (di) => {
      const runKubectlFor = di.inject(runKubectlInjectionToken);

      // What each type last listed as, per cluster, for when discovery briefly forgets a type it served.
      const lastListed = new Map<string, unknown[]>();

      return () => async (clusterId) => {
        const runKubectl = runKubectlFor(clusterId);

        const list = async (resource: SnapshotResource, attemptsLeft: number): Promise<{ resource: SnapshotResource; items: unknown[]; error?: string }> => {
          try {
            const output = await runKubectl(["get", resource, "--all-namespaces", "--output", "json"]);
            const items = (JSON.parse(output) as { items?: unknown[] }).items ?? [];

            lastListed.set(`${clusterId}/${resource}`, items);

            return { resource, items };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);

            // A recently added CRD, such as ListenerSet going v1, can be missing from one API server's
            // discovery, or from kubectl's cache of it, for a while: ask again before believing it.
            if (isNotServed(message) && attemptsLeft > 0) {
              return list(resource, attemptsLeft - 1);
            }

            const previous = lastListed.get(`${clusterId}/${resource}`);

            return isNotServed(message) && previous ? { resource, items: previous } : { resource, items: [], error: message };
          }
        };

        const results = await Promise.all(snapshotResources.map((resource) => list(resource, notServedRetries)));

        return {
          snapshot: Object.fromEntries(results.map(({ resource, items }) => [resource, items])) as unknown as Snapshot,
          notServed: results.filter((result) => result.error && isNotServed(result.error)).map((result) => result.resource),
          failures: results
            .filter((result) => result.error && !isNotServed(result.error))
            .map((result) => ({ resource: result.resource, message: result.error!.trim() })),
          loadedAt: Date.now(),
        };
      };
    },
  },
});
