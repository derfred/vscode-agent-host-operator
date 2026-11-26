#!/usr/bin/env bash
# The operator, end to end, on your machine, in one command: a kind cluster,
# the agent host image built from examples/agent-host-image, the operator,
# one agent host pod, and a workspace the operator clones onto it. It ends
# with the address to add to VS Code's chat.remoteAgentHosts.
#
#   examples/quickstart/quickstart.sh
#   examples/quickstart/quickstart.sh --delete      # remove it all
#
# Options:
#   --repository URL        the workspace to clone (default: this repository)
#   --operator-from-source  run the operator built from this checkout, not
#                           the released image
#   --no-forward            set up, print how to connect, and exit
#   --delete                delete the cluster and exit
#
# What it applies, next to this script: hosts.yaml (the StatefulSet and its
# AgentHostSet) and workspace.yaml (an AgentWorkspace and an
# AgentAutomation), plus deploy/install.yaml. The connection token is a
# Secret it generates once.
#
# Needs docker (running), kind and kubectl. Re-running it is safe: it reuses
# the cluster and the token, and rolls the pod onto a changed image.
set -eEuo pipefail

cluster=${CLUSTER:-agent-host-quickstart}
ns=agents
pod=agents-quickstart-0
repository=https://github.com/derfred/vscode-agent-host-operator.git
from_source=false
forward=true
port=${PORT:-8081}

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)

usage() { sed -n '2,/^set -eEuo/{/^set -eEuo/d;s/^# \{0,1\}//;p;}' "$0"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --repository) repository=${2:?--repository needs a URL}; shift 2 ;;
    --operator-from-source) from_source=true; shift ;;
    --no-forward) forward=false; shift ;;
    --delete) delete=true; shift ;;
    -h | --help) usage; exit ;;
    *) echo "unknown option $1" >&2; usage >&2; exit 2 ;;
  esac
done

missing=()
for tool in docker kind kubectl; do
  command -v "$tool" > /dev/null || missing+=("$tool")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "quickstart needs these on the PATH, and is missing: ${missing[*]}" >&2
  exit 1
fi
if ! docker info > /dev/null 2>&1; then
  echo "docker is installed, but its daemon isn't reachable: start Docker and try again." >&2
  exit 1
fi

if [ "${delete:-false}" = true ]; then
  kind delete cluster --name "$cluster"
  exit
fi

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
k() { kubectl --context "kind-$cluster" "$@"; }
# A manifest next to this script, its ${NAME} placeholders filled in.
render() { # render FILE NAME=VALUE...
  local file=$1 args=() kv name value
  shift
  for kv in "$@"; do
    name=${kv%%=*} value=${kv#*=}
    value=${value//\\/\\\\} value=${value//|/\\|} value=${value//&/\\&}
    args+=(-e "s|\${$name}|$value|g")
  done
  sed "${args[@]}" "$here/$file"
}

on_error() {
  echo >&2
  echo "Something went wrong. What the cluster says:" >&2
  k -n "$ns" get agenthostsets,agentworkspaces,agentautomations,pods -o wide >&2 2>/dev/null || true
  k -n "$ns" get agenthostsets,agentworkspaces -o jsonpath='{range .items[*]}{.kind} {.metadata.name}: {.status.hosts}{"\n"}{end}' >&2 2>/dev/null || true
  k -n "$ns" logs deploy/agent-host-operator --tail 30 >&2 2>/dev/null || true
  k -n "$ns" logs "$pod" --tail 30 >&2 2>/dev/null || true
}
trap on_error ERR

step "Cluster: kind $cluster"
if kind get clusters 2>/dev/null | grep -qx "$cluster"; then
  echo "reusing it"
else
  kind create cluster --name "$cluster" --wait 120s
fi

# Built, tagged by content (so a changed image rolls the pod on a re-run),
# and loaded into kind. Prints the tag.
build() { # build NAME CONTEXT
  local id
  docker build -t "$1" "$2" >&2
  id=$(docker image inspect --format '{{.Id}}' "$1" | sed 's/^sha256://' | cut -c1-12)
  docker tag "$1" "$1:$id"
  kind load docker-image --name "$cluster" "$1:$id" >&2
  echo "$1:$id"
}

step "Agent host image: examples/agent-host-image (VS Code CLI and its server, git, Node)"
image=$(build quickstart/agent-host "$root/examples/agent-host-image")
echo "built $image"

step "Operator: deploy/install.yaml"
k apply -f "$root/deploy/install.yaml"
if $from_source; then
  operator_image=$(build quickstart/operator "$root")
  k -n "$ns" set image deploy/agent-host-operator operator="$operator_image"
  k -n "$ns" patch deploy/agent-host-operator --type=json \
    -p '[{"op":"replace","path":"/spec/template/spec/containers/0/imagePullPolicy","value":"Never"}]'
fi
k wait --for=condition=Established --timeout=60s \
  crd/agenthostsets.agenthost.derfred.com crd/agentworkspaces.agenthost.derfred.com crd/agentautomations.agenthost.derfred.com

step "Connection token: Secret agents-quickstart-token (made once, kept on re-runs)"
if ! k -n "$ns" get secret agents-quickstart-token > /dev/null 2>&1; then
  k -n "$ns" create secret generic agents-quickstart-token \
    --from-literal=token="$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9_-')"
else
  echo "reusing it"
fi

step "Agent host pod and AgentHostSet (hosts.yaml), workspace and automation (workspace.yaml)"
render hosts.yaml IMAGE="$image" | k apply -f -
render workspace.yaml REPOSITORY="$repository" | k apply -f -

step "Waiting: the operator, then the pod (Ready once the workspace is cloned)"
k -n "$ns" rollout status deploy/agent-host-operator --timeout=180s
k -n "$ns" rollout status statefulset/agents-quickstart --timeout=600s
k -n "$ns" wait --for=condition=Ready "pod/$pod" --timeout=600s
k -n "$ns" wait --for=jsonpath='{.status.phase}'=Ready agentworkspace/quickstart --timeout=300s
k -n "$ns" get agenthostsets,agentworkspaces,agentautomations

token=$(k -n "$ns" get secret agents-quickstart-token -o jsonpath='{.data.token}' | base64 --decode)
step "Connect"
cat <<EOF
The workspace is on the pod, at /workspace/quickstart. In VS Code, add this
to the setting chat.remoteAgentHosts, then open the Agents window:

  ws://localhost:$port/?tkn=$token

Then try:
  kubectl --context kind-$cluster -n $ns get agenthostset quickstart -o yaml          # agents, protocol version
  kubectl --context kind-$cluster -n $ns scale statefulset agents-quickstart --replicas 2   # a second host, cloned before it's Ready
  kubectl --context kind-$cluster -n $ns get agentautomation morning-summary -o yaml  # where the automation is
  examples/quickstart/quickstart.sh --delete                                          # remove it all
EOF

if $forward; then
  echo
  echo "Forwarding localhost:$port to the pod; Ctrl-C to stop (re-run the script to start again)."
  k -n "$ns" port-forward "pod/$pod" "$port:8081"
else
  echo
  echo "To connect: kubectl --context kind-$cluster -n $ns port-forward pod/$pod $port:8081"
fi
