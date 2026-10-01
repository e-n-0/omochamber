# Native OMO backend

This directory owns the native runtime adapter for local web and Electron. `../../native.js` composes it with authentication and retained local tools. `../../index.js` is the default package entrypoint. Legacy OpenCode composition lives in `../../legacy-opencode.js` and isn't imported by native startup.

Read the [web README](../../../README.md) for runnable commands and the [UI documentation](../../../../ui/src/omo/DOCUMENTATION.md) for the application wire codec.

Conversation inventory excludes the native `.computer-audit.jsonl` sidecar.
It contains computer action receipts, not session headers or conversation entries.
The adapter leaves that file untouched; unreadable or invalid conversation JSONL still fails the inventory read.

## Module ownership

| Module and exports | Responsibility |
| --- | --- |
| `installed-runtime.js`: `resolveInstalledRuntime` | Resolve and validate the existing OMO package, Senpi snapshot, launch spec and Bun executable |
| `host-client.js`: `createHostClient` | Local JSONL framing, negotiation, deadlines, correlation and connection teardown |
| `discovery.js`: `discoverHosts` | Read-only layout-2 endpoint/shard discovery and owner checks |
| `native-layout.js`: `loadNativeReaders`, `nativeProjectKey`, `resolveNativeLayout`, `selectActiveBranch` | Pure installed readers, native path identity, owner-scoped roots and active ancestry |
| `projections.js`: `projectNativeTask`, `createNativeProjectionReader` | Sanitized goal/todo/task/DAG views and read-only directory watches |
| `session-service.js`: `createSessionService` | Server-owned session bindings, hydration, native controls and retained disconnect |
| `settings.js`: `createNativeSettings` | App-owned project/appearance persistence and serialized atomic writes |
| `local-services.js`: `createLocalServices` | Scoped filesystem/Git/worktree routes and owned PTY lifecycle |
| `routes.js`: `registerOmoRoutes` | Validated HTTP requests and snapshot-first SSE |

`startWebUiServer` returns the `NativeServerHandle` declared in `../../index.d.ts`: `runtime: 'omo'`, `expressApp`, `httpServer`, `getPort`, `isReady` and idempotent `stop`. Listener readiness doesn't assert native host availability.

## Installed runtime and host ownership

The target installation is OMO 5.1.6/Senpi 2026.9.30. Resolution reads installed launcher/package metadata and validates its existing snapshot. Runtime files are immutable inputs. No download, install, preparation, build or upgrade occurs.

Transport is native JSONL protocol version 1 over local sockets, not app-server or CBOR. Hosted attachment requires `multi_session`, `extension_events`, `session_context` and `session_kind`; retention is checked separately. The client advertises `extension_events` and `question`, not `media_placeholders`.

Discovery observes protocol and session inventory without opening a session. It includes registered shards and reads their store roots. Only initial `ENOENT` or `ECONNREFUSED` becomes an inactive endpoint. Timeouts, permissions, invalid protocol or unreadable registration remain unavailable. A failed inventory isn't an empty inventory.

Keep application and native identities distinct:

- `requestId` correlates one application submission.
- `sessionKey` is the stable opaque browser key.
- `durableSessionId` identifies the persisted native conversation.
- The live session handle routes requests within the owning host.
- The host instance identifies that owner's current process generation.

Socket addresses, host handles, transcript paths, store roots and credentials stay server-private. Public views pick allowed fields; native records aren't forwarded wholesale.

Attach to the discovered owner. Terminal-owned sessions remain read-only and never open a second writer. Offline reopen refuses conflicting owners or any unavailable host that leaves ownership uncertain. App session creation uses a generated durable ID, interactive kind, disabled auto-title and retention.

The dedicated app endpoint is `<data-dir>/omo.sock`. If it needs a host, `ensureAppHost` invokes the installed Senpi CLI with the unchanged OMO launch spec, `host ensure`, and `--policy never`. It reconstructs OMO branding/environment and removes inherited orchestration-shard variables. It doesn't run the OMO preparation launcher or adopt the caller's task shard.

## Application requests and recovery

`registerOmoRoutes` provides:

| Routes | Purpose |
| --- | --- |
| `GET /api/omo/status`, `GET /api/omo/hosts` | Sanitized availability and capabilities |
| `GET/POST /api/omo/projects`, `PATCH/DELETE /api/omo/projects/:projectId` | App project registration |
| `GET/POST /api/omo/sessions` | Native inventory and retained creation |
| `POST /api/omo/sessions/:sessionKey/attach` | Attach or safely reopen |
| `GET /api/omo/sessions/:sessionKey/snapshot`, `GET .../events` | Authoritative snapshot and SSE |
| `POST .../commands`, `POST .../ui-responses` | Native control or interaction response |
| `GET .../tasks/:taskId/output` | Parent-scoped task status/tail/full output |
| `GET/PATCH /api/omo/settings` | Public appearance preferences |

