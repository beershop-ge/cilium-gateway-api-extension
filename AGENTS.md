# cilium-ui — a Lens Desktop extension

> **You are developing a Lens Desktop extension.** This project is *not* a standalone Node app, a website, or a generic library — it is a plugin that runs inside the Lens Desktop application. Lens is a Kubernetes IDE built on Electron + React; the extension hooks into its dependency-injection container to add UI — sidebar items, status-bar items, preferences pages, commands, routes, and so on.

The scaffold ships with a pre-built `dist/index.js` placeholder, so the extension loads as soon as Lens registers it. `src/index.ts` is the TypeScript source that mirrors that placeholder — edit it to replace the placeholder with your own code.

## Extension development instructions — read this first

> `~/.k8slens/extensions/extension-development-instructions/README.md` is **the** definitive source on how to author a Lens extension. Lens regenerates it on every app load against the host build you're developing against. It documents the build loop, the conventions every extension follows (features, injectables, MobX, React), and enumerates every supported surface (top-bar items, status-bar items, notifications, commands, routes, preferences pages, …) with the exact tokens, factories, and code samples to use.
>
> **If a capability isn't in that file, it isn't part of the extension surface.** Don't infer from `@k8slens/*` or `@lensapp/*` package names or internal Lens code — the instructions file is the only source of truth, and it tracks the host build precisely.
>
> **When the user asks for something that isn't in it, say so and report it**, rather than working around the sandbox: run the `lens-extension-development-missing-capability` skill, which is in this directory for every AI tool Lens knows; the README's section *When the surface lacks what the user asks for* has the command it runs. The Lens team reads those reports to decide what the surface gains next.
>
> Read it before integrating, and re-read it after every Lens upgrade.

## Dependency versions follow the Lens build

Lens serves `react`, `mobx`, `@k8slens/*` and `@lensapp/*` to this extension from its own bundle, and refuses to load the extension when a range declared in `package.json` for one of them does not match the bundled version. The README above lists those versions under "Dependency versions in this Lens build". Declare `^<version>` for each host-provided package you use, and re-check after every Lens upgrade. The `lens-extension-development-sync-dependencies` skill, in this directory for every AI tool Lens knows, rewrites the ranges, reinstalls and rebuilds for you.

The `build` script runs `lens-extension-dependencies-check` first. It fails on every range the Lens on this machine would refuse, naming the range to declare instead. `npx lens-extension-dependencies-check --fix` rewrites those ranges; run `npm install` after it. Without Lens on the machine, the check says it was skipped and passes.

## Publishing is checked before it happens

`prepublishOnly` builds the extension and runs `lens-extension-publish-check` before every `npm publish`. It fails, and npm publishes nothing, when the published package would leave out `dist/index.js`, when a range would keep every Lens from loading the extension, or when a prerelease would become the version users install by default. Publish through Lens, as the README's *Publish* section says, and Lens runs the same checks.

## Keep up with what Lens scaffolds today

Lens keeps improving the scaffold, and writes the extension it would scaffold today to `~/.k8slens/current-extension-scaffold/example-extension` on every load. When this extension lacks something of it a user would be better off with, offer to bring it over, and do it only when the user says yes: the `lens-extension-development-modernize` skill, which is in this directory for every AI tool Lens knows, merges what is missing, raises the ranges to the versions this Lens serves, and moves the extension's code off the Lens APIs that are deprecated.

## Architecture of Cilium Network Manager

Everything lives under `src/`; `src/index.ts` registers every `*.injectable.ts(x)` and stylesheet by glob, so a new file of that name is wired up by itself. Only those files are registered: an injectable exported from any other file is never registered.

- **`src/common/`**: pure helpers, no Lens imports: JSON paths (`setPath`/`deletePath` keep every field they do not touch), YAML, line diff, CIDR maths (IPv4/IPv6, BigInt), label selectors (Cilium `k8s:`/`any:` prefixes), conditions → health, redaction, GitOps detection, risk assessment, manifest cleaning, JSONPath, and `query.ts`, the MobX async value (`Query`) components render instead of suspending.
- **`src/schema/`**: OpenAPI v3 structural schemas: `$ref`/`allOf` resolution, validation (types, required, enum, bounds, patterns, list-map keys, oneOf), skeletons, `schemaHasPath`/`enumAt` to detect what the installed CRD version supports.
- **`src/kube/`**: cluster access, only through Lens's `runKubectlInjectionToken` (the user's own credentials and RBAC, per cluster). `kubectl.ts` adds timeouts and classifies errors into `KubeError` kinds; `operations.ts` does discovery (`kubectl get crd`, falling back to `api-resources` + OpenAPI v3 when forbidden), get/list, create/replace/server-side apply (with `--dry-run=server`), delete, uid-guarded merge patch, events and `auth can-i`; `cilium-info.ts` finds Cilium's pods by label and reads `cilium-config` for feature detection; `cilium-exec.ts` runs `cilium-dbg`/`hubble` in an agent pod with `kubectl exec`; `snapshot.ts` reads many kinds at once, tolerating ones not installed or not allowed; `dynamic-kinds.ts` names a kind discovered at runtime for Lens's own contracts (watch, details, editor).
- **`cluster-context.injectable.ts`** gives one `ClusterContext` per cluster id (kubectl, operations, query cache, discovery, Cilium info, read-only flag). Every read and write goes through the context of the tab's cluster, never another's. Query keys starting with `q:` are refreshed by `context.invalidate()` after a write.
- **`src/navigation/`**: the navigator branch *Cilium* under every cluster (sections from `pages.ts`, pages from discovery plus contributed pages), one main-view tab per cluster and page (tab id `<clusterId>::<pageId>`), and per-tab view state (`useViewState`). A module adds a page by exporting an injectable bound to `ciliumPageInjectionToken` from a `*.injectable.tsx` file; resource pages (`res:<plural.group>`) are generated for every discovered type.
- **`src/resources/`**: the generic CRD experience: live list (Lens's `kubeResourcesInjectionToken` watch), details drawer, schema-driven form (`schema-form.tsx`), YAML/JSON editors, import/export, clone, delete. **All writes go through `ApplyPanel` → `resourceActionsInjectable`**: read-only check, validation against the installed schema, risk and GitOps warnings, mandatory server dry run with a diff against the live object, automatic backup of what is replaced or deleted, conflict-safe replace (resourceVersion) or server-side apply.
- **`src/ui/`**: shared components (states, callouts, badges, `DataTable`, `CodeEditor`, `DiffView`, `PageLayout`, `Select`, `KeyValueEditor`, confirm modal, notifications) styled with Lens's theme variables (`--grey*`, `--primary`, …) so both themes work.
- **Feature modules**: `gateway/`, `policy/`, `topology/`, `bgp/`, `lb-ipam/`, `observability/` (Hubble via `observability/hubble.ts`), `config/`, `overview/`, `settings/`.

Conventions: never invent data (show "not available" with the reason instead), detect features from installed CRDs/schemas and `cilium-config` before offering them, never apply anything without the user reviewing a dry run, keep secrets out of logs and UI (`redactText`/`redactObject`), and put logic in pure functions under test (`test/*.test.ts`, run with `npm test`).
