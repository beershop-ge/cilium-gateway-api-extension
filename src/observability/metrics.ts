import type { PrometheusSeries } from "@k8slens/prometheus-contracts";

export type MetricUnit = "per-second" | "count" | "seconds";

export interface MetricDefinition {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly query: string;
  readonly unit: MetricUnit;
  /** The label that names each series, when grouped by one. */
  readonly seriesLabel?: string;
  /** Shown only when it has data: metrics that only exist with an optional feature. */
  readonly optional?: boolean;
}

export const metricDefinitions: readonly MetricDefinition[] = [
  { id: "flows-by-verdict", title: "Flows processed by verdict", description: "hubble_flows_processed_total", query: "sum(rate(hubble_flows_processed_total[5m])) by (verdict)", unit: "per-second", seriesLabel: "verdict" },
  { id: "hubble-drops", title: "Drops seen by Hubble, by reason", description: "hubble_drop_total", query: "sum(rate(hubble_drop_total[5m])) by (reason)", unit: "per-second", seriesLabel: "reason" },
  { id: "cilium-drops", title: "Packets dropped by the datapath, by reason", description: "cilium_drop_count_total", query: "sum(rate(cilium_drop_count_total[5m])) by (reason)", unit: "per-second", seriesLabel: "reason" },
  { id: "forwarded", title: "Packets forwarded by the datapath", description: "cilium_forward_count_total", query: "sum(rate(cilium_forward_count_total[5m]))", unit: "per-second" },
  { id: "endpoint-state", title: "Endpoints by state", description: "cilium_endpoint_state", query: "sum(cilium_endpoint_state) by (endpoint_state)", unit: "count", seriesLabel: "endpoint_state" },
  { id: "dns-queries", title: "DNS queries", description: "hubble_dns_queries_total", query: "sum(rate(hubble_dns_queries_total[5m]))", unit: "per-second" },
  { id: "dns-responses", title: "DNS responses by code", description: "hubble_dns_responses_total", query: "sum(rate(hubble_dns_responses_total[5m])) by (rcode)", unit: "per-second", seriesLabel: "rcode", optional: true },
  { id: "http-p95", title: "HTTP request latency (p95)", description: "hubble_http_request_duration_seconds", query: "histogram_quantile(0.95, sum(rate(hubble_http_request_duration_seconds_bucket[5m])) by (le))", unit: "seconds" },
  { id: "policy-import-errors", title: "Policy import errors", description: "cilium_policy_import_errors_total / cilium_policy_change_total{outcome=\"fail\"}", query: "sum(rate(cilium_policy_change_total{outcome=\"fail\"}[5m])) or sum(rate(cilium_policy_import_errors_total[5m]))", unit: "per-second", optional: true },
  { id: "bgp-sessions", title: "BGP sessions established", description: "cilium_bgp_control_plane_session_state", query: "sum(cilium_bgp_control_plane_session_state) by (neighbor)", unit: "count", seriesLabel: "neighbor", optional: true },
];

export type RangeId = "15m" | "1h" | "6h" | "24h";

export const ranges: Record<RangeId, { readonly seconds: number; readonly step: number; readonly label: string }> = {
  "15m": { seconds: 15 * 60, step: 15, label: "15 minutes" },
  "1h": { seconds: 3600, step: 60, label: "1 hour" },
  "6h": { seconds: 6 * 3600, step: 300, label: "6 hours" },
  "24h": { seconds: 24 * 3600, step: 900, label: "24 hours" },
};

export const rangeFor = (id: RangeId, nowSeconds: number) => {
  const { seconds, step } = ranges[id];
  const end = Math.floor(nowSeconds / step) * step;

  return { start: end - seconds, end, step };
};

export interface ChartPoint {
  readonly t: number;
  readonly v: number;
}

export interface ChartSeries {
  readonly name: string;
  readonly points: readonly ChartPoint[];
  readonly latest?: number;
}

/** Turns Prometheus series into chart series: finite samples only, named by the grouping label. */
export const toChartSeries = (series: readonly PrometheusSeries[], seriesLabel?: string): ChartSeries[] =>
  series
    .map((item) => {
      const points = item.values.map(([t, value]) => ({ t: Number(t), v: Number(value) })).filter((point) => Number.isFinite(point.v) && Number.isFinite(point.t));
      const name = (seriesLabel ? item.metric[seriesLabel] : undefined) ?? (Object.entries(item.metric).map(([key, value]) => `${key}=${value}`).join(", ") || "total");

      return { name: name || "(none)", points, latest: points.at(-1)?.v };
    })
    .filter((item) => item.points.length > 0)
    .sort((a, b) => (b.latest ?? 0) - (a.latest ?? 0) || a.name.localeCompare(b.name));

/** A round upper bound for the y axis: 1, 2, 2.5 or 5 times a power of ten. */
export const niceMax = (max: number): number => {
  if (!Number.isFinite(max) || max <= 0) return 1;

  const power = 10 ** Math.floor(Math.log10(max));

  for (const factor of [1, 2, 2.5, 5, 10]) {
    if (max <= factor * power) return factor * power;
  }

  return 10 * power;
};

export interface ChartGeometry {
  readonly yMax: number;
  readonly ticks: readonly number[];
  readonly paths: ReadonlyArray<{ readonly name: string; readonly d: string }>;
}

/** Scales series into an SVG box: x across the range, y from zero to a round maximum; gaps longer than two steps break the line. */
export const chartGeometry = (series: readonly ChartSeries[], range: { start: number; end: number; step: number }, width: number, height: number): ChartGeometry => {
  const yMax = niceMax(Math.max(0, ...series.flatMap((item) => item.points.map((point) => point.v))));
  const span = Math.max(1, range.end - range.start);
  const x = (t: number) => ((t - range.start) / span) * width;
  const y = (v: number) => height - (Math.max(0, v) / yMax) * height;
  const round = (n: number) => Math.round(n * 10) / 10;

  return {
    yMax,
    ticks: [0, yMax / 4, yMax / 2, (yMax * 3) / 4, yMax],
    paths: series.map((item) => ({
      name: item.name,
      d: item.points
        .map((point, index) => `${index === 0 || point.t - item.points[index - 1].t > range.step * 2 ? "M" : "L"}${round(x(point.t))},${round(y(point.v))}`)
        .join(" "),
    })),
  };
};

export const formatMetric = (value: number | undefined, unit: MetricUnit): string => {
  if (value === undefined || !Number.isFinite(value)) return "—";

  const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : n >= 10 || n === 0 ? n.toFixed(0) : n >= 1 ? n.toFixed(1) : n.toFixed(2));

  switch (unit) {
    case "per-second":
      return `${compact(value)}/s`;
    case "seconds":
      return value >= 1 ? `${value.toFixed(2)}s` : `${(value * 1000).toFixed(value >= 0.01 ? 0 : 1)}ms`;
    default:
      return compact(value);
  }
};

const seriesColors: Record<string, string> = {
  FORWARDED: "var(--success)",
  DROPPED: "var(--critical)",
  ERROR: "var(--critical)",
  AUDIT: "var(--warning)",
  NOERROR: "var(--success)",
  NXDOMAIN: "var(--warning)",
  SERVFAIL: "var(--critical)",
  ready: "var(--success)",
  "not-ready": "var(--warning)",
  disconnected: "var(--critical)",
};

const palette = ["var(--primary)", "var(--success)", "var(--warning)", "var(--critical)", "var(--grey20)", "var(--grey60)"];

/** A theme colour per series: known values by meaning, the rest by position. */
export const seriesColor = (name: string, index: number) => seriesColors[name] ?? palette[index % palette.length];
