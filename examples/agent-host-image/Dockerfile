# An agent host image for the operator to manage, and a starting point for
# your own: the VS Code CLI (`code agent host`), the server it runs, git and
# Node. The end-to-end test (e2e/run.ts) builds and runs this image.
#
#   docker build -t agent-host examples/agent-host-image
#   docker build -t agent-host --build-arg VSCODE_VERSION=<commit> examples/agent-host-image
#   docker build -t agent-host --build-arg VSCODE_QUALITY=insider examples/agent-host-image
#
# Checked against VS Code 1.148.0 (scripts/probe.ts, docs/testing.md):
#
# - `code agent host` detaches into the background unless --foreground is
#   given; the ENTRYPOINT gives it, so the container lives as long as the host.
# - The CLI downloads the matching server on first start, into its data dir.
#   VSCODE_CLI_DATA_DIR puts that outside the home volume, and the build
#   downloads it now, so a pod starts the server the image was tested with.
#   Pin VSCODE_VERSION to make the AHP version a deploy decision.
# - The host's state (sessions, the automation catalogue) is under
#   --server-data-dir: put that on the pod's home volume.

ARG NODE_VERSION=24

FROM debian:bookworm-slim AS cli
ARG VSCODE_QUALITY=stable
ARG VSCODE_VERSION=latest
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && case "$TARGETARCH" in amd64 | "") arch=x64 ;; arm64) arch=arm64 ;; *) echo "unsupported $TARGETARCH" >&2; exit 1 ;; esac \
 && curl -fsSL "https://update.code.visualstudio.com/${VSCODE_VERSION}/cli-linux-${arch}/${VSCODE_QUALITY}" -o /tmp/cli.tar.gz \
 && tar -xzf /tmp/cli.tar.gz -C /usr/local/bin \
 && if [ ! -e /usr/local/bin/code ]; then mv /usr/local/bin/code-insiders /usr/local/bin/code; fi \
 && /usr/local/bin/code --version

FROM node:${NODE_VERSION}-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git openssh-client procps curl less ripgrep \
  && rm -rf /var/lib/apt/lists/*
COPY --from=cli /usr/local/bin/code /usr/local/bin/code
# The CLI's data, with the downloaded server: in the image, not the volume.
ENV VSCODE_CLI_DATA_DIR=/opt/vscode-cli
RUN mkdir -p /opt/vscode-cli /workspace && chown node:node /opt/vscode-cli /workspace
# The node image's user, uid 1000, as the StatefulSet's securityContext
# expects. Its home is the pod's home volume.
USER node
WORKDIR /home/node
# Starts a host once, so the CLI downloads the server, then stops it and
# drops everything but the download.
RUN set -eu; \
    code agent host --foreground --without-connection-token --port 18999 \
      --server-data-dir /tmp/warm-data --user-data-dir /tmp/warm-user > /tmp/warm.log 2>&1 & \
    pid=$!; \
    for i in $(seq 180); do grep -q 'ready in' /tmp/warm.log && break; kill -0 $pid 2>/dev/null || break; sleep 1; done; \
    grep -q 'ready in' /tmp/warm.log || { cat /tmp/warm.log; exit 1; }; \
    kill $pid; wait $pid || true; \
    ls /opt/vscode-cli/servers; \
    rm -rf /tmp/warm-data /tmp/warm-user /tmp/warm.log /home/node/.vscode-server /home/node/.vscode
EXPOSE 8081
# Arguments follow, from the StatefulSet (examples/manifests/host-set.yaml):
#   --host 0.0.0.0 --port 8081 --connection-token-file … --server-data-dir …
ENTRYPOINT ["code", "agent", "host", "--foreground"]
