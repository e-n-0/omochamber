# Native OmoChamber UI

This directory owns the native browser application shared with local Electron. It consumes OmoChamber's `/api/omo` contracts, not the OpenCode SDK or legacy session stores.

`packages/web/src/omo-main.tsx` mounts `OmoApp` with localization and optional `NativeDesktopContext`. `omo-runtime.ts` configures same-origin HTTP/realtime transport and adapts the trusted Electron preload through `initializeNativeDesktopCapability`. Native startup doesn't mount legacy `App`, `SyncProvider` or an OpenCode compatibility gate.

## Owners and public contracts

| File or directory | Responsibility |
| --- | --- |
| `contracts.ts` | Zod application wire codec and public views, including `NativeSnapshot`, `NativeCommand`, `PendingInteraction`, goal/todo/task/DAG projections and event envelopes |
| `client.ts` | `createNativeClient`, `NativeClient`, `NativeClientError` and `NativeSubscription`; parsed HTTP/SSE, deadlines and submission correlation |
| `state.ts` | `createNativeStore`, `NativeStore`, `NativeStateError` and external store state; selection, hydration, event reduction and mutation ledger |
| `OmoApp.tsx` | Native shell, project/directory/session selection, Chat/Files/Changes/Terminal tabs and panels |
| `AuthGate.tsx` | Same-origin password login before workspace initialization |
| `AppearanceProvider.tsx`, `appearance/` | Native appearance settings and semantic theme/font/density application |
| `chat/` | Active-branch transcript, live content/tools, composer/model controls and native dialogs |
| `panels/` | Goal/task controls and read-only todo/DAG views |
| `workbench/` | Directory-scoped files/editor, changes/staging/worktrees and actual PTY transport |
| `desktop/adapter.ts` | `NativeDesktopBridge`, `NativeDesktopCapabilities`, `createNativeDesktopCapabilities`; per-operation IPC reply parsing |
| `desktop/context.ts` | `NativeDesktopContext`, `useNativeDesktop`; optional capability outside client/store contracts |
| `desktop/notifications.ts` | `useNativeRequestNotification`; session/interaction-scoped pending notification ledger |

The settled `OmoApp` props are:

```ts
{ readonly client?: NativeClient; readonly store?: NativeStore }
```

It creates and disposes its own store when none is supplied. A caller that injects a store owns that store's disposal. Keep `NativeClient` and `NativeStore` as the existing return-type contracts; components receive these dependencies rather than creating parallel native adapters.

`NativeClient` provides status/hosts/projects/sessions/settings reads, project/settings updates, create/attach/snapshot, execute/respond, task output and subscribe. `NativeStore` exposes `getState`, `subscribe`, `selectSession`, `reconnect`, `refresh`, `execute`, `respond`, `resetRuntime` and `dispose`.

`NativeSubscription.ready` resolves when the HTTP stream opens, before snapshot hydration. `done` rejects on stream loss or invalid data and resolves on deliberate close. The client uses fetch SSE with the runtime auth helpers; no implicit EventSource mutation retry or credential-bearing socket URL is hidden in this layer.

## Hydration, reconnect and continuation

1. Select a session and subscribe before attach/snapshot reads.
2. Buffer events during hydration, commit the parsed snapshot, then apply buffered events not already represented.
3. Accept only the current runtime, selection generation, session key, connection epoch and revision.
4. Resnapshot on an event gap or new epoch. Failed reads keep the prior snapshot and expose failure.

Snapshots carry schema version 1, the opaque session key, durable conversation ID, ownership, connection, native session state, active branch, work projections and pending interactions. Socket paths, native routing handles, store roots and provider credentials aren't browser contracts.

History is the root-to-leaf active ancestry, not every append-order record. The codec rejects missing or cyclic ancestry. Persisted entries and live content reconcile by identity; rendered persisted tool results replace their live counterpart. Native `agent_settled`/`agent_idle` owns idle state, not a low-level turn-end event.

After reload, select the same native session to restore its active history and continue through its native owner. This is linear continuation. There is no branch selector, rollback, OpenCode history migration or dual-engine operation.

Transport recovery may reopen reads and subscriptions. It never automatically replays a prompt, goal action, task control or interaction answer. Detach marks outstanding submissions uncertain. An HTTP `202` records acceptance; a correlated command result settles it. Inspect native history/state before deciding whether to submit new work after an uncertain result.

