import type { Json } from "../common/json";
import { isGatewayGroup, type ResourceType, versionOf } from "../kube/resource-types";
import { enumAt, type Schema, type SchemaDefinitions, schemaHasPath } from "../schema/schema";

export const gatewayGroup = "gateway.networking.k8s.io";

/** The kinds the designer builds, in the order it offers them. */
export const designerKinds = ["GatewayClass", "Gateway", "HTTPRoute", "GRPCRoute", "TLSRoute", "TCPRoute", "UDPRoute", "ReferenceGrant"] as const;

export type DesignerKind = (typeof designerKinds)[number];

export const routeKinds = ["HTTPRoute", "GRPCRoute", "TLSRoute", "TCPRoute", "UDPRoute"] as const;

export type RouteKind = (typeof routeKinds)[number];

export const isRouteKind = (kind: string): kind is RouteKind => (routeKinds as readonly string[]).includes(kind);

export const isDesignerKind = (kind: string | undefined): kind is DesignerKind => kind !== undefined && (designerKinds as readonly string[]).includes(kind);

/** The served type of a Gateway API kind, preferring the standard group over the experimental `x-k8s.io` one. */
export const gatewayTypeOf = (types: readonly ResourceType[], kind: string): ResourceType | undefined =>
  types.find((type) => type.kind === kind && type.group === gatewayGroup) ?? types.find((type) => type.kind === kind && isGatewayGroup(type.group));

export interface KindSchema {
  readonly schema?: Schema;
  readonly definitions?: SchemaDefinitions;
}

/** What the installed Gateway API bundle says about itself, from the annotations of its CRDs. */
export interface BundleInfo {
  readonly version?: string;
  readonly channel?: string;
  /** More than one bundle version is installed across the CRDs: an upgrade went half way. */
  readonly mixed: readonly string[];
}

export const bundleVersionAnnotation = "gateway.networking.k8s.io/bundle-version";
export const channelAnnotation = "gateway.networking.k8s.io/channel";

export const bundleInfoOf = (types: readonly ResourceType[]): BundleInfo => {
  const gatewayTypes = types.filter((type) => isGatewayGroup(type.group));
  const versions = [...new Set(gatewayTypes.map((type) => type.crdAnnotations?.[bundleVersionAnnotation]).filter((value): value is string => Boolean(value)))];
  const channels = [...new Set(gatewayTypes.map((type) => type.crdAnnotations?.[channelAnnotation]).filter((value): value is string => Boolean(value)))];
  const fromGateway = gatewayTypeOf(types, "Gateway")?.crdAnnotations;

  return {
    version: fromGateway?.[bundleVersionAnnotation] ?? versions[0],
    channel: fromGateway?.[channelAnnotation] ?? (channels.length === 1 ? channels[0] : channels.join(" + ") || undefined),
    mixed: versions.length > 1 ? versions : [],
  };
};

/**
 * Features a GatewayClass reports it implements (`status.supportedFeatures`): a list of names in
 * v1.1 and earlier, of `{ name }` objects since. Undefined when the class reports none, which means
 * nothing is known and nothing is hidden on its account.
 */
export const supportedFeaturesOf = (gatewayClass: Json | undefined): ReadonlySet<string> | undefined => {
  const list = gatewayClass?.status?.supportedFeatures;

  if (!Array.isArray(list) || list.length === 0) {
    return undefined;
  }

  return new Set(list.map((entry: Json) => (typeof entry === "string" ? entry : String(entry?.name ?? ""))).filter(Boolean));
};

export interface Availability {
  readonly available: boolean;
  /** Why it is not offered, for a tooltip. */
  readonly reason?: string;
}

const yes: Availability = { available: true };

/**
 * Whether a field is offered: the installed CRD schema must have it, and when the GatewayClass
 * reports its features, the named feature must be among them. Without a schema (discovery without
 * permission to read CRDs and no OpenAPI) only core fields are offered, so this says no.
 */
