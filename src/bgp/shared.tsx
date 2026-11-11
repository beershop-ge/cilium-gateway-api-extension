import { Badge } from "@k8slens/badge";
import { Div, Span } from "@k8slens/element-components";
import { PlayArrowIcon } from "@k8slens/icon";
import { PlainButton } from "@k8slens/input-components";
import { useInject } from "@k8slens/use-inject";
import { observer } from "mobx-react";
import { type ReactNode, useState } from "react";
import { errorMessage } from "../common/json";
import { redactText } from "../common/redact";
import type { AgentPod } from "../kube/cilium-info";
import { KubeError, type KubectlClient } from "../kube/kubectl";
import type { Snapshot } from "../kube/snapshot";
import { openCiliumPageInjectable } from "../navigation/open-page.injectable";
import { resourcePageId } from "../navigation/pages";
import { type ResourceRef, resourceActionsInjectable } from "../resources/resource-actions.injectable";
import { Callout, Section, StatusDot, uiStyles } from "../ui/components";
import { useCiliumInfo, useClusterContext } from "../ui/use-cluster";
import type { BgpIssue } from "./bgp-model";

/** Marks where a value comes from: what the user configured, or what Cilium reports. */
export const StateBadge = ({ kind, detail }: { kind: "config" | "runtime" | "live"; detail?: string }) =>
  kind === "config" ? (
    <Badge small label="Configuration" $tooltip={detail ?? "Desired state, from the resources' spec"} />
  ) : kind === "runtime" ? (
    <Badge small label="Runtime status" $backgroundColor="primary" $color="white" $tooltip={detail ?? "Reported by Cilium in the resources' status"} />
  ) : (
    <Badge small label="Live from agent" $backgroundColor="success" $color="white" $tooltip={detail ?? "Read just now from the Cilium agent with cilium-dbg"} />
  );

/** Says which of the requested kinds are missing or unreadable, so an empty table is never mistaken for "none". */
export const SnapshotProblems = ({ snapshot, kinds }: { snapshot: Snapshot; kinds?: readonly string[] }) => {
  const missing = snapshot.notInstalled.filter((kind) => !kinds || kinds.includes(kind));

  return (
    <>
      {snapshot.errors.map((error) => (
        <Callout key={error.what} level="warning" title={error.forbidden ? `Not allowed to read ${error.what}` : `Could not read ${error.what}`}>
          {redactText(error.message)}
        </Callout>
      ))}
      {missing.length > 0 && (
        <Callout level="info" title="Not installed on this cluster">
          {missing.join(", ")}
        </Callout>
      )}
    </>
  );
};

export const IssueList = ({ issues, onOpen }: { issues: readonly BgpIssue[]; onOpen?: (issue: BgpIssue) => void }) =>
  issues.length === 0 ? (
    <Callout level="success" title="No configuration problems found">
      References, ASNs, peers, advertisement selectors and authentication secrets were checked.
    </Callout>
  ) : (
    <Div $flex={{ direction: "vertical", gap: "xs" }}>
      {issues.map((issue, index) => (
        <Callout key={index} level={issue.severity === "error" ? "danger" : issue.severity === "warning" ? "warning" : "info"}>
          <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center", wrap: true }}>
            {issue.name && (
              <Span $font={{ bold: true }}>
                {issue.kind} {issue.name}
              </Span>
            )}
            <Span>{issue.message}</Span>
            {issue.name && onOpen && <PlainButton $onClick={() => onOpen(issue)}>Open</PlainButton>}
          </Div>
        </Callout>
      ))}
    </Div>
  );

/** Opens resources in their pages: one resource by reference, or the list of a kind (to create one). */
export const useResourceNavigation = (clusterId: string) => {
  const context = useClusterContext(clusterId);
  const actions = useInject(resourceActionsInjectable)();
  const openPage = useInject(openCiliumPageInjectable)();

  return {
    openRef: (ref: ResourceRef) => void actions.openRef(clusterId, ref),
    openKind: (kind: string) => {
      const type = context.typeOfKind(kind);

      if (type) void openPage(clusterId, resourcePageId(type));
    },
    hasKind: (kind: string) => context.typeOfKind(kind) !== undefined,
  };
};

export const Clickable = ({ onClick, children, title }: { onClick: () => void; children: ReactNode; title?: string }) => (
  <Span
    $color="link"
    role="link"
    tabIndex={0}
    title={title}
    $style={{ cursor: "pointer" }}
    onClick={(event) => {
      event.stopPropagation();
      onClick();
    }}
    onKeyDown={(event) => {
      if (event.key === "Enter") {
        event.stopPropagation();
        onClick();
      }
    }}
  >
    {children}
  </Span>
);

