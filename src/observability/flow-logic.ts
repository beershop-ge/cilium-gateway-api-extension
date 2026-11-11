import { KubeError } from "../kube/kubectl";
import { endpointName, type Flow, type FlowEndpoint, type FlowFilter, type Verdict } from "./hubble";

/** A time Hubble printed (RFC 3339 with 0 to 9 fractional digits) as a string that sorts chronologically. */
export const sortableTime = (time: string | undefined): string => {
  if (!time) return "";

  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(time);

  if (match) return `${match[1]}.${(match[2] ?? "").padEnd(9, "0")}Z`;

  const parsed = Date.parse(time);

  return Number.isNaN(parsed) ? time : `${new Date(parsed).toISOString().slice(0, 19)}.${String(parsed % 1000).padStart(3, "0").padEnd(9, "0")}Z`;
};

export const compareFlowTime = (a: Flow, b: Flow) => (sortableTime(a.time) < sortableTime(b.time) ? -1 : sortableTime(a.time) > sortableTime(b.time) ? 1 : 0);

const endpointKey = (endpoint: FlowEndpoint) => `${endpoint.ip ?? ""}:${endpoint.port ?? ""}:${endpoint.podName ?? ""}`;

/** Identifies a flow across repeated reads: its uuid when Hubble gives one, else what describes it. */
export const flowKey = (flow: Flow): string =>
  flow.uuid ?? [sortableTime(flow.time), flow.node ?? "", endpointKey(flow.source), endpointKey(flow.destination), flow.verdict, flow.type, flow.protocol, flow.l7Type ?? "", flow.summary ?? "", flow.isReply ? "r" : ""].join("|");

/** Merges newly read flows into the ones shown, without duplicates, oldest first, keeping the newest `limit`. */
export const mergeFlows = (current: readonly Flow[], incoming: readonly Flow[], limit: number): Flow[] => {
  const byKey = new Map<string, Flow>();

  for (const flow of [...current, ...incoming]) byKey.set(flowKey(flow), flow);

  const merged = [...byKey.values()].sort(compareFlowTime);

  return limit > 0 && merged.length > limit ? merged.slice(merged.length - limit) : merged;
};

/** The newest time among flows, as Hubble printed it, for the next `--since` in follow mode. */
export const latestTime = (flows: readonly Flow[]): string | undefined =>
  flows.reduce<string | undefined>((latest, flow) => (flow.time && (!latest || sortableTime(flow.time) > sortableTime(latest)) ? flow.time : latest), undefined);

export const dnsRcodeNames: Record<number, string> = {
  0: "NOERROR",
  1: "FORMERR",
  2: "SERVFAIL",
  3: "NXDOMAIN",
  4: "NOTIMP",
  5: "REFUSED",
  6: "YXDOMAIN",
  7: "YXRRSET",
  8: "NXRRSET",
  9: "NOTAUTH",
  10: "NOTZONE",
};

export const rcodeName = (rcode: number | undefined) => (rcode === undefined ? "" : (dnsRcodeNames[rcode] ?? `RCODE${rcode}`));

/** A one-line description of what a flow carried at L7. */
export const l7Summary = (flow: Flow): string => {
  if (flow.dns) {
    const name = flow.dns.query ?? "";
    const types = flow.dns.qtypes?.length ? ` ${flow.dns.qtypes.join(",")}` : "";

    if (flow.l7Type === "RESPONSE" || (flow.l7Type === undefined && (flow.isReply === true || (flow.dns.ips?.length ?? 0) > 0 || (flow.dns.rcode ?? 0) !== 0))) {
      return `DNS answer ${name}${types} ${rcodeName(flow.dns.rcode ?? 0)}${flow.dns.ips?.length ? ` → ${flow.dns.ips.join(", ")}` : ""}`;
    }

    return `DNS query ${name}${types}`;
  }

  if (flow.http) {
    const latency = flow.http.latencyNs ? ` (${formatDuration(flow.http.latencyNs / 1e9)})` : "";

    return `${flow.http.protocol ?? "HTTP"} ${flow.http.method ?? ""} ${flow.http.url ?? ""}${flow.http.code ? ` → ${flow.http.code}` : ""}${latency}`.replace(/\s+/g, " ").trim();
  }

  return "";
};

