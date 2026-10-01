# OmoChamber web

This package owns the local native backend, browser entrypoint and `omochamber` CLI. `@openchamber/web` remains the internal package name. See the [root README](../../README.md) for prerequisites and product scope.

## Start

From the repository root, using existing `packages/web/dist` assets:

```sh
bun packages/web/bin/omochamber.js --help
bun packages/web/bin/omochamber.js --help --json
bun run start:web --port 0 --json
```

The JSON result contains `runtime: "omo"`, the selected port and listening URL. Open that URL locally. `--quiet` prints only the URL. Without either flag, non-TTY output is also the URL.

For a direct invocation with browser assets:

```sh
bun packages/web/bin/omochamber.js serve --ui-dir packages/web/dist --port 0 --quiet
```

The CLI accepts only `serve`, which is also the default. It runs in the foreground; Ctrl+C or SIGTERM stops owned HTTP and PTY resources. It has no daemon, update, remote-connect or lifecycle subcommands. Omitting `--ui-dir` from the direct CLI serves APIs without browser assets.

## Configuration

| Option or environment | Meaning |
| --- | --- |
| `--port` | Default `3000`; `0` selects a free port |
| `--host` | Default `127.0.0.1`; only loopback addresses are accepted |
| `--data-dir`, `OMOCHAMBER_DATA_DIR` | App data directory, default `~/.config/omochamber` |
| `--ui-dir` | Existing native browser build directory |
| `--ui-password`, `OMOCHAMBER_UI_PASSWORD` | Optional browser login password |
| `--omo-binary`, `OMO_BIN` | Existing installed OMO executable |
| `--bun-binary` | Existing Bun executable used for native hosts |
| `--agent-dir` | Existing OMO agent directory |

Without `--agent-dir`, resolution checks `OMO_CODING_AGENT_DIR`, `SENPI_CODING_AGENT_DIR`, then `PI_CODING_AGENT_DIR`, and defaults to `~/.omo/agent`. The resolver validates installed package metadata and the matching Senpi snapshot. It never creates or repairs that snapshot.

Configure providers and credentials in the separate OMO installation. Browser settings expose appearance only; they don't expose runtime paths or provider secrets.

Password login uses same-origin, port-scoped HttpOnly cookies. Issued sessions are memory-only and expire or disappear on server restart. With no password, local access is unlocked. Loopback binding still enforces Host and Origin checks, refuses forwarded-host/protocol claims, and requires Origin on mutations. Terminal WebSockets use the authenticated transport gate too. This isn't a remote-access configuration.

## Native ownership

The server talks directly to native JSONL protocol version 1 over local sockets. Socket addresses, routing handles and native store roots stay server-side. No app-server, CBOR client or OpenCode controller starts on this path.

Discovery observes existing registered hosts and shards. Attachment follows the actual owner; terminal-owned sessions are read-only. An offline transcript can reopen only when discovery establishes safe ownership. Conflicts and uncertain hosts are refused, not replaced.

New sessions use an app endpoint at `<data-dir>/omo.sock`. When needed, the server invokes the existing Senpi CLI's `host ensure` with the unchanged OMO launch spec and `--policy never`. It doesn't invoke the OMO preparation launcher. Hosts retain sessions after disconnect, including when this web server stops.

OMO owns goal continuation, counters, tasks, todo state and DAG execution. Goal actions use the native `/goal` command and confirm the resulting sidecar, rather than treating acknowledgment as completion. Task output/send/cancel stays scoped to the selected native parent. Todo and DAG views are read-only.

Snapshots restore the active branch and projections before buffered events apply. Failed or partial reads keep the last valid data visibly incomplete or unavailable. An HTTP `202` accepts a command; a correlated event supplies its result. An uncertain submission is never automatically replayed.

App-owned `settings.json` stores projects and appearance. `worktrees/` holds app-created worktrees; `create-requests/` holds creation intent markers that prevent duplicate creates after adapter loss. Native transcripts and goal/task/DAG records remain under OMO ownership. Removing a project registration doesn't delete native history. Worktree removal refuses dirty directories, directories in use and uncertain ownership.

## In-process server

`server/index.js` exports `startWebUiServer`. Importing it doesn't start a listener. It delegates to `server/native.js` and defaults browser assets to the web package's `dist`.

The returned `NativeServerHandle` has `runtime: 'omo'`, `expressApp`, `httpServer`, `getPort()`, `isReady()` and idempotent `stop()`. Electron uses this same handle in its main process.

`isReady()` and `/health` describe the web listener. `/api/omo/status` describes discovered native availability, so a ready web server needn't have an available native host. `stop()` closes owned HTTP connections, PTYs, projection watches and attachments. It never signals hosts, deletes transcripts or repairs native stores.

See [backend documentation](server/lib/omo/DOCUMENTATION.md) for module exports and [UI documentation](../ui/src/omo/DOCUMENTATION.md) for browser contracts.

## Development and limits

`bun run dev` at the repository root starts the native API and Vite HMR UI on loopback. `bun run build:web` builds the native browser entrypoint, `src/omo-main.tsx`. Default product builds neither prepare OMO nor stage OpenCode binaries.

Local web and local Electron are the product targets. VS Code, native mobile, remote/SSH/tunnels/relay/pairing, updater workflows, multi-run/fusion/scheduling and advanced OpenCode settings are deferred. Legacy routes and UI modules remain dormant; they don't provide dual-engine operation or history migration.

## License

The OpenChamber [MIT license and copyright notice](../../LICENSE) remain intact. Senpi retains its upstream MIT notices. OMO is separately installed under its Sustainable Use License; this package doesn't bundle it or grant new redistribution rights.
