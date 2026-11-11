# Cilium Network Manager for Lens

Manage Cilium from Lens, visually, on every cluster you open. Cilium Network Manager adds a **Cilium** section under each cluster in the navigator: Gateway API resources you configure in a designer instead of YAML, network policies built by drag and drop, a live topology of what connects to what, BGP sessions and advertisements, LoadBalancer IP pools, Hubble flows, and a form-based editor for every Cilium CRD your cluster has installed.

It works with the access Lens already has to each cluster: no kubeconfig to set up, no credentials stored, and nothing you are not allowed to do by your Kubernetes RBAC.

## Install

[Open Cilium Network Manager in Lens](https://app.k8slens.dev/lens-launcher?c=lens%3A%2F%2Fapp%2Fopen%2Fextension%3Fname%3Dcilium-ui) and click Install there. The link offers Lens for download when it is not installed yet.

**From a zip** (`cilium-ui-<version>.zip`): unzip it into Lens's extensions folder, so that `package.json` ends up at `~/.k8slens/extensions/cilium-ui/package.json` (on Windows `%USERPROFILE%\.k8slens\extensions\cilium-ui`). Lens picks it up within seconds; restart Lens if it does not. To remove it, delete that folder.

## Where to find it

Open a cluster in the navigator and expand **Cilium**. Every page opens in a tab of its own, one per cluster, and every page shows which cluster it reads and changes.

| Section | Pages |
|---|---|
| Cilium | **Overview** (version, agent/operator/Relay health, enabled features, resource counts, what needs attention) · **Network Topology** |
| Gateway API | **Gateway Designer** · **Gateway Map** · a page for each installed kind: GatewayClasses, Gateways, HTTPRoutes, GRPCRoutes, TLSRoutes, TCPRoutes, UDPRoutes, ReferenceGrants, BackendTLSPolicies, ListenerSets |
| Network Security | CiliumNetworkPolicies · CiliumClusterwideNetworkPolicies · Kubernetes NetworkPolicies · **Policy Visualization** · **Policy Rule Builder** |
| BGP & Routing | **BGP Configuration** · the BGP CRDs (v2 and legacy) · **BGP Session Status** · **Route Advertisements** |
| Load Balancing & IPAM | **LB IP Pool Usage** · CiliumLoadBalancerIPPools · CiliumL2AnnouncementPolicies · CiliumNodeConfigs · CiliumCIDRGroups · CiliumPodIPPools · **IP Address Allocation** · **Services and LoadBalancer Status** |
| Networking | CiliumNodes · CiliumEndpoints · CiliumEndpointSlices · CiliumIdentities · CiliumLocalRedirectPolicies · CiliumEgressGatewayPolicies · CiliumEnvoyConfigs · CiliumClusterwideEnvoyConfigs |
| Observability | **Hubble Flows** · **Traffic Visualization** · **Policy Verdicts** · **DNS Visibility** · **Network Metrics** · **Agent Health** |
| Configuration | **Installed CRDs** · **Feature Detection** · **Helm Configuration** · **Backups** · **Extension Settings** |

Resource pages appear only for kinds your cluster serves; any other Cilium CRD shows up under **Other Cilium Resources**. The command palette has *Cilium: Open …* commands for the cluster in front.

## Features

### Every Cilium and Gateway API resource

- A live list (watched, not polled) with search by name, namespace or `label=value`, namespace filter, sorting, the CRD's own columns, health and a "managed by" badge.
- Details beside the list: status and conditions, labels and annotations, YAML, Kubernetes events, and related resources one click away (owners, parent Gateways, backends, peer configs, CIDR groups, identities…).
- Create, edit, clone and delete, with a **form generated from the CRD's installed OpenAPI schema** (nested objects, lists, maps, enums, defaults, required fields), or as YAML or JSON. Editing in the form never drops fields it does not show.
- Import manifests from a file or pasted text, export one resource or a whole filtered list as YAML.
- Choose among the API versions a CRD serves; deprecated versions are flagged.

### Changes you can review before they happen

Nothing is changed without you seeing it first:

1. The manifest is validated against the cluster's installed schema.
2. Risky changes are called out: deleting a policy, an empty selector in a clusterwide policy, removing pool blocks, changing BGP peers, editing system namespaces, and resources managed by **Flux, Argo CD or Helm**, which would revert a manual edit.
3. A **server-side dry run** runs admission, schema, CEL rules and your RBAC for real, and you get a **diff** against what the cluster holds now.
4. Apply. Edits are refused rather than overwritten when someone changed the resource since you read it (reload, re-diff, apply again), or use server-side apply.

Deletion asks you to type the name, and every resource replaced or deleted is first saved under **Configuration › Backups**, where you can download or restore it. A **read-only mode**, for all clusters or one, turns every change off.

### Gateway Designer

Visual builders for GatewayClasses, Gateways (listeners, protocols, ports, hostnames, TLS with certificate Secrets, allowed routes), HTTPRoutes (path, header, query and method matches; redirects, rewrites, header modifiers, mirroring; weighted backends for traffic splitting; timeouts and retries), GRPCRoutes, TLSRoutes, TCPRoutes, UDPRoutes and ReferenceGrants, with an advanced YAML view. Attach and detach routes from a listener. It checks references to Services and their ports, Secrets, Gateways and listeners, cross-namespace references without a ReferenceGrant (and offers to create one), conflicting listeners, hostnames that never match, and routes a listener does not admit. It shows Accepted, Programmed and ResolvedRefs for Gateways, listeners and each route parent. Only fields and kinds your installed Gateway API version and GatewayClass support are offered. **Gateway Map** draws GatewayClass → Gateway → listeners → routes → backend Services, with what Cilium provisioned for each Gateway.

### Network policies

The **Policy Rule Builder** writes CiliumNetworkPolicies, CiliumClusterwideNetworkPolicies and Kubernetes NetworkPolicies:

- Drag peers (endpoints, namespaces, entities, CIDRs, CIDR groups, FQDNs, services) onto ingress, egress and deny lanes. Every drag also works from the keyboard.
- Ports, protocols, and HTTP and DNS L7 rules.

It shows the YAML live, and the endpoints the selector matches right now. Safety checks warn before you break things:

- egress that blocks DNS to kube-dns, with a one-click fix
- FQDN rules without a DNS rule
- selecting kube-system or Cilium itself
- empty selectors, unintended default deny, cutting off the API server
- CIDRs overlapping the pod network

With Hubble, it can **suggest rules from observed traffic**. You pick which ones to add, and nothing is applied for you. **Policy Visualization** shows which endpoints each policy selects, its rules in plain words, its enforcement status, and which endpoints no policy covers.

### Network Topology

An interactive graph of real relationships:

- Internet → Gateway → listener → route → Service → endpoint → pod → node
- policies on the pods they select, and security identities
- BGP peers and advertisements, LoadBalancer IP pools, L2 announcements, egress gateways, Envoy configurations

Zoom, pan, search, filter by namespace and layer, click a node for its details, and highlight its whole path. Health and errors are shown on the nodes. Turn on **observed traffic** to overlay Hubble flows: dashed, coloured by verdict, clearly apart from configured relationships. Export as SVG or PNG.

### BGP, LoadBalancer and IPAM

- **BGP Configuration:**
  - shows cluster configs → instances → peers → peer configs (timers, auth Secret by name) → families → advertisements
  - checks for broken references and other problems
  - offers a guided "Add peer"
- **BGP Session Status:** per node and peer: peer IP, local and remote ASN, session state, uptime, timers and routes.
- **Route Advertisements:** what each advertisement actually selects.
- **Live agent output:** sessions and advertised routes from the agent, on request, per node.
- **LB IP Pool Usage:** blocks, sizes, assigned IPs and their Services, usage, conflicts and overlaps, plus the L2 announcement policies and the node currently announcing each service.
- **IP Address Allocation:** pod IPAM per node and per pool.
- **Services and LoadBalancer Status:** every LoadBalancer Service with its IP, pool, class, BGP or L2 announcement, and why a pending one has no IP. You can edit its Cilium annotations and `loadBalancerClass`.

Configuration and live state are always labelled as such.

### Hubble and observability

- **Hubble Flows:** filters for namespace, pod, labels, verdict, protocol, port, type, HTTP status and time range, plus follow mode and the full flow details.
- **Traffic Visualization:** a service map of observed traffic, coloured by verdict.
- **Policy Verdicts:** allowed and denied traffic with the policies that decided it.
- **DNS Visibility:** queries, answers, failures and top names.
- **Network Metrics:** Cilium and Hubble metrics from the Prometheus configured for the cluster in Lens.
- **Agent Health:** every Cilium pod's readiness, restarts and version, and the agent's own `cilium-dbg status`.

Flows are read with the `hubble` CLI inside a Cilium agent pod: through Hubble Relay for the whole cluster, or from one node when there is no Relay.

### Configuration

- **Installed CRDs** with their served and stored versions and the Gateway API bundle version.
- **Feature Detection:** what Cilium has enabled, from `cilium-config` and the installed CRDs.
- **Helm Configuration:** the effective agent configuration and the values of the Cilium Helm release, with secrets masked.
- **Extension Settings:** also under Lens Preferences › Extensions.

## Requirements

- A Lens version that serves the package versions in `package.json`. Lens refuses the extension otherwise and says which version it needs.
- Cilium on the cluster. The extension adapts to what is installed:
  - the BGP v2 resources need Cilium 1.16 or newer
  - Gateway API pages need the Gateway API CRDs and `gatewayAPI.enabled=true`
  - Hubble pages need `hubble.enabled=true`, and ideally `hubble.relay.enabled=true`
- Kubernetes permissions as needed: list/watch to view, create/update/delete to change, `pods/exec` on the Cilium agent pods for Hubble and live agent output, and Secrets `get` in Cilium's namespace for the Helm values.

## Troubleshooting

- **No "Cilium" item under a cluster.** The cluster must be connected in Lens. If it still does not appear, check that the extension is enabled in *Extensions*.
- **"Cilium was not found on this cluster".** The extension looks for pods labelled `k8s-app=cilium` in every namespace. If your user can only see Cilium's namespace, or Cilium uses other labels, set **Cilium namespace** in *Configuration › Extension Settings*.
- **A page says a kind is "not installed".** The cluster does not serve that CRD. Check *Configuration › Installed CRDs*. Gateway API kinds such as TLSRoute, TCPRoute and UDPRoute are only in the experimental channel.
- **"Permission denied" / disabled buttons.** Your Kubernetes user lacks the RBAC verb shown in the message or the button's tooltip. Buttons are disabled when `kubectl auth can-i` says no; the dry run reports anything finer-grained.
- **Forms fall back to YAML.** When you may not list CustomResourceDefinitions, schemas come from the API server's OpenAPI document instead. If that is unavailable too, edit as YAML; the server still validates in the dry run.
- **"Changed since it was read".** Someone or a controller updated the resource while you edited. Choose *Reload the latest version*, check the new diff, and apply again.
- **Hubble pages show only one node.** Hubble Relay is not deployed, not reachable, or uses TLS. Deploy it (`hubble.relay.enabled=true`), or set its address under *Hubble Relay address* in the settings.
- **"Hubble is not available".** Hubble is disabled (`enable-hubble=false`), or your user may not `exec` into the Cilium agent pods (`pods/exec`).
- **No DNS flows.** Cilium only parses DNS for pods under a policy with a DNS rule (`rules.dns`). The DNS page shows an example.
- **Network Metrics shows no Prometheus.** Configure the cluster's metrics in Lens (*cluster settings › Metrics*). Charts that say "no data" need the corresponding Cilium or Hubble metrics enabled in Helm.
- **My manual change was reverted.** The resource is managed by Flux, Argo CD or another controller, as the "Managed by" badge and the warnings say. Change it in Git instead.
- **The topology says too many nodes.** Pick namespaces or layers, or raise *Maximum nodes drawn in the topology* in the settings.

What changed in each version is in [CHANGELOG.md](./CHANGELOG.md).
