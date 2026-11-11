# Changelog

## 0.2.0

- Now Cilium Network Manager: a **Cilium** section under every cluster replaces the single "Gateway API Map" entry under Network. The map is now **Cilium › Gateway API › Gateway Map**.
- A page for every installed Cilium and Gateway API resource kind, found at runtime (other Cilium CRDs under "Other Cilium Resources"). Each page has a live list, search, namespace filter, details, events and related resources.
- Create, edit, clone and delete any of them with a form generated from the CRD's installed schema, or as YAML or JSON. Import and export manifests.
- Every change is validated, previewed as a server dry run with a diff, warned about when risky or managed by Flux, Argo CD or Helm, and backed up first. Edits are conflict-safe. Read-only mode, per cluster or for all.
- Gateway Designer: visual builders and checks for GatewayClasses, Gateways, HTTP/gRPC/TLS/TCP/UDP routes and ReferenceGrants.
- Policy Rule Builder (drag and drop, safety checks, suggestions from Hubble traffic) and Policy Visualization.
- Network Topology: an interactive graph of gateways, routes, services, endpoints, pods, nodes, policies, identities, BGP, IP pools, L2, egress gateways and Envoy configs, with observed Hubble traffic, and SVG/PNG export.
- BGP Configuration, BGP Session Status, Route Advertisements, LB IP Pool Usage, IP Address Allocation, and Services and LoadBalancer Status.
- Hubble Flows, Traffic Visualization, Policy Verdicts, DNS Visibility, Network Metrics and Agent Health.
- Overview, Installed CRDs, Feature Detection, Helm Configuration, Backups and Extension Settings (also in Lens Preferences); *Cilium: Open …* commands in the command palette.
- New icon and banner.

## 0.1.0

- Gateway API Map: a live map of a cluster's Gateway API resources, under Network in each cluster, from GatewayClass to Gateway, listeners (ListenerSets included), routes and backend Services, coloured by health.
- Select anything on the map to light up its path and see its details: conditions, route rules, endpoints ready, and what Cilium provisioned for a Gateway (LoadBalancer Service, CiliumEnvoyConfig, LB IP pool), each one click from Lens's own details.