interface Run<T> {
  readonly running: boolean;
  readonly value?: T;
  readonly error?: unknown;
  readonly at?: number;
}

export interface LiveAgentSectionProps<T> {
  readonly clusterId: string;
  readonly title: string;
  readonly description: ReactNode;
  /** The command, described for the user, such as `cilium-dbg bgp peers`. */
  readonly command: string;
  readonly run: (kubectl: KubectlClient, pod: AgentPod) => Promise<T>;
  readonly render: (value: T, pod: AgentPod) => ReactNode;
  /** Explains why live reads make no sense now (BGP disabled, …); the buttons are then off. */
  readonly unavailable?: string;
}

const describeExecError = (error: unknown) => {
  if (error instanceof KubeError && error.kind === "Forbidden") {
    return `Not allowed to exec into the agent pod (needs create on pods/exec): ${error.message}`;
  }

  return redactText(errorMessage(error));
};

/**
 * Live output of the agents, read only on request, one node at a time or all at once, each with its own
 * result or error.
 */
const LiveAgentSectionImpl = <T,>({ clusterId, title, description, command, run, render, unavailable }: LiveAgentSectionProps<T>) => {
  const context = useClusterContext(clusterId);
  const { state } = useCiliumInfo(clusterId);
  const [runs, setRuns] = useState<Record<string, Run<T>>>({});
  const agents = state.value?.agents ?? [];

  const runOn = async (pod: AgentPod) => {
    setRuns((current) => ({ ...current, [pod.name]: { ...current[pod.name], running: true } }));

    try {
      const value = await run(context.kubectl, pod);

      setRuns((current) => ({ ...current, [pod.name]: { running: false, value, at: Date.now() } }));
    } catch (error) {
      setRuns((current) => ({ ...current, [pod.name]: { running: false, error, at: Date.now() } }));
    }
  };

  return (
    <Section
      title={
        <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center" }}>
          <span>{title}</span>
          <StateBadge kind="live" />
        </Div>
      }
      actions={
        agents.length > 1 && (
          <PlainButton Icon={PlayArrowIcon} $enabled={!unavailable && !agents.some((pod) => runs[pod.name]?.running)} $onClick={() => void Promise.all(agents.map(runOn))}>
            Read all nodes
          </PlainButton>
        )
      }
    >
      <Span $color="textMuted" $font={{ size: "s" }}>
        {description} Runs <code>{command}</code> in the agent pod with kubectl exec, only when you ask.
      </Span>
      {unavailable && <Callout level="info">{unavailable}</Callout>}
      {state.status === "error" && state.value === undefined && <Callout level="warning" title="Cilium agents could not be found">{redactText(errorMessage(state.error))}</Callout>}
      {state.value?.podsError && <Callout level="warning" title="Cilium agent pods could not be listed">{redactText(state.value.podsError)}</Callout>}
      {state.value && agents.length === 0 && !state.value.podsError && <Callout level="info">No Cilium agent pods (label k8s-app=cilium) were found.</Callout>}
      {agents.map((pod) => {
        const result = runs[pod.name];

        return (
          <Div key={pod.name} $flex={{ direction: "vertical", gap: "xs" }} $padding={{ vertical: "xs" }}>
            <Div $flex={{ direction: "horizontal", gap: "s", verticalAlign: "center", wrap: true }}>
              <StatusDot health={pod.ready ? "ok" : "warn"} title={pod.ready ? "Agent ready" : "Agent not ready"} />
              <Span $font={{ bold: true }}>{pod.node ?? "(unscheduled)"}</Span>
              <Span $color="textMuted" $font={{ size: "s" }}>
                {pod.namespace}/{pod.name}
              </Span>
              <Div $flexChild />
              {result?.at && !result.running && (
                <Span $color="textMuted" $font={{ size: "s" }}>
                  Read {new Date(result.at).toLocaleTimeString()}
                </Span>
              )}
              <PlainButton Icon={PlayArrowIcon} $enabled={!unavailable && !result?.running} $onClick={() => void runOn(pod)}>
                {result?.running ? "Reading…" : result ? "Read again" : "Read live"}
              </PlainButton>
            </Div>
            {result?.error !== undefined && !result.running && (
              <Callout level="warning" title={`Could not read from ${pod.node ?? pod.name}`}>
                {describeExecError(result.error)}
              </Callout>
            )}
            {result?.value !== undefined && render(result.value, pod)}
          </Div>
        );
      })}
    </Section>
  );
};

export const LiveAgentSection = observer(LiveAgentSectionImpl) as <T>(props: LiveAgentSectionProps<T>) => ReactNode;

export const Mono = ({ children }: { children: ReactNode }) => <Span className={uiStyles.mono}>{children}</Span>;