export const formatDuration = (seconds: number): string => {
  if (!Number.isFinite(seconds)) return String(seconds);
  if (seconds >= 1) return `${seconds.toFixed(seconds >= 10 ? 0 : 2)}s`;
  if (seconds >= 0.001) return `${(seconds * 1000).toFixed(seconds >= 0.01 ? 0 : 1)}ms`;

  return `${(seconds * 1e6).toFixed(0)}µs`;
};

export const protocolPort = (flow: Flow): string => (flow.destination.port ? `${flow.protocol} ${flow.destination.port}` : flow.protocol);

export const isAllowed = (verdict: Verdict) => verdict === "FORWARDED" || verdict === "REDIRECTED" || verdict === "TRANSLATED";
export const isDenied = (verdict: Verdict) => verdict === "DROPPED" || verdict === "ERROR";

/** A short name and its context for one side of a flow. */
export const describeEndpoint = (endpoint: FlowEndpoint): { name: string; detail: string } => {
  const name = endpointName(endpoint);
  const parts = [endpoint.podName && endpoint.workload ? endpoint.podName : undefined, endpoint.ip && endpoint.port ? `${endpoint.ip}:${endpoint.port}` : endpoint.ip, endpoint.identity !== undefined ? `identity ${endpoint.identity}` : undefined, endpoint.service ? `svc ${endpoint.service}` : undefined];

  return { name, detail: parts.filter(Boolean).join(" · ") };
};

/** Free-text search over what the flows table shows. */
export const searchFlows = (flows: readonly Flow[], search: string): Flow[] => {
  const needle = search.trim().toLowerCase();

  if (!needle) return [...flows];

  return flows.filter((flow) =>
    [endpointName(flow.source), endpointName(flow.destination), flow.source.ip, flow.destination.ip, flow.source.podName, flow.destination.podName, flow.verdict, flow.dropReason, flow.protocol, flow.destination.port, flow.node, flow.summary, l7Summary(flow), ...(flow.destination.names ?? [])]
      .filter((value) => value !== undefined)
      .join(" ")
      .toLowerCase()
      .includes(needle),
  );
};

export type TimeMode = "last" | "range";

/** The flow filter form as the user fills it: every field a string, so it round-trips through inputs. */
export interface FlowFilterForm {
  readonly namespace: string;
  readonly pod: string;
  readonly labels: string;
  readonly verdict: "" | "FORWARDED" | "DROPPED" | "ERROR" | "AUDIT";
  readonly protocol: string;
  readonly port: string;
  readonly type: "" | "l7" | "policy-verdict" | "drop" | "trace";
  readonly httpStatus: string;
  readonly timeMode: TimeMode;
  readonly last: string;
  readonly since: string;
  readonly until: string;
}

export const emptyFilterForm: FlowFilterForm = {
  namespace: "",
  pod: "",
  labels: "",
  verdict: "",
  protocol: "",
  port: "",
  type: "",
  httpStatus: "",
  timeMode: "last",
  last: "",
  since: "",
  until: "",
};

const durationPattern = /^\d+(\.\d+)?(ns|us|µs|ms|s|m|h)$/;
const rfc3339Pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** Whether hubble's `--since`/`--until` accept a value: a duration such as `5m`, or an RFC 3339 time. */
export const isHubbleTime = (value: string) => durationPattern.test(value.trim()) || rfc3339Pattern.test(value.trim());

