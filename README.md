# vscode-agent-host-operator

A Kubernetes operator for [VS Code agent hosts](https://code.visualstudio.com/docs/agents/concepts/agent-host) (`code agent host`), the [Agent Host Protocol](https://microsoft.github.io/agent-host-protocol/) server the Agents window connects to. It is [t3code-operator](https://github.com/derfred/t3code-operator)'s model applied to a different server:

- **Workspaces**: an `AgentWorkspace` is a git repository the operator clones onto every host of the `AgentHostSet`s it selects, even when pods are scaled or recreated later. A `hostSetSelector` controls the placement.
- **Readiness**: pods (optionally) declare the readiness gate `agenthost.derfred.com/content-ready` and become Ready only once their workspaces are in place.
- **Automations**: an `AgentAutomation` is a prompt the host runs on a schedule in a workspace. The host runs it, in its own automation catalogue; the operator decides which hosts hold it and keeps the definition in line with the manifest.
- **Status**: each `AgentHostSet` lists its hosts with the address to connect to, the protocol version they agreed, and the agents they offer. Broken git URLs and unreachable hosts show up as `Error`.

The pods are managed by a StatefulSet you write, not the operator, and people reach them over Tailscale. Design and trade-offs: [docs/design.md](docs/design.md).

> **Status: v0.1.0, before the spike.** The code follows AHP 1.1 and is tested against a fake host; it hasn't run against a real `code agent host` yet. [docs/design.md, Spike](docs/design.md#spike) lists what to confirm first.

## Install

```sh
kubectl apply -f https://raw.githubusercontent.com/derfred/vscode-agent-host-operator/v0.1.0/deploy/install.yaml
```

[`deploy/install.yaml`](deploy/install.yaml) sets up the namespace `agents`, the three CustomResourceDefinitions, and the operator (ServiceAccount, Role, RoleBinding, Deployment). The Role covers the operator's kinds, the StatefulSets they name, their pods (and `pods/exec`, for `git clone`), and reading Secrets for the connection tokens.

For another namespace, or a Role narrowed to the token Secrets, vendor the jsonnet library at a release tag (`jb install github.com/derfred/vscode-agent-host-operator/deploy/jsonnet@v0.1.0`):

```jsonnet
local operator = import 'vscode-agent-host-operator/main.libsonnet';
local cfg = operator.config {
  namespace: 'agents',
  tokenSecrets: ['agents-fred-token'],   // optional: only these Secrets
};
operator.crds + operator.objects(cfg)
```

## Example

[`examples/manifests`](examples/manifests):

- [`host-set.yaml`](examples/manifests/host-set.yaml): the connection-token Secret, the StatefulSet of agent hosts, and the `AgentHostSet` naming it.
- [`tailscale.yaml`](examples/manifests/tailscale.yaml): a Service and a Tailscale Ingress per pod, so each host has its own tailnet hostname.
- [`workspace.yaml`](examples/manifests/workspace.yaml): an `AgentWorkspace` and an `AgentAutomation` in it.

```yaml
apiVersion: agenthost.derfred.com/v1alpha1
kind: AgentWorkspace
metadata:
  name: my-app
  namespace: agents
spec:
  repository: https://github.com/example/my-app.git
  hostSetSelector:
    matchLabels: { owner: fred }
---
apiVersion: agenthost.derfred.com/v1alpha1
kind: AgentAutomation
metadata:
  name: dependencies
  namespace: agents
spec:
  workspace: my-app
  prompt: Check for outdated dependencies and open a PR for any that are behind.
  trigger: { schedule: "0 3 * * 1-5", timeZone: Europe/Berlin }
  agent: { provider: claude, model: claude-sonnet-5-5 }
```

```sh
kubectl -n agents get agenthostsets,agentworkspaces,agentautomations
kubectl -n agents get agenthostset fred -o jsonpath='{.status.hosts[*].address}'
```

Then add `wss://<pod>.<tailnet>.ts.net/?tkn=<token>` to the VS Code setting `chat.remoteAgentHosts`.

[`examples/agent-host-image`](examples/agent-host-image/Dockerfile) is a starting point for the host image (VS Code CLI, git, Node).

## When

A pass runs on every change to the operator's kinds or to a pod in its namespace, when a clone ends, every `CLONING_POLL_SECONDS` (5) while a clone runs, and every `RESYNC_INTERVAL_SECONDS` (300) otherwise, for what only the hosts see.

## Develop

Node 24 runs the TypeScript as it is; the one runtime dependency is the AHP client, `@microsoft/agent-host-protocol`.

```sh
npm ci
npm test               # node --test, against a fake agent host and a fake Kubernetes client
npm run typecheck
npm run render         # deploy/install.yaml from deploy/jsonnet (needs jsonnet)
```
