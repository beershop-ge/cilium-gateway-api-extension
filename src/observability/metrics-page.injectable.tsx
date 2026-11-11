import { Div, Span } from "@k8slens/element-components";
import { getInjectable2 } from "@k8slens/injectable";
import { prometheusIsConfiguredInjectionToken } from "@k8slens/prometheus-contracts";
import { useSubscribable } from "@k8slens/subscribable-react";
import { useInject, useSyncInject } from "@k8slens/use-inject";
import { observer } from "mobx-react";
import { type ReactNode, Suspense, use, useMemo } from "react";
import { redactText } from "../common/redact";
import { ciliumPageInjectionToken, type PageProps } from "../navigation/pages";
import { useViewState } from "../navigation/view-state.injectable";
import { Callout, ErrorBoundary, Loading, QueryView, Select, uiStyles, UpdatedAt, useQueryState } from "../ui/components";
import { PageLayout } from "../ui/page-layout";
import { useClusterContext, useRefreshSeconds } from "../ui/use-cluster";
import { chartGeometry, formatMetric, ranges, type RangeId, seriesColor } from "./metrics";
import { observabilityStyles as styles } from "./hubble-view";
import { loadNetworkMetricsInjectable, type MetricResult, type MetricsResult } from "./prometheus-metrics.injectable";

const width = 600;
const height = 160;
const left = 56;
const bottom = 18;

const timeLabel = (seconds: number, span: number) => {
  const date = new Date(seconds * 1000);

  return span > 6 * 3600 ? date.toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" }) : date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
};

