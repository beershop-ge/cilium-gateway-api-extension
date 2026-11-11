# Developing Cilium Network Manager

This is a Lens Desktop extension (package `cilium-ui`). Lens loads `dist/index.js` into its sandbox; the source is TypeScript and React under `src/`. The architecture is described in [AGENTS.md](../AGENTS.md#architecture-of-cilium-network-manager); the authoritative reference for the extension surface is `~/.k8slens/extensions/extension-development-instructions/README.md`, which Lens regenerates on every start.

## Prerequisites

- Lens Desktop, running, with this folder registered as a local extension (Lens scaffolded it, or *Extensions › Add local extension*).
- Node.js 20 or newer and npm.
- A cluster with Cilium (1.14 or newer recommended; the BGP v2 resources need 1.16+, ListenerSet support needs a recent Gateway API) to try it against. A kind cluster with Cilium works: `cilium install --set gatewayAPI.enabled=true --set hubble.relay.enabled=true`.

## Build loop

```sh
npm install        # first time, and after changing dependencies
npm run build      # type-check, dependency-range check against your Lens, bundle to dist/index.js
npm test           # unit and integration tests (vitest)
```

Lens reloads the extension by itself a moment after every build. Check that it did:

```sh
LOG="$(ls -dt ~/Library/Logs/Lens/*/ | head -1)lens-renderer-root-frame.log"   # macOS; see the Lens README for other platforms
grep -F '[EXTENSION-INSTALLATION]' "$LOG" | tail -3
grep -E 'Uncaught error|Unhandled promise rejection' "$LOG" | tail -5
```

`console.log` from the extension goes to the developer tools of the Lens window (*View › Toggle Developer Tools*), not to these logs.

## Dependencies

`react`, `mobx`, `mobx-react` and every `@k8slens/*` package are served by Lens itself; their ranges in `package.json` must include the versions the running Lens serves (`npm run build` checks; `npx lens-extension-dependencies-check --fix` rewrites them). `yaml` and `@xyflow/react` are the extension's own dependencies, kept external by the build and installed into the extension's `node_modules` (Lens installs them when a user installs from the marketplace; the zip ships them).

## Tests

Tests live in `test/` and run under Node with vitest. Logic is kept in pure modules so it can be tested without Lens: schema validation and form helpers, CIDR maths, selectors, diffing, discovery and kubectl operations (against a fake `kubectl` that records its arguments and stdin), Helm release decoding, Hubble flow parsing and aggregation, and the feature modules' builders, validators and graph construction.

```sh
npm test                      # everything
npx vitest run test/gateway   # one area
npm run typecheck             # sources and tests
```

## Packaging

```sh
npm run package   # builds, then writes release/cilium-ui-<version>.zip
```

The zip holds `dist/`, `assets/`, the README, changelog and `package.json`, plus `node_modules` with only the dependencies Lens does not serve, so unzipping it into `~/.k8slens/extensions/` is enough to install it. Publishing to npm goes through Lens (*Publish* on the extension's details), which runs `prepublishOnly`: a build and `lens-extension-publish-check`.

## Adding things

- **A page**: export an injectable bound to `ciliumPageInjectionToken` (`src/navigation/pages.ts`) from a `*.injectable.tsx` file, with a `section` (`root`, `gateway`, `security`, `bgp`, `lb`, `networking`, `observability`, `config`). It appears in the navigator under every cluster and opens in a tab of its own. See `src/config/installed-crds-page.injectable.tsx`.
- **A known kind**: add it to `knownKinds` in `src/kube/resource-types.ts` to give it a section, title and description. Unknown kinds of Cilium groups are listed under *Other Cilium Resources* anyway.
- **A write**: build the manifests and render `ApplyPanel` (`src/resources/apply-panel.tsx`). It validates, warns, dry-runs, diffs, backs up and applies; nothing else in the extension writes to a cluster.
- **Cluster data**: `useSnapshot` (several kinds, tolerant of missing ones), `context.queries.get("q:…", loader)` with `useQueryState` (any kubectl read), or Lens's `kubeResourcesInjectionToken` watch (live lists).
