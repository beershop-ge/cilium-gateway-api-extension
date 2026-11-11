import { redactText } from "../common/redact";

/** The shape of Lens's kubectl for one cluster (`runKubectlInjectionToken`), so the services can be tested with a fake. */
export type RunKubectl = (args: string[], options?: { input?: string; signal?: AbortSignal }) => Promise<string>;

export type KubeErrorKind = "NotFound" | "Forbidden" | "Unauthorized" | "Conflict" | "AlreadyExists" | "Invalid" | "NotServed" | "Timeout" | "Unreachable" | "Aborted" | "Other";

export class KubeError extends Error {
  constructor(
    readonly kind: KubeErrorKind,
    message: string,
    readonly command?: string,
  ) {
    super(message);
    this.name = "KubeError";
  }
}

export const classifyKubectlError = (message: string): KubeErrorKind => {
  if (/\(NotFound\)|not found/i.test(message) && !/the server doesn't have a resource type/i.test(message)) return "NotFound";
  if (/doesn't have a resource type|could not find the requested resource|no matches for kind|resource mapping not found/i.test(message)) return "NotServed";
  if (/\(Forbidden\)|forbidden|cannot (get|list|create|update|patch|delete|watch)/i.test(message)) return "Forbidden";
  if (/\(Unauthorized\)|unauthorized|must be logged in/i.test(message)) return "Unauthorized";
  if (/\(Conflict\)|the object has been modified|conflict/i.test(message)) return "Conflict";
  if (/\(AlreadyExists\)|already exists/i.test(message)) return "AlreadyExists";
  if (/\(Invalid\)|is invalid|\(BadRequest\)|error validating|unknown field|strict decoding error/i.test(message)) return "Invalid";
  if (/timeout|timed out|deadline exceeded/i.test(message)) return "Timeout";
  if (/connection refused|no such host|unable to connect|dial tcp|EOF|network is unreachable|i\/o timeout/i.test(message)) return "Unreachable";

  return "Other";
};

export const describeKubeErrorKind: Record<KubeErrorKind, string> = {
  NotFound: "Not found",
  Forbidden: "Permission denied",
  Unauthorized: "Not authenticated",
  Conflict: "Changed since it was read",
  AlreadyExists: "Already exists",
  Invalid: "Rejected as invalid",
  NotServed: "Not installed on this cluster",
  Timeout: "Timed out",
  Unreachable: "Cluster unreachable",
  Aborted: "Cancelled",
  Other: "Failed",
};

export interface KubectlClient {
  /** Runs kubectl against the API server, with a request timeout, rejecting with a classified `KubeError`. */
  readonly run: (args: string[], options?: { input?: string; signal?: AbortSignal; timeoutMs?: number }) => Promise<string>;
  readonly json: <T = unknown>(args: string[], options?: { input?: string; signal?: AbortSignal; timeoutMs?: number }) => Promise<T>;
}

const apiTimeoutSeconds = 30;

export const createKubectlClient = (runKubectl: RunKubectl, { defaultTimeoutMs = 45_000 } = {}): KubectlClient => {
  const run: KubectlClient["run"] = async (args, options = {}) => {
    const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new KubeError("Timeout", `kubectl did not answer within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    const onAbort = () => controller.abort(new KubeError("Aborted", "Cancelled"));

    options.signal?.addEventListener("abort", onAbort);

    // exec runs a command in a pod for as long as it takes; everything else talks to the API server.
    const withTimeout = args[0] === "exec" || args.some((arg) => arg.startsWith("--request-timeout")) ? args : [...args, `--request-timeout=${apiTimeoutSeconds}s`];

    try {
      return await runKubectl(withTimeout, { input: options.input, signal: controller.signal });
    } catch (error) {
      if (error instanceof KubeError) {
        throw error;
      }

      if (controller.signal.aborted && controller.signal.reason instanceof KubeError) {
        throw controller.signal.reason;
      }

      const message = redactText(error instanceof Error ? error.message : String(error)).trim();

      throw new KubeError(classifyKubectlError(message), message || "kubectl failed", args.slice(0, 2).join(" "));
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  };

  return {
    run,
    json: async <T>(args: string[], options?: { input?: string; signal?: AbortSignal; timeoutMs?: number }) => {
      const output = await run(args, options);

      try {
        return JSON.parse(output) as T;
      } catch {
        throw new KubeError("Other", `kubectl answered with something other than JSON: ${redactText(output.slice(0, 200))}`);
      }
    },
  };
};
