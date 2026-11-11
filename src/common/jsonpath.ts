import type { Json } from "./json";

type Segment = { readonly key: string } | { readonly index: number } | { readonly wildcard: true } | { readonly filter: { readonly path: readonly string[]; readonly value: string; readonly negate: boolean } };

const parse = (expression: string): Segment[] => {
  const segments: Segment[] = [];
  const text = expression.trim().replace(/^\{|\}$/g, "").replace(/^\$/, "");
  let i = 0;

  while (i < text.length) {
    if (text[i] === ".") {
      i++;

      const match = /^[^.[]+/.exec(text.slice(i));

      if (match) {
        segments.push(match[0] === "*" ? { wildcard: true } : { key: match[0] });
        i += match[0].length;
      }
    } else if (text[i] === "[") {
      const end = text.indexOf("]", i);
      const inner = text.slice(i + 1, end < 0 ? text.length : end).trim();

      i = end < 0 ? text.length : end + 1;

      if (inner === "*") {
        segments.push({ wildcard: true });
      } else if (/^-?\d+$/.test(inner)) {
        segments.push({ index: Number(inner) });
      } else if (/^['"].*['"]$/.test(inner)) {
        segments.push({ key: inner.slice(1, -1) });
      } else {
        const filter = /^\?\(@\.([\w.\-/]+)\s*(==|!=)\s*['"]?([^'")]*)['"]?\)$/.exec(inner);

        if (filter) {
          segments.push({ filter: { path: filter[1].split("."), value: filter[3], negate: filter[2] === "!=" } });
        }
      }
    } else {
      const match = /^[^.[]+/.exec(text.slice(i));

      if (!match) {
        break;
      }

      segments.push({ key: match[0] });
      i += match[0].length;
    }
  }

  return segments;
};

/** Evaluates the JSONPath subset CRD printer columns use: fields, indexes, wildcards and `[?(@.a=="b")]` filters. */
export const evaluateJsonPath = (value: Json, expression: string): Json[] => {
  let current: Json[] = [value];

  for (const segment of parse(expression)) {
    const next: Json[] = [];

    for (const item of current) {
      if (item === null || item === undefined) {
        continue;
      }

      if ("key" in segment) {
        if (item[segment.key] !== undefined) next.push(item[segment.key]);
      } else if ("index" in segment) {
        if (Array.isArray(item)) {
          const element = item[segment.index < 0 ? item.length + segment.index : segment.index];

          if (element !== undefined) next.push(element);
        }
      } else if ("wildcard" in segment) {
        next.push(...(Array.isArray(item) ? item : typeof item === "object" ? Object.values(item) : []));
      } else {
        for (const element of Array.isArray(item) ? item : []) {
          const actual = segment.filter.path.reduce<Json>((node, key) => node?.[key], element);
          const matches = String(actual) === segment.filter.value;

          if (matches !== segment.filter.negate) next.push(element);
        }
      }
    }

    current = next;
  }

  return current;
};

export const formatJsonPathValue = (values: readonly Json[]): string =>
  values.length === 0 ? "" : values.map((value) => (typeof value === "object" ? JSON.stringify(value) : String(value))).join(", ");
