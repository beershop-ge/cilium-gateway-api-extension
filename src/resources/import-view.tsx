import { Div, Span } from "@k8slens/element-components";
import { CloseIcon, UploadFileIcon } from "@k8slens/icon";
import { PlainButton, PrimaryButton } from "@k8slens/input-components";
import { useInject } from "@k8slens/use-inject";
import { observer } from "mobx-react";
import { useRef, useState } from "react";
import type { Json } from "../common/json";
import { parseYamlDocuments } from "../common/yaml";
import { clusterContextInjectable } from "../kube/cluster-context.injectable";
import { KubeError } from "../kube/kubectl";
import { validateResource, type ValidationIssue } from "../schema/validate";
import { Callout } from "../ui/components";
import { CodeEditor } from "../ui/code-editor";
import { ApplyPanel } from "./apply-panel";

/** Imports manifests, pasted or from a file: parsed, validated against the installed schemas, compared with the cluster, then applied. */
export const ImportView = observer(({ clusterId, defaultNamespace, initialText = "", onClose }: { clusterId: string; defaultNamespace?: string; initialText?: string; onClose: () => void }) => {
  const context = useInject(clusterContextInjectable)()(clusterId);
  const fileInput = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(initialText);
  const [prepared, setPrepared] = useState<{ documents: Json[]; originals: Json[]; issues: ValidationIssue[]; notes: string[] }>();
  const [preparing, setPreparing] = useState(false);
  const parsed = parseYamlDocuments(text);

  const prepare = async () => {
    setPreparing(true);

    const notes: string[] = [];
    const issues: ValidationIssue[] = [];
    const originals: Json[] = [];
    const documents = parsed.documents.flatMap((document) => (document?.kind === "List" ? (document.items ?? []) : [document]));

    for (const [index, document] of documents.entries()) {
      const group = String(document?.apiVersion ?? "").includes("/") ? String(document.apiVersion).split("/")[0] : "";
      const version = String(document?.apiVersion ?? "").split("/").pop() ?? "";
      const type = context.typeOfKind(document?.kind, group);

      if (type?.namespaced && !document.metadata?.namespace && defaultNamespace) {
        document.metadata = { ...document.metadata, namespace: defaultNamespace };
        notes.push(`${document.kind} ${document.metadata.name}: no namespace given, using ${defaultNamespace}`);
      }

      if (!type) {
        notes.push(`${document?.kind ?? "Document"} ${document?.metadata?.name ?? index + 1}: not a Cilium or Gateway API kind this extension knows; the server validates it.`);
        continue;
      }

      const schema = type.versions.find((candidate) => candidate.name === version)?.schema;

      issues.push(...validateResource(document, schema, { namespaced: type.namespaced }).map((issue) => ({ ...issue, path: [`${document.kind} ${document.metadata?.name}`, ...issue.path] })));

      try {
        originals.push(await context.ops.get(type, version, document.metadata.name, document.metadata.namespace));
      } catch (error) {
        if (!(error instanceof KubeError && error.kind === "NotFound")) {
          notes.push(`Could not read the live ${document.kind} ${document.metadata?.name}: ${(error as Error).message}`);
        }
      }
    }

    setPrepared({ documents, originals, issues, notes });
    setPreparing(false);
  };

  return (
    <Div $flex={{ direction: "vertical", gap: "m" }} $padding="l">
      <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center" }}>
        <Span $font={{ size: "l", bold: true }} $flexChild>
          Import YAML
        </Span>
        <PlainButton Icon={CloseIcon} $onClick={onClose}>
          Close
        </PlainButton>
      </Div>

      {!prepared ? (
        <>
          <Span $color="textMuted">Paste one or more manifests separated by ---, or open a file. Nothing is changed until you review a dry run and apply.</Span>
          <Div>
            <input
              ref={fileInput}
              type="file"
              accept=".yaml,.yml,.json,application/yaml,application/json"
              style={{ display: "none" }}
              onChange={(event) => {
                const file = event.target.files?.[0];

                if (file) {
                  void file.text().then(setText);
                }
              }}
            />
            <PlainButton Icon={UploadFileIcon} $onClick={() => fileInput.current?.click()}>
              Open a file…
            </PlainButton>
          </Div>
          <Div $style={{ height: 380 }}>
            <CodeEditor value={text} onChange={setText} ariaLabel="Manifests to import" errorLines={parsed.errors.map((error) => error.line ?? 0).filter(Boolean)} />
          </Div>
          {parsed.errors.length > 0 && (
            <Callout level="danger" title="The YAML does not parse">
              {parsed.errors.map((error, index) => (
                <div key={index}>{error.line ? `line ${error.line}: ` : ""}{error.message}</div>
              ))}
            </Callout>
          )}
          <Div>
            <PrimaryButton $enabled={parsed.errors.length === 0 && parsed.documents.length > 0 && !preparing} $onClick={() => void prepare()}>
              {preparing ? "Comparing with the cluster…" : `Review ${parsed.documents.length} document${parsed.documents.length === 1 ? "" : "s"}`}
            </PrimaryButton>
          </Div>
        </>
      ) : (
        <>
          <PlainButton $onClick={() => setPrepared(undefined)}>← Back to the text</PlainButton>
          {prepared.notes.map((note, index) => (
            <Callout key={index} level="info">
              {note}
            </Callout>
          ))}
          <ApplyPanel
            clusterId={clusterId}
            documents={prepared.documents}
            originals={prepared.originals}
            issues={prepared.issues}
            modes={["server-side-apply", "create"]}
            defaultMode="server-side-apply"
            description={`Import ${prepared.documents.length} manifest${prepared.documents.length === 1 ? "" : "s"}`}
            onApplied={onClose}
          />
        </>
      )}
    </Div>
  );
});
