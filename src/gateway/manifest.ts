import { deletePath, getPath, isPlainObject, type Json, type Path, setPath } from "../common/json";
import type { DesignerKind, RouteKind } from "./features";
import { gatewayGroup } from "./features";

export const ciliumControllerName = "io.cilium/gateway-controller";

export const keyOf = (namespace: string | undefined, name: string | undefined) => `${namespace ?? ""}/${name ?? ""}`;

export const resourceKeyOf = (resource: Json) => keyOf(resource?.metadata?.namespace, resource?.metadata?.name);

/** Whether a value is "nothing" for a form: undefined, an empty string, an empty array or an empty object. */
const isEmptyValue = (value: Json) =>
  value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0) || (isPlainObject(value) && Object.keys(value).length === 0);

/**
 * Sets a field from a form input: an empty value removes the field instead of writing `""`, and any
 * object the removal leaves empty is removed too, so the manifest never carries form leftovers.
 */
export const editField = (root: Json, path: Path, value: Json): Json => {
  // An array element is always written: removing it would shift the indexes, and `{}` can mean something (a match-all).
  if (!isEmptyValue(value) || typeof path[path.length - 1] === "number") {
    return setPath(root, path, value);
  }

  let result = deletePath(root, path);

  for (let length = path.length - 1; length > 1; length -= 1) {
    const parentPath = path.slice(0, length);
    const parent = getPath(result, parentPath);

    // Array elements are kept: removing one would shift the indexes the form points at.
    if (!isPlainObject(parent) || Object.keys(parent).length > 0 || typeof path[length] === "number" || typeof parentPath[parentPath.length - 1] === "number") {
      break;
    }

    result = deletePath(result, parentPath);
  }

  return result;
};

/** Appends an element to the array at `path`. */
export const appendAt = (root: Json, path: Path, element: Json): Json => setPath(root, path, [...((getPath(root, path) as Json[] | undefined) ?? []), element]);

/** Removes an element from the array at `path`, removing the array when it becomes empty. */
export const removeAt = (root: Json, path: Path, index: number): Json => {
  const next = ((getPath(root, path) as Json[] | undefined) ?? []).filter((_, position) => position !== index);

  return editField(root, path, next);
};

/** The apiVersion the designer writes for a kind: the preferred served version of its type. */
export type ApiVersions = Readonly<Partial<Record<DesignerKind, string>>>;

const apiVersionFor = (versions: ApiVersions, kind: DesignerKind) => versions[kind] ?? `${gatewayGroup}/v1`;

export const newGatewayClass = (versions: ApiVersions, name = "cilium"): Json => ({
  apiVersion: apiVersionFor(versions, "GatewayClass"),
  kind: "GatewayClass",
  metadata: { name },
  spec: { controllerName: ciliumControllerName },
});

export interface ListenerDraft {
  readonly protocol: string;
  readonly port?: number;
  readonly name?: string;
  readonly hostname?: string;
}

const defaultPorts: Record<string, number> = { HTTP: 80, HTTPS: 443, TLS: 443, TCP: 9000, UDP: 9000 };

/** A new listener with a name not yet used on the Gateway and the protocol's usual port. */
export const newListener = (existing: readonly Json[], draft: ListenerDraft): Json => {
  const names = new Set(existing.map((listener) => listener?.name));
  const base = draft.name ?? draft.protocol.toLowerCase();
  let name = base;

  for (let counter = 2; names.has(name); counter += 1) {
    name = `${base}-${counter}`;
  }

  const listener: Json = { name, protocol: draft.protocol, port: draft.port ?? defaultPorts[draft.protocol] ?? 80 };

  if (draft.hostname) listener.hostname = draft.hostname;
  if (draft.protocol === "HTTPS") listener.tls = { mode: "Terminate", certificateRefs: [] };
  if (draft.protocol === "TLS") listener.tls = { mode: "Passthrough" };

  listener.allowedRoutes = { namespaces: { from: "Same" } };

  return listener;
};

