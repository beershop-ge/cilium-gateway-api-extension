import { Div, Span } from "@k8slens/element-components";
import { TextInput } from "@k8slens/input-components";
import { observer } from "mobx-react";
import type { Json, Path } from "../common/json";
import { Callout, FieldLabel, Section, Select } from "../ui/components";
import { KeyValueEditor } from "../ui/key-value-editor";
import type { BuilderProps, DesignerContext } from "./data";
import { BackendRefFields, MetadataFields, ParentRefsEditor } from "./common-builders";
import { AddButton, Card, InlineIssues, NumberField, RemoveButton, Row, StringListEditor, SubCard, TextField, gatewayStyles } from "./fields";
import { appendAt, editField, headerListToMap, headerMapToList, newFilter, newRule, removeAt, trafficShares } from "./manifest";
import type { RouteKind } from "./features";
import { hostnameError, issuesUnder } from "./validation";

const shareColors = ["var(--primary)", "var(--colorSuccess, #48c78e)", "var(--colorWarning, #ffb020)", "var(--colorInfo, #3d90ce)", "var(--colorError, #ce3933)", "var(--grey40)"];

/** Where traffic matching a rule goes, as each backend's share of it. */
const TrafficSplit = ({ backends }: { backends: readonly Json[] }) => {
  const shares = trafficShares(backends);

  if (backends.length < 2) {
    return null;
  }

  return (
    <Div $flex={{ direction: "vertical", gap: "xxs" }}>
      <div className={gatewayStyles.shareBar} role="img" aria-label="Traffic split">
        {shares.map((share, index) => (
          <span key={index} style={{ width: `${share}%`, background: shareColors[index % shareColors.length] }} title={`${backends[index]?.name}: ${share}%`} />
        ))}
      </div>
      <Span $color="textMuted" $font={{ size: "s" }}>
        {backends.map((backend, index) => `${backend?.name || "?"} ${shares[index]}%`).join(" · ")}
      </Span>
    </Div>
  );
};

const BackendsEditor = observer(({ ctx, route, rulePath, onChange }: { ctx: DesignerContext; route: Json; rulePath: Path; onChange: (route: Json) => void }) => {
  const path = [...rulePath, "backendRefs"];
  const backends = (route?.spec?.rules?.[rulePath[2] as number]?.backendRefs ?? []) as Json[];
  const namespace = route?.metadata?.namespace;

  return (
    <SubCard title={`Backends (${backends.length})`}>
      {backends.map((backend, index) => (
        <Div key={index} $flex={{ direction: "horizontal", gap: "xs", verticalAlign: "top" }}>
          <Div $flexChild>
            <BackendRefFields ctx={ctx} routeNamespace={namespace} backend={backend} path={[...path, index]} showWeight={backends.length > 1} onChange={(next) => onChange(editField(route, [...path, index], next))} />
          </Div>
          <RemoveButton label="Remove backend" onClick={() => onChange(removeAt(route, path, index))} />
        </Div>
      ))}
      <TrafficSplit backends={backends} />
      <Div>
        <AddButton
          onClick={() => {
            // Splitting traffic: give every backend an explicit weight so the split is visible and editable.
            const withWeights = backends.map((backend) => ({ ...backend, weight: backend.weight ?? 1 }));

            onChange(editField(route, path, [...withWeights, backends.length > 0 ? { name: "", weight: 1 } : { name: "" }]));
          }}
        >
          {backends.length > 0 ? "Add a backend (split traffic)" : "Add a backend"}
        </AddButton>
      </Div>
      <InlineIssues issues={issuesUnder(ctx.issues, path, { exact: true })} />
    </SubCard>
  );
});

const HeaderMatches = ({ matches, types, onChange, label }: { matches: readonly Json[]; types: readonly string[]; onChange: (matches: Json[]) => void; label: string }) => (
  <Div $flex={{ direction: "vertical", gap: "xs" }}>
    {matches.map((match, index) => (
      <Row key={index}>
        <div className={gatewayStyles.narrow}>
          <Select ariaLabel={`${label} match type`} value={match.type ?? "Exact"} options={types.map((type) => ({ value: type, label: type }))} onChange={(type) => onChange(matches.map((item, position) => (position === index ? { ...item, type } : item)))} />
        </div>
        <div className={gatewayStyles.grow}>
          <TextInput aria-label={`${label} name`} placeholder="name" value={match.name ?? ""} onChange={(event) => onChange(matches.map((item, position) => (position === index ? { ...item, name: event.target.value.trim() } : item)))} />
        </div>
        <div className={gatewayStyles.grow}>
          <TextInput aria-label={`${label} value`} placeholder="value" value={match.value ?? ""} onChange={(event) => onChange(matches.map((item, position) => (position === index ? { ...item, value: event.target.value } : item)))} />
        </div>
        <RemoveButton label={`Remove ${label} match`} onClick={() => onChange(matches.filter((_, position) => position !== index))} />
      </Row>
    ))}
    <Div>
      <AddButton onClick={() => onChange([...matches, { type: "Exact", name: "", value: "" }])}>{label} match</AddButton>
    </Div>
  </Div>
);

