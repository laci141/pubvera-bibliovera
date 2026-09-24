# syntax=docker/dockerfile:1
#
# thelancet-web: Go wrapper serving the UI + /affiliations + /authors + /drift +
# /curate + /check endpoints against a local mirror DB.
#
# The mirror is NOT in this image. Measured 2026-09-13:
#   - `git ls-tree origin/main` lists no data.db, `git lfs ls-files` is empty:
#     the file is not in the repo, as a blob or as an LFS pointer.
#   - The running container gets it from a bind mount declared in
#     docker-compose.yml: /opt/pubvera/bibliovera-data/data.db -> /app/data.db.
#     That mount is what lets `refresh` writes survive an image rebuild; the
#     file was 197 MB and growing when measured, not the 117 MB an image copy
#     would have frozen.
# There used to be an LFS-fetcher stage here that cloned the whole repo, ran
# `git lfs pull`, and copied data.db into the image. Every part of that is now
# dead: the clone brings no data.db, so the stage only still succeeded from
# Docker layer cache, and anything it did copy was hidden by the bind mount
# anyway. Removing it drops a full-repo clone from every build.
#
# If the mount is ever missing, the CLI fails on a missing DB and says so. That
# is the intended outcome: a stale copy baked into the image would answer with
# months-old data and look healthy.
#
# Two CLI binaries ship in the runtime image, both built in the cli-builder
# stage with go install from ONE pinned printing-press-library commit:
#   - thelancet-pp-cli       (analytics: affiliations, authors, drift, curate)
#   - retraction-checker-pp-cli (live retraction status over Crossref & OpenAlex)
# They used to be PRE-BUILT binaries in bin/, made by vendor-cli.sh, and
# nothing in the image said which upstream source they came from. The commit
# is now stamped on the image as org.pubvera.cli.commit.
#
# PP_LIBRARY_COMMIT is declared before the first FROM so it is global. An ARG
# declared after a FROM exists only in that stage; each stage that needs the
# value re-declares it with a bare ARG and inherits this default. Declaring
# the default inside the builder stage only left the label empty on
# pubvera-recallis (measured 2026-09-24), and CI now fails on that.
ARG PP_LIBRARY_COMMIT=58edea349ce3df8a301d4d8950119487c32604b8

# ---- Stage 1: build both CLIs from upstream source -------------------------
# Two RUN lines, not one: a single go install accepts packages from one module
# only, and the two CLIs are separate modules.
FROM golang:1.26-alpine AS cli-builder
ARG PP_LIBRARY_COMMIT
RUN CGO_ENABLED=0 go install -trimpath \
    github.com/mvanhorn/printing-press-library/library/developer-tools/thelancet/cmd/thelancet-pp-cli@${PP_LIBRARY_COMMIT}
RUN CGO_ENABLED=0 go install -trimpath \
    github.com/mvanhorn/printing-press-library/library/other/retraction-checker/cmd/retraction-checker-pp-cli@${PP_LIBRARY_COMMIT}

# ---- Stage 2: build the web wrapper for linux/amd64 -------------------------
FROM golang:1.26-alpine AS web-builder
WORKDIR /build
COPY go.mod ./
COPY main.go semaphore.go ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o /out/server .

# ---- Stage 3: runtime -------------------------------------------------------
# Pinned to a minor release, not :latest. :latest moves on its own, so a
# rebuild with no code change could ship a different base system. 3.24 is the
# same line pubvera-grantvera and pubvera-recallis run.
FROM alpine:3.24
RUN apk add --no-cache ca-certificates wget
WORKDIR /app
COPY --from=web-builder /out/server ./server
COPY --from=cli-builder /go/bin/thelancet-pp-cli ./thelancet
COPY --from=cli-builder /go/bin/retraction-checker-pp-cli ./retraction-checker
COPY index.html ./index.html
RUN chmod +x ./thelancet ./retraction-checker ./server

# The upstream commit both CLIs were built from, readable with docker inspect.
LABEL org.pubvera.cli.commit=${PP_LIBRARY_COMMIT}

ENV CLI_BIN=/app/thelancet
ENV THELANCET_DB=/app/data.db
ENV RETRACTION_CHECKER_BIN=/app/retraction-checker
EXPOSE 8080

# The probe picks its port by the same rule main.go uses to pick the listen
# address: ADDR wins if set (its port is the part after the last ':'), then
# PORT, then the built-in 8080. A probe with its own hard-coded number would
# report a healthy server as down the moment the two disagreed.
# Timings match the docker-compose.yml override this replaces (start period
# 15s), so dropping that override changes nothing but where the rule lives.
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD p="${PORT:-8080}"; [ -n "$ADDR" ] && p="${ADDR##*:}"; wget -qO- "http://localhost:$p/healthz" || exit 1
CMD ["./server"]