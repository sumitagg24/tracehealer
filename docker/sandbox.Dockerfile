# TraceHealer untrusted-repository sandbox image.
#
# Debian slim + Node 22 + git. Runs as a non-root user, carries no secrets, and
# is executed by lib/container-sandbox.ts with --network none --read-only
# --cap-drop ALL --security-opt no-new-privileges --user 1000:1000.
#
# The base image already ships a `node` user with uid 1000; the provider invokes
# the container with an explicit --user and maps the workspace uid accordingly.
#
# Build:
#   docker build -f docker/sandbox.Dockerfile -t tracehealer-sandbox:latest .
FROM node:22-bookworm-slim

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

USER node
WORKDIR /workspace

# No ENTRYPOINT/CMD: the provider supplies the exact argv per command.