const HttpMatchEditor = observer(({ ctx, match, onChange }: { ctx: DesignerContext; match: Json; onChange: (match: Json) => void }) => {
  const features = ctx.features.http;
  const set = (path: Path, value: Json) => onChange(editField(match, path, value));

  return (
    <Div $flex={{ direction: "vertical", gap: "xs" }}>
      <Row>
        <div className={gatewayStyles.medium}>
          <FieldLabel label="Path match">
            <Select
              ariaLabel="Path match type"
              value={match?.path?.type ?? (match?.path ? "PathPrefix" : "")}
              options={[{ value: "", label: "Any path" }, ...features.pathTypes.map((type) => ({ value: type, label: type }))]}
              onChange={(type) => set(["path"], type ? { type, value: match?.path?.value ?? "/" } : undefined)}
            />
          </FieldLabel>
        </div>
        {match?.path && <TextField label="Path" value={match.path.value} placeholder="/" onChange={(value) => set(["path", "value"], value)} />}
        {features.method.available && (
          <div className={gatewayStyles.narrow}>
            <FieldLabel label="Method">
              <Select ariaLabel="Method" value={match?.method ?? ""} options={[{ value: "", label: "Any" }, ...features.methods.map((method) => ({ value: method, label: method }))]} onChange={(method) => set(["method"], method)} />
            </FieldLabel>
          </div>
        )}
      </Row>
      <FieldLabel label="Headers">
        <HeaderMatches label="Header" matches={match?.headers ?? []} types={features.headerMatchTypes} onChange={(headers) => set(["headers"], headers)} />
      </FieldLabel>
      {features.queryParams.available ? (
        <FieldLabel label="Query parameters">
          <HeaderMatches label="Query parameter" matches={match?.queryParams ?? []} types={features.headerMatchTypes} onChange={(queryParams) => set(["queryParams"], queryParams)} />
        </FieldLabel>
      ) : (
        <Span $color="textMuted" $font={{ size: "xs" }}>
          Query parameter matching is not offered: {features.queryParams.reason}.
        </Span>
      )}
    </Div>
  );
});

const GrpcMatchEditor = observer(({ ctx, match, onChange }: { ctx: DesignerContext; match: Json; onChange: (match: Json) => void }) => {
  const set = (path: Path, value: Json) => onChange(editField(match, path, value));

  return (
    <Div $flex={{ direction: "vertical", gap: "xs" }}>
      <Row>
        <div className={gatewayStyles.narrow}>
          <FieldLabel label="Method match">
            <Select ariaLabel="Method match type" value={match?.method?.type ?? "Exact"} options={ctx.features.grpc.methodMatchTypes.map((type) => ({ value: type, label: type }))} onChange={(type) => set(["method", "type"], type)} />
          </FieldLabel>
        </div>
        <TextField label="Service" placeholder="any, e.g. foo.bar.v1.Echo" value={match?.method?.service} onChange={(value) => set(["method", "service"], value.trim())} />
        <TextField label="Method" placeholder="any, e.g. Ping" value={match?.method?.method} onChange={(value) => set(["method", "method"], value.trim())} />
      </Row>
      <FieldLabel label="Headers">
        <HeaderMatches label="Header" matches={match?.headers ?? []} types={ctx.features.http.headerMatchTypes} onChange={(headers) => set(["headers"], headers)} />
      </FieldLabel>
    </Div>
  );
});

const HeaderModifierEditor = ({ value, onChange }: { value: Json; onChange: (value: Json) => void }) => (
  <Row>
    <div className={gatewayStyles.grow}>
      <FieldLabel label="Set">
        <KeyValueEditor ariaLabel="headers to set" keyPlaceholder="header" value={headerListToMap(value?.set)} onChange={(map) => onChange(editField(value ?? {}, ["set"], headerMapToList(map)))} />
      </FieldLabel>
    </div>
    <div className={gatewayStyles.grow}>
      <FieldLabel label="Add">
        <KeyValueEditor ariaLabel="headers to add" keyPlaceholder="header" value={headerListToMap(value?.add)} onChange={(map) => onChange(editField(value ?? {}, ["add"], headerMapToList(map)))} />
      </FieldLabel>
    </div>
    <div className={gatewayStyles.grow}>
      <FieldLabel label="Remove">
        <StringListEditor ariaLabel="headers to remove" placeholder="header" values={value?.remove} onChange={(list) => onChange(editField(value ?? {}, ["remove"], list))} />
      </FieldLabel>
    </div>
  </Row>
);

