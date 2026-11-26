# Agent Host Operator: design

A Kubernetes operator, built like [t3code-operator](https://github.com/derfred/t3code-operator), that keeps VS Code agent host pods supplied with workspaces and scheduled automations, reached over Tailscale.

This is the design as implemented in v0.1.0. The section [Decisions made in the implementation](#decisions-made-in-the-implementation) lists what the code settled that the design left open, and [Spike](#spike) what still needs a real host to confirm.

## Goal and scope

The operator makes VS Code agent hosts declarative: the repositories each host holds, and the automations it runs, are Kubernetes resources, and every pod converges on them. It is t3code-operator's model ([design](https://github.com/derfred/t3code-operator/blob/main/docs/design.md)) applied to a different server.

Vocabulary, as in t3code-operator:

- **Agent host**: one VS Code agent host server (`code agent host`), here one pod with its own volumes. It runs sessions for the Copilot, Claude and Codex harnesses and keeps them while clients come and go.
- **Host set**: a StatefulSet whose pods are agent hosts, described by an `AgentHostSet`.
- **Workspace**: a git checkout on a host's volume that sessions point at. An `AgentWorkspace`.
- **Automation**: a prompt the host runs on a schedule, using the host's own automations feature over AHP. An `AgentAutomation`. **The host runs it**; the operator decides which hosts hold it.

In scope for v1:

- Reading host sets and their pods; one status entry per pod, with its address.
- Cloning workspaces onto each pod and holding the pod's readiness until they are there.
- Creating, updating and removing automations through AHP.

Out of scope for v1:

- **Rendering the StatefulSet, Services or Tailscale objects.** You keep them in your reviewed manifests, as with t3code-operator (examples in [`examples/manifests`](../examples/manifests)).
- **Provider logins.** The pod spec supplies credentials (see [Credentials](#credentials)).
- **Sessions and chats.** Anything a person does inside a host stays theirs.
- **Permission policy** (deny/ask rules). Possible later; see [Later](#later).
- **Public ingress.** Ruled out; see [Decisions](#decisions).

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Which AHP server runs in the pod | VS Code's agent host (`code agent host`) | It's the reference implementation, so the Agents window works fully against it. It already runs Claude through the Agent SDK. Fallback: [ahpd](https://github.com/ahpio/ahpd) (MIT) if the VS Code license rules it out. |
| Our own Claude-to-AHP adapter | Not built | The Agent SDK starts the same Claude Code binary as `claude -p`, so a stream-JSON adapter adds nothing. |
| Claude credential | API key by default; Max token (`CLAUDE_CODE_OAUTH_TOKEN`) at the user's own risk | Anthropic's terms point Agent SDK use at API keys. |
| How people reach a host | Tailscale, one tailnet hostname per pod | WireGuard encrypts and authenticates the device, the token never passes an Ingress log, and tailnet access rules decide who reaches which pod. |
| Public `wss://` Ingress | Rejected | The host accepts its token only as the `tkn` query parameter, so it lands in proxy logs and URLs. |
| One host per person or per team | Per person or small team | AHP has no isolation between users; everyone with the token can do everything on the pod. |
| Language and dependencies | TypeScript on Node 24, as t3code-operator, plus the AHP TypeScript client (`@microsoft/agent-host-protocol`) | Most of t3code-operator's code is reused, and the protocol's own client follows the spec as it changes. |

## Architecture

People come in through one Tailscale Ingress per pod. The operator talks to the same pods on their IPs from inside the cluster, and reads and writes only Kubernetes objects and AHP.

```
 VS Code / Agents window ──tailnet── Tailscale Ingress (per pod) ──┐
                                                                   ▼
                       ┌───────────── agent host pod (StatefulSet) ─────────────┐
 operator ──AHP ws://<pod IP>:8081/?tkn=…──▶ code agent host   /workspace  /home │
          ──pods/exec: git clone──────────▶                                      │
          ──pods/status: content-ready gate                                      │
                       └─────────────────────────────────────────────────────────┘
```

## Custom resources

Three kinds in API group `agenthost.derfred.com/v1alpha1`, each matching a t3code-operator kind. Schemas: [`deploy/jsonnet/crds.libsonnet`](../deploy/jsonnet/crds.libsonnet); examples: [`examples/manifests`](../examples/manifests).

| Kind | t3code-operator equivalent | Owns |
| --- | --- | --- |
| `AgentHostSet` | `T3EnvironmentSet` | Which StatefulSet's pods are hosts, how to reach and authenticate to them |
| `AgentWorkspace` | `T3Project` (clone part) | A repository checked out on every selected host |
| `AgentAutomation` | `T3Project.spec.tasks` | A scheduled prompt in a workspace |

### AgentHostSet

```yaml
spec:
  statefulSet: agents-fred          # its pods are the hosts
  container: agent-host             # for exec (clones); default: the first container
  port: 8081                        # the host's WebSocket port
  connectionToken:                  # the same Secret the pods mount as --connection-token-file
    secretName: agents-fred-token
    key: token
  address: "wss://{pod}.example-tailnet.ts.net"   # reported in status, for clients
```

Status has one entry per pod:

```yaml
status:
  phase: Ready                      # Ready | Progressing | Degraded | Error
  hosts:
    - pod: agents-fred-0
      phase: Ready                  # Pending | Ready | Degraded | Error
      address: wss://agents-fred-0.example-tailnet.ts.net
      protocolVersion: 1.1.0        # what initialize agreed
      serverInfo: …                 # the host software, when it says
      agents: [claude, codex, copilotcli]
      contentReady: true
      workspaces: [{ name: my-app, phase: Ready }]
      message: null
```

A host is `Pending` while its pod isn't up or a workspace is still on its way, `Error` when the operator can't connect to it (the message says why), `Degraded` when a workspace placed on it failed, and `Ready` otherwise.

### AgentWorkspace

```yaml
spec:
  repository: https://github.com/example/my-app.git
  # ref: main                       # branch to check out; default: the remote's default
  # path: /workspace/my-app         # default /workspace/<name>
  hostSetSelector:                  # a LabelSelector; {} = every set
    matchLabels: { owner: fred }
  # deletionPolicy: Retain          # Retain | Delete (removes the folder)
```

Unlike t3, the agent host has no project registry, so a workspace is just a folder on the volume. The operator owns the clone, so `Delete` can remove the folder, which t3code-operator can't do. Status lists each host with `phase` (`Waiting | Cloning | Ready | Error`), the repository the checkout came from, and since when it is cloning or failed.

### AgentAutomation

```yaml
spec:
  workspace: my-app                 # an AgentWorkspace: the working directory, and where it goes
  prompt: Check for outdated dependencies and open a PR for any that are behind.
  # title: …                        # default <name>
  # enabled: true
  trigger:
    schedule: "0 3 * * 1-5"         # AHP's five-field cron
    timeZone: Europe/Berlin         # default UTC
    # misfirePolicy: runOnce        # skip | runOnce
  agent:
    provider: claude                # claude | codex | copilotcli
    model: claude-sonnet-5-5
  # config: { … }                   # session config values (e.g. a permission mode), passed as they are
  # placement: One                  # One | EachHost
```

The operator places an automation on the hosts that hold its workspace (`Ready` there): on one of them (`One`, the lowest ordinal; it then stays there across pod restarts), or on all of them (`EachHost`). Status lists, per pod, the automation's resource on that host, its next run and its last run.

## Pod contract

The pods come from a StatefulSet you write ([`examples/manifests/host-set.yaml`](../examples/manifests/host-set.yaml)), and the operator only reads it. The host binds to all addresses so the operator can reach it on the pod IP, and reads the same token file the operator reads from the Secret. The pod declares the readiness gate `agenthost.derfred.com/content-ready`.

- **The token is read once, at start** (confirmed: probe check P9). A rotated Secret takes effect on the next pod restart; rotate by rolling the StatefulSet. The operator reads the Secret every pass and reconnects when it changed.
- **No Service is required by the operator.** It talks to each pod IP. Per-pod Services exist only for Tailscale.
- **Bake the server into the image.** The CLI otherwise downloads the server on first start; pinning both makes the AHP version a deploy decision.

## Reconcile model

The loop is t3code-operator's, level-triggered: watches on the three kinds and on pods wake it within about a second; it also polls every 5 seconds while a clone runs and every 5 minutes as a safety net. Each pass reads everything and reconciles everything ([`src/main.ts`](../src/main.ts)):

1. **Observe.** Read every `AgentHostSet`, its StatefulSet, that StatefulSet's pods by its own selector, and its token Secret. A host is up when its pod's `ContainersReady` is true.
2. **Connect.** For each host that is up, reuse or open its AHP connection ([`src/connections.ts`](../src/connections.ts)): `initialize` with the protocol versions the operator supports; record the agreed version and the agents. A dead connection is replaced at once, a host that can't be reached is retried with backoff (1 s to 5 min), and a version the operator doesn't support makes that host `Error`, not the set.
3. **Workspaces** ([`reconcileWorkspace`](../src/reconcile.ts)). For each `AgentWorkspace`, on every host of the sets it selects:
   1. If the folder has files (AHP `resourceList`), it is there. Files that were there already, such as a clone made by hand, are kept.
   2. Otherwise start `git clone` over pods/exec, kept in memory between passes ([`src/clones.ts`](../src/clones.ts)). A failed clone makes the entry `Error` with git's message, and is retried after 5 minutes, or at once for a changed URL or ref.
   3. A host the selector no longer reaches, and a deleted workspace, follow `deletionPolicy`: `Delete` removes the folder (`resourceDelete`), then the finalizer is dropped.
4. **Automations** ([`reconcileAutomations`](../src/reconcile.ts)). For each `AgentAutomation`, pick its hosts (placement); then, for each connected host, compare the host's catalogue with what should be there. Create what is missing, update what differs, remove ours that are no longer wanted.
5. **Readiness.** Set the pod condition `agenthost.derfred.com/content-ready` to true once no workspace placed on the pod is still `Waiting`, or `Cloning` for less than 15 minutes. `Error` does not hold the gate.
6. **Status.** Write each resource's status only when it differs from what the API server holds, compared the way the server stores it, so the operator's own writes settle after one more pass.

Finalizers on `AgentWorkspace` and `AgentAutomation` undo what the operator did: the automation is removed from every host, and the folder follows `deletionPolicy`. A host that held it and can't be reached keeps the finalizer until it can; a host whose pod is gone is forgotten.

## Talking to the host

The operator is an AHP client like the Agents window ([`src/ahp.ts`](../src/ahp.ts)). It connects to `ws://<pod IP>:8081/?tkn=<token>`, inside the cluster, so the token never leaves it.

| Need | AHP surface |
| --- | --- |
| Handshake, version | `initialize` (client sends `protocolVersions`, server picks one); root snapshot for the agents |
| Is the checkout there | `resourceList` on the folder |
| Remove a folder | `resourceDelete` (recursive) |
| Clone a repository | None: `git clone` over pods/exec |
| Automations: list, create, update, remove | The `ahp-automations://` channel: its snapshot is the catalogue; `automation/createRequested`, `automation/updateRequested` and `automation/removed` change it |

Design rules:

- **One connection per pod, kept open,** with `ping` each pass to notice a dead one.
- **Pin the protocol range.** The operator offers the versions it was tested against (`1.1.0`, `1.0.0`). AHP moves fast; the end-to-end test should run against each new host image before the range grows.
- **Stable identity for automations.** The client chooses the automation's resource: `ahp-automation:/k8s-<name>`. The definition's `_meta` also carries `agenthost.derfred.com/automation: <name>` and the hash of the definition the operator applied, so a lost status doesn't create duplicates, and a definition is only updated when the spec changed.
- **Accepting and refusing actions.** Automation actions are dispatched as notifications. A refusal comes back as the same action with the operator's origin and a `rejectionReason`, which the operator reports in status. An acceptance comes back either as that echo without a reason (the spec's write-ahead model), or, as VS Code 1.148 does it, as the published result with no origin: `automation/set` or `automation/removed` for that resource. The operator waits for either ([testing.md, results](testing.md#results-vs-code-11480-2026-11-26)).
- **The host's automations switch.** A host runs automations only while its root config value `automationsEnabled` is on, and it is off on a new host. The operator turns it on (`root/configChanged`) for each host where it places an enabled `AgentAutomation`, and for no other host. The host keeps the setting across restarts.
- **Use the official TypeScript client** rather than hand-written JSON-RPC types.
- **Why exec for clones:** AHP can read and write files but has no clone call. Exec needs `pods/exec` in the namespace, which the operator's Role has.

## Credentials

The operator needs one secret, the connection token. Provider credentials stay in the pod spec.

| Credential | Where it comes from | Who uses it |
| --- | --- | --- |
| Connection token | A Secret, mounted as `--connection-token-file`; the operator reads the same Secret | Operator and every client. Full control of the pod: treat like an SSH key. |
| Claude, API key | `ANTHROPIC_API_KEY` from a Secret | Claude harness |
| Claude, Max subscription | `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, from a Secret | Claude harness; whether the terms allow it through the Agent SDK is unclear; the user decides |
| Copilot | The client's GitHub sign-in, sent to the host over AHP | Copilot harness |
| Codex | `CODEX_HOME` on the home volume, or an API key | Codex harness |
| Git | A credential helper or token in the image or home volume | The clone (exec), and agents pushing branches |

The operator never reads provider credentials. Its Role can `get` Secrets in its namespace; set `tokenSecrets` in the jsonnet config to narrow that to the connection-token Secrets.

## Reachability

Each pod gets its own tailnet hostname with a TLS certificate, through the Tailscale Kubernetes operator ([`examples/manifests/tailscale.yaml`](../examples/manifests/tailscale.yaml)). Clients add `wss://<pod>.<tailnet>.ts.net/?tkn=<token>` to the VS Code setting `chat.remoteAgentHosts`. The operator creates no Services or Ingresses: it reports `spec.address` with `{pod}` filled in, in status, for clients to copy.

## Reuse from t3code-operator

| File | Fate |
| --- | --- |
| `src/watch.ts`, `src/selector.ts` | Kept |
| `src/kube.ts` | Kept, adapted: new group, Secrets, exec with a timeout per call |
| `src/main.ts` | Adapted: the new reconcilers; same timers and signal handling |
| `src/auth.ts` | Dropped: the token is read from its Secret each pass |
| `src/clones.ts` | Adapted: `git clone` over exec instead of t3's `cloneRepository` |
| `src/reconcile.ts` | Split and rewritten: `aggregatePhase`, `choosePlacement`, `canonical`, `writeStatus`, finalizers and the gate logic kept |
| `src/t3.ts` | Replaced by `src/ahp.ts`, a thin wrapper around the AHP client, and `src/connections.ts` |
| `src/workflows.ts` | Dropped |
| `deploy/` | Adapted: new CRDs and Role; exec is in the main Role |

## Decisions made in the implementation

- **Automation fields.** AHP 1.x settled what the design left to the spike: a client-chosen `ahp-automation:` resource, a `message` with origin `automation`, a session template (`provider`, `model`, `workingDirectories`, `config`) and schedule triggers of five cron fields plus an IANA time zone. `AgentAutomation` maps onto exactly that. `permissionMode` became the open `config` map, since the key is host-defined. `agent.provider` is required: VS Code 1.148's host has no default agent and defers every run of an automation without one.
- **Placement `One`** is the lowest ordinal holding the workspace, and sticky: a host that has it keeps it while it holds the workspace.
- **No watch on Secrets.** The token is read every pass instead; the host reads its token only at start anyway, so a rotation shows up through the pod restart, which is watched.
- **A host the operator can't connect to** makes its workspaces `Error`, which doesn't hold the readiness gate, so a wrong token can't stall a rollout.

## Spike

Checks 3 and part of 1 are done: [testing.md](testing.md#results-vs-code-11480-2026-11-26) has the results against VS Code 1.148.0, and stages 1 to 3 there repeat them automatically. The rest need people and devices (testing.md, stage 4).

| # | Check | If it fails |
| --- | --- | --- |
| 1 | `code agent host --host 0.0.0.0 --connection-token-file …` runs in the image; the desktop app connects over Tailscale; a Claude session survives a client disconnect and a pod restart | Try the standalone server entry point; if no direct connection works, stop |
| 2 | The browser Agents window, on a phone, opens the same pod over `wss://` | Fine for desktop-only use |
| 3 | The host accepts `automation/createRequested` from a non-VS Code client, keeps `_meta`, and runs on time across a pod restart | Drop `AgentAutomation` from v1; workspaces still work |
| 4 | `git clone` over exec into `/workspace/<name>`; a session on that folder works with no other registration | Unlikely to fail |
| 5 | The VS Code CLI and server license allows self-hosting for your own team | Switch the host to ahpd |

## Later

- **Permission policy** (`AgentPolicy`): deny/ask rules. The host merges rules from each connected client and drops them when it disconnects, so the operator would hold a connection to every pod for as long as the policy applies.
- **A VS Code extension that lists your hosts** from the operator's status.
- **Several repositories in one workspace.**
- **Shared code with t3code-operator,** extracted into a package once both are stable.
