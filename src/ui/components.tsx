import { Badge } from "@k8slens/badge";
import { Div, Span, Table, TBody, Td, Tr } from "@k8slens/element-components";
import { ErrorOutlineIcon, InfoOutlineIcon, LockIcon, RefreshIcon, WarningIcon } from "@k8slens/icon";
import { PlainButton } from "@k8slens/input-components";
import { observer } from "mobx-react";
import { Component, type ReactNode, useEffect, useRef } from "react";
import type { Condition, Health } from "../common/conditions";
import { conditionIsGood } from "../common/conditions";
import { age } from "../common/format";
import { errorMessage } from "../common/json";
import type { Query, QueryState } from "../common/query";
import { redactText } from "../common/redact";
import { describeKubeErrorKind, KubeError } from "../kube/kubectl";
import styles from "./ui.module.scss";

export { styles as uiStyles };

export const healthColor = { ok: "success", warn: "warning", error: "critical", unknown: "grey40" } as const satisfies Record<Health, string>;
export const healthLabel: Record<Health, string> = { ok: "Healthy", warn: "Pending", error: "Failing", unknown: "Unknown" };

export class ErrorBoundary extends Component<{ children: ReactNode; title?: string }, { error?: Error }> {
  state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    return this.state.error ? (
      <ErrorState title={this.props.title ?? "This view failed to render"} error={this.state.error} onRetry={() => this.setState({ error: undefined })} />
    ) : (
      this.props.children
    );
  }
}

export const Loading = ({ text = "Loading…" }: { text?: string }) => (
  <Div $padding="xl" $color="textMuted" role="status" aria-live="polite">
    {text}
  </Div>
);

export const EmptyState = ({ title, text, children }: { title: string; text?: ReactNode; children?: ReactNode }) => (
  <Div $flex={{ direction: "vertical", gap: "s" }} $padding="xl">
    <Span $font={{ size: "l", bold: true }}>{title}</Span>
    {text && <Span $color="textMuted">{text}</Span>}
    {children}
  </Div>
);

const errorHint = (error: unknown) => {
  if (!(error instanceof KubeError)) {
    return undefined;
  }

  switch (error.kind) {
    case "Forbidden":
      return "Your Kubernetes user is not allowed to do this. Ask a cluster administrator for the RBAC permission named above.";
    case "Unauthorized":
      return "Lens could not authenticate to the cluster. Reconnect the cluster in Lens.";
    case "Unreachable":
    case "Timeout":
      return "The cluster did not answer. Check the connection in Lens and try again.";
    case "NotServed":
      return "The resource type is not installed on this cluster.";
    case "Conflict":
      return "Someone changed the resource after it was read. Reload it, review the difference and apply again.";
    default:
      return undefined;
  }
};

export const ErrorState = ({ title, error, onRetry }: { title?: string; error: unknown; onRetry?: () => void }) => {
  const kind = error instanceof KubeError ? error.kind : undefined;
  const isPermission = kind === "Forbidden" || kind === "Unauthorized";

  return (
    <Div $flex={{ direction: "vertical", gap: "s" }} $padding="xl" role="alert">
      <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center" }} $color={isPermission ? "warning" : "critical"}>
        {isPermission ? <LockIcon /> : <ErrorOutlineIcon />}
        <Span $font={{ size: "l", bold: true }}>{title ?? (kind ? describeKubeErrorKind[kind] : "Something went wrong")}</Span>
      </Div>
      <Span $color="textMuted" className={styles.wrap}>
        {redactText(errorMessage(error))}
      </Span>
      {errorHint(error) && <Span $font={{ size: "s" }}>{errorHint(error)}</Span>}
      {onRetry && (
        <Div>
          <PlainButton Icon={RefreshIcon} $onClick={onRetry}>
            Try again
          </PlainButton>
        </Div>
      )}
    </Div>
  );
};

export type CalloutLevel = "info" | "warning" | "danger" | "success";

const calloutColor = { info: "primary", warning: "warning", danger: "critical", success: "success" } as const;

