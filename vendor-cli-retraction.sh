#!/usr/bin/env bash
# vendor-cli-retraction.sh — cross-compile the retraction-checker CLI to
# bin/retraction-checker-pp-cli-linux (linux/amd64).
#
# This repo ships TWO vendored binaries and the Dockerfile copies both, but
# only one had a script: vendor-cli.sh builds thelancet. The retraction-checker
# binary sat at its 2026-07-17 build with nothing recording how it was made.
# A second file rather than a flag on the existing one, deliberately: that
# script works, and a rewrite to make it clever risks the thing that already
# runs.
#
# The two scratch directories MUST stay different — cli-src there,
# cli-src-retraction here — because each begins with rm -rf on its own path.
# Sharing one lets either delete the other's tree mid-build, which yields a
# wrong binary rather than an error.
#
# An earlier version of this comment said the CLI's logic had not changed since
# July and that a rebuild brought only a newer Go toolchain. That stopped being
# true: measured 2026-09-20, the CLI carries #1948 (read Crossref updated-by,
# not update-by) and #1978 (fail closed on ambiguous write retries, which also
# made a batch upsert report committed rows rather than loop progress). This
# repo's copy predated #1978 until that day, while pubvera-retractis already
# carried it — the two copies drift independently. Read the upstream log rather
# than assuming: `git log --oneline -- .` in the source directory.
#
# The default source is the monorepo under ~/printing-press-library, NOT the
# Desktop copy: there are two clones on this machine on different branches.
#
# The default source path is specific to one workstation. That is acceptable
# because the check below refuses to run against a path that does not hold the
# CLI, so a wrong machine gets an error naming the path it tried, not a silent
# build from the wrong source. PP_LIBRARY_ROOT exists so a different machine can
# be configured once for every pubvera repo instead of editing each script.
#
# Resolution order: explicit argument, then PP_LIBRARY_ROOT, then the default.
#
# cmd/ holds two binaries, the CLI and an MCP server. Only the CLI is built.
#
# USAGE (from the bibliovera repo, Git Bash):
#   ./vendor-cli-retraction.sh
#   ./vendor-cli-retraction.sh "/c/Users/LACI/printing-press-library/library/other/retraction-checker"
#   PP_LIBRARY_ROOT="/path/to/printing-press-library" ./vendor-cli-retraction.sh
set -euo pipefail
PP_ROOT="${PP_LIBRARY_ROOT:-/c/Users/LACI/printing-press-library}"
CLI_SRC="${1:-$PP_ROOT/library/other/retraction-checker}"
OUT="bin/retraction-checker-pp-cli-linux"
if [ ! -f "$CLI_SRC/go.mod" ] || [ ! -d "$CLI_SRC/cmd" ]; then
  echo "ERROR: CLI source not found at: $CLI_SRC" >&2
  echo "" >&2
  echo "Expected a directory holding go.mod, cmd/ and internal/. Either:" >&2
  echo "  - pass the path:   ./vendor-cli-retraction.sh \"/path/to/library/other/retraction-checker\"" >&2
  echo "  - or set the root: PP_LIBRARY_ROOT=\"/path/to/printing-press-library\"" >&2
  exit 1
fi
echo "Vendoring from: $CLI_SRC"
( cd "$CLI_SRC" && git rev-parse --abbrev-ref HEAD && git log --oneline -1 -- . )
rm -rf cli-src-retraction && mkdir -p cli-src-retraction
# go.sum only exists when the CLI has external dependencies.
cp "$CLI_SRC/go.mod" cli-src-retraction/
[ -f "$CLI_SRC/go.sum" ] && cp "$CLI_SRC/go.sum" cli-src-retraction/ || true
cp -r "$CLI_SRC/cmd" "$CLI_SRC/internal" cli-src-retraction/
echo "Cross-compiling -> $OUT"
mkdir -p bin
( cd cli-src-retraction && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o "../$OUT" ./cmd/retraction-checker-pp-cli )
# `file` is not present in every Git Bash; a missing one must not kill the
# script under set -e after a successful build.
command -v file >/dev/null && file "$OUT" || true
ls -la "$OUT"