import { rangeOfBlock } from "./cidr";
import { detectManagers } from "./gitops";
import { deepEqual, type Json } from "./json";
import { isEmptySelector } from "./selectors";

export type RiskLevel = "info" | "warning" | "danger";

export interface Risk {
  readonly level: RiskLevel;
  readonly message: string;
}

export const systemNamespaces = ["kube-system", "cilium", "cilium-system", "kube-public", "kube-node-lease"];

const blocksOf = (pool: Json) => ((pool?.spec?.blocks ?? pool?.spec?.cidrs ?? []) as Json[]).map(rangeOfBlock).filter(Boolean);

/**
 * Looks at a change, or a deletion when `after` is undefined, and says what could break.
 * These are warnings for the user to read before applying, never a block.
 */
export const assessChange = (before: Json | undefined, after: Json | undefined): Risk[] => {
  const subject = after ?? before;
  const kind: string = subject?.kind ?? "";
  const namespace: string | undefined = subject?.metadata?.namespace;
  const risks: Risk[] = [];

  const managers = detectManagers(before ?? after);

  for (const manager of managers.filter((owner) => owner.reconciles)) {
    risks.push({ level: "warning", message: `Managed by ${manager.tool} (${manager.detail}): a manual change may be reverted by the next reconciliation.` });
  }

  if (namespace && systemNamespaces.includes(namespace)) {
    risks.push({ level: "warning", message: `This resource is in the system namespace "${namespace}".` });
  }

  if (!after) {
    switch (kind) {
      case "CiliumNetworkPolicy":
      case "CiliumClusterwideNetworkPolicy":
      case "NetworkPolicy":
        risks.push({ level: "danger", message: "Deleting a policy changes what traffic is allowed immediately. If other policies select the same endpoints, traffic they did not allow becomes denied; if none do, the endpoints may fall back to allow-all." });
        break;
      case "Gateway":
        risks.push({ level: "danger", message: "Deleting a Gateway removes its LoadBalancer Service and address: every attached route stops serving." });
        break;
      case "GatewayClass":
        risks.push({ level: "danger", message: "Gateways of this class lose their controller." });
        break;
      case "CiliumLoadBalancerIPPool":
        risks.push({ level: "danger", message: "Services holding addresses from this pool lose them." });
        break;
      case "CiliumBGPClusterConfig":
      case "CiliumBGPPeerConfig":
      case "CiliumBGPAdvertisement":
      case "CiliumBGPPeeringPolicy":
        risks.push({ level: "danger", message: "BGP sessions or advertisements configured by this resource are withdrawn: external reachability of services may be lost." });
        break;
      case "CiliumEgressGatewayPolicy":
        risks.push({ level: "warning", message: "Egress traffic of the selected pods stops leaving through the gateway node and its address." });
        break;
      case "CiliumNode":
      case "CiliumEndpoint":
      case "CiliumIdentity":
        risks.push({ level: "danger", message: `${kind} objects are managed by Cilium itself; deleting one by hand can disrupt connectivity until Cilium recreates it.` });
        break;
      default:
        break;
    }

    return risks;
  }

  const spec = after.spec ?? {};

  if (kind === "CiliumClusterwideNetworkPolicy" && isEmptySelector(spec.endpointSelector) && !spec.nodeSelector) {
    risks.push({ level: "danger", message: "The endpointSelector is empty: this policy applies to every endpoint in the cluster, system components included." });
  }

  if (kind === "CiliumNetworkPolicy" && isEmptySelector(spec.endpointSelector)) {
    risks.push({ level: "warning", message: `The endpointSelector is empty: this policy applies to every endpoint in "${namespace}".` });
  }

  if (kind === "NetworkPolicy" && isEmptySelector(spec.podSelector)) {
    risks.push({ level: "warning", message: `The podSelector is empty: this policy applies to every pod in "${namespace}".` });
  }

  if (kind === "CiliumLoadBalancerIPPool" && before) {
    const removed = blocksOf(before).filter((block) => !blocksOf(after).some((other) => other!.start === block!.start && other!.end === block!.end));

    if (removed.length > 0) {
      risks.push({ level: "warning", message: `Blocks removed from the pool (${removed.map((block) => block!.label).join(", ")}): services holding addresses from them lose them.` });
    }
  }

  if (kind === "Gateway" && before && !deepEqual(before.spec?.listeners, after.spec?.listeners)) {
    risks.push({ level: "info", message: "Listeners change: routes attached to a removed or renamed listener detach." });
  }

  if ((kind === "CiliumBGPPeerConfig" || kind === "CiliumBGPClusterConfig") && before && !deepEqual(before.spec, after.spec)) {
    risks.push({ level: "warning", message: "Changing BGP configuration can reset sessions with peers." });
  }

  if (kind === "Service" && before && before.spec?.loadBalancerClass !== after.spec?.loadBalancerClass) {
    risks.push({ level: "danger", message: "loadBalancerClass is immutable once set: the API server refuses the change unless the Service is recreated." });
  }

  return risks;
};
