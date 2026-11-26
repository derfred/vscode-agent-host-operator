# An agent host image for the operator to manage, and a starting point for
# your own: the VS Code CLI (`code agent host`), git and Node.
#
#   docker build -t agent-host examples/agent-host-image
#   docker build -t agent-host --build-arg VSCODE_QUALITY=insider examples/agent-host-image
#
# NOT YET VERIFIED: this is the shape spike check 1 (docs/design.md, Spike)
# confirms. Two things to settle there:
#
# - The CLI downloads the matching server on first start into
#   --server-data-dir. Pin VSCODE_VERSION (a commit, or `latest`) and warm
#   that download at build time so the AHP version is a deploy decision,
#   tested before rollout, not whatever was current when a pod started.
# - Whether `code agent host` passes --host and --connection-token-file
#   through to the standalone server.

ARG NODE_VERSION=24

FROM debian:bookworm-slim AS cli
ARG VSCODE_QUALITY=stable
ARG VSCODE_VERSION=latest
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && case "$TARGETARCH" in amd64 | "") arch=x64 ;; arm64) arch=arm64 ;; *) echo "unsupported $TARGETARCH" >&2; exit 1 ;; esac \
 && curl -fsSL "https://update.code.visualstudio.com/${VSCODE_VERSION}/cli-linux-${arch}/${VSCODE_QUALITY}" -o /tmp/cli.tar.gz \
 && tar -xzf /tmp/cli.tar.gz -C /usr/local/bin \
 && (/usr/local/bin/code --version || /usr/local/bin/code-insiders --version)

FROM node:${NODE_VERSION}-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git openssh-client procps curl less ripgrep \
  && rm -rf /var/lib/apt/lists/*
COPY --from=cli /usr/local/bin/ /usr/local/bin/
# Insiders ships the CLI as code-insiders.
RUN if [ ! -e /usr/local/bin/code ]; then ln -s /usr/local/bin/code-insiders /usr/local/bin/code; fi
# The node image's user, uid 1000, as the StatefulSet's securityContext
# expects. Its home is the pod's home volume: sessions, automations, the
# downloaded server and the CLI's state live there.
USER node
WORKDIR /home/node
EXPOSE 8081
ENTRYPOINT ["code", "agent", "host"]
