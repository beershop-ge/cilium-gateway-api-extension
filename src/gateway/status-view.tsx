import { Badge } from "@k8slens/badge";
import { Div, Span } from "@k8slens/element-components";
import type { ReactNode } from "react";
import type { Json } from "../common/json";
import { ConditionsList, HealthBadge, Section } from "../ui/components";
import { isRouteKind } from "./features";
import { gatewayClassStatusOf, gatewayStatusOf, routeParentStatusesOf, type StatusLine } from "./status";

const StatusBlock = ({ line, extra }: { line: StatusLine; extra?: ReactNode }) => (
  <Div $flex={{ direction: "vertical", gap: "xs" }} $padding={{ bottom: "s" }}>
    <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center", wrap: true }}>
      <Span $font={{ bold: true }}>{line.label}</Span>
      <HealthBadge health={line.health} reason={line.reason} />
      {line.stale && <Badge small label="Stale" $backgroundColor="warning" $color="white" $tooltip="The controller has not processed the latest change yet" />}
      {extra}
    </Div>
    {line.reason && line.health !== "ok" && (
      <Span $color="textMuted" $font={{ size: "s" }}>
        {line.reason}
      </Span>
    )}
    {line.conditions.length > 0 && <ConditionsList conditions={line.conditions} />}
  </Div>
);

/** The live status of a resource as its controller reports it: Accepted, Programmed and ResolvedRefs, with reasons. */
export const StatusView = ({ resource }: { resource: Json }) => {
  const kind = String(resource?.kind ?? "");

  if (kind === "GatewayClass") {
    const status = gatewayClassStatusOf(resource);

    return (
      <Section title="Status">
        <StatusBlock line={status} />
      </Section>
    );
  }

  if (kind === "Gateway") {
    const status = gatewayStatusOf(resource);

    return (
      <Section title="Status">
        <StatusBlock line={status.gateway} extra={status.addresses.length > 0 ? <Badge small label={status.addresses.join(", ")} $tooltip="Addresses assigned" /> : <Badge small label="No address" />} />
        {status.listeners.map((listener) => (
          <StatusBlock
            key={listener.name}
            line={listener}
            extra={
              <>
                {listener.attachedRoutes !== undefined && <Badge small label={`${listener.attachedRoutes} attached route${listener.attachedRoutes === 1 ? "" : "s"}`} />}
                {listener.supportedKinds.length > 0 && <Span $color="textMuted" $font={{ size: "s" }}>{listener.supportedKinds.join(", ")}</Span>}
              </>
            }
          />
        ))}
      </Section>
    );
  }

  if (isRouteKind(kind)) {
    const parents = routeParentStatusesOf(resource);

    return (
      <Section title="Status per parent">
        {parents.length === 0 && <Span $color="textMuted">The route names no parent.</Span>}
        {parents.map((parent, index) => (
          <StatusBlock key={index} line={parent} extra={parent.controllerName ? <Span $color="textMuted" $font={{ size: "s" }}>{parent.controllerName}</Span> : undefined} />
        ))}
      </Section>
    );
  }

  return null;
};
