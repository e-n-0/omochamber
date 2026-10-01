# OmoChamber desktop

This package owns the local Electron shell. Shared native UI lives in `packages/ui/src/omo`; the backend lives in `packages/web/server/native.js`. The package name `@openchamber/electron` and the `openchamber-ui` scheme remain internal identifiers.

## Run and bundle

Use the [root prerequisites](../../README.md#run-locally), including the separately installed OMO/Senpi runtime and an already available Electron binary. From the repository root:

```sh
bun run electron:dev
```

This starts loopback Vite HMR, then launches `omo/entry.mjs` with the installed Electron binary. It doesn't install or repair Electron, prepare OMO, or stage OpenCode.

For staged UI, first have a current `packages/web/dist` build, then run:

```sh
bun run --cwd packages/electron native:dev:bundled
```

That bundles the native shell, copies the existing browser build, and launches `dist-bundle/omo/entry.mjs`. `bun run electron:build` runs the same native bundling step without launching a window. It produces `dist-bundle/omo`, not an installer. The root `bun run build` builds web before this step.

Installer creation, signing and platform release verification are separate work. Legacy packaging/preparation scripts still exist in the package, but aren't the native default build or dev path.

## Startup and shutdown

`omo/entry.mjs` sets the OmoChamber identity, profile path, application scheme and single-instance lock before readiness. It then imports `omo/main.mjs` and `@openchamber/web/server/index.js`.

`createNativeDesktop` starts one native backend in the Electron main process on `127.0.0.1`, using port `0` by default. It checks the returned `NativeServerHandle` for `runtime: 'omo'` and readiness before loading the application window. There is no backend sidecar.

HMR loads an exact loopback application URL. Staged UI loads from `openchamber-ui://app/index.html`; packaged code selects `resources/web-dist`. The scheme handler confines assets to the staged directory and forwards app HTTP/SSE requests to the fixed owned loopback backend. Packaged terminal WebSockets use that backend's loopback address.

Closing the last window requests quit. Quit and partial startup failure await backend `stop()`, then clear selection grants, notifications, IPC and protocol handlers and destroy the window. The backend stops its HTTP listener and PTYs and disconnects retained native attachments. OMO hosts, native goals and transcripts remain owned by OMO.

The development launcher also closes its Vite instance and awaits its owned Electron process. This native shell doesn't use legacy tray, SSH, updater or managed OpenCode cleanup.

## Privileged bridge

The trusted top-level app document receives `window.__OMOCHAMBER_DESKTOP__` with five methods:

| Method | Contract |
| --- | --- |
| `selectFolder({ defaultPath? })` | Native picker, canonical selected path or `null` |
| `selectFile({ defaultPath? })` | Native picker, canonical selected path or `null` |
| `openPath(path)` | Opens a path covered by a main-owned selection grant |
| `revealPath(path)` | Reveals a path covered by that grant |
| `notify({ title, body? })` | Resolves on native display confirmation, or reports unsupported/rejects |

Main checks the owned window, main frame and exact app document for every IPC call, including after asynchronous picker/path operations. Folder grants cover canonical descendants; symlink escapes aren't grants. Navigation away, popups and webviews are refused. The bridge exposes no raw IPC, filesystem, shell, credentials or host-control methods.

The renderer uses context isolation with Node integration disabled. Its ESM preload is unsandboxed, so main-process checks remain the privilege boundary. Browser permission requests are denied.

The browser entrypoint adapts the trusted preload through optional `NativeDesktopContext`. `ProjectSidebar` consumes folder selection, `NativeFiles` consumes file selection/open/reveal, and `NativeDialogs` notifies on writable pending human requests. Without that capability, browser-only use keeps typed project registration, file editing and pending responses. Read [desktop consumer lifecycle](../ui/src/omo/DOCUMENTATION.md#desktop-consumers) for cancellation, refusal and notification handling.

## Files and configuration

| File | Owner |
| --- | --- |
| `omo/entry.mjs` | Identity, profile, scheme registration, startup and single-instance focus |
| `omo/main.mjs` | `createNativeDesktop`, window lifecycle, local protocol and privileged IPC |
| `omo/preload.mjs` | Trusted app bootstrap and the five-method bridge |
| `scripts/native-dev.mjs` | Owned Vite/Electron development lifecycle |
| `scripts/native-bundle.mjs` | Native main/entry bundles, preload copy and existing web assets |

Profiles default to `OmoChamber Dev` in development and `OmoChamber` when packaged. `OMOCHAMBER_DESKTOP_USER_DATA_DIR` overrides the Electron profile; `OMOCHAMBER_DATA_DIR` separately selects backend data. Development and packaged modes share the backend data default unless you override it.

`OMOCHAMBER_DESKTOP_PORT` selects the loopback backend port. The dev launcher supplies `OMOCHAMBER_UI_URL` for HMR and `OMOCHAMBER_DESKTOP_BUNDLED=1` for staged UI. Runtime discovery uses the inherited environment and [web runtime configuration](../web/README.md#configuration); there is no legacy login-shell probe or remote host switcher.

## Verification limits

The October 1, 2026 desktop evidence records actual installed-Electron launches in HMR and staged modes, loaded native UI, an in-process native handle, PTY cleanup and foreign-frame IPC refusal. Those checks don't establish full OS or release support.

OS screenshots remain unverified while the running `senpi-desktop-engine` helper reports Screen Recording denial. Native picker confirmation and OS open/reveal actions remain unverified. Earlier notification attempts failed with `UNErrorDomain error 1`; successful OS display isn't claimed.

All five bridge methods now have UI consumers. Unit checks and HTTP/SSE/preload fixtures cover their integration at desktop and responsive widths. Fixture captures and successful fixture notification replies don't establish native OS window, picker or notification proof.

Windows/Linux execution, installer creation/signing and password-protected packaged-cookie login remain unverified. The native shell doesn't expose remote/SSH/tunnel/relay/pairing, updater, Mini Chat or multi-window workflows. VS Code and native mobile packaging are deferred.

For backend ownership and recovery, read [native backend documentation](../web/server/lib/omo/DOCUMENTATION.md). For renderer contracts, read [native UI documentation](../ui/src/omo/DOCUMENTATION.md).

## License

OpenChamber's [MIT license and copyright notice](../../LICENSE) and Senpi's upstream MIT notices remain intact. OMO remains separately installed under its Sustainable Use License. Native bundling doesn't include OMO/Senpi or grant new redistribution rights to OMO.
