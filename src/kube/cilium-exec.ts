import type { AgentPod } from "./cilium-info";
import { KubeError, type KubectlClient } from "./kubectl";

/** Runs a command in a Cilium agent pod's agent container, as the user, through Lens's kubectl. */
export const execInAgent = (kubectl: KubectlClient, pod: AgentPod, command: readonly string[], { timeoutMs = 45_000, signal }: { timeoutMs?: number; signal?: AbortSignal } = {}) =>
  kubectl.run(["exec", pod.name, "--namespace", pod.namespace, ...(pod.containers.includes("cilium-agent") ? ["--container", "cilium-agent"] : []), "--", ...command], { timeoutMs, signal });

const notFound = (error: unknown) => error instanceof KubeError && /executable file not found|not found in \$PATH|no such file/i.test(error.message);

/** Runs the agent's debug CLI: `cilium-dbg` since Cilium 1.15, `cilium` before. */
export const ciliumDbg = async (kubectl: KubectlClient, pod: AgentPod, args: readonly string[], options?: { timeoutMs?: number; signal?: AbortSignal }) => {
  try {
    return await execInAgent(kubectl, pod, ["cilium-dbg", ...args], options);
  } catch (error) {
    if (notFound(error)) {
      return execInAgent(kubectl, pod, ["cilium", ...args], options);
    }

    throw error;
  }
};

export const parseJsonOutput = <T>(output: string): T => {
  const start = output.search(/[[{]/);

  if (start < 0) {
    throw new KubeError("Other", `Expected JSON, got: ${output.slice(0, 200)}`);
  }

  return JSON.parse(output.slice(start)) as T;
};
