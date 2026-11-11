import { getInjectable2 } from "@k8slens/injectable";
import { queryPrometheusRangeInjectionToken } from "@k8slens/prometheus-contracts";
import { errorMessage } from "../common/json";
import { type ChartSeries, type MetricDefinition, metricDefinitions, rangeFor, type RangeId, toChartSeries } from "./metrics";

export interface MetricResult {
  readonly definition: MetricDefinition;
  readonly series: readonly ChartSeries[];
  readonly error?: string;
}

export interface MetricsResult {
  readonly range: { readonly start: number; readonly end: number; readonly step: number };
  readonly metrics: readonly MetricResult[];
}

/** Reads every Cilium and Hubble chart over a range from the cluster's Prometheus, one failure per chart rather than for all. */
export const loadNetworkMetricsInjectable = getInjectable2({
  id: "cilium-ui-load-network-metrics",
  consumptions: [queryPrometheusRangeInjectionToken],

  instantiate: (di) => {
    const queryPrometheusRange = di.inject(queryPrometheusRangeInjectionToken)();

    return () =>
      async (clusterId: string, rangeId: RangeId): Promise<MetricsResult> => {
        const range = rangeFor(rangeId, Date.now() / 1000);
        const metrics = await Promise.all(
          metricDefinitions.map(async (definition): Promise<MetricResult> => {
            try {
              return { definition, series: toChartSeries(await queryPrometheusRange(clusterId, definition.query, range), definition.seriesLabel) };
            } catch (error) {
              return { definition, series: [], error: errorMessage(error) };
            }
          }),
        );

        return { range, metrics };
      };
  },
});
