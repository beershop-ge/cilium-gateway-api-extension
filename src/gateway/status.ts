import { type Condition, conditionsOf, type Health, healthOf } from "../common/conditions";
import type { Json } from "../common/json";
import { gatewayGroup } from "./features";

/** The conditions the Gateway API defines for each level, in the order the designer shows them. */
export const keyConditionTypes = {
  gatewayClass: ["Accepted", "SupportedVersion"],
  gateway: ["Accepted", "Programmed"],
  listener: ["Accepted", "Programmed", "ResolvedRefs", "Conflicted"],
  routeParent: ["Accepted", "ResolvedRefs"],
} as const;

export interface StatusLine {
  readonly label: string;
  readonly health: Health;
  readonly reason?: string;
  readonly conditions: readonly Condition[];
  /** Whether the controller has seen the latest spec: a condition older than the generation is stale. */
  readonly stale: boolean;
}

const isStale = (conditions: readonly Condition[], generation: number | undefined) =>
  generation !== undefined && conditions.some((condition) => condition.observedGeneration !== undefined && condition.observedGeneration < generation);

/** Orders conditions so the key ones come first, in the order the API documents them. */
export const orderConditions = (conditions: readonly Condition[], keys: readonly string[]): Condition[] =>
  [...conditions].sort((a, b) => {
    const ia = keys.indexOf(a.type);
    const ib = keys.indexOf(b.type);

    return (ia < 0 ? keys.length : ia) - (ib < 0 ? keys.length : ib) || a.type.localeCompare(b.type);
  });

const line = (label: string, conditions: readonly Condition[], keys: readonly string[], generation: number | undefined, required: readonly string[] = keys.filter((key) => key !== "Conflicted" && key !== "SupportedVersion")): StatusLine => {
  const { health, reason } = healthOf(conditions, required);

  return { label, health, reason, conditions: orderConditions(conditions, keys), stale: isStale(conditions, generation) };
};

export interface GatewayStatus {
  readonly gateway: StatusLine;
  readonly addresses: readonly string[];
  readonly listeners: ReadonlyArray<StatusLine & { readonly name: string; readonly attachedRoutes?: number; readonly supportedKinds: readonly string[] }>;
}

export const gatewayStatusOf = (gateway: Json): GatewayStatus => {
  const generation = gateway?.metadata?.generation;
  const statuses = (gateway?.status?.listeners ?? []) as Json[];

  return {
    gateway: line("Gateway", conditionsOf(gateway?.status), keyConditionTypes.gateway, generation),
    addresses: ((gateway?.status?.addresses ?? []) as Json[]).map((address) => String(address.value)),
    listeners: ((gateway?.spec?.listeners ?? []) as Json[]).map((listener) => {
      const status = statuses.find((candidate) => candidate.name === listener.name);
      const conditions = conditionsOf(status);

      return {
        ...line(`Listener ${listener.name}`, conditions, keyConditionTypes.listener, generation),
        name: String(listener.name),
        attachedRoutes: status?.attachedRoutes,
        supportedKinds: ((status?.supportedKinds ?? []) as Json[]).map((kind) => String(kind.kind)),
      };
    }),
  };
};

export const gatewayClassStatusOf = (gatewayClass: Json): StatusLine =>
  line("GatewayClass", conditionsOf(gatewayClass?.status), keyConditionTypes.gatewayClass, gatewayClass?.metadata?.generation, ["Accepted"]);

export const describeParentRef = (ref: Json, routeNamespace?: string) =>
  `${ref?.kind ?? "Gateway"} ${ref?.namespace && ref.namespace !== routeNamespace ? `${ref.namespace}/` : ""}${ref?.name}${ref?.sectionName ? ` › ${ref.sectionName}` : ""}${ref?.port ? ` :${ref.port}` : ""}`;

const parentMatches = (status: Json, ref: Json, routeNamespace: string | undefined) => {
  const parent = status?.parentRef ?? {};

  return (
    (parent.group ?? gatewayGroup) === (ref.group ?? gatewayGroup) &&
    (parent.kind ?? "Gateway") === (ref.kind ?? "Gateway") &&
    parent.name === ref.name &&
    (parent.namespace ?? routeNamespace) === (ref.namespace ?? routeNamespace) &&
    (parent.sectionName ?? "") === (ref.sectionName ?? "") &&
    (parent.port ?? "") === (ref.port ?? "")
  );
};

export interface RouteParentStatus extends StatusLine {
  readonly ref: Json;
  readonly controllerName?: string;
  /** The route names this parent but no controller has reported on it. */
  readonly unreported: boolean;
}

/**
 * The status of a route for each of its parents: the parents it names, each with the conditions
 * the controllers reported, and any parent reported on that the spec no longer names.
 */
export const routeParentStatusesOf = (route: Json): RouteParentStatus[] => {
  const namespace = route?.metadata?.namespace;
  const generation = route?.metadata?.generation;
  const statuses = (route?.status?.parents ?? []) as Json[];
  const refs = (route?.spec?.parentRefs ?? []) as Json[];
  const used = new Set<Json>();

  const result: RouteParentStatus[] = refs.flatMap((ref): RouteParentStatus[] => {
    const matching = statuses.filter((status) => parentMatches(status, ref, namespace));

    if (matching.length === 0) {
      return [{ ...line(describeParentRef(ref, namespace), [], keyConditionTypes.routeParent, generation), health: "unknown" as const, reason: "No controller has reported on this parent yet", ref, unreported: true }];
    }

    return matching.map((status) => {
      used.add(status);

      return { ...line(describeParentRef(ref, namespace), conditionsOf(status), keyConditionTypes.routeParent, generation), ref, controllerName: status.controllerName, unreported: false };
    });
  });

  for (const status of statuses) {
    if (!used.has(status)) {
      result.push({
        ...line(`${describeParentRef(status.parentRef, namespace)} (no longer in spec)`, conditionsOf(status), keyConditionTypes.routeParent, generation),
        ref: status.parentRef,
        controllerName: status.controllerName,
        unreported: false,
      });
    }
  }

  return result;
};

/** The routes attached to a Gateway, per listener: those whose parentRefs select the listener. */
export const routesOfListener = (routes: readonly Json[], gateway: Json, listener: Json): Json[] => {
  const gatewayName = gateway?.metadata?.name;
  const gatewayNamespace = gateway?.metadata?.namespace;

  return routes.filter((route) =>
    ((route?.spec?.parentRefs ?? []) as Json[]).some(
      (ref) =>
        (ref.kind ?? "Gateway") === "Gateway" &&
        (ref.group ?? gatewayGroup) === gatewayGroup &&
        ref.name === gatewayName &&
        (ref.namespace ?? route.metadata?.namespace) === gatewayNamespace &&
        (!ref.sectionName || ref.sectionName === listener?.name) &&
        (ref.port === undefined || ref.port === listener?.port),
    ),
  );
};
