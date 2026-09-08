#!/usr/bin/env bash
set -euo pipefail
vibecheck_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
vibecheck_runtime="${VIBECHECK_RUNTIME:-auto}"
case "$vibecheck_runtime" in
  auto)
    if command -v bun >/dev/null 2>&1; then
      vibecheck_runtime=bun
    else
      vibecheck_runtime=node
    fi
    ;;
  bun|node) ;;
  *) printf 'VIBECHECK_RUNTIME must be auto, bun, or node.\n' >&2; exit 2 ;;
esac
if ! command -v "$vibecheck_runtime" >/dev/null 2>&1; then
  printf 'Vibecheck requires Bun or Node.js 24 or newer.\n' >&2
  exit 1
fi
if [[ "$vibecheck_runtime" == node ]]; then
  node -e 'if (Number(process.versions.node.split(".")[0]) < 24) { process.stderr.write("Vibecheck requires Node.js 24 or newer.\n"); process.exit(1); }'
fi
if [[ ! -f "$vibecheck_root/runtime/vibecheck.mjs" ]]; then
  printf 'Vibecheck runtime bundle is missing. In the source checkout, run bun install --frozen-lockfile and bun run build:release.\n' >&2
  exit 1
fi
exec "$vibecheck_runtime" "$vibecheck_root/runtime/vibecheck.mjs" "$@"