export const Callout = ({ level = "info", title, children }: { level?: CalloutLevel; title?: ReactNode; children?: ReactNode }) => (
  <Div
    className={styles.callout}
    $color={calloutColor[level]}
    $padding={{ horizontal: "m", vertical: "s" }}
    $backgroundColor="backgroundPrimary"
    $flex={{ direction: "horizontal", gap: "s" }}
    role={level === "danger" ? "alert" : "note"}
  >
    <Span>{level === "info" || level === "success" ? <InfoOutlineIcon $size="s" /> : <WarningIcon $size="s" />}</Span>
    <Div $flex={{ direction: "vertical", gap: "xxs" }} $color="textDefault" $flexChild>
      {title && <Span $font={{ bold: true }}>{title}</Span>}
      {children && <Div $font={{ size: "s" }}>{children}</Div>}
    </Div>
  </Div>
);

export const HealthBadge = ({ health, reason, label }: { health: Health; reason?: string; label?: string }) => (
  <Badge small label={label ?? healthLabel[health]} $backgroundColor={healthColor[health]} $color="white" $tooltip={reason} />
);

export const StatusDot = ({ health, title }: { health: Health; title?: string }) => (
  <Span className={styles.statusDot} $backgroundColor={healthColor[health]} title={title ?? healthLabel[health]} aria-label={title ?? healthLabel[health]} role="img" />
);

export const SectionTitle = ({ children, actions }: { children: ReactNode; actions?: ReactNode }) => (
  <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center" }}>
    <Span $color="textMuted" $font={{ size: "s", bold: true }} $flexChild>
      {children}
    </Span>
    {actions}
  </Div>
);

export const Section = ({ title, actions, children }: { title: ReactNode; actions?: ReactNode; children: ReactNode }) => (
  <Div $flex={{ direction: "vertical", gap: "s" }}>
    <SectionTitle actions={actions}>{title}</SectionTitle>
    {children}
  </Div>
);

/** Two columns of label and value, as a details panel shows facts. */
export const Facts = ({ rows }: { rows: ReadonlyArray<readonly [label: ReactNode, value: ReactNode] | false | undefined | null> }) => (
  <Table className={styles.compactTable}>
    <TBody>
      {rows.filter(Boolean).map((row, index) => {
        const [label, value] = row as readonly [ReactNode, ReactNode];

        return (
          <Tr key={index}>
            <Td $color="textMuted" $style={{ whiteSpace: "nowrap" }}>
              {label}
            </Td>
            <Td className={styles.wrap}>{value ?? "—"}</Td>
          </Tr>
        );
      })}
    </TBody>
  </Table>
);

export const ConditionsList = ({ conditions }: { conditions: readonly Condition[] }) =>
  conditions.length === 0 ? (
    <Span $color="textMuted">No conditions reported.</Span>
  ) : (
    <Div $flex={{ direction: "vertical", gap: "xs" }}>
      {conditions.map((condition, index) => (
        <Div key={`${condition.type}-${index}`} $flex={{ direction: "vertical" }}>
          <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center" }}>
            <StatusDot health={condition.status === "Unknown" ? "unknown" : conditionIsGood(condition) ? "ok" : "error"} />
            <Span $font={{ bold: true }}>{condition.type}</Span>
            <Span $color="textMuted">{condition.status}</Span>
            {condition.reason && <Badge small label={condition.reason} />}
            {condition.lastTransitionTime && (
              <Span $color="textMuted" $font={{ size: "s" }}>
                {age(condition.lastTransitionTime)} ago
              </Span>
            )}
          </Div>
          {condition.message && (
            <Span $color="textMuted" $font={{ size: "s" }} className={styles.wrap}>
              {condition.message}
            </Span>
          )}
        </Div>
      ))}
    </Div>
  );

export const LabelBadges = ({ labels, limit = 6 }: { labels?: Readonly<Record<string, string>>; limit?: number }) => {
  const entries = Object.entries(labels ?? {});

  return entries.length === 0 ? (
    <Span $color="textMuted">—</Span>
  ) : (
    <Div $flex={{ direction: "horizontal", gap: "xxs", wrap: true }}>
      {entries.slice(0, limit).map(([key, value]) => (
        <Badge key={key} small label={value === "" ? key : `${key}=${value}`} />
      ))}
      {entries.length > limit && <Badge small label={`+${entries.length - limit}`} $tooltip={entries.slice(limit).map(([key, value]) => `${key}=${value}`).join("\n")} />}
    </Div>
  );
};

/** Starts loading a query when the component mounts, and loads it again every `refreshSeconds` while mounted. */
export const useQueryState = <T,>(query: Query<T>, refreshSeconds = 0): QueryState<T> => {
  useEffect(() => {
    query.ensure();
  }, [query]);

  useEffect(() => {
    if (refreshSeconds <= 0) {
      return undefined;
    }

    const interval = setInterval(() => void query.refresh(), refreshSeconds * 1000);

    return () => clearInterval(interval);
  }, [query, refreshSeconds]);

  return query.state();
};