/** Changes a listener's protocol, keeping its TLS settings consistent with what the protocol allows. */
export const changeListenerProtocol = (listener: Json, protocol: string): Json => {
  const next: Json = { ...listener, protocol };

  if (protocol === "HTTPS") {
    next.tls = { ...(listener.tls ?? {}), mode: "Terminate", certificateRefs: listener.tls?.certificateRefs ?? [] };
  } else if (protocol === "TLS") {
    next.tls = { ...(listener.tls ?? {}), mode: listener.tls?.mode ?? "Passthrough" };
  } else {
    delete next.tls;
  }

  if (protocol === "TCP" || protocol === "UDP") {
    delete next.hostname;
  }

  // Kinds chosen for another protocol would no longer be admitted; let the protocol's default apply.
  if (next.allowedRoutes?.kinds) {
    next.allowedRoutes = { ...next.allowedRoutes };
    delete next.allowedRoutes.kinds;
  }

  return next;
};

export const newGateway = (versions: ApiVersions, namespace: string, gatewayClassName: string, name = "gateway"): Json => ({
  apiVersion: apiVersionFor(versions, "Gateway"),
  kind: "Gateway",
  metadata: { name, namespace },
  spec: { gatewayClassName, listeners: [newListener([], { protocol: "HTTP", name: "http" })] },
});

export interface ParentTarget {
  readonly name: string;
  readonly namespace?: string;
  readonly sectionName?: string;
  readonly port?: number;
}

/** A parentRef to a Gateway, leaving out the namespace when it is the route's own, as the API defaults it. */
export const parentRefFor = (routeNamespace: string | undefined, target: ParentTarget): Json => {
  const ref: Json = { group: gatewayGroup, kind: "Gateway", name: target.name };

  if (target.namespace && target.namespace !== routeNamespace) ref.namespace = target.namespace;
  if (target.sectionName) ref.sectionName = target.sectionName;
  if (target.port !== undefined) ref.port = target.port;

  return ref;
};

/** Whether two parentRefs point at the same parent (and the same section and port of it). */
export const sameParentRef = (a: Json, b: Json, routeNamespace: string | undefined) =>
  (a?.group ?? gatewayGroup) === (b?.group ?? gatewayGroup) &&
  (a?.kind ?? "Gateway") === (b?.kind ?? "Gateway") &&
  a?.name === b?.name &&
  (a?.namespace ?? routeNamespace) === (b?.namespace ?? routeNamespace) &&
  (a?.sectionName ?? "") === (b?.sectionName ?? "") &&
  (a?.port ?? "") === (b?.port ?? "");

/** Attaches a route to a Gateway (or one listener of it) by adding a parentRef, unless it is attached already. */
export const attachRoute = (route: Json, target: ParentTarget): Json => {
  const namespace = route?.metadata?.namespace;
  const ref = parentRefFor(namespace, target);
  const refs = (route?.spec?.parentRefs ?? []) as Json[];

  return refs.some((existing) => sameParentRef(existing, ref, namespace)) ? route : setPath(route, ["spec", "parentRefs"], [...refs, ref]);
};

/**
 * Detaches a route from a Gateway: removes the parentRefs to that Gateway, or only those naming the
 * section when one is given.
 */
export const detachRoute = (route: Json, target: ParentTarget): Json => {
  const namespace = route?.metadata?.namespace;
  const refs = (route?.spec?.parentRefs ?? []) as Json[];
  const kept = refs.filter(
    (ref) =>
      !(
        (ref.kind ?? "Gateway") === "Gateway" &&
        ref.name === target.name &&
        (ref.namespace ?? namespace) === (target.namespace ?? namespace) &&
        (target.sectionName === undefined || ref.sectionName === target.sectionName)
      ),
  );

  return kept.length === refs.length ? route : editField(route, ["spec", "parentRefs"], kept);
};