/** Turns the form into hubble's filter, or the problems that keep it from being one. */
export const buildFlowFilter = (form: FlowFilterForm, limit: number): { filter?: FlowFilter; errors: string[] } => {
  const errors: string[] = [];
  const port = form.port.trim();
  const last = form.last.trim();

  if (port && !(/^\d+$/.test(port) && Number(port) > 0 && Number(port) < 65536)) errors.push("Port must be a number from 1 to 65535.");
  if (last && !(/^\d+$/.test(last) && Number(last) > 0)) errors.push("The number of flows must be a positive number.");
  if (form.timeMode === "range") {
    if (!form.since.trim() && !form.until.trim()) errors.push("Give a start (since) or an end (until), such as 15m or 2024-05-01T10:00:00Z.");
    if (form.since.trim() && !isHubbleTime(form.since)) errors.push("Since must be a duration such as 15m or an RFC 3339 time.");
    if (form.until.trim() && !isHubbleTime(form.until)) errors.push("Until must be a duration such as 5m or an RFC 3339 time.");
  }

  if (form.httpStatus.trim() && !/^[1-5](\d\d|\d?\+)$/.test(form.httpStatus.trim())) errors.push("HTTP status must be a code such as 404, or a class such as 5+.");

  if (errors.length > 0) return { errors };

  const count = last ? Math.min(Number(last), limit > 0 ? limit : Number(last)) : limit > 0 ? limit : 500;
  const filter: FlowFilter = {
    ...(form.timeMode === "range"
      ? { since: form.since.trim() || undefined, until: form.until.trim() || undefined, last: last ? count : undefined }
      : { last: count }),
    namespace: form.namespace.trim() || undefined,
    pod: form.pod.trim() || undefined,
    labels: form.labels.trim() || undefined,
    verdict: (form.verdict || undefined) as Verdict | undefined,
    protocol: form.protocol.trim().toLowerCase() || undefined,
    port: port ? Number(port) : undefined,
    type: form.type || undefined,
    httpStatus: form.httpStatus.trim() || undefined,
  };

  return { filter: Object.fromEntries(Object.entries(filter).filter(([, value]) => value !== undefined)) as FlowFilter, errors };
};

/** A stable key for a filter, for caching what it read. */
export const filterKey = (filter: FlowFilter) =>
  JSON.stringify(Object.keys(filter).sort().reduce<Record<string, unknown>>((sorted, key) => ({ ...sorted, [key]: filter[key as keyof FlowFilter] }), {}));

export interface HubbleProblem {
  readonly title: string;
  readonly detail: string;
  readonly kind: "rbac" | "disabled" | "relay" | "cli" | "other";
}

/** Explains why flows could not be read, in terms of what to set up. */
export const explainHubbleError = (error: unknown): HubbleProblem => {
  const message = error instanceof Error ? error.message : String(error);

  if (error instanceof KubeError && (error.kind === "Forbidden" || error.kind === "Unauthorized")) {
    return { kind: "rbac", title: "Not allowed to run hubble in the Cilium agent pods", detail: `Reading flows runs \`hubble observe\` inside a Cilium agent pod, which needs the RBAC permission create on pods/exec in the Cilium namespace. ${message.split("\n")[0]}` };
  }

  if (error instanceof KubeError && error.kind === "NotServed") {
    return { kind: "disabled", title: "Hubble is not available", detail: message };
  }

  if (/executable file not found|hubble: not found|no such file/i.test(message)) {
    return { kind: "cli", title: "The hubble CLI is not in the agent image", detail: "Cilium agent images ship the hubble CLI from 1.8 on. Upgrade Cilium, or set the Hubble Relay address in the extension settings." };
  }

  if (/unix:\/\/\/var\/run\/cilium\/hubble.sock|hubble.sock|Unavailable|connection refused|failed to connect/i.test(message)) {
    return { kind: "disabled", title: "Hubble did not answer", detail: `The agent's Hubble server is not reachable, so Hubble is probably disabled. ${message.split("\n")[0]}` };
  }

  return { kind: "other", title: "Flows could not be read", detail: message };
};
