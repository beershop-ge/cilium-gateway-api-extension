import { Div, Span } from "@k8slens/element-components";
import { CheckIcon, PlayArrowIcon } from "@k8slens/icon";
import { PlainButton, PrimaryButton } from "@k8slens/input-components";
import { useInject } from "@k8slens/use-inject";
import { observer } from "mobx-react";
import { useMemo, useState } from "react";
import { errorMessage, type Json } from "../common/json";
import { cleanForDiff, resourceKey } from "../common/manifest";
import { assessChange, type Risk } from "../common/risk";
import { toYaml } from "../common/yaml";
import { KubeError } from "../kube/kubectl";
import type { WriteMode } from "../kube/operations";
import type { ValidationIssue } from "../schema/validate";
import { formatIssue } from "../schema/validate";
import { settingsStoreInjectable } from "../settings/settings.injectable";
import { Callout, Checkbox, ErrorState, Select } from "../ui/components";
import { confirmInjectable } from "../ui/confirm-modal.injectable";
import { DiffView } from "../ui/code-editor";
import { resourceActionsInjectable } from "./resource-actions.injectable";

const modeLabels: Record<WriteMode, string> = {
  create: "Create (fails if it exists)",
  replace: "Replace (refused if changed since read)",
  "server-side-apply": "Server-side apply (merge, field ownership)",
};

export interface ApplyPanelProps {
  readonly clusterId: string;
  readonly documents: readonly Json[];
  readonly originals?: readonly Json[];
  readonly issues?: readonly ValidationIssue[];
  readonly modes: readonly WriteMode[];
  readonly defaultMode?: WriteMode;
  readonly description: string;
  readonly onApplied?: (results: Json[]) => void;
  /** Offered when the server refuses a replace as a conflict: read the resource again. */
  readonly onReload?: () => void;
  readonly extraRisks?: readonly Risk[];
}

type DryRun = { readonly key: string; readonly results?: Json[]; readonly error?: unknown; readonly running: boolean };

/**
 * The one way the extension writes to a cluster: shows what is wrong and what is risky, runs a server-side
 * dry run (admission, schema, RBAC and CEL rules all evaluated by the API server), shows the diff against
 * what is live, and only then applies.
 */
