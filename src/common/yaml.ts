import { parseAllDocuments, stringify } from "yaml";
import type { Json } from "./json";

export const toYaml = (value: Json): string =>
  stringify(value, { lineWidth: 0, aliasDuplicateObjects: false, sortMapEntries: false });

export const toYamlDocuments = (values: readonly Json[]): string => values.map(toYaml).join("---\n");

export interface ParsedDocuments {
  readonly documents: Json[];
  readonly errors: ReadonlyArray<{ readonly message: string; readonly line?: number }>;
}

/** Parses one or more YAML (or JSON, which is YAML) documents, skipping empty ones. */
export const parseYamlDocuments = (text: string): ParsedDocuments => {
  const documents: Json[] = [];
  const errors: Array<{ message: string; line?: number }> = [];

  for (const document of parseAllDocuments(text, { prettyErrors: true })) {
    if ("errors" in document && document.errors.length > 0) {
      for (const error of document.errors) {
        errors.push({ message: error.message.split("\n")[0], line: error.linePos?.[0]?.line });
      }

      continue;
    }

    const value = document.toJS({ maxAliasCount: 100 });

    if (value !== null && value !== undefined) {
      documents.push(value);
    }
  }

  return { documents, errors };
};

export const parseSingleYaml = (text: string): { value?: Json; error?: string } => {
  const { documents, errors } = parseYamlDocuments(text);

  if (errors.length > 0) {
    return { error: errors.map((error) => (error.line ? `line ${error.line}: ${error.message}` : error.message)).join("; ") };
  }

  if (documents.length !== 1) {
    return { error: documents.length === 0 ? "The document is empty" : `Expected one document, found ${documents.length}` };
  }

  return { value: documents[0] };
};
