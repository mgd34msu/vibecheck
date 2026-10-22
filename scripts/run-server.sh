#!/usr/bin/env bash
set -euo pipefail
vibecheck_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "${VIBECHECK_RUNTIME:-bun}" != bun && "${VIBECHECK_RUNTIME:-bun}" != auto ]]; then
  printf 'Vibecheck requires Bun; remove the old runtime override.\n' >&2
  exit 2
fi
if ! command -v bun >/dev/null 2>&1; then
  printf 'Vibecheck requires Bun 1.3.14 or newer.\n' >&2
  exit 1
fi
if [[ ! -f "$vibecheck_root/runtime/vibecheck.mjs" ]]; then
  printf 'Vibecheck runtime bundle is missing. In the source checkout, run bun install --frozen-lockfile and bun run build:release.\n' >&2
  exit 1
fi
exec bun "$vibecheck_root/runtime/vibecheck.mjs" "$@"
