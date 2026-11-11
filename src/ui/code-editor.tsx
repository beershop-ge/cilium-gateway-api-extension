import { Div, Span } from "@k8slens/element-components";
import { ContentCopyIcon } from "@k8slens/icon";
import { PlainButton } from "@k8slens/input-components";
import { type KeyboardEvent, useMemo, useRef } from "react";
import { diffLines, diffStats, toHunks } from "../common/diff";
import styles from "./ui.module.scss";

export interface CodeEditorProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly ariaLabel: string;
  readonly errorLines?: readonly number[];
  readonly readOnly?: boolean;
  readonly minHeight?: number;
}

/** A plain-text editor for YAML and JSON with line numbers, two-space indentation on Tab, and error lines marked. */
export const CodeEditor = ({ value, onChange, ariaLabel, errorLines = [], readOnly, minHeight = 320 }: CodeEditorProps) => {
  const gutterRef = useRef<HTMLDivElement>(null);
  const lineCount = Math.max(1, value.split("\n").length);
  const errors = new Set(errorLines);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Tab" || event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }

    // Escape leaves the editor by keyboard: Tab indents, so offer Shift+Tab at line start to outdent instead of trapping focus forever.
    const textarea = event.currentTarget;
    const { selectionStart, selectionEnd } = textarea;

    event.preventDefault();

    if (event.shiftKey) {
      const lineStart = value.lastIndexOf("\n", selectionStart - 1) + 1;

      if (value.slice(lineStart, lineStart + 2) === "  ") {
        onChange(value.slice(0, lineStart) + value.slice(lineStart + 2));
        requestAnimationFrame(() => textarea.setSelectionRange(Math.max(lineStart, selectionStart - 2), Math.max(lineStart, selectionEnd - 2)));
      }

      return;
    }

    onChange(`${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`);
    requestAnimationFrame(() => textarea.setSelectionRange(selectionStart + 2, selectionStart + 2));
  };

  return (
    <div className={styles.codeEditor} style={{ minHeight, height: "100%" }}>
      <div ref={gutterRef} className={`${styles.gutter} ${styles.mono}`} aria-hidden>
        {Array.from({ length: lineCount }, (_, index) => (
          <div key={index} className={errors.has(index + 1) ? styles.errorLine : undefined}>
            {index + 1}
          </div>
        ))}
      </div>
      <textarea
        className={styles.mono}
        value={value}
        aria-label={ariaLabel}
        aria-invalid={errors.size > 0}
        readOnly={readOnly}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        onScroll={(event) => {
          if (gutterRef.current) {
            gutterRef.current.scrollTop = event.currentTarget.scrollTop;
          }
        }}
      />
    </div>
  );
};

export const copyToClipboard = async (text: string) => {
  await navigator.clipboard.writeText(text);
};

/** Read-only code with a copy button. */
export const CodeView = ({ value, maxHeight }: { value: string; maxHeight?: number }) => (
  <Div $flex={{ direction: "vertical", gap: "xs" }}>
    <Div $flex={{ direction: "horizontal", horizontalAlign: "right" }}>
      <PlainButton Icon={ContentCopyIcon} $onClick={() => void copyToClipboard(value)} $tooltip="Copy to the clipboard">
        Copy
      </PlainButton>
    </Div>
    <pre className={`${styles.codeView} ${styles.mono}`} style={maxHeight ? { maxHeight } : undefined}>
      {value}
    </pre>
  </Div>
);

/** A unified diff of two texts, with context around each change. */
export const DiffView = ({ before, after, maxHeight }: { before: string; after: string; maxHeight?: number }) => {
  const lines = useMemo(() => diffLines(before, after), [before, after]);
  const hunks = useMemo(() => toHunks(lines, 4), [lines]);
  const stats = diffStats(lines);

  if (hunks.length === 0) {
    return <Span $color="textMuted">No changes.</Span>;
  }

  return (
    <Div $flex={{ direction: "vertical", gap: "xs" }}>
      <Span $font={{ size: "s" }}>
        <Span $color="success">+{stats.added}</Span> <Span $color="critical">−{stats.removed}</Span> lines
      </Span>
      <div className={`${styles.diff} ${styles.mono}`} style={maxHeight ? { maxHeight } : undefined} role="table" aria-label="Changes">
        {hunks.map((hunk, hunkIndex) => (
          <div key={hunkIndex}>
            {hunkIndex > 0 && <div className={styles.hunkGap}>⋯</div>}
            {hunk.lines.map((line, index) => (
              <div key={index} className={`${styles.line} ${line.type === "add" ? styles.add : line.type === "remove" ? styles.remove : ""}`} role="row">
                <span className={styles.number}>{line.oldNumber ?? ""}</span>
                <span className={styles.number}>{line.newNumber ?? ""}</span>
                <span className={styles.sign}>{line.type === "add" ? "+" : line.type === "remove" ? "−" : " "}</span>
                <span>{line.text}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Div>
  );
};

/** Saves text as a file through the browser's download, which Lens's window handles with a save dialog. */
export const downloadText = (filename: string, text: string, type = "application/yaml") => {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
};

export const downloadBlob = (filename: string, blob: Blob) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
};