/** A backendRef to a Service port, with the namespace only when it is not the route's own. */
export const backendRefFor = (routeNamespace: string | undefined, service: { name: string; namespace?: string }, port?: number, weight?: number): Json => {
  const ref: Json = { name: service.name };

  if (service.namespace && service.namespace !== routeNamespace) ref.namespace = service.namespace;
  if (port !== undefined) ref.port = port;
  if (weight !== undefined) ref.weight = weight;

  return ref;
};

/** A first rule for a route of each kind, with one backend when one is given. */
export const newRule = (kind: RouteKind, backend?: Json): Json => {
  const rule: Json = {};

  if (kind === "HTTPRoute") rule.matches = [{ path: { type: "PathPrefix", value: "/" } }];
  if (backend) rule.backendRefs = [backend];
  else rule.backendRefs = [];

  return rule;
};

export const newRoute = (versions: ApiVersions, kind: RouteKind, namespace: string, name = kind.toLowerCase().replace("route", "-route"), parent?: ParentTarget): Json => {
  const route: Json = {
    apiVersion: apiVersionFor(versions, kind),
    kind,
    metadata: { name, namespace },
    spec: { parentRefs: parent ? [parentRefFor(namespace, parent)] : [], rules: [newRule(kind)] },
  };

  return route;
};

export interface GrantSide {
  readonly group: string;
  readonly kind: string;
  readonly namespace: string;
}

export interface GrantTarget {
  readonly group: string;
  readonly kind: string;
  readonly namespace: string;
  readonly name?: string;
}

const dnsName = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);

/** A ReferenceGrant in the target's namespace letting `from` refer to `to` (to one name when given). */
export const newReferenceGrant = (versions: ApiVersions, from: GrantSide, to: GrantTarget): Json => ({
  apiVersion: apiVersionFor(versions, "ReferenceGrant"),
  kind: "ReferenceGrant",
  metadata: { name: dnsName(`allow-${from.kind}-${from.namespace}-to-${to.kind}${to.name ? `-${to.name}` : ""}`), namespace: to.namespace },
  spec: {
    from: [{ group: from.group, kind: from.kind, namespace: from.namespace }],
    to: [{ group: to.group, kind: to.kind, ...(to.name ? { name: to.name } : {}) }],
  },
});

/** Ports of a Service as the designer offers them: number, and name and protocol for the label. */
export const servicePortsOf = (service: Json): Array<{ port: number; name?: string; protocol: string; appProtocol?: string }> =>
  ((service?.spec?.ports ?? []) as Json[])
    .filter((port) => typeof port?.port === "number")
    .map((port) => ({ port: port.port, name: port.name, protocol: port.protocol ?? "TCP", appProtocol: port.appProtocol }));

/** Converts the `[{ name, value }]` lists header modifiers use to a map the key-value editor edits, and back. */
export const headerListToMap = (list: Json): Record<string, string> | undefined => {
  const entries = ((Array.isArray(list) ? list : []) as Json[]).filter((entry) => entry?.name).map((entry) => [String(entry.name), String(entry.value ?? "")] as const);

  return entries.length ? Object.fromEntries(entries) : undefined;
};

export const headerMapToList = (map: Readonly<Record<string, string>> | undefined) => Object.entries(map ?? {}).map(([name, value]) => ({ name, value }));

/** A new filter of a type with the minimum each type needs to be valid. */
export const newFilter = (type: string): Json => {
  switch (type) {
    case "RequestRedirect":
      return { type, requestRedirect: { scheme: "https", statusCode: 301 } };
    case "URLRewrite":
      return { type, urlRewrite: { path: { type: "ReplacePrefixMatch", replacePrefixMatch: "/" } } };
    case "RequestHeaderModifier":
      return { type, requestHeaderModifier: { set: [] } };
    case "ResponseHeaderModifier":
      return { type, responseHeaderModifier: { set: [] } };
    case "RequestMirror":
      return { type, requestMirror: { backendRef: { name: "" } } };
    default:
      return { type };
  }
};