Runtime changes reset the store and appearance scope, including an A-to-B-to-A change. `dispose()` aborts and closes the owned subscription and awaits its reader cleanup; it doesn't stop the backend or native host.

## Native controls and work state

Writable controls require a ready, connected, selected hosted session. Terminal-owned sessions remain read-only; an offline session must safely attach before mutation. Backend ownership checks remain authoritative even if a control is visible.

The composer supports prompt, steer/follow-up while busy, abort and native model/thinking selection. It doesn't invent optimistic assistant output or completion. `NativeDialogs` is mounted outside the tab content so select/confirm/input/editor/question requests remain answerable while viewing files or terminals. Stale or already-submitted interaction IDs are refused. Browser reconnect can recover adapter-held dialogs; generic dialogs can't be recreated after adapter/native transport loss.

OMO owns goals and all native work. The goal panel requires the extension-owned `goal` command and a ready goal projection. It exposes set/replace/pause/resume/clear, not manual complete/blocked. Native replacement dialogs and sidecar confirmation belong to the backend. Pausing a goal doesn't abort a running turn.

Task output/send/cancel is scoped to the selected durable parent. Todo and DAG panels only display native state. Persisted task status is labeled recorded; it isn't proof that a task is currently executing.

Every work projection is `ready`, `incomplete` or `unavailable`. Partial/failed projections may retain their last valid values. Only an authoritative ready empty value presents an empty state. A failed task-output read keeps prior output with a retained-data notice. See [backend authority and recovery](../../../web/server/lib/omo/DOCUMENTATION.md) for the native read-only sources.

## Local workspace and appearance

The selected registered project or worktree scopes files, Git and terminals. Workbench controllers use explicit local routes and runtime URL/auth helpers. They reuse the editor, diff renderer and `TerminalViewport`, without importing legacy `GitView`/`TerminalView` session stores.

Files support browsing, editing and explicit save. Changes expose status, working/staged diffs, stage/unstage and app worktree creation/removal. Terminals use real PTYs and authenticated WebSockets with attach, resize, input and close. Backend stop owns PTY shutdown; browser unmount closes its subscriptions without claiming native host ownership.

Appearance hydration doesn't write defaults. Explicit settings writes are serialized and confirmed from the backend; failed reads/writes remain visible. The shell exposes light/dark/system selection. The appearance contract also carries font and compact/comfortable density settings. Custom theme import/deletion is unavailable.

## Desktop consumers

`initializeNativeDesktopCapability` returns parsed desktop methods when the trusted preload exists; otherwise the context is `undefined`. Browser-only use has no native controls or notification calls, while typed project registration, file editing and pending responses remain available. Desktop capability doesn't change `NativeClient`, `NativeStore` or public component props.

`ProjectSidebar` calls `selectFolder` from the add-project form. Selection updates the path draft without registering anything; explicit submit still owns registration. Cancel or refusal preserves path/name drafts. Picker failures use localized native error copy.

`NativeFiles` calls `selectFile` with the selected project/worktree directory as its default. Cancel, refusal and directory return preserve unsaved drafts; an inactive scope ignores a late picker result. The registered-directory client still owns file reads, and a refused read restores the prior selected document. `openPath` and `revealPath` pass the currently loaded file path unchanged to main, which enforces native selection grants and frame/symlink checks.

`NativeDialogs` calls `notify` for writable pending human requests, including questions while another tab is active. Its non-persisted session/interaction ledger reuses one invocation across StrictMode replay, locale changes and pending-request revisits, and prunes resolved requests. Unsupported or rejected delivery shows an alert without blocking answers or dismissal.

Unit/browser fixtures cover these consumer paths. Successful fixture replies and responsive captures aren't native OS delivery or window proof. See the [Electron README](../../../electron/README.md#verification-limits) for remaining OS and platform limits.

## Runtime scope and validation

Local browser and local Electron use this same application. Responsive layout isn't native-mobile packaging or remote access. VS Code, Capacitor/native mobile, remote/SSH/tunnel/relay/pairing, updater workflows, multi-run/fusion/scheduling and advanced OpenCode settings are deferred.

For executable UI changes, use the existing isolated runner, `node scripts/run-isolated-tests.mjs packages/ui/src/omo`, and owning UI/web checks. Subscribe to state/events before test actions; use bounded event deadlines, not fixed sleeps. Rendered/browser evidence is required for UI behavior, and OS captures are required for native desktop claims.

Documentation-only changes need narrow link/syntax review and documented command checks, not prose-pinning tests or another UI build.
