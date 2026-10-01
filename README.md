# OmoChamber

OmoChamber is a local workspace for native OMO, forked from OpenChamber. It uses your existing OMO installation for conversations and agent work. The runnable product is the native browser application and its local Electron shell.

## What it keeps

- Projects and native sessions, with a linear view of the active branch and continuation after reconnect.
- Streaming chat, reasoning and tool output, model/thinking selection, steer/follow-up, abort, and native questions and permission dialogs.
- Native goal set/replace/pause/resume/clear and parent-owned task output/send/cancel. Todo and DAG panels are read-only.
- Local file editing, Git status/diffs/stage/unstage, worktrees, real PTY terminals, and appearance settings.

OMO owns execution, goal continuation and accounting. OmoChamber reads native state and forwards controls; it doesn't run another goal loop. Closing the browser or stopping the app disconnects attachments without stopping retained native work.

## Run locally

Use the repository's Bun 1.4.2 toolchain and Node.js 22+ for repository scripts. OMO's installed package requires Node.js 24+. This integration targets an already installed OMO 5.1.6 with Senpi 2026.9.30, its existing runtime snapshot, configuration and provider credentials. Repository dependencies must already be available.

OmoChamber resolves that installation from `omo` on PATH or an explicit `--omo-binary`. It doesn't install, upgrade, rebuild or prepare OMO/Senpi. A missing or mismatched runtime snapshot is a startup error.

From the repository root, with `packages/web/dist` already built:

```sh
bun packages/web/bin/omochamber.js --help
bun run start:web --port 0 --json
```

Open the printed loopback URL. Port `0` selects a free port; use `--port 3000` for a fixed one. The server runs in the foreground. Ctrl+C stops its HTTP listener and owned terminals, but leaves native hosts and retained sessions alone.

To build the browser assets from source, use `bun run build:web`. The default `bun run build` builds SDK support, UI, web and the native Electron bundle. These paths neither rebuild OMO nor stage OpenCode binaries.

The browser uses native JSONL protocol version 1 over server-owned local sockets. It doesn't use app-server or experimental CBOR. See the [web README](packages/web/README.md) for runtime overrides, password login and local data ownership.

## Runtime limits

| Runtime | Current scope |
| --- | --- |
| Local browser | Native UI and loopback backend, including responsive layouts |
| Local Electron | The same backend in-process and a local application window. See [desktop limits](packages/electron/README.md#verification-limits) before treating native OS actions or installers as verified |
| VS Code and native mobile | Deferred, excluded from the default product build |
| Remote, SSH, tunnels, relay and pairing | Deferred |

Responsive browser layouts don't imply access from another device. The backend refuses non-loopback listeners.

Multi-run, fusion, scheduling, updater workflows, advanced OpenCode settings, isolated spaces, and GitHub/Linear orchestration are deferred. Dormant upstream code remains in the repository; it isn't a second runnable engine. There is no OpenCode history migration, branch navigation or rollback.

## Ownership and development

Start with [AGENTS.md](AGENTS.md). The owning native contracts live in:

- [Backend documentation](packages/web/server/lib/omo/DOCUMENTATION.md), installed runtime resolution, host/session ownership, authenticated APIs and read-only recovery.
- [UI documentation](packages/ui/src/omo/DOCUMENTATION.md), `NativeClient`, `NativeStore`, active-branch history and reconnect behavior.
- [Electron README](packages/electron/README.md), local startup, preload privileges, bundling and OS verification limits.

## Credits and licenses

OpenChamber supplied the workspace UI and local services. Its [MIT license and copyright notice](LICENSE), Copyright (c) 2025 Bohdan Triapitsyn, remain intact. Senpi retains its upstream MIT notices.

OMO remains separately installed under its Sustainable Use License. OmoChamber doesn't bundle OMO or grant new rights to redistribute it. Keep each upstream component's license and notices with that component.
