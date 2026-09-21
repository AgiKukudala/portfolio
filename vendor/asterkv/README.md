# AsterKV

A fault-tolerant replicated key-value store written in Go using gRPC and a custom
Raft implementation. It supports PUT, GET, DELETE, and atomic compare-and-swap,
with durable recovery, snapshots, and safe client retries. Designed as a readable
distributed-systems portfolio project; it is not a production database.

## Architecture

```text
Client → Leader → durable Raft log → replicas → majority → commit → apply → reply
```

Raft chooses one ordered history. The deterministic KV machine executes that
history. Locally appended, safely committed, and already applied are distinct
states. A successful mutation response is produced only after application of a
committed entry. GET is also a replicated command, giving strong reads without
assuming that an isolated node's belief in its leadership is sufficient authority.

Raft uses randomized elections, durable one-vote-per-term rules, log freshness
checks, prefix matching, per-follower nextIndex/matchIndex, and the current-term
commit rule. One mutex owns node state; network calls happen outside it.

See [architecture and invariants](docs/architecture.md), the
[component-by-component learning guide](docs/learning.md), and
[interview explanations and 20 questions](docs/interview.md).

## Layout

```text
cmd/node/                 node executable
cmd/client/               redirecting/retrying CLI
cmd/bench/                local benchmark utility
proto/asterkv/v1/         schema + committed generated Go/gRPC bindings
internal/raft/            elections, replication, application ordering, snapshots
internal/state/           deterministic KV, CAS, deduplication, snapshot encoding
internal/storage/         checksummed atomic durable file + exclusive lock
internal/server/          gRPC handlers and runtime lifecycle
internal/client/          retry logic and endpoint parsing
internal/sim/             transport fault injection and disk-backed test clusters
tests/                    cluster, partition, restart, gRPC, and subprocess tests
scripts/                  checks and local cluster launcher
docs/                     learning, architecture, interview, validation, benchmarks
```

## Running locally

Requires Go 1.26+, a C compiler for `-race`, and macOS or Linux. Generated protobuf
bindings are included; protoc is required only to regenerate them. This workspace
also has a git-ignored Go toolchain under `.tools/go`; Make detects it automatically.

```sh
make build
make cluster
```

In another terminal:

```sh
./bin/asterkv-client put x 10
./bin/asterkv-client get x
./bin/asterkv-client cas x 10 20
./bin/asterkv-client delete x
```

Press Ctrl-C in the cluster terminal to stop its nodes. Data remains under
`data/node1`, `data/node2`, and `data/node3`; launching again recovers it. The script
starts processes with loopback-only listeners. Each data directory is locked against
concurrent use. Never delete a running node's data or copy one node's directory to
another identity.

Start nodes separately for manual failure experiments:

```sh
./bin/asterkv-node --id=node1 --addr=127.0.0.1:5001 \
  --peers=node2=127.0.0.1:5002,node3=127.0.0.1:5003 --data=data/node1
./bin/asterkv-node --id=node2 --addr=127.0.0.1:5002 \
  --peers=node1=127.0.0.1:5001,node3=127.0.0.1:5003 --data=data/node2
./bin/asterkv-node --id=node3 --addr=127.0.0.1:5003 \
  --peers=node1=127.0.0.1:5001,node2=127.0.0.1:5002 --data=data/node3
```

Timing flags: `--heartbeat=50ms`, `--election-min=250ms`, `--election-max=500ms`,
`--rpc-timeout=150ms`. Use `--debug` to include commit and replication diagnostics. Snapshot default: `--snapshot-threshold=1000` applied entries
(including no-ops and reads); zero disables it. Each node lists every other member.
A five-node cluster works with the same rules and a quorum of three; a five-node
election/replication test is included. Membership is fixed for a data directory.

## API behavior and retries

Keys and values are strings. Key limit: 4 KiB; value/expected limit: 1 MiB each;
client and request identity limits: 256 bytes each. Result includes `value`, `found`,
and `success`. For mutations, value/found describe the previous state. Missing GET
has found=false. DELETE succeeds even if absent. CAS fails on a missing key and
succeeds only when an existing value equals expected. JSON output omits zero-valued
protobuf fields, so an omitted boolean means false.

CAS is replicated as CAS, never as a separately prechecked PUT. Two simultaneous
CAS calls expecting 5 cannot both change x from 5 to different replacements.

