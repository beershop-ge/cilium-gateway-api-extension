import { endpointName, type Flow } from "./hubble";
import { isAllowed, isDenied, rcodeName, sortableTime } from "./flow-logic";

export interface VerdictRow {
  readonly key: string;
  readonly source: string;
  readonly destination: string;
  readonly port: string;
  readonly direction: string;
  readonly allowed: number;
  readonly denied: number;
  readonly audit: number;
  readonly policies: readonly string[];
  readonly deniedBy: readonly string[];
  readonly dropReasons: readonly string[];
  readonly lastSeen: string;
  readonly flows: readonly Flow[];
}

const portOf = (flow: Flow) => {
  const transport = flow.protocol === "DNS" ? "UDP" : flow.protocol === "HTTP" || flow.protocol === "Kafka" ? "TCP" : flow.protocol;

  return flow.destination.port ? `${flow.destination.port}/${transport}` : transport;
};

/** Groups policy verdicts by source → destination → port, counting allowed and denied, with the policies that decided. */
export const verdictStats = (flows: readonly Flow[]): VerdictRow[] => {
  const rows = new Map<string, { source: string; destination: string; port: string; direction: string; allowed: number; denied: number; audit: number; policies: Set<string>; deniedBy: Set<string>; dropReasons: Set<string>; lastSeen: string; flows: Flow[] }>();

  for (const flow of flows) {
    const source = endpointName(flow.source);
    const destination = endpointName(flow.destination);
    const port = portOf(flow);
    const direction = flow.direction ?? "";
    const key = `${source}→${destination}→${port}→${direction}`;
    let row = rows.get(key);

    if (!row) {
      row = { source, destination, port, direction, allowed: 0, denied: 0, audit: 0, policies: new Set(), deniedBy: new Set(), dropReasons: new Set(), lastSeen: flow.time, flows: [] };
      rows.set(key, row);
    }

    if (isAllowed(flow.verdict)) row.allowed++;
    else if (isDenied(flow.verdict)) row.denied++;
    else if (flow.verdict === "AUDIT") row.audit++;

    for (const policy of flow.allowedBy ?? []) row.policies.add(policy);
    for (const policy of flow.deniedBy ?? []) row.deniedBy.add(policy);
    if (flow.dropReason) row.dropReasons.add(flow.dropReason);
    if (sortableTime(flow.time) > sortableTime(row.lastSeen)) row.lastSeen = flow.time;
    row.flows.push(flow);
  }

  return [...rows.entries()]
    .map(([key, row]) => ({ ...row, key, policies: [...row.policies].sort(), deniedBy: [...row.deniedBy].sort(), dropReasons: [...row.dropReasons].sort() }))
    .sort((a, b) => b.denied - a.denied || b.allowed + b.audit - (a.allowed + a.audit) || a.key.localeCompare(b.key));
};

export interface CountedValue {
  readonly value: string;
  readonly count: number;
}

const countBy = (values: Iterable<string>): CountedValue[] => {
  const counts = new Map<string, number>();

  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);

  return [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
};

export const verdictTotals = (rows: readonly VerdictRow[]) => ({
  allowed: rows.reduce((sum, row) => sum + row.allowed, 0),
  denied: rows.reduce((sum, row) => sum + row.denied, 0),
  audit: rows.reduce((sum, row) => sum + row.audit, 0),
  dropReasons: countBy(rows.flatMap((row) => row.flows.map((flow) => flow.dropReason).filter((reason): reason is string => Boolean(reason)))),
});

export interface DnsQuery {
  readonly key: string;
  readonly time: string;
  readonly client: string;
  readonly clientPod?: string;
  readonly clientNamespace?: string;
  readonly server: string;
  readonly name: string;
  readonly qtypes: readonly string[];
  /** Undefined while no answer was seen for the query. */
  readonly rcode?: string;
  readonly ips: readonly string[];
  readonly verdict: string;
  readonly flow: Flow;
}

export interface DnsClientStats {
  readonly client: string;
  readonly queries: number;
  readonly failures: number;
  readonly names: readonly string[];
}

export interface DnsStats {
  readonly total: number;
  /** One row per answer, or per query that has no answer among the flows. */
  readonly queries: readonly DnsQuery[];
  readonly rcodes: readonly CountedValue[];
  readonly topNames: readonly CountedValue[];
  readonly failing: readonly CountedValue[];
  readonly byClient: readonly DnsClientStats[];
}

