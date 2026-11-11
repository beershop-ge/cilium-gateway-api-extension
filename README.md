# cilium-ui

See how traffic gets from a Cilium Gateway to your pods, without reading a stack of YAML. cilium-ui draws a cluster's Gateway API resources as one live map in Lens: which GatewayClass each Gateway uses, which listeners (ListenerSets included) each Gateway exposes, which routes attach to them, and which Services those routes send traffic to. It also shows what Cilium itself created for each Gateway.

## Features

- **Gateway API Map**: GatewayClasses → Gateways → Listeners → Routes (HTTP, gRPC, TLS, TCP, UDP) → backend Services, laid out left to right.
- **Health at a glance**: every card and connection is coloured by its status conditions; a route waiting for the controller is dashed, a missing backend or a Service with no ready endpoints stands out.
- **Follow a path**: select a card and its whole path lights up, upstream and downstream; or search by gateway, hostname, route or service name.
- **Details beside the map**: conditions, route rules (`/api → novaops-api:8000`, redirects), ports and endpoints ready, TLS certificates of listeners.
- **What Cilium provisioned**: for each Gateway, its LoadBalancer Service and address, the CiliumEnvoyConfig behind it, and the CiliumLoadBalancerIPPool its address comes from.
- **One click to Lens**: open any resource on the map in Lens's own details panel.
- The map reads the cluster again every 15 seconds while it is open, or on **Refresh**.

## Install

[Open cilium-ui in Lens](https://app.k8slens.dev/lens-launcher?c=lens%3A%2F%2Fapp%2Fopen%2Fextension%3Fname%3Dcilium-ui) and click Install there. The link offers Lens for download when it is not installed yet.

### Install from the zip

The zip carries the built extension (`dist/index.js`), and everything it imports is served by Lens itself, so it runs without `npm install`.

1. Lens can stay open while you install.
2. Unzip `cilium-ui.zip` into Lens's extensions folder, so that `package.json` ends up at `~/.k8slens/extensions/cilium-ui/package.json`:
   - macOS / Linux:
     ```sh
     mkdir -p ~/.k8slens/extensions
     unzip cilium-ui.zip -d ~/.k8slens/extensions/
     ```
   - Windows (PowerShell):
     ```powershell
     Expand-Archive cilium-ui.zip -DestinationPath "$env:USERPROFILE\.k8slens\extensions\"
     ```
3. Lens picks the extension up within a few seconds. If it does not, restart Lens.
4. Open a cluster in the navigator, then **Network → Gateway API Map**.

Requirements: a Lens version that serves the package versions listed in `package.json` (Lens refuses the extension otherwise and says which version it needs), and a cluster running Cilium with the Gateway API CRDs installed.

### Build it yourself

Change the code under `src/`, then, from the extension's folder:

```sh
npm install
npm run build
```

`npm run build` checks the types and the dependency ranges against the Lens on your machine, and writes `dist/index.js`, which Lens reloads on its own.

### Remove it

Delete the folder `~/.k8slens/extensions/cilium-ui`.

## Usage

In the navigator, open a cluster, then **Network → Gateway API Map**. The map opens in a tab of its own, one per cluster.

The cluster needs the Gateway API CRDs and Cilium's gateway controller (`gatewayAPI.enabled=true`); the map says so when they are missing. It reads with your own access to the cluster, so it shows what you are allowed to list.

What changed in each version is in [CHANGELOG.md](./CHANGELOG.md).