export const LineChart = ({ metric, range }: { metric: MetricResult; range: MetricsResult["range"] }) => {
  const geometry = useMemo(() => chartGeometry(metric.series, range, width - left, height - bottom), [metric.series, range]);
  const span = range.end - range.start;

  return (
    <Div $flex={{ direction: "vertical", gap: "xs" }}>
      <svg className={styles.chart} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${metric.definition.title} over time`}>
        {geometry.ticks.map((tick) => {
          const y = height - bottom - (tick / geometry.yMax) * (height - bottom);

          return (
            <g key={tick}>
              <line className={styles.grid} x1={left} x2={width} y1={y} y2={y} />
              <text className={styles.axis} x={left - 4} y={y + 3} textAnchor="end">
                {formatMetric(tick, metric.definition.unit)}
              </text>
            </g>
          );
        })}
        {[0, 0.5, 1].map((fraction) => (
          <text key={fraction} className={styles.axis} x={left + fraction * (width - left)} y={height - 4} textAnchor={fraction === 0 ? "start" : fraction === 1 ? "end" : "middle"}>
            {timeLabel(range.start + fraction * span, span)}
          </text>
        ))}
        <g transform={`translate(${left},0)`}>
          {geometry.paths.map((path, index) => (
            <path key={path.name} d={path.d} style={{ stroke: seriesColor(path.name, index) }}>
              <title>{path.name}</title>
            </path>
          ))}
        </g>
      </svg>
      <Div $flex={{ direction: "horizontal", gap: "m", wrap: true }} $font={{ size: "xs" }}>
        {metric.series.slice(0, 12).map((series, index) => (
          <Div key={series.name} $flex={{ direction: "horizontal", gap: "xs", verticalAlign: "center" }}>
            <span className={styles.swatch} style={{ background: seriesColor(series.name, index) }} />
            <Span>{series.name}</Span>
            <Span $color="textMuted">{formatMetric(series.latest, metric.definition.unit)}</Span>
          </Div>
        ))}
        {metric.series.length > 12 && <Span $color="textMuted">+{metric.series.length - 12} more series</Span>}
      </Div>
    </Div>
  );
};

const MetricCard = ({ metric, range }: { metric: MetricResult; range: MetricsResult["range"] }) => (
  <Div className={uiStyles.card} $padding="m" $flex={{ direction: "vertical", gap: "s" }}>
    <Div $flex={{ direction: "vertical" }}>
      <Span $font={{ bold: true }}>{metric.definition.title}</Span>
      <Span $color="textMuted" $font={{ size: "xs" }} className={uiStyles.mono} $tooltip={metric.definition.query}>
        {metric.definition.description}
      </Span>
    </Div>
    {metric.error ? (
      <Span $color="critical" $font={{ size: "s" }} className={uiStyles.wrap}>
        Query failed: {redactText(metric.error)}
      </Span>
    ) : metric.series.length === 0 ? (
      <Span $color="textMuted">No data (metric not exported?)</Span>
    ) : (
      <LineChart metric={metric} range={range} />
    )}
  </Div>
);

const Charts = observer(({ clusterId, rangeId }: { clusterId: string; rangeId: RangeId }) => {
  const context = useClusterContext(clusterId);
  const load = useInject(loadNetworkMetricsInjectable)();
  const query = context.queries.get(`obs:metrics:${rangeId}`, () => load(clusterId, rangeId));
  const state = useQueryState(query, useRefreshSeconds());

  return (
    <Div $flex={{ direction: "vertical", gap: "m" }}>
      <Div $flex={{ direction: "horizontal", horizontalAlign: "right" }}>
        <UpdatedAt state={state} onRefresh={() => void query.refresh()} />
      </Div>
      <QueryView state={state} onRetry={() => void query.refresh()} loadingText="Querying Prometheus…">
        {(value) => {
          const shown = value.metrics.filter((metric) => !metric.definition.optional || metric.series.length > 0 || metric.error);
          const missingOptional = value.metrics.filter((metric) => metric.definition.optional && metric.series.length === 0 && !metric.error);
          const noData = value.metrics.filter((metric) => !metric.error && metric.series.length === 0);

          return (
            <Div $flex={{ direction: "vertical", gap: "m" }}>
              {noData.length === value.metrics.length && (
                <Callout level="warning" title="No Cilium or Hubble metrics in Prometheus">
                  Enable them with the Helm values prometheus.enabled=true, operator.prometheus.enabled=true and hubble.metrics.enabled=&#123;dns,drop,tcp,flow,port-distribution,icmp,httpV2&#125;, and make sure Prometheus scrapes them (for example with
                  prometheus.serviceMonitor.enabled=true).
                </Callout>
              )}
              <div className={styles.chartGrid}>
                {shown.map((metric) => (
                  <MetricCard key={metric.definition.id} metric={metric} range={value.range} />
                ))}
              </div>
              {missingOptional.length > 0 && (
                <Span $color="textMuted" $font={{ size: "s" }}>
                  Not shown, no data: {missingOptional.map((metric) => metric.definition.title).join(", ")} (the feature is off or the metric is not exported).
                </Span>
              )}
            </Div>
          );
        }}
      </QueryView>
    </Div>
  );
});

/** Reads Lens's subscribable of whether the cluster has a Prometheus, the one place this module suspends. */
const PrometheusConfigured = observer(({ clusterId, children }: { clusterId: string; children: ReactNode }) => {
  const prometheusIsConfigured = useSyncInject(prometheusIsConfiguredInjectionToken);
  const subscribable = useMemo(() => prometheusIsConfigured(clusterId), [prometheusIsConfigured, clusterId]);
  const { value } = useSubscribable(subscribable);
  const configured = use(value).get();

  return configured ? (
    <>{children}</>
  ) : (
    <Callout level="info" title="No Prometheus configured for this cluster">
      Lens has no Prometheus for this cluster. Install one that scrapes Cilium and Hubble (Helm values prometheus.enabled=true and hubble.metrics.enabled=…), then pick it in the cluster&apos;s settings under Metrics.
    </Callout>
  );
});

const MetricsPage = observer(({ clusterId, tabKey }: PageProps) => {
  const [rangeId, setRangeId] = useViewState<RangeId>(tabKey, "range", "1h");

  return (
    <PageLayout
      clusterId={clusterId}
      title="Network Metrics"
      subtitle="Cilium and Hubble metrics from the cluster's Prometheus"
      toolbar={<Select ariaLabel="Time range" value={rangeId} options={(Object.keys(ranges) as RangeId[]).map((id) => ({ value: id, label: `Last ${ranges[id].label}` }))} onChange={setRangeId} />}
    >
      <Div $padding={{ horizontal: "l", bottom: "l" }}>
        <ErrorBoundary title="Whether Prometheus is configured could not be read">
          <Suspense fallback={<Loading text="Checking for Prometheus…" />}>
            <PrometheusConfigured clusterId={clusterId}>
              <Charts clusterId={clusterId} rangeId={rangeId} />
            </PrometheusConfigured>
          </Suspense>
        </ErrorBoundary>
      </Div>
    </PageLayout>
  );
});

export const metricsPageInjectable = getInjectable2({
  id: "cilium-ui-page-network-metrics",
  injectionToken: ciliumPageInjectionToken,
  instantiate: () => () => ({
    id: "metrics",
    section: "observability" as const,
    title: "Network Metrics",
    orderNumber: 50,
    Component: MetricsPage,
    description: "Charts of Cilium and Hubble metrics from Prometheus",
  }),
});