/** Sets the weights of a rule's backends so traffic splits by the given percentages. */
export const splitWeights = (backendRefs: readonly Json[], weights: readonly number[]): Json[] =>
  backendRefs.map((backend, index) => ({ ...backend, weight: Math.max(0, Math.round(weights[index] ?? 0)) }));

/** The share of traffic each backend of a rule receives, in percent, as the data plane divides it by weight. */
export const trafficShares = (backendRefs: readonly Json[]): number[] => {
  const weights = backendRefs.map((backend) => (typeof backend?.weight === "number" ? backend.weight : 1));
  const total = weights.reduce((sum, weight) => sum + weight, 0);

  return weights.map((weight) => (total > 0 ? Math.round((weight / total) * 1000) / 10 : 0));
};

/**
 * Detaches a route from one listener of a Gateway: removes the parentRefs that select exactly that
 * listener (by sectionName or port) and those naming the whole Gateway, which would keep it attached.
 */
export const detachRouteFromListener = (route: Json, gateway: Json, listener: Json): Json => {
  const namespace = route?.metadata?.namespace;
  const refs = (route?.spec?.parentRefs ?? []) as Json[];
  const kept = refs.filter((ref) => {
    const targetsGateway =
      (ref.kind ?? "Gateway") === "Gateway" && (ref.group ?? gatewayGroup) === gatewayGroup && ref.name === gateway?.metadata?.name && (ref.namespace ?? namespace) === gateway?.metadata?.namespace;
    const selectsListener = (!ref.sectionName || ref.sectionName === listener?.name) && (ref.port === undefined || ref.port === listener?.port);

    return !(targetsGateway && selectsListener);
  });

  return kept.length === refs.length ? route : editField(route, ["spec", "parentRefs"], kept);
};

/** A name not yet taken among `existing`, from `base`, `base-2`, `base-3`… */
export const uniqueName = (base: string, existing: readonly Json[], namespace?: string) => {
  const taken = new Set(existing.filter((item) => namespace === undefined || item?.metadata?.namespace === namespace).map((item) => item?.metadata?.name));
  let name = base;

  for (let counter = 2; taken.has(name); counter += 1) {
    name = `${base}-${counter}`;
  }

  return name;
};

export interface NewDocumentContext {
  readonly namespace: string;
  readonly gatewayClasses: readonly Json[];
  readonly gateways: readonly Json[];
  readonly existing: readonly Json[];
}

/** A starting manifest for a new resource of a kind, filled from what the cluster has where it can be. */
export const newDocument = (kind: DesignerKind, versions: ApiVersions, context: NewDocumentContext): Json => {
  const { namespace, gatewayClasses, gateways, existing } = context;

  switch (kind) {
    case "GatewayClass":
      return newGatewayClass(versions, uniqueName("cilium", existing));
    case "Gateway": {
      const ciliumClass = gatewayClasses.find((item) => item?.spec?.controllerName === ciliumControllerName) ?? gatewayClasses[0];

      return newGateway(versions, namespace, ciliumClass?.metadata?.name ?? "", uniqueName("gateway", existing, namespace));
    }
    case "ReferenceGrant":
      return {
        apiVersion: apiVersionFor(versions, "ReferenceGrant"),
        kind: "ReferenceGrant",
        metadata: { name: uniqueName("allow-routes", existing, namespace), namespace },
        spec: { from: [{ group: gatewayGroup, kind: "HTTPRoute", namespace: "" }], to: [{ group: "", kind: "Service" }] },
      };
    default: {
      // With one Gateway in the namespace, attach to it from the start.
      const local = gateways.filter((gateway) => gateway?.metadata?.namespace === namespace);
      const parent = local.length === 1 ? { name: local[0].metadata.name, namespace } : undefined;

      return newRoute(versions, kind, namespace, uniqueName(kind.toLowerCase().replace(/route$/, "-route"), existing, namespace), parent);
    }
  }
};