const PathModifierEditor = ({ value, onChange, allowNone }: { value: Json; onChange: (value: Json) => void; allowNone: boolean }) => (
  <>
    <div className={gatewayStyles.medium}>
      <FieldLabel label="Path">
        <Select
          ariaLabel="Path modifier"
          value={value?.type ?? ""}
          options={[...(allowNone ? [{ value: "", label: "Keep the path" }] : []), { value: "ReplaceFullPath", label: "Replace the full path" }, { value: "ReplacePrefixMatch", label: "Replace the matched prefix" }]}
          onChange={(type) => onChange(type ? { type, ...(type === "ReplaceFullPath" ? { replaceFullPath: value?.replaceFullPath ?? "/" } : { replacePrefixMatch: value?.replacePrefixMatch ?? "/" }) } : undefined)}
        />
      </FieldLabel>
    </div>
    {value?.type === "ReplaceFullPath" && <TextField label="Full path" value={value.replaceFullPath} onChange={(text) => onChange({ type: value.type, replaceFullPath: text })} />}
    {value?.type === "ReplacePrefixMatch" && <TextField label="Prefix" value={value.replacePrefixMatch} onChange={(text) => onChange({ type: value.type, replacePrefixMatch: text })} />}
  </>
);

const FilterEditor = observer(({ ctx, route, filter, path, onChange }: { ctx: DesignerContext; route: Json; filter: Json; path: Path; onChange: (filter: Json) => void }) => {
  const set = (field: Path, value: Json) => onChange(editField(filter, field, value));

  switch (filter?.type) {
    case "RequestRedirect":
      return (
        <Row>
          <div className={gatewayStyles.narrow}>
            <FieldLabel label="Scheme">
              <Select ariaLabel="Scheme" value={filter.requestRedirect?.scheme ?? ""} options={[{ value: "", label: "Keep" }, { value: "https", label: "https" }, { value: "http", label: "http" }]} onChange={(value) => set(["requestRedirect", "scheme"], value)} />
            </FieldLabel>
          </div>
          <TextField label="Hostname" placeholder="keep" value={filter.requestRedirect?.hostname} onChange={(value) => set(["requestRedirect", "hostname"], value.trim())} />
          <NumberField label="Port" placeholder="keep" value={filter.requestRedirect?.port} min={1} max={65535} onChange={(value) => set(["requestRedirect", "port"], value)} />
          <div className={gatewayStyles.narrow}>
            <FieldLabel label="Status">
              <Select
                ariaLabel="Status code"
                value={String(filter.requestRedirect?.statusCode ?? 302)}
                options={ctx.features.http.redirectStatusCodes.map((code) => ({ value: String(code), label: String(code) }))}
                onChange={(value) => set(["requestRedirect", "statusCode"], Number(value))}
              />
            </FieldLabel>
          </div>
          <PathModifierEditor allowNone value={filter.requestRedirect?.path} onChange={(value) => set(["requestRedirect", "path"], value)} />
        </Row>
      );
    case "URLRewrite":
      return (
        <Row>
          <TextField label="Hostname" placeholder="keep" value={filter.urlRewrite?.hostname} onChange={(value) => set(["urlRewrite", "hostname"], value.trim())} />
          <PathModifierEditor allowNone value={filter.urlRewrite?.path} onChange={(value) => set(["urlRewrite", "path"], value)} />
        </Row>
      );
    case "RequestHeaderModifier":
      return <HeaderModifierEditor value={filter.requestHeaderModifier} onChange={(value) => set(["requestHeaderModifier"], value ?? {})} />;
    case "ResponseHeaderModifier":
      return <HeaderModifierEditor value={filter.responseHeaderModifier} onChange={(value) => set(["responseHeaderModifier"], value ?? {})} />;
    case "RequestMirror":
      return (
        <Div $flex={{ direction: "vertical", gap: "xs" }}>
          <BackendRefFields
            ctx={ctx}
            routeNamespace={route?.metadata?.namespace}
            backend={filter.requestMirror?.backendRef ?? {}}
            path={[...path, "requestMirror", "backendRef"]}
            showWeight={false}
            onChange={(backend) => set(["requestMirror", "backendRef"], backend)}
          />
          {ctx.features.http.mirrorPercent.available && route?.kind === "HTTPRoute" && (
            <Row>
              <NumberField label="Mirror percent" placeholder="100" min={0} max={100} value={filter.requestMirror?.percent} onChange={(value) => set(["requestMirror", "percent"], value)} />
            </Row>
          )}
        </Div>
      );
    default:
      return (
        <Span $color="textMuted" $font={{ size: "s" }}>
          A {filter?.type} filter: edit it in the Advanced YAML view.
        </Span>
      );
  }
});

