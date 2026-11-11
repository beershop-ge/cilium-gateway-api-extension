import type { Json } from "../common/json";
import { redactObject } from "../common/redact";
import type { KubectlClient } from "../kube/kubectl";

export interface HelmRelease {
  readonly name: string;
  readonly namespace: string;
  readonly revision: number;
  readonly status?: string;
  readonly chart?: string;
  readonly appVersion?: string;
  readonly updated?: string;
  /** The values the user supplied, with anything secret-looking masked. */
  readonly userValues: Json;
}

const base64ToBytes = (text: string) => Uint8Array.from(atob(text), (character) => character.charCodeAt(0));

const gunzip = async (bytes: Uint8Array): Promise<string> => {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));

  return new Response(stream).text();
};

/**
 * Decodes a Helm 3 release Secret: its `release` key is base64 (by Kubernetes) of base64 (by Helm)
 * of gzipped JSON. Only the user-supplied values and the chart's identity are kept, values masked.
 */
export const decodeHelmReleaseSecret = async (secret: Json): Promise<HelmRelease> => {
  const encoded = secret?.data?.release;

  if (typeof encoded !== "string") {
    throw new Error("The Secret holds no Helm release");
  }

  let bytes = base64ToBytes(atob(encoded));

  // Helm gzips releases; very old ones were not. Gzip starts with 0x1f 0x8b.
  const json = bytes[0] === 0x1f && bytes[1] === 0x8b ? await gunzip(bytes) : new TextDecoder().decode(bytes);
  const release = JSON.parse(json);

  bytes = new Uint8Array();

  return {
    name: release.name,
    namespace: release.namespace,
    revision: release.version,
    status: release.info?.status,
    chart: release.chart?.metadata ? `${release.chart.metadata.name}-${release.chart.metadata.version}` : undefined,
    appVersion: release.chart?.metadata?.appVersion,
    updated: release.info?.last_deployed,
    userValues: redactObject(release.config ?? {}),
  };
};

/** Finds the newest deployed revision of the Cilium Helm release in a namespace, if Helm installed it there. */
export const loadCiliumHelmRelease = async (kubectl: KubectlClient, namespace: string): Promise<HelmRelease | undefined> => {
  const list = await kubectl.json<Json>(["get", "secrets", "--namespace", namespace, "--selector", "owner=helm,name=cilium", "--output", "json"]);
  const secrets = ((list?.items ?? []) as Json[]).sort((a, b) => Number(b.metadata?.labels?.version ?? 0) - Number(a.metadata?.labels?.version ?? 0));
  const latest = secrets.find((secret) => secret.metadata?.labels?.status === "deployed") ?? secrets[0];

  return latest ? decodeHelmReleaseSecret(latest) : undefined;
};