export const ApplyPanel = observer(({ clusterId, documents, originals = [], issues = [], modes, defaultMode, description, onApplied, onReload, extraRisks = [] }: ApplyPanelProps) => {
  const actions = useInject(resourceActionsInjectable)();
  const settings = useInject(settingsStoreInjectable)();
  const confirm = useInject(confirmInjectable)();
  const readOnly = settings.isReadOnly(clusterId);
  const [mode, setMode] = useState<WriteMode>(defaultMode && modes.includes(defaultMode) ? defaultMode : modes[0]);
  const [force, setForce] = useState(false);
  const [dryRun, setDryRun] = useState<DryRun>();
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<unknown>();

  const key = useMemo(() => `${mode}|${force}|${JSON.stringify(documents)}`, [mode, force, documents]);
  const currentDryRun = dryRun?.key === key ? dryRun : undefined;
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  const originalOf = (document: Json) => originals.find((original) => resourceKey(original) === resourceKey(document));

  const risks = useMemo(() => {
    const all = [...extraRisks, ...documents.flatMap((document) => assessChange(originalOf(document), document))];

    return all.filter((risk, index) => all.findIndex((other) => other.message === risk.message) === index);
  }, [documents, originals, extraRisks]);

  const runDryRun = async () => {
    setDryRun({ key, running: true });
    setApplyError(undefined);

    try {
      setDryRun({ key, running: false, results: await actions.dryRun(clusterId, { documents, mode, forceConflicts: force }) });
    } catch (error) {
      setDryRun({ key, running: false, error });
    }
  };

  const apply = async () => {
    if (risks.some((risk) => risk.level === "danger")) {
      const ok = await confirm({
        title: "Apply risky change",
        message: `${description}. Read the warnings before going ahead.`,
        confirmLabel: "Apply",
        danger: true,
        risks: risks.filter((risk) => risk.level !== "info"),
      });

      if (!ok) {
        return;
      }
    }

    setApplying(true);
    setApplyError(undefined);

    try {
      const results = await actions.apply(clusterId, { documents, originals, mode, forceConflicts: force, description });

      onApplied?.(results);
    } catch (error) {
      setApplyError(error);
    } finally {
      setApplying(false);
    }
  };

  const conflict = (error: unknown) => error instanceof KubeError && error.kind === "Conflict";

  return (
    <Div $flex={{ direction: "vertical", gap: "m" }}>
      {readOnly && <Callout level="warning" title="Read-only mode">Changes are turned off for this cluster. You can still validate with a dry run.</Callout>}

      {errors.length > 0 && (
        <Callout level="danger" title={`${errors.length} validation error${errors.length === 1 ? "" : "s"} against the installed schema`}>
          {errors.slice(0, 12).map((issue, index) => (
            <div key={index}>{formatIssue(issue)}</div>
          ))}
          {errors.length > 12 && <div>…and {errors.length - 12} more</div>}
        </Callout>
      )}

      {warnings.length > 0 && (
        <Callout level="warning" title="Fields the API server will drop">
          {warnings.slice(0, 8).map((issue, index) => (
            <div key={index}>{formatIssue(issue)}</div>
          ))}
        </Callout>
      )}

      {risks.map((risk, index) => (
        <Callout key={index} level={risk.level === "danger" ? "danger" : risk.level === "warning" ? "warning" : "info"}>
          {risk.message}
        </Callout>
      ))}

      <Div $flex={{ direction: "horizontal", gap: "m", verticalAlign: "center", wrap: true }}>
        {modes.length > 1 && (
          <Div $width={{ width: "11xl" }}>
            <Select ariaLabel="How to write" value={mode} options={modes.map((value) => ({ value, label: modeLabels[value] }))} onChange={setMode} />
          </Div>
        )}
        {mode === "server-side-apply" && (
          <Checkbox checked={force} onChange={setForce} label="Take over fields other managers own" title="--force-conflicts: needed when another field manager owns a field you change" />
        )}
        <Div $flexChild />
        <PlainButton Icon={PlayArrowIcon} $onClick={() => void runDryRun()} $enabled={!currentDryRun?.running && documents.length > 0}>
          {currentDryRun?.running ? "Validating…" : "Dry run on the server"}
        </PlainButton>
        <PrimaryButton
          Icon={CheckIcon}
          $onClick={() => void apply()}
          $enabled={!readOnly && !applying && currentDryRun?.results !== undefined}
          $tooltip={readOnly ? "Read-only mode is on" : currentDryRun?.results ? undefined : "Run a successful dry run of these changes first"}
        >
          {applying ? "Applying…" : "Apply to cluster"}
        </PrimaryButton>
      </Div>

      {currentDryRun?.error !== undefined && (
        <Div $flex={{ direction: "vertical", gap: "s" }}>
          <ErrorState title="The server refused the dry run" error={currentDryRun.error} />
          {conflict(currentDryRun.error) && onReload && <PlainButton $onClick={onReload}>Reload the latest version</PlainButton>}
          {mode === "create" && currentDryRun.error instanceof KubeError && currentDryRun.error.kind === "AlreadyExists" && modes.includes("server-side-apply") && (
            <PlainButton $onClick={() => setMode("server-side-apply")}>Switch to server-side apply</PlainButton>
          )}
        </Div>
      )}

      {currentDryRun?.results && (
        <Div $flex={{ direction: "vertical", gap: "s" }}>
          <Callout level="success" title="The server accepted the change (dry run: nothing was saved)">
            Below is what the cluster would hold afterwards, compared with what it holds now.
          </Callout>
          {currentDryRun.results.map((result, index) => {
            const original = originalOf(result);

            return (
              <Div key={index} $flex={{ direction: "vertical", gap: "xs" }}>
                <Span $font={{ bold: true }}>
                  {result?.kind} {result?.metadata?.namespace ? `${result.metadata.namespace}/` : ""}
                  {result?.metadata?.name} {original ? "" : "(new)"}
                </Span>
                <DiffView before={original ? toYaml(cleanForDiff({ ...original, status: undefined })) : ""} after={toYaml(cleanForDiff({ ...result, status: undefined }))} maxHeight={360} />
              </Div>
            );
          })}
        </Div>
      )}

      {applyError !== undefined && (
        <Div $flex={{ direction: "vertical", gap: "s" }}>
          <ErrorState title="Applying failed" error={applyError} />
          {conflict(applyError) && onReload && <PlainButton $onClick={onReload}>Reload the latest version</PlainButton>}
          {!(applyError instanceof KubeError) && <Span $color="textMuted">{errorMessage(applyError)}</Span>}
        </Div>
      )}
    </Div>
  );
});