const FiltersEditor = observer(({ ctx, route, rulePath, onChange }: { ctx: DesignerContext; route: Json; rulePath: Path; onChange: (route: Json) => void }) => {
  const path = [...rulePath, "filters"];
  const filters = (route?.spec?.rules?.[rulePath[2] as number]?.filters ?? []) as Json[];
  const offered = route?.kind === "GRPCRoute" ? ctx.features.grpc.filterTypes : ctx.features.http.filterTypes;

  return (
    <SubCard title={`Filters (${filters.length})`}>
      {filters.map((filter, index) => (
        <SubCard key={index} title={filter.type} actions={<RemoveButton label={`Remove ${filter.type} filter`} onClick={() => onChange(removeAt(route, path, index))} />}>
          <FilterEditor ctx={ctx} route={route} filter={filter} path={[...path, index]} onChange={(next) => onChange(editField(route, [...path, index], next))} />
          <InlineIssues issues={issuesUnder(ctx.issues, [...path, index]).filter((issue) => !issue.grant)} />
        </SubCard>
      ))}
      <Div $flex={{ direction: "horizontal", gap: "xs", wrap: true }}>
        {offered.map((option) => (
          <AddButton key={option.type} enabled={option.available} tooltip={option.reason} onClick={() => onChange(appendAt(route, path, newFilter(option.type)))}>
            {option.type}
          </AddButton>
        ))}
      </Div>
      <InlineIssues issues={issuesUnder(ctx.issues, path, { exact: true })} />
    </SubCard>
  );
});

const TimeoutsAndRetry = observer(({ ctx, route, rulePath, onChange }: { ctx: DesignerContext; route: Json; rulePath: Path; onChange: (route: Json) => void }) => {
  const rule = route?.spec?.rules?.[rulePath[2] as number] ?? {};
  const { timeouts, retry } = ctx.features.http;

  if (!timeouts.available && !retry.available) {
    return null;
  }

  return (
    <SubCard title="Timeouts and retries">
      <Row>
        {timeouts.available && (
          <>
            <TextField className={gatewayStyles.medium} label="Request timeout" placeholder="e.g. 10s" value={rule.timeouts?.request} onChange={(value) => onChange(editField(route, [...rulePath, "timeouts", "request"], value.trim()))} />
            <TextField
              className={gatewayStyles.medium}
              label="Backend request timeout"
              placeholder="e.g. 5s"
              value={rule.timeouts?.backendRequest}
              onChange={(value) => onChange(editField(route, [...rulePath, "timeouts", "backendRequest"], value.trim()))}
            />
          </>
        )}
        {retry.available && (
          <>
            <NumberField label="Retry attempts" min={0} value={rule.retry?.attempts} onChange={(value) => onChange(editField(route, [...rulePath, "retry", "attempts"], value))} />
            <TextField className={gatewayStyles.medium} label="Retry backoff" placeholder="e.g. 100ms" value={rule.retry?.backoff} onChange={(value) => onChange(editField(route, [...rulePath, "retry", "backoff"], value.trim()))} />
            <TextField
              className={gatewayStyles.medium}
              label="Retry on status codes"
              placeholder="e.g. 503, 504"
              value={((rule.retry?.codes ?? []) as number[]).join(", ")}
              onChange={(value) =>
                onChange(
                  editField(
                    route,
                    [...rulePath, "retry", "codes"],
                    value
                      .split(/[,\s]+/)
                      .filter(Boolean)
                      .map(Number)
                      .filter((code) => Number.isInteger(code)),
                  ),
                )
              }
            />
          </>
        )}
      </Row>
    </SubCard>
  );
});

