# Testing

How the operator is tested, from unit tests to a person on a phone. Each stage either confirms an assumption the code makes or says what to change before the next one. Stages 0–3 are automated; 4 and 5 are by hand.

| Stage | What | Run with | Where |
|---|---|---|---|
| 0 | Unit tests: reconcile logic against a fake host and a fake Kubernetes client | `npm test` | every push (`test` workflow, `unit`) |
| 1 | Probe a real `code agent host`: what the operator assumes about AHP | `npm run probe -- …` | by hand, on each new VS Code version |
| 2 | End to end: the operator against a fake API server and two real hosts | `npm run e2e` | every push (`test` workflow, `e2e`) |
| 3 | A real cluster (kind): exec, RBAC, readiness gates, volumes | `examples/quickstart/quickstart.sh` | PRs touching `src`, `deploy`, `examples` (`cluster` workflow) |
| 4 | People and clients: the Agents window, a phone, an automation run | checklist below | by hand, per release |
| 5 | Licence and a soak run | below | before 1.0 |

## Stage 1: probe a real host

[`scripts/probe.ts`](../scripts/probe.ts) talks to a host through the operator's own client (`src/ahp.ts`) and its own automation definitions (`automationDefinition` in `src/reconcile.ts`), so what passes here is what the operator does.