The `...` routes share `/api/omo/sessions/:sessionKey`. Requests can't supply native socket/store paths. Session creation selects a registered project or its registered worktree after canonical directory validation.

Commands carry `requestId`, `connectionEpoch` and a discriminated command. Stale epochs and duplicate submissions are refused before forwarding. HTTP `202` means accepted, not completed; SSE supplies the correlated result. Connection loss or uncertain native delivery never triggers mutation replay. Creation intent markers under app-owned `create-requests/` survive adapter loss and refuse a repeated create ID.

Subscribe before hydration and buffer attach-time events. Each event carries the session key, epoch and monotonic revision. SSE opens with a fresh snapshot even when a client supplies `Last-Event-ID`, because native replay has no durable cursor guarantee. Slow clients disconnect and resnapshot rather than silently lose deltas.

`get_entries` supplies append-order inventory plus the active leaf. Follow `parentId` to the root and reverse it for linear history and todo recovery. Native configuration writes can omit append events. When a subsequent entry exposes missing ancestry, coalesce an owning-host history read and publish the recovered snapshot. Reject obsolete ownership generations and preserve the previous branch if recovery fails. Remaining missing ancestry is incomplete, not a guessed branch. The product has no branch navigation, rollback, history migration or second engine.

Pending native select/confirm/input/editor/question interactions remain in the adapter across browser reconnect. After native transport or adapter loss, generic connection-bound dialogs aren't fabricated; native questions can recover from `get_state`. A response must match the pending interaction and can be submitted once.

## Native work authority

OMO owns goal continuation, completion/blocking decisions and token/time accounting. The adapter requires the extension-owned `goal` command, sends `/goal` set/replace/pause/resume/clear through native prompt expansion, and observes the goal sidecar before reporting success. Native replacement may open a select dialog. Pause doesn't abort a running turn. There is no GUI complete/blocked action or another goal loop.

Task controls use `omo.task.output`, `omo.task.send` and `omo.task.cancel` for the selected parent. Validate the returned parent/task identity before displaying output or controlling it. Todo and DAG views are read-only; this module never constructs native task/DAG stores, takes writer locks/leases, repairs journals or advances checkpoints.

## Read-only projections

Projections distinguish `ready`, `incomplete` and `unavailable`. Valid empty values can clear a view; failed reads preserve prior valid values and their failure status. One invalid task or DAG doesn't erase unrelated records. Persisted `running` is recorded state, not proof of live execution.

- Goal authority is the pure installed goal reader and `extensions/goal/<encoded durable ID>.json` beside the canonical transcript. Missing means no goal; malformed/unreadable data is unavailable.
- Todo authority is the installed todo reducer over the active branch. OmoChamber doesn't promote or rewrite todo tasks.
- Task roots prefer absolute shard-registered stores. Otherwise use native `task.state_dir` with the owning launch directory, then existing project `.omo/senpi-task`, then the native agent project bucket. Unresolved relative paths, profiles or conflicting records stay incomplete.
- Task inventory reads current `tasks/*.json` records for the exact durable parent. Capped live snapshots supplement records; omissions aren't deletion.
- DAG inventory reads owner-matched `dag/runs/*.json` checkpoints and complete LF records in `dag/events/*.jsonl`. Journal head must match checkpoint sequence. Ahead, inconsistent or changing reads stay incomplete; trailing fragments aren't repaired.

Install directory or ancestor watches before enumeration. Serialize refreshes and reject stale generations. Watches are invalidations, not another native state writer or a model-powered poll loop.

## Auth, local tools and cleanup

`native.js` owns loopback binding, Host/Origin checks, optional password issuance and existing auth gates. Mutations require Origin. Forwarded-host/protocol claims and non-loopback Host values are refused. Password sessions are memory-only; see the web README for expiration and restart behavior.

Local tool routes validate canonical paths against registered projects/worktrees and exclude private runtime/app/task data. Worktree removal is restricted to app-created clean worktrees and refuses live use or uncertain ownership. PTYs belong to this web server, unlike native OMO hosts.

Shutdown stops accepting HTTP work, shuts down owned PTYs, closes attachments and projection watches, and destroys remaining HTTP sockets. Partial startup follows the same cleanup. It never sends native shutdown/session-delete, unlinks host sockets, deletes native history or terminates foreign hosts.

Local web and local Electron share this implementation. VS Code, native mobile, remote/SSH/relay/pairing and advanced OpenCode workflows are deferred.

## Validation

Use colocated tests for executable adapter changes and `server/native.test.js` for composition. The web package's runner is `bun run --cwd packages/web test`. Actual provider/history and OS desktop verification belong to their native/browser/Electron QA runs; static checks or a health response aren't substitutes.

For documentation-only changes, run documented CLI help/start on an owned loopback server, check links and syntax, and clean only owned resources. No prose-pinning tests or unrelated build/test sweep is needed.