const RuleEditor = observer(({ ctx, route, index, onChange }: { ctx: DesignerContext; route: Json; index: number; onChange: (route: Json) => void }) => {
  const kind = route.kind as RouteKind;
  const rulePath: Path = ["spec", "rules", index];
  const rule = route?.spec?.rules?.[index] ?? {};
  const matches = (rule.matches ?? []) as Json[];
  const hasMatches = kind === "HTTPRoute" || kind === "GRPCRoute";
  const hasFilters = hasMatches;

  return (
    <Card title={`Rule ${index + 1}${rule.name ? ` · ${rule.name}` : ""}`} actions={<RemoveButton label={`Remove rule ${index + 1}`} onClick={() => onChange(removeAt(route, ["spec", "rules"], index))} />}>
      {hasMatches && (
        <SubCard title={`Matches (${matches.length === 0 ? "every request" : matches.length})`}>
          {matches.map((match, matchIndex) => (
            <SubCard key={matchIndex} title={`Match ${matchIndex + 1}`} actions={<RemoveButton label={`Remove match ${matchIndex + 1}`} onClick={() => onChange(removeAt(route, [...rulePath, "matches"], matchIndex))} />}>
              {kind === "HTTPRoute" ? (
                <HttpMatchEditor ctx={ctx} match={match} onChange={(next) => onChange(editField(route, [...rulePath, "matches", matchIndex], next))} />
              ) : (
                <GrpcMatchEditor ctx={ctx} match={match} onChange={(next) => onChange(editField(route, [...rulePath, "matches", matchIndex], next))} />
              )}
              <InlineIssues issues={issuesUnder(ctx.issues, [...rulePath, "matches", matchIndex])} />
            </SubCard>
          ))}
          <Span $color="textMuted" $font={{ size: "xs" }}>
            A request matches the rule when it matches any one of these; within a match, every condition must hold.
          </Span>
          <Div>
            <AddButton onClick={() => onChange(appendAt(route, [...rulePath, "matches"], kind === "HTTPRoute" ? { path: { type: "PathPrefix", value: "/" } } : { method: { type: "Exact", service: "" } }))}>
              Match
            </AddButton>
          </Div>
        </SubCard>
      )}
      {hasFilters && <FiltersEditor ctx={ctx} route={route} rulePath={rulePath} onChange={onChange} />}
      <BackendsEditor ctx={ctx} route={route} rulePath={rulePath} onChange={onChange} />
      {kind === "HTTPRoute" && <TimeoutsAndRetry ctx={ctx} route={route} rulePath={rulePath} onChange={onChange} />}
    </Card>
  );
});

export const RouteBuilder = observer(({ ctx, document, onChange, isNew }: BuilderProps) => {
  const kind = document.kind as RouteKind;
  const rules = (document?.spec?.rules ?? []) as Json[];
  const hasHostnames = kind === "HTTPRoute" || kind === "GRPCRoute" || kind === "TLSRoute";

  return (
    <Div $flex={{ direction: "vertical", gap: "l" }}>
      <MetadataFields ctx={ctx} document={document} onChange={onChange} isNew={isNew} />
      <ParentRefsEditor ctx={ctx} document={document} onChange={onChange} isNew={isNew} portAvailable={ctx.features.http.parentPort.available} />

      {hasHostnames && (
        <Section title={kind === "TLSRoute" ? "SNI hostnames" : "Hostnames"}>
          <Span $color="textMuted" $font={{ size: "s" }}>
            {kind === "TLSRoute" ? "The TLS server names (SNI) this route takes." : "The Host headers this route takes; none means every hostname the listener accepts."}
          </Span>
          <StringListEditor
            ariaLabel="hostnames"
            placeholder="www.example.com or *.example.com"
            values={document?.spec?.hostnames}
            validate={(value) => {
              const error = hostnameError(value.toLowerCase());

              return error ? `Hostname ${error}` : undefined;
            }}
            onChange={(hostnames) => onChange(editField(document, ["spec", "hostnames"], hostnames.map((hostname) => hostname.toLowerCase())))}
          />
          <InlineIssues issues={issuesUnder(ctx.issues, ["spec", "hostnames"])} />
        </Section>
      )}

      <Section title={`Rules (${rules.length})`}>
        {rules.length === 0 && (
          <Callout level={kind === "HTTPRoute" || kind === "GRPCRoute" ? "info" : "warning"}>
            {kind === "HTTPRoute" || kind === "GRPCRoute" ? "Without rules, the route sends every request to no backend." : "The route needs at least one rule with a backend."}
          </Callout>
        )}
        {rules.map((_, index) => (
          <RuleEditor key={index} ctx={ctx} route={document} index={index} onChange={onChange} />
        ))}
        <Div>
          <AddButton onClick={() => onChange(appendAt(document, ["spec", "rules"], newRule(kind)))}>Rule</AddButton>
        </Div>
      </Section>
    </Div>
  );
});
