#!/usr/bin/env bash
# Builds the extension and writes an installable zip to ./release/.
#
# Lens serves react, mobx and the @k8slens packages itself; only the extension's other runtime
# dependencies (yaml, @xyflow/react and what they need) are shipped, in node_modules, so the zip
# runs when unzipped into ~/.k8slens/extensions without running npm.
set -euo pipefail

cd "$(dirname "$0")/.."

name=$(node -p "require('./package.json').name")
version=$(node -p "require('./package.json').version")
staging="$PWD/release/.staging"; rm -rf "$staging"; mkdir -p "$staging"
trap 'rm -rf "$staging"' EXIT

npm run build

target="$staging/$name"
mkdir -p "$target"
cp -R dist assets README.md CHANGELOG.md package.json "$target/"
[ -f LICENSE ] && cp LICENSE "$target/"

# The dependencies Lens does not serve, at the exact versions package.json pins.
own_deps=$(node -e '
  const pkg = require("./package.json");
  const served = require(require("os").homedir() + "/.k8slens/extensions/extension-development-instructions/extension-dependency-versions.json");
  const fallbackServed = (name) => name.startsWith("@k8slens/") || ["react", "react-dom", "mobx", "mobx-react", "zod"].includes(name);
  console.log(Object.entries(pkg.dependencies)
    .filter(([name]) => !(name in served) && !fallbackServed(name))
    .map(([name, range]) => `${name}@${range}`).join(" "));
' 2>/dev/null || true)

# Copied from node_modules at the installed versions, with whatever they depend on in turn.
copy_dep() {
  local dep="$1"
  [ -d "$target/node_modules/$dep" ] && return
  mkdir -p "$target/node_modules/$(dirname "$dep")"
  cp -R "node_modules/$dep" "$target/node_modules/$dep"
  for sub in $(node -p "Object.keys(require('./node_modules/$dep/package.json').dependencies || {}).join(' ')"); do
    copy_dep "$sub"
  done
}

for spec in $own_deps; do
  copy_dep "${spec%@*}"
done

mkdir -p release
rm -f "release/$name-$version.zip"
(cd "$staging" && zip -qr - "$name") > "release/$name-$version.zip"

echo "Wrote release/$name-$version.zip (runtime dependencies: ${own_deps:-none})"
