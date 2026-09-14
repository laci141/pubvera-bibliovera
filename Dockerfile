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
# Two CLI binaries ship in the runtime image:
#   - thelancet-pp-cli       (analytics: affiliations, authors, drift, curate)
#   - retraction-checker-pp-cli (live retraction status over Crossref & OpenAlex)

# ---- Stage 1: build the web wrapper for linux/amd64 -------------------------
FROM golang:1.26-alpine AS web-builder
WORKDIR /build
COPY go.mod ./
COPY main.go semaphore.go ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o /out/server .

# ---- Stage 2: runtime -------------------------------------------------------
FROM alpine:latest
RUN apk add --no-cache ca-certificates wget
WORKDIR /app
COPY --from=web-builder /out/server ./server
COPY bin/thelancet-pp-cli-linux ./thelancet
COPY bin/retraction-checker-pp-cli-linux ./retraction-checker
COPY index.html ./index.html
RUN chmod +x ./thelancet ./retraction-checker ./server
ENV CLI_BIN=/app/thelancet
ENV THELANCET_DB=/app/data.db
ENV RETRACTION_CHECKER_BIN=/app/retraction-checker
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8080/healthz || exit 1
CMD ["./server"]