/** Renders a query's states: loading, failed, and loaded (keeping the last value visible while it refreshes). */
export const QueryView = observer(<T,>({
  state,
  onRetry,
  loadingText,
  errorTitle,
  children,
}: {
  state: QueryState<T>;
  onRetry?: () => void;
  loadingText?: string;
  errorTitle?: string;
  children: (value: T) => ReactNode;
}) => {
  if (state.value !== undefined) {
    return <>{children(state.value)}</>;
  }

  if (state.status === "error") {
    return <ErrorState title={errorTitle} error={state.error} onRetry={onRetry} />;
  }

  return <Loading text={loadingText} />;
}) as <T>(props: { state: QueryState<T>; onRetry?: () => void; loadingText?: string; errorTitle?: string; children: (value: T) => ReactNode }) => ReactNode;

export const UpdatedAt = observer(({ state, onRefresh }: { state: QueryState<unknown>; onRefresh: () => void }) => (
  <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center" }}>
    {state.status === "error" && state.value !== undefined && (
      <Span $color="warning" $font={{ size: "s" }} $tooltip={state.error?.message}>
        Last refresh failed
      </Span>
    )}
    {state.loadedAt && (
      <Span $color="textMuted" $font={{ size: "s" }}>
        {state.refreshing ? "Refreshing…" : `Updated ${new Date(state.loadedAt).toLocaleTimeString()}`}
      </Span>
    )}
    <PlainButton Icon={RefreshIcon} $onClick={onRefresh} $enabled={!state.refreshing} $tooltip="Read again from the cluster">
      Refresh
    </PlainButton>
  </Div>
));

export const Checkbox = ({ checked, onChange, label, disabled, title }: { checked: boolean; onChange: (checked: boolean) => void; label: ReactNode; disabled?: boolean; title?: string }) => (
  <label className={styles.checkbox} title={title}>
    <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
    <span>{label}</span>
  </label>
);

export interface Option<T extends string = string> {
  readonly value: T;
  readonly label: string;
  readonly disabled?: boolean;
}

export const Select = <T extends string>({
  value,
  options,
  onChange,
  placeholder,
  ariaLabel,
  disabled,
  width,
}: {
  value: T | undefined;
  options: readonly Option<T>[];
  onChange: (value: T) => void;
  placeholder?: string;
  ariaLabel: string;
  disabled?: boolean;
  width?: number;
}) => (
  <select
    className={styles.select}
    value={value ?? ""}
    aria-label={ariaLabel}
    disabled={disabled}
    style={width ? { width } : undefined}
    onChange={(event) => onChange(event.target.value as T)}
  >
    {(value === undefined || !options.some((option) => option.value === value)) && <option value="">{placeholder ?? (value ? value : "Select…")}</option>}
    {options.map((option) => (
      <option key={option.value} value={option.value} disabled={option.disabled}>
        {option.label}
      </option>
    ))}
  </select>
);

export const FieldLabel = ({ label, required, help, children, error }: { label: ReactNode; required?: boolean; help?: ReactNode; error?: string; children: ReactNode }) => (
  <Div $flex={{ direction: "vertical", gap: "xxs" }}>
    <Span $font={{ size: "s", bold: true }}>
      {label}
      {required && <Span $color="critical"> *</Span>}
    </Span>
    {children}
    {error && (
      <Span className={styles.fieldError} $font={{ size: "s" }}>
        {error}
      </Span>
    )}
    {help && (
      <Span $color="textMuted" $font={{ size: "xs" }}>
        {help}
      </Span>
    )}
  </Div>
);

export const UsageBar = ({ used, total, title }: { used: number; total: number; title?: string }) => (
  <div className={styles.bar} title={title ?? `${used} of ${total}`} role="meter" aria-valuenow={used} aria-valuemin={0} aria-valuemax={total}>
    <Div $backgroundColor={total > 0 && used / total > 0.9 ? "critical" : total > 0 && used / total > 0.7 ? "warning" : "primary"} $style={{ width: `${total > 0 ? Math.min(100, (used / total) * 100) : 0}%` }} />
  </div>
);

/** Focuses the element once mounted, for dialogs and editors that open in response to the keyboard. */
export const useAutoFocus = <T extends HTMLElement>() => {
  const ref = useRef<T>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return ref;
};