The CLI creates and prints a stable identity before sending a mutation. It reuses
that identity for every attempt, including redirects. To resume an ambiguous
request after restarting the CLI, provide its printed IDs and the exact operation:

```sh
./bin/asterkv-client --client-id=demo --request-id=91 cas x 10 20
# Repeating the exact line returns the original result without rerunning the CAS.
```

A request timeout does not prove that the operation failed. Followers return a
`not_leader` result with a known leader ID when available. The client uses that hint
or rotates configured endpoints. Use `--endpoints=id=host:port,...` and `--timeout=5s`
before the operation. Reusing a client/request pair with a different command is an
error. All cached request results are retained, including across snapshots/restarts.

## Failure handling

| Failure | Behavior |
|---|---|
| Follower loss | Remaining majority keeps committing; returning follower catches up |
| Leader loss | Survivors elect a new leader; clients retry with unchanged IDs |
| Minority partition | Cannot commit fresh writes or GETs; requests time out |
| Partition heals | Higher term replaces stale leadership; divergent uncommitted suffix is repaired |
| Lost/delayed/duplicate RPC | Retry plus term and log-prefix validation |
| Lost client response | Replicated cache returns the original result |
| Process restart | Restore snapshot and committed log suffix; rejoin as follower |
| Storage error/corruption | Node fails closed; startup rejects corrupt published data |

Liveness assumes an eventual communicating majority and timing/storage conditions
that allow elections and RPCs to finish. Safety assumes honest crash-fault peers,
consistent initial membership, and durable storage honoring its sync contract.

## Persistent logging and snapshots

Terms, votes, log entries, known commitment, snapshot, and node/membership identity
are stored in one checksummed state image. Every update uses temporary-file sync,
atomic rename, and directory sync. This preserves ordering before acknowledgements
and keeps snapshot publication atomic with log compaction. It rewrites retained
state, so it is intentionally less efficient than a segmented WAL.

Snapshots include KV data **and** deduplication results with lastIncludedIndex/Term.
A follower behind the compacted prefix receives InstallSnapshot and continues with
later entries. Restart reconstructs a fresh machine from the snapshot and replays
only the retained committed suffix, leaving uncommitted entries unapplied.

## Testing and code generation

```sh
go test ./...
go test -race ./...
go vet ./...
# Make variants also work with the workspace-local Go toolchain:
make check
# Optional separate-process CLI smoke check (requires Python 3):
make build
python3 scripts/smoke.py
```

Tests use local TCP ports and child processes; an execution sandbox must allow them.
Coverage includes elections, heartbeats, log repair, minority rejection, concurrent
CAS, RPC faults, snapshot catch-up, full restart, and subprocess SIGKILL recovery.
See [validation records](docs/validation.md) for commands and results.

Regenerate bindings with protoc 30.2 and the pinned plugins:

```sh
go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.36.11
go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@v1.6.1
# Ensure the install directory (usually ~/go/bin) is on PATH.
make proto
```

## Benchmarks

```sh
make build
./bin/asterkv-bench -scenario=all -n=60
```

Runs normal gRPC, leader-stop gRPC, and injected RPC-loss scenarios with real durable
files. Reports PUT/GET p50/p95/p99, sequential throughput, leader recovery, and
follower catch-up time. See [actual measurements and methodology](docs/benchmarks.md).
The fault transport uses different timing and is not directly comparable to gRPC.

## Limitations and future work

- Fixed membership; no joint consensus, discovery, or bootstrap agreement protocol.
- No TLS, authentication, or Byzantine-fault protection. Use on a trusted local network.
- Full-file durable replacement, synchronous application, and heartbeat-paced replication
  limit throughput. No pipelining, WAL, or adaptive batching.
- GET incurs replication and disk cost; no ReadIndex, leases, or stale follower reads.
- Deduplication retains every identity; no session expiration or safe cache reclamation.
- Unary snapshot messages have a 64 MiB runtime limit; streaming snapshots are future work.
- No admission control for uncommitted proposals during a long partition. The log can
  grow when clients continue proposing without a quorum.
- Structured election/snapshot logs and debug replication logs; no metrics endpoint,
  dashboards, sharding, multi-Raft, or performance tuning claims.
- Fault tests and the race detector are substantial evidence, not a formal proof or
  exhaustive linearizability test. Model checking and history checking are future work.
- Storage code and subprocess tests target macOS/Linux, not Windows.

## License

Released under the [MIT License](LICENSE).