export const fieldAvailability = (kindSchema: KindSchema | undefined, path: readonly string[], feature: string | undefined, supported: ReadonlySet<string> | undefined): Availability => {
  if (!kindSchema?.schema) {
    return { available: false, reason: "The installed schema is not available, so this optional field is not offered" };
  }

  if (!schemaHasPath(kindSchema.schema, path, kindSchema.definitions)) {
    return { available: false, reason: `The installed CRD version has no ${path.join(".")}` };
  }

  if (feature && supported && !supported.has(feature)) {
    return { available: false, reason: `The GatewayClass does not report support for ${feature}` };
  }

  return yes;
};

const enumOr = (kindSchema: KindSchema | undefined, path: readonly string[], fallback: readonly string[]): string[] => {
  const values = enumAt(kindSchema?.schema, path, kindSchema?.definitions);

  return values && values.length > 0 ? values.map(String) : [...fallback];
};

export const httpFilterTypes = ["RequestHeaderModifier", "ResponseHeaderModifier", "RequestRedirect", "URLRewrite", "RequestMirror"] as const;
export const grpcFilterTypes = ["RequestHeaderModifier", "ResponseHeaderModifier", "RequestMirror"] as const;

/** Features named in the Gateway API conformance profiles, for the filters and fields the designer offers. */
const filterFeature: Record<string, string | undefined> = {
  RequestHeaderModifier: undefined,
  ResponseHeaderModifier: "HTTPRouteResponseHeaderModification",
  RequestRedirect: undefined,
  URLRewrite: "HTTPRoutePathRewrite",
  RequestMirror: "HTTPRouteRequestMirror",
};

export interface GatewayFeatures {
  readonly installed: Readonly<Record<DesignerKind, ResourceType | undefined>>;
  readonly bundle: BundleInfo;
  readonly supported?: ReadonlySet<string>;
  readonly gateway: {
    readonly protocols: readonly string[];
    readonly tlsModes: readonly string[];
    readonly allowedRoutesFrom: readonly string[];
    readonly addresses: Availability;
    readonly addressTypes: readonly string[];
  };
  readonly http: {
    readonly pathTypes: readonly string[];
    readonly headerMatchTypes: readonly string[];
    readonly methods: readonly string[];
    readonly queryParams: Availability;
    readonly method: Availability;
    readonly filterTypes: ReadonlyArray<{ readonly type: string } & Availability>;
    readonly redirectStatusCodes: readonly number[];
    readonly timeouts: Availability;
    readonly retry: Availability;
    readonly mirrorPercent: Availability;
    readonly parentPort: Availability;
  };
  readonly grpc: {
    readonly methodMatchTypes: readonly string[];
    readonly filterTypes: ReadonlyArray<{ readonly type: string } & Availability>;
  };
  readonly gatewayClass: {
    readonly description: Availability;
  };
}

/**
 * Everything the designer may offer on this cluster: the kinds whose CRDs are installed, the
 * fields and enums of the installed schemas, and the features the chosen GatewayClass reports.
 */