/** Whether a DNS flow is an answer: Hubble says so in the L7 type; older output only tells by direction or content. */
export const isDnsResponse = (flow: Flow) =>
  flow.l7Type === "RESPONSE" || (flow.l7Type === undefined && (flow.isReply === true || (flow.dns?.ips?.length ?? 0) > 0 || (flow.dns?.rcode ?? 0) !== 0));

const isResponse = isDnsResponse;

/** Normalizes a DNS name for counting: lower case without the trailing dot. */
export const dnsName = (name: string | undefined) => (name ?? "").toLowerCase().replace(/\.$/, "") || "(empty)";

/**
 * Summarizes DNS flows (L7 DNS visibility): every response with its code and answer IPs, by client, the most queried
 * names, and the names whose answers were not NOERROR. A response's client is its destination.
 */
export const dnsStats = (flows: readonly Flow[]): DnsStats => {
  const dnsFlows = flows.filter((flow) => flow.dns);
  const responses = dnsFlows.filter(isResponse);
  const requests = dnsFlows.filter((flow) => !isResponse(flow));
  const answered = new Set(responses.map((flow) => `${endpointName(flow.destination)}|${dnsName(flow.dns?.query)}`));

  const rows: DnsQuery[] = [
    ...responses.map((flow) => ({
      key: `${flow.uuid ?? ""}${flow.time}|r|${flow.destination.ip}:${flow.destination.port}|${flow.dns?.query}`,
      time: flow.time,
      client: endpointName(flow.destination),
      clientPod: flow.destination.podName,
      clientNamespace: flow.destination.namespace,
      server: endpointName(flow.source),
      name: dnsName(flow.dns?.query),
      qtypes: flow.dns?.qtypes ?? [],
      rcode: rcodeName(flow.dns?.rcode ?? 0),
      ips: flow.dns?.ips ?? [],
      verdict: flow.verdict,
      flow,
    })),
    ...requests
      .filter((flow) => !answered.has(`${endpointName(flow.source)}|${dnsName(flow.dns?.query)}`) || flow.verdict === "DROPPED")
      .map((flow) => ({
        key: `${flow.uuid ?? ""}${flow.time}|q|${flow.source.ip}:${flow.source.port}|${flow.dns?.query}`,
        time: flow.time,
        client: endpointName(flow.source),
        clientPod: flow.source.podName,
        clientNamespace: flow.source.namespace,
        server: endpointName(flow.destination),
        name: dnsName(flow.dns?.query),
        qtypes: flow.dns?.qtypes ?? [],
        rcode: flow.verdict === "DROPPED" ? "DROPPED" : undefined,
        ips: [],
        verdict: flow.verdict,
        flow,
      })),
  ].sort((a, b) => (sortableTime(a.time) < sortableTime(b.time) ? 1 : -1));

  // Count queries from requests when visible, else from answers (both directions are not always observed).
  const queryRows = requests.length > 0 ? requests.map((flow) => ({ client: endpointName(flow.source), name: dnsName(flow.dns?.query) })) : rows.map((row) => ({ client: row.client, name: row.name }));
  const failed = rows.filter((row) => row.rcode !== undefined && row.rcode !== "NOERROR");
  const clients = new Map<string, { queries: number; failures: number; names: Set<string> }>();

  for (const query of queryRows) {
    const client = clients.get(query.client) ?? { queries: 0, failures: 0, names: new Set<string>() };

    client.queries++;
    client.names.add(query.name);
    clients.set(query.client, client);
  }

  for (const row of failed) {
    const client = clients.get(row.client) ?? { queries: 0, failures: 0, names: new Set<string>([row.name]) };

    client.failures++;
    clients.set(row.client, client);
  }

  return {
    total: dnsFlows.length,
    queries: rows,
    rcodes: countBy(rows.map((row) => row.rcode).filter((code): code is string => code !== undefined)),
    topNames: countBy(queryRows.map((query) => query.name)),
    failing: countBy(failed.map((row) => `${row.name} (${row.rcode})`)),
    byClient: [...clients.entries()]
      .map(([client, stats]) => ({ client, queries: stats.queries, failures: stats.failures, names: [...stats.names].sort() }))
      .sort((a, b) => b.failures - a.failures || b.queries - a.queries || a.client.localeCompare(b.client)),
  };
};

/** The flows that start or end at an endpoint of the service map. */
export const flowsOfEndpoint = (flows: readonly Flow[], name: string): Flow[] =>
  flows.filter((flow) => endpointName(flow.source) === name || endpointName(flow.destination) === name);