Start a host. The VS Code CLI runs anywhere: [download it](https://code.visualstudio.com/Download) (`cli-linux-x64`, `cli-darwin-arm64`, …) or use the image.

```sh
echo -n "probe-$(head -c 16 /dev/urandom | base64 | tr -dc A-Za-z0-9)" > token
code agent host --foreground --host 127.0.0.1 --port 8081 \
  --connection-token-file token --server-data-dir ./host-data --user-data-dir ./host-user
# or: docker run --rm -p 8081:8081 -v "$PWD/token:/token:ro" agent-host \
#       --host 0.0.0.0 --port 8081 --connection-token-file /token
```

Then, in three steps (the second waits for a run, up to three minutes):

```sh
npm run probe -- --token-file token --dir /tmp --record frames.jsonl   # P1–P7
npm run probe -- --token-file token --dir /tmp --wait-run --keep       # P8: a run on schedule
# restart the host with a new token in the file, then:
npm run probe -- --token-file token --dir /tmp --after-restart --old-token <the old token>   # P8, P9
```

| # | Checks | The operator relies on it for |
|---|---|---|
| P1 | `initialize` agrees on a version in `PROTOCOL_VERSIONS`; the root snapshot lists agents | connecting; `status.hosts[].agents` |
| P2 | `resourceList` lists a folder; a missing one is an RPC error | "is the checkout there" (a broken connection must not look like a missing folder) |
| P3 | `resourceDelete` with `recursive` removes a tree; again is quiet | `deletionPolicy: Delete` |
| P4 | `InitializeResult.automations.create` | `AgentAutomation` at all |
| P5 | a create and a remove are accepted, and the dispatch settles | every catalogue change |
| P6 | `_meta` (owner, hash) and the rest of the definition come back unchanged, after create and after update | updating only on a change, not every pass |
| P7 | a definition the host refuses comes back with a `rejectionReason` | the error in `status.message` |
| P8 | with `automationsEnabled` on, an every-minute automation runs; after a restart, the automation, the setting and a future `nextRunAt` are still there | automations that run, and survive pod restarts |
| P9 | after the token changes and the host restarts, the old token is refused | token rotation by rolling the StatefulSet |

`--record` saves every frame. Save a new version's recording as `test/fixtures/vscode-<version>.jsonl`, with local paths replaced. [`test/conformance.test.ts`](../test/conformance.test.ts) replays every recording against [`test/fake-host.ts`](../test/fake-host.ts) and requires the same answer to each action (echoed, refused, or published), so stage 0 stays faithful. When it fails, change the fake to match.

### Results: VS Code 1.148.0 (2026-11-26)

All of P1–P9 pass, after two changes they called for. The host is `vscode-agent-host 1.148.0`, AHP `1.1.0`, with agents `claude`, `codex`, `copilotcli`.

- **P5 failed at first.** The host doesn't echo an accepted `automation/createRequested`/`updateRequested`/`removed` back with the client's origin, as the spec's write-ahead model has it. It publishes the result instead, with no origin: `automation/set`, `automation/removed`. Only a refusal is echoed, with our origin and a `rejectionReason`. Every create would have timed out after 30s. `src/ahp.ts` now settles a dispatch on either. The fake host answers the 1.148 way by default, and the spec's way with `echo: true`; the tests cover both.
- **P8 failed at first.** A host runs no automations until its root config value `automationsEnabled` ("Whether this Agent Host may run automations", default `false`) is on. Until then it keeps definitions, but gives no `run` operation and schedules nothing. A client turns it on with `root/configChanged`, and the host keeps it across restarts. The operator now turns it on for each host where it places an enabled `AgentAutomation`, and on no other.
- P2: a missing folder is RPC error `-32008` ("Directory not found").
- P6: nothing in the definition changes on the way through, `_meta` included. An entry gets `operations: [update, remove]`, plus `run` once automations are on. It has no `nextRunAt` while disabled.
- P8: runs happen on the minute. Without agent credentials on the host they fail with "Authentication is required to use Claude", which the operator reports as `lastRun.error`. While a run is pending or running, the entry has no `remove` operation. The operator reports "a run is in progress" and removes the entry on a later pass.
- **P8, a third time.** An automation that names no agent (`session.provider`) is deferred indefinitely ("Deferring Automation run until its provider is available"). The host has a default-provider slot, but nothing sets it on 1.148. `agent.provider` is now required, in the CRD and in the operator.
- P9: a wrong token fails the WebSocket handshake.
- The host's state (sessions, the automation catalogue and its run history) is in `--server-data-dir`, at `data/User/globalStorage/agent-host-storage.json`. Put that directory on the pod's home volume.
- `code agent host` detaches into the background unless given `--foreground`. In a container it must be given, or the container exits. The CLI downloads the server into `--cli-data-dir` (env `VSCODE_CLI_DATA_DIR`) on first start. The image now does that at build time, outside the home volume.

## Stage 2: end to end

[`e2e/run.ts`](../e2e/run.ts) runs [`e2e/scenario.ts`](../e2e/scenario.ts) with these parts:

- a fake Kubernetes API server in the test process (from t3code-operator: REST, watches, status, finalizers, and `pods/exec` over WebSocket);
- two real agent hosts, standing in for the pods `-0` and `-1` of a StatefulSet;
- the operator.

The scenario drives the operator only through the API, as `kubectl` would, and checks results in the hosts over AHP. The resync stays at 5 minutes, so each reaction it waits for shows that a watch works.

1. The `AgentHostSet` is Ready and reports each host's address, version and agents.
2. A workspace clones onto both hosts; the gates open.
3. A repository that doesn't exist is `Error` with git's message. The gate isn't held, and the set is `Degraded`.
4. A folder that already has files is kept, not cloned over.
5. An automation is placed on `-0` only (`One`). A disabled one leaves `automationsEnabled` alone. A pass without a spec change doesn't update it; a spec change updates it once.
6. `EachHost`, enabled: the automation is on both hosts, `automationsEnabled` is on, and `nextRunAt` is in status.
7. A missing token Secret makes the hosts `Error`, with the Secret's name in the message. The gates aren't held.
8. Restarting the operator changes no status and no catalogue entry.
9. Restarting a host (unready, then ready again): the operator reconnects, the catalogue and the setting are kept, and nothing is duplicated.

Cleanup is also checked: deleting the automations empties the catalogues, and deleting a `Retain` workspace keeps its folder.

```sh
npm run e2e                                               # Docker: both images built from this checkout
npm run e2e -- --host-image agent-host:1.149              # another host image
npm run e2e -- --hosts process --operator process --code ~/bin/code   # no Docker: hosts on 127.0.0.2/.3
```

Without Docker, the hosts share this machine's filesystem, so both "clone" into the same folder; the second finds it there. Docker gives each host its own volumes, as pods have.

Before raising `PROTOCOL_VERSIONS` or the pinned VS Code version, run stage 1 against the new version, then the `test` workflow by hand with `vscode-version` set to it.

## Stage 3: a cluster

[`examples/quickstart/quickstart.sh`](../examples/quickstart/quickstart.sh) sets up a kind cluster with these parts:

- the host image;
- `deploy/install.yaml`, with the operator image from this checkout when given `--operator-from-source`;
- one host pod;
- a workspace and an automation.

The [`cluster` workflow](../.github/workflows/cluster.yaml) runs it and then checks:

- the clone, over a real `pods/exec` with the Role `install.yaml` grants;
- the set and the automation are Ready;
- a deleted pod comes back on its volume with its checkout, without a new clone;
- a second replica is Ready only once its checkout is there;
- `deletionPolicy: Delete` removes the folder from every host;
- re-running the script is safe.

Applying `install.yaml` to a real API server is its server-side validation.

By hand, on the same cluster:

- [ ] Delete a `Delete` workspace while a host is unreachable (`kubectl scale … --replicas 0` does not count, since a gone pod holds nothing). Break the token instead: the finalizer waits until the host is back.
- [ ] `kubectl rollout restart statefulset/agents-quickstart`: each pod waits for its gate in turn.
- [ ] Turn on `morning-summary` with a schedule a few minutes ahead. `status.hosts[0].lastRun` shows the run. It fails without credentials; with `ANTHROPIC_API_KEY` set on the pod, it succeeds.

## Stage 4: people and clients

With the quickstart's port-forward, or a Tailscale address (`examples/manifests/tailscale.yaml`):

- [ ] **Desktop**: add `ws://localhost:8081/?tkn=…` (or `wss://<pod>.<tailnet>.ts.net/?tkn=…`) to `chat.remoteAgentHosts`. The host appears in the Agents window with its agents. Start a Claude session in `/workspace/quickstart`. It survives closing the window, and a `kubectl delete pod` (spike check 1).
- [ ] **Browser and phone**: `insiders.vscode.dev/agents` against the same host over `wss://` (spike check 2).
- [ ] **Automations**: the operator's automation appears in the Agents window's automation list, a run shows up there, and VS Code can edit it. Then edit the manifest: the operator puts its definition back (it owns the entry).
- [ ] **The automations switch**: the Agents window shows automations as on for a host the operator enabled, and turning them off there is undone on the next pass. Is that what we want? This is a decision to take, not a check.
- [ ] **Claude billing**: with the client signed in to GitHub, does a `claude` session go through Copilot or the host's own credentials? (docs/design.md, risks.)

## Stage 5: before 1.0

- **Licence**: read the VS Code server licence for self-hosting (spike check 5). The CLI asks for `--accept-server-license-terms` only for tunnels and GitHub environments. A direct `code agent host` doesn't ask, which doesn't settle the question.
- **Soak**: a few days on a real cluster at the default resync. Watch the operator's memory, its connections across host restarts and token rotations, and that settled resources get no status writes.
