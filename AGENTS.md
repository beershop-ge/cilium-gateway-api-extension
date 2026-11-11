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