export const gatewayFeaturesOf = (types: readonly ResourceType[], schemas: Readonly<Partial<Record<DesignerKind, KindSchema>>>, supported?: ReadonlySet<string>): GatewayFeatures => {
  const installed = Object.fromEntries(designerKinds.map((kind) => [kind, gatewayTypeOf(types, kind)])) as Record<DesignerKind, ResourceType | undefined>;
  const gateway = schemas.Gateway;
  const http = schemas.HTTPRoute;
  const grpc = schemas.GRPCRoute;
  const listener = ["spec", "listeners"];
  const rules = ["spec", "rules"];

  // Protocols are a pattern, not an enum, in the CRD: offer those whose routes this cluster serves.
  const protocols = enumOr(gateway, [...listener, "protocol"], [
    "HTTP",
    "HTTPS",
    ...(installed.TLSRoute || installed.TCPRoute ? ["TLS"] : []),
    ...(installed.TCPRoute ? ["TCP"] : []),
    ...(installed.UDPRoute ? ["UDP"] : []),
  ]);

  // Only HTTPRoute filters have conformance feature names; GRPCRoute filters are core or unnamed.
  const filters = (kindSchema: KindSchema | undefined, candidates: readonly string[], gated: boolean) => {
    const allowed = enumOr(kindSchema, [...rules, "filters", "type"], candidates);

    return candidates
      .filter((type) => allowed.includes(type))
      .map((type) => {
        const feature = gated ? filterFeature[type] : undefined;

        return { type, ...(feature && supported && !supported.has(feature) ? { available: false, reason: `The GatewayClass does not report support for ${feature}` } : yes) };
      });
  };

  return {
    installed,
    bundle: bundleInfoOf(types),
    supported,
    gateway: {
      protocols,
      tlsModes: enumOr(gateway, [...listener, "tls", "mode"], ["Terminate", "Passthrough"]),
      allowedRoutesFrom: enumOr(gateway, [...listener, "allowedRoutes", "namespaces", "from"], ["All", "Same", "Selector"]),
      addresses: fieldAvailability(gateway, ["spec", "addresses"], "GatewayStaticAddresses", supported),
      addressTypes: enumOr(gateway, ["spec", "addresses", "type"], ["IPAddress", "Hostname"]),
    },
    http: {
      pathTypes: enumOr(http, [...rules, "matches", "path", "type"], ["PathPrefix", "Exact", "RegularExpression"]),
      headerMatchTypes: enumOr(http, [...rules, "matches", "headers", "type"], ["Exact", "RegularExpression"]),
      methods: enumOr(http, [...rules, "matches", "method"], ["GET", "HEAD", "POST", "PUT", "DELETE", "CONNECT", "OPTIONS", "TRACE", "PATCH"]),
      queryParams: fieldAvailability(http, [...rules, "matches", "queryParams"], "HTTPRouteQueryParamMatching", supported),
      method: fieldAvailability(http, [...rules, "matches", "method"], "HTTPRouteMethodMatching", supported),
      filterTypes: filters(http, httpFilterTypes, true),
      redirectStatusCodes: (enumAt(http?.schema, [...rules, "filters", "requestRedirect", "statusCode"], http?.definitions) ?? [301, 302]).map(Number),
      timeouts: fieldAvailability(http, [...rules, "timeouts"], "HTTPRouteRequestTimeout", supported),
      retry: fieldAvailability(http, [...rules, "retry"], "HTTPRouteRetry", supported),
      mirrorPercent: fieldAvailability(http, [...rules, "filters", "requestMirror", "percent"], "HTTPRouteRequestPercentageMirror", supported),
      parentPort: fieldAvailability(http, ["spec", "parentRefs", "port"], undefined, undefined),
    },
    grpc: {
      methodMatchTypes: enumOr(grpc, [...rules, "matches", "method", "type"], ["Exact", "RegularExpression"]),
      filterTypes: filters(grpc, grpcFilterTypes, false),
    },
    gatewayClass: {
      description: fieldAvailability(schemas.GatewayClass, ["spec", "description"], undefined, undefined),
    },
  };
};

/** The schema of the version the designer writes for a type: its preferred served version. */
export const preferredSchemaOf = (type: ResourceType | undefined): KindSchema | undefined => {
  const version = type ? versionOf(type) : undefined;

  return version?.schema ? { schema: version.schema, definitions: version.definitions } : undefined;
};

/**
 * The GatewayClass whose `supportedFeatures` apply to a document: itself, a Gateway's class, or the
 * class of the first Gateway a route attaches to.
 */
export const gatewayClassForDocument = (document: Json, gatewayClasses: readonly Json[], gateways: readonly Json[]): Json | undefined => {
  const byName = (name: string | undefined) => (name ? gatewayClasses.find((item) => item?.metadata?.name === name) : undefined);

  switch (document?.kind) {
    case "GatewayClass":
      return byName(document.metadata?.name);
    case "Gateway":
      return byName(document.spec?.gatewayClassName);
    default: {
      for (const ref of (document?.spec?.parentRefs ?? []) as Json[]) {
        const gateway = gateways.find((item) => item?.metadata?.name === ref?.name && item?.metadata?.namespace === (ref?.namespace ?? document.metadata?.namespace));
        const found = byName(gateway?.spec?.gatewayClassName);

        if (found) return found;
      }

      return undefined;
    }
  }
};
