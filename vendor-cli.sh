#!/usr/bin/env bash
# vendor-cli.sh — cross-compile the thelancet CLI to bin/thelancet-pp-cli-linux
# (linux/amd64), which the Docker image copies and runs (refresh + analytics).
#
# The default source path is specific to one workstation. That is acceptable
# because the check below refuses to run against a path that does not hold the
# CLI, so a wrong machine gets an error naming the path it tried, not a silent
# build from the wrong source. PP_LIBRARY_ROOT exists so a different machine can
# be configured once for every pubvera repo instead of editing each script.
#
# Resolution order: explicit argument, then PP_LIBRARY_ROOT, then the default.
#
# The branch matters. There are two monorepo clones on this workstation and they
# sit on different branches; a binary vendored from a feature branch is
# indistinguishable from a correct one. The script prints the branch it is
# building from — read that line every time. The earlier instruction to check
# out feat/thelancet was removed rather than updated: a branch named in a
# comment goes stale silently, while the printed line is always current.
#
# This repo ships TWO vendored binaries. The retraction-checker has its own
# vendor-cli-retraction.sh, and the two scratch directories MUST stay different
# — cli-src here, cli-src-retraction there — because each begins with rm -rf on
# its own path. Sharing one lets either delete the other's tree mid-build, which
# yields a wrong binary rather than an error.
#
# USAGE (from the bibliovera repo, Git Bash):
#   ./vendor-cli.sh
#   ./vendor-cli.sh "/c/Users/LACI/printing-press-library/library/developer-tools/thelancet"
#   PP_LIBRARY_ROOT="/path/to/printing-press-library" ./vendor-cli.sh
set -euo pipefail
PP_ROOT="${PP_LIBRARY_ROOT:-/c/Users/LACI/printing-press-library}"
CLI_SRC="${1:-$PP_ROOT/library/developer-tools/thelancet}"
OUT="bin/thelancet-pp-cli-linux"
if [ ! -f "$CLI_SRC/go.mod" ] || [ ! -d "$CLI_SRC/cmd" ]; then
  echo "ERROR: CLI source not found at: $CLI_SRC" >&2
  echo "" >&2
  echo "Expected a directory holding go.mod, cmd/ and internal/. Either:" >&2
  echo "  - pass the path:   ./vendor-cli.sh \"/path/to/library/developer-tools/thelancet\"" >&2
  echo "  - or set the root: PP_LIBRARY_ROOT=\"/path/to/printing-press-library\"" >&2
  exit 1
fi
echo "Vendoring from: $CLI_SRC"
( cd "$CLI_SRC" && git rev-parse --abbrev-ref HEAD && git log --oneline -1 -- . )
rm -rf cli-src && mkdir -p cli-src
cp "$CLI_SRC/go.mod" "$CLI_SRC/go.sum" cli-src/
cp -r "$CLI_SRC/cmd" "$CLI_SRC/internal" cli-src/
echo "Cross-compiling -> $OUT"
mkdir -p bin
( cd cli-src && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o "../$OUT" ./cmd/thelancet-pp-cli )
command -v file >/dev/null && file "$OUT" || true
ls -la "$OUT"