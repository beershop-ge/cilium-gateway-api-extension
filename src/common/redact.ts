import { isPlainObject, type Json } from "./json";

const sensitiveKey = /pass(word)?|secret|token|private[-_]?key|credential|api[-_]?key|bearer|auth[-_]?key|client[-_]?key|\.key$|^key$|tls\.key|ca\.key|psk|md5/i;

export const redactedMarker = "••••••";

/** Masks secret-looking values in free text such as kubectl's stderr, before showing or logging it. */
export const redactText = (text: string): string =>
  text
    .replace(/(authorization:\s*)(bearer|basic)\s+[^\s"']+/gi, `$1$2 ${redactedMarker}`)
    .replace(/(--token[= ])[^\s"']+/gi, `$1${redactedMarker}`)
    .replace(/((?:password|passwd|secret|token|api[-_]?key)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, `$1${redactedMarker}`)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, `-----PRIVATE KEY ${redactedMarker}-----`)
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, redactedMarker);

/** A copy of a manifest or values tree with sensitive values masked: Secret data, and fields named like secrets. */
export const redactObject = (value: Json, parentIsSecret = false): Json => {
  if (Array.isArray(value)) {
    return value.map((item) => redactObject(item, parentIsSecret));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const isSecret = value.kind === "Secret";
  const result: Record<string, Json> = {};

  for (const [key, child] of Object.entries(value)) {
    if ((isSecret || parentIsSecret) && (key === "data" || key === "stringData") && isPlainObject(child)) {
      result[key] = Object.fromEntries(Object.keys(child).map((dataKey) => [dataKey, redactedMarker]));
    } else if (sensitiveKey.test(key) && (typeof child === "string" || typeof child === "number") && String(child) !== "") {
      result[key] = redactedMarker;
    } else {
      result[key] = redactObject(child);
    }
  }

  return result;
};
