import type { Json } from "./json";

export type Health = "ok" | "warn" | "error" | "unknown";

export interface Condition {
  readonly type: string;
  readonly status: string;
  readonly reason?: string;
  readonly message?: string;
  readonly lastTransitionTime?: string;
  readonly observedGeneration?: number;
}

export const conditionsOf = (status: Json): Condition[] =>
  Array.isArray(status?.conditions)
    ? (status.conditions as Json[]).map((condition) => ({
        type: String(condition.type),
        status: String(condition.status),
        reason: condition.reason,
        message: condition.message,
        lastTransitionTime: condition.lastTransitionTime,
        observedGeneration: condition.observedGeneration,
      }))
    : [];

export const isTrue = (conditions: readonly Condition[], type: string) =>
  conditions.some((condition) => condition.type === type && condition.status === "True");

/** Condition types where "True" means something is wrong. */
const negativeTypes = /conflict|degraded|error|fail|stalled|unavailable|pressure|outofsync/i;

export const conditionIsGood = (condition: Condition) =>
  negativeTypes.test(condition.type) ? condition.status !== "True" : condition.status === "True";

export const healthOf = (conditions: readonly Condition[], required: readonly string[] = []): { health: Health; reason?: string } => {
  if (conditions.length === 0) {
    return { health: "unknown", reason: "No status reported" };
  }

  const bad = conditions.find((condition) => (required.length === 0 || required.includes(condition.type) || negativeTypes.test(condition.type)) && !conditionIsGood(condition) && condition.status !== "Unknown");

  if (bad) {
    return { health: "error", reason: `${bad.type}: ${bad.reason ?? bad.status}${bad.message ? ` — ${bad.message}` : ""}` };
  }

  const missing = required.filter((type) => !isTrue(conditions, type));

  if (missing.length > 0) {
    return { health: "warn", reason: `Waiting for ${missing.join(", ")}` };
  }

  return { health: "ok" };
};

/** Generic health of any resource: its conditions, the conditions of route parents, or a `state`/`phase` field. */
export const healthOfResource = (resource: Json): { health: Health; reason?: string } => {
  const conditions = conditionsOf(resource?.status);
  const parents = (resource?.status?.parents ?? []) as Json[];
  const parentConditions = parents.flatMap((parent) => conditionsOf(parent));
  const all = [...conditions, ...parentConditions];

  if (all.length > 0) {
    return healthOf(all);
  }

  const state = resource?.status?.state ?? resource?.status?.phase;

  if (typeof state === "string") {
    return /ready|running|active|bound|established|ok|healthy/i.test(state)
      ? { health: "ok" }
      : /fail|error|invalid|disconnect/i.test(state)
        ? { health: "error", reason: state }
        : { health: "warn", reason: state };
  }

  return { health: "unknown" };
};
