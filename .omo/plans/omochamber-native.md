# omochamber-native - Work Plan

## TL;DR (For humans)

Build OmoChamber as a native OMO workspace using the existing installed OMO 5.1.6 and Senpi 2026.9.30. Keep chat, projects/sessions, files/diffs/basic Git/worktrees, terminal, themes/layout and local Electron. Native OMO owns all goals and execution.

Use separate native server/browser/Electron entrypoints and reuse lower-level OpenChamber services/primitives. Keep legacy OpenCode code dormant and testable; it must not initialize from native startup. No OMO rebuild/install/change, companion extension, app-server, experimental CBOR transport, dual-engine facade, history migration, branch navigation or rollback.

Effort: XL. Execute three phase-specific mass-ulw DAGs with disjoint producers and an all-producer verification node per phase. The parent owns integration, native/browser/desktop QA, cleanup, review, signed Conventional Commits and push. No PR or merge is requested.

## Scope

### Affected user and ideal state

The user is switching from OpenChamber/OpenCode to native OMO and wants the retained workspace UI to drive the same native tools/configuration/providers.

| ID | Ideal state | Delivering tasks |
|-|-|-|
| IS-1 | Installed OMO starts/attaches without preparation, build, upgrade or an OpenCode controller/process. | 1, 2, 4, 11, 12 |
| IS-2 | Actual native chat streams, restores active-branch history and continues after reload without duplicate accepted input. | 2, 5, 6, 7, 11 |
| IS-3 | Native questions/permissions/replacement dialogs can be answered once and recover across browser reconnect. | 2, 5, 7 |
| IS-4 | Native task/DAG/todo/goal state is visible on initial/reconnect attachment. OMO alone continues goals. | 2, 3, 5, 8 |
| IS-5 | Projects/sessions, files/editor, Git diff/worktrees, real terminal, appearance and local desktop work. | 4, 6, 9, 12 |
| IS-6 | Deferred workflows are not exposed as broken controls. | 6, 10, 11, 12, 14 |
| IS-7 | GUI disconnect preserves retained work and foreign hosts; secrets and socket access stay server-side. | 1, 2, 4, 5, 12 |
| IS-8 | Runnable identity is OmoChamber; verified commits reach the requested fork without changing remote main. | 13, 14, F4 |

Gaps: legacy startup constructs OpenCode lifecycle/goal/scheduler services; legacy UI takes an OpenCode SDK; native pending dialogs need mapping; arbitrary extension snapshots are not guaranteed to replay; native initial inventories need read-only recovery; retained tools have old directory/store dependencies; product entrypoints/branding/remote still point upstream.

### Must have

- Native JSONL protocol version 1 over local sockets, using the immutable existing installation.
- Native-host discovery including shards; attachment to the actual owner; a dedicated OmoChamber host for new sessions.
- Normal active-branch history/continuation, streaming/tool output, abort, model/thinking selection, questions and permissions.
- Native goal set/replace/pause/resume/clear, native task output/send/cancel, read-only DAG/todo panels with initial/reconnect hydration.
- Reused lower-level files/Git/worktrees/terminal and semantic UI tokens/primitives.
- Responsive local browser and local Electron. Electron starts the native web server in-process.
- Existing local data and upstream license notices preserved.
- Origin git@github.com:e-n-0/omochamber.git and branch flavien.darche/omochamber-native; signed Conventional Commits and push.

### Must NOT have

- OMO/Senpi rebuild, modification, installation, preparation or upgrade.
- App-server, experimental CBOR client, guessed native handlers, a second goal loop/accounting system, duplicate native store writer, or model-powered state polling.
- Branch navigation/rollback, OpenCode history migration, dual-engine product support.
- Reachable VS Code/native-mobile release flows, relay/pairing/tunnels/SSH, multi-run/fusion/scheduling, advanced OpenCode configuration editors, isolated spaces or GitHub/Linear orchestration.
- Native task/DAG store construction, journal repair/replay, lock/lease acquisition, checkpoint writes, or cleanup of foreign native hosts.
- New dependencies, mass deletion of legacy source, force push, rewriting destination main, or unrequested PR.

### Runtime decisions

| Runtime | Outcome |
|-|-|
| Local web | Native application and backend, loopback listener, existing auth/origin gates |
| Local Electron | Same backend in-process, local window/folder/file/notification lifecycle |
| Responsive browser | Same native application at desktop and phone widths |
| VS Code | Deferred, not selected by native startup/build |
| Capacitor/native mobile | Deferred, not selected by native startup/build |
| Relay/remote/SSH | Deferred, no native UI controls or listeners |

## Verification strategy

HEAVY: a new integration and session/streaming/security boundary. Tests follow existing owning runners, with event subscriptions before triggers and bounded deadlines; no fixed sleeps, prose pinning, skipped tests or weakened assertions.

Baseline already captured before source changes: 9 auth tests and 48 Git/terminal tests pass after `bun install --frozen-lockfile` restored missing declared `jose`. Worktree remained unchanged. OMO was not installed/rebuilt.

Each producer reads nearby tests/docs/skills and owns its tests. Run diagnostics before builds. Phase verification is independent of producer claims. Parent executes real browser/desktop/native QA and inspects captures. The native plan-reviewer gate refused this request because no explicit ulw-plan workflow was invoked. Record the required source-backed plan self-review rather than bypassing that gate. Independent phase verifiers and a fresh implementation reviewer still evaluate the actual changes and evidence; no plan-reviewer approval is claimed.

Evidence root: `.tmp/omochamber-evidence`, ignored by the existing `.gitignore`. QA resource directories are separate temporary directories. Every scenario records exact invocation, PASS/FAIL, source revision, screenshots/action log or HTTP headers/body, and owned-resource cleanup receipt.

Final applicable checks:

```sh
bun run --cwd packages/web test server/lib/omo server/native.test.js
node scripts/run-isolated-tests.mjs packages/ui/src/omo
node scripts/run-isolated-tests.mjs packages/electron/omo
bun test packages/web/server/lib/ui-auth/ui-auth.test.js
bun run --cwd packages/web test server/lib/git/routes.test.js server/lib/terminal/runtime.test.js server/lib/terminal/terminal-ws-protocol.test.js server/lib/terminal/shutdown.test.js
bun run type-check
bun run lint
bun run build
bun run dead-code
```

Run `bunx oxlint` on exact authored/substantially rewritten JS/TS paths. Inspect the non-blocking dead-code report; leave pre-existing dormant-source findings identified, not suppressed or mass-fixed.

## Execution strategy

### Source roots and authority

- C: /Users/en0/Documents/openchamber
- O: /Users/en0/.bun/install/global/node_modules/omo-ai
- R: /Users/en0/.omo/agent/runtime/6ed61b8c440e75f7-a87b340a60f5
- N: O/plugin/extensions/omo-task.js, minified line 2; cited byte ranges below locate its source contracts.
- Prior audit: /Users/en0/docs/research/senpi-openchamber-contracts.md
- Approved scope/decisions: .omo/drafts/omochamber-native.md
- Notepad: /var/folders/qm/075ylgw94r5frj4nb_n9gxd80000gn/T/ulw-20261001-005615.XXXXXX.md.24ahF1nppU

### Frozen native control contract

Protocol/capability negotiation precedes attachment. Required host capabilities: multi_session, extension_events, session_context, session_kind; retention and prompt surface are separately negotiated. Native correlation ID, live routing handle, durable conversation ID and host instance ID are distinct.

Use `get_protocol_info`, `set_client_info` with extension_events/question, `list_sessions {include_workers:true}`, `open_session {sessionPath,retain_on_disconnect:true}`, `get_state`, `get_entries`, `get_available_models`, `get_commands`, `set_model`, thinking commands, prompt/steer/follow_up/abort/set_session_name, extension_request and extension_ui_response. Do not advertise media_placeholders while this version consumes inline image blocks; that optional native capability changes tool/history payloads to image_ref and requires an on-demand media consumer.

New sessions use a server-generated durableSessionId, cwd, kind interactive, auto_title false and retention true. Do not change promptSurface on foreign attachment. Never open a second writer against a terminal-owned transcript; terminal sessions are visibly read-only.

Start a missing dedicated app endpoint with the installed engine, not the OMO preparation launcher:

```sh
bun "$R/dist/cli.js" host ensure --launch-spec "$O/plugin/daemon-launch-spec.json" --policy never --socket "$OMOCHAMBER_DATA_DIR/omo.sock" --json
```

Resolve R/O from the existing installed executable/runtime metadata, with explicit configuration when needed; do not hardcode this workstation's paths into production. Reproduce the native environment/branding from O/bin/lib/launcher.js:37-62,99-117 and load the unchanged launch spec. No fallback download/build. On app shutdown disconnect retained attachments, never stop a shared native host.

Goal controls first require `get_commands` to report `goal` with source extension. Send `/goal <objective>`, `/goal pause`, `/goal resume`, `/goal clear` through prompt with command expansion enabled and unknownCommandAsText false. Reject blank/reserved-word objectives. Replacement may ask a select dialog. Handled acknowledgment is not mutation success; observe the resulting sidecar. Pause does not abort. No manual complete/blocked action.

Task controls:

- omo.task.output: `{task_id, mode?:status|tail|full, tail_lines?:integer 1..1000}`
- omo.task.send: `{to:task_id, message:nonblank <=32000}`
- omo.task.cancel: `{task_id, reason?:<=2000}`

Native handlers enforce selected-parent ownership; no cross-owner override.

### Frozen application API

All routes use existing auth and origin checks. Browser never supplies socket paths, native store roots or host handles.

```text
GET /api/omo/status
GET /api/omo/hosts
GET /api/omo/projects
POST /api/omo/projects
PATCH /api/omo/projects/:projectId
DELETE /api/omo/projects/:projectId
GET /api/omo/sessions?projectId=...
POST /api/omo/sessions
POST /api/omo/sessions/:sessionKey/attach
GET /api/omo/sessions/:sessionKey/snapshot
GET /api/omo/sessions/:sessionKey/events
POST /api/omo/sessions/:sessionKey/commands
POST /api/omo/sessions/:sessionKey/ui-responses
GET /api/omo/sessions/:sessionKey/tasks/:taskId/output
GET /api/omo/settings
PATCH /api/omo/settings
```

`status` exposes sanitized native availability/protocol/capabilities, never credentials or environment. Create session accepts `{requestId,projectId,worktreePath?,name?}` and validates canonical cwd server-side. Browser sessionKey is stable, opaque and resolves to server-owned native binding.

Commands use `{requestId,connectionEpoch,command}` with discriminants prompt/steer/followUp/abort/rename/setModel/setThinking/goalSet/goalPause/goalResume/goalClear/taskSend/taskCancel and their explicit values. Reject obsolete epochs before forwarding. Return 202 for submission, then a correlated result through SSE; no automatic mutation replay after uncertain disconnect.

Snapshot fields: schemaVersion 1, sessionKey, durableSessionId, connectionEpoch, monotonic revision, ownership hosted/terminal/offline, connection connected/reconnecting/unavailable, sanitized native state, active branch `{leafId,entries}`, goal/todo/tasks/dags projections, and `pendingInteractions`. Projection is ready/incomplete/unavailable with last valid value when known; failure is not empty success. Pick public fields rather than forwarding native private records wholesale.

Freeze public view names in contracts.ts: NativeSessionView carries directory/name, streaming/compaction/bash/retry state, projectTrusted, selected `{provider,id}` model/thinking and sanitized availableModels/availableThinkingLevels/commands. PendingInteraction is discriminated by native method select/confirm/input/editor/question, with request ID, rendered title/options/questions, and deadline information when native supplies it. GoalView keeps native objective/status/counters/times/blocked information. TaskView maps task_id to taskId, native status/residency/model/name/task_summary/description/category/child_session_id/times/output/error to explicit camelCase fields and marks persisted versus live source. DagView exposes runId/name/status/generation/lastSeq, projected nodes/edges/waves/counts. Unknown native/private fields do not flow through.

Frontend `contracts.ts` is the application wire-codec/type owner. Backend JS projections follow this frozen shape and round-trip fixtures must parse with that codec. No new contracts workspace.

SSE events carry sessionKey, connectionEpoch and revision: snapshot, native event, correlated command result, connection state. Subscribe/buffer before hydration; commit snapshot then buffered events not represented. On a replay gap send a fresh snapshot. Old-session/old-host results cannot replace current state. Preserve pending interactions across browser reconnect; after adapter-process loss do not fabricate unrecoverable generic-dialog answers.

### Authoritative read-only projections

Goal: R/dist/core/extensions/builtin/goal/store-ref.js:4-16 and persistence.js:18-26,198-225. Use pure `readGoalFile(ref)` where available, never migration/store mutation functions. Path is dirname(canonical sessionPath)/extensions/goal/encodeURIComponent(durableSessionId).json. Schema `{version:1,goal:null|record}`; status active/paused/blocked/complete; counters/timestamps nonnegative safe integers in Unix seconds; blocked requires reason/time. Watch containing directory for atomic replacement. Missing is null; invalid/version/read failure is unavailable.

Todo: native get_entries returns all append-order entries and leafId. Follow parentId from leaf, reverse root-to-leaf, then call pure native todo-storage.js `getLatestTodoStateFromBranchEntries`. Missing ancestors/inconsistent leaf is incomplete. Canonical customType senpi.todo-state has schema v2, phases `{name,tasks:[{content,status:pending|in_progress|completed|abandoned}]}`, optional ask. Native reducer also accepts supported legacy/toolResult forms; latest valid payload wins, including authoritative empty. Do not add GUI promotion. References: R/dist/modes/rpc/connection-handler.js:1228-1238 and todotools/todo-storage.js:5-78,106-137.

Tasks: prefer absolute roots registered in shard sibling meta.json stores. Otherwise resolve native task.state_dir with the owning native configuration/launch directory; never resolve foreign relative paths against server cwd. Default existing project .omo/senpi-task wins before agentDir/projects/sanitizedBasename-sha256(realpathProject).slice(0,12)/senpi-task. Unresolved/conflicting roots are incomplete. Current inventory is tasks/*.json, not temporary files or expunging tombstones. Filter exact parent_session_id === durableSessionId; task_id is identity.

Consumed task fields include parent/root IDs, depth, status pending/running/completed/error/cancelled/interrupted/lost, residency state, model, ISO timestamps, notification epochs, optional name/summary/description/category/agent/child ID/final response/error. Do not forward execution/isolation/steering/private metadata. Persisted running is recorded state, not live execution proof. Live omo.task.updated supplements it; truncated 256-record snapshots cannot delete omitted records. One partial/unreadable record preserves its prior good projection and does not erase other tasks. References N:2 bytes 294465-310600,322237-324850; O/plugin/runtime/task-config/index.js:63 bytes196162-205429.

DAGs: taskRoot/dag/runs/runId.json and events/runId.jsonl. Checkpoint schemaVersion 1, checkpointSeq, run/parent/root IDs, name/key/generation, status pending/running/paused/completed/failed/cancelled, ISO times, nodes/edges/waves. Node states pending/blocked/scheduled/running/completed/failed/cancelled/skipped. Filter exact parentSessionId. Native snapshot lastSeq maps checkpointSeq.

Read complete LF journal records only. Journal head equal checkpointSeq means covered; ahead means recovery pending; checkpoint ahead/inconsistent means incomplete. Preserve each run independently on error. Do not run a journal reducer. The native store constructor truncates/repairs journals and refresh can advance checkpoints, so NEVER instantiate it. Consume native DAG events as invalidations/live projections; capped snapshots cannot delete omissions. References N:2 bytes777495-784500,794800-796700,799782,808506-809600,850700-852900.

Watch before enumeration/read, serialize refresh per owner, reject stale generations, and preserve valid data on failure. No writer locks, repair, pruning or lease claims.

### Graph topology and scopes

One run per phase. Task prompts read this plan and owning docs/skills, specify exact exclusive scope, own tests, use apply_patch, and return bounded evidence. No commits by children. Parent commits/pushes each verified phase. Contracts do not change independently; a required contract change returns to parent and updates the plan before dependent work.

- Phase 1: a quick runtime-resolver producer owns installed-runtime.js/tests; a deep-low transport/discovery producer owns host-client.js/discovery.js/tests; projections and native-client producers run independently where their inputs are fixed. Session integration waits for transport/projections/contracts; local-server integration waits for session APIs. The verifier waits for every producer/integration node. The quick resolver is a safe mechanical split of task 1, not another architecture lane.
- Phase 2: shell, chat, panels and workbench disjoint UI producers; locale writer owns all central dictionaries; web cutover waits for all UI/locales; verifier waits for all.
- Phase 3: desktop, branding and documentation disjoint producers; verifier waits for all.
- Parent final QA/review/publishing is not delegated away.

## Todos

- [ ] 1. Implement existing-runtime resolution and native JSONL transport/discovery.
  - Recommended task executor category: deep-low; cohesive native transport/ownership logic.
  - Scope: web/server/lib/omo/{installed-runtime,host-client,discovery}.js and colocated tests. Split installed-runtime.js into a quick lane with disjoint ownership; transport/discovery remain deep-low.
  - References: R/docs/rpc.md:82-232,398-425,663-704; R/dist/modes/rpc/{connection-handler,host-launch-spec}.js; O/bin/lib/launcher.js.
  - Acceptance: existing installation only; split/coalesced LF frames and interleaved events correlate correctly; deadlines/disconnect reject pending calls; no replay; discovery includes shards and validates ownership/capabilities.
  - Happy/failure QA: real dedicated host handshake; malformed/split frames, wrong capability and dead socket tests. Evidence .tmp/omochamber-evidence/foundation/transport.
  - Commit: part of verified native-foundation increment.

- [ ] 2. Implement session service, safe hydration and authenticated native routes.
  - Recommended task executor category: deep-low; session-generation/snapshot and HTTP lifecycle cross module.
  - Scope: web/server/lib/omo/{session-service,routes}.js and tests; native QA script scripts/qa/omochamber-native.mjs. Depends on 1, 3 and 5.
  - References: frozen API/control contract; native session-command-router.js:440-549; session-event-fanout.js:55-69,128-166; existing ui-auth/request-security modules.
  - Acceptance: owner attachment/create/reopen, status/snapshot/SSE/commands, dialogs, native goal actions and task controls; retained disconnect; no socket/credential leakage; terminal-owned read-only; native response uncertainty visible.
  - Happy/failure QA: native create/continue/late attach; unauthorized 401, foreign origin 403, malformed 400, stale epoch 409, failed read preserves prior state; no duplicate command replay.
  - Evidence: foundation/native-http, late-attach, security.
  - Commit: native-foundation increment.

- [ ] 3. Implement immutable native layout and authoritative state readers.
  - Recommended task executor category: deep-low; native persistence consistency without writer ownership.
  - Scope: web/server/lib/omo/{native-layout,projections}.js, fixtures/tests.
  - References: authoritative projection contracts and exact installed sources above.
  - Acceptance: goal/todo/task/DAG recovery on late attach; valid empty versus invalid/missing distinctions; exact parent isolation; no native reader writes; partial records and journal gaps preserve unrelated state.
  - Happy/failure QA: fixture snapshots from native formats, active/abandoned branch, atomic goal replacement, truncated task snapshot, DAG lag/trailing fragment; compare resource tree before/after reads.
  - Evidence: foundation/projections.
  - Commit: native-foundation increment.

- [ ] 4. Compose native server, retained local services/settings and CLI.
  - Recommended task executor category: deep-low; native startup, local capability/auth and shutdown boundary.
  - Scope: web/server/native.js, lib/omo/{local-services,settings}.js, web/bin/omochamber.js, tests; optional Git SDK import adjustment only.
  - References: fs/routes.js registration, git/routes.js:25-71, terminal/runtime.js:94-119, ui-auth and bind-host security; frozen NativeServerHandle.
  - Acceptance: native server serves assets/APIs and loopback-only local tools; validated settings/project persistence; actual PTY transport; worktree deletion refused when in use; stop cleans owned PTYs/server but not shared native host. No legacy import.
  - Happy/failure QA: live status/health, file read/write containment, Git diff/worktrees, terminal socket auth/origin, partial startup shutdown.
  - Evidence: foundation/local-server and workspace.
  - Commit: native-foundation increment.

- [ ] 5. Implement typed native browser contracts, API client and state lifecycle.
  - Recommended task executor category: deep-low; request/snapshot/SSE and selection race invariants.
  - Scope: ui/src/omo/{contracts,client,state}.ts and tests; no UI components or central locales.
  - References: frozen application API, runtime-fetch/runtime-url existing helpers, sync-state-invariants.
  - Acceptance: precise parsed contracts; request correlation/epochs; subscribe-before-snapshot, reconnect resnapshot, preservation on read failure, selected-session isolation; never automatic mutation replay.
  - Happy/failure QA: owning isolated tests for response fidelity, snapshot/delta ordering, stale selection, failed reads, command uncertainty and pending-question recovery.
  - Evidence: foundation/native-client.
  - Commit: native-foundation increment.

- [ ] 6. Build the native application shell, navigation and appearance.
  - Recommended task executor category: visual-engineering; shared UI layout and responsive navigation.
  - Scope: ui/src/omo/{OmoApp,AppearanceProvider,ProjectSidebar,SessionSidebar}.tsx, native layout CSS/tests.
  - References: task5 exports; shared theme tokens/primitives/icons and locale skill.
  - Acceptance: project/session add/select/rename/reopen; native connection state; reachable Chat/Files/Changes/Terminal and panels; theme/font/layout persistence; no legacy App/SyncProvider imports.
  - Happy/failure QA: desktop/mobile snapshots, empty projects, connection error and session switching without discarded pending interactions.
  - Evidence: web/shell.
  - Commit: native-web increment.

- [ ] 7. Build native chat, model controls and pending interactions.
  - Recommended task executor category: visual-engineering; real chat rendering and form interactions.
  - Scope: ui/src/omo/chat/** and tests.
  - References: task5 contract/state; lower-level Markdown core; native extension UI request forms.
  - Acceptance: source-backed history and streaming text/reasoning/tool calls/results; composer data-testid omo-composer/omo-send; abort/model/thinking; select/input/confirm/editor/question responses; no invented optimistic completion; uncertain send visible; terminal-owned read-only.
  - Happy/failure QA: native sentinel chat/reload/continuation, structured question, permission/replacement select and stale/resolved request rejection.
  - Evidence: web/chat and controls.
  - Commit: native-web increment.

- [ ] 8. Build native goal/task/DAG/todo panels.
  - Recommended task executor category: visual-engineering; native state/action presentation.
  - Scope: ui/src/omo/panels/** and tests.
  - References: goal/native task commands and projection semantics above.
  - Acceptance: authoritative/incomplete/unavailable visible; native goal set/pause/resume/clear, task output/send/cancel; read-only todo/DAG; recorded status not misrepresented as live; replacement native dialog supported.
  - Happy/failure QA: initial and reconnect late-attach inventory, real goal action, task output/cancel, incomplete/malformed projections retaining last good state.
  - Evidence: web/panels and late-attach.
  - Commit: native-web increment.

- [ ] 9. Integrate retained files/editor, Git/diffs/worktrees and terminal.
  - Recommended task executor category: visual-engineering; real workspace UI and lower-level tool rendering.
  - Scope: ui/src/omo/workbench/** and tests.
  - References: native local-service routes; CodeMirror/diff renderers/TerminalViewport existing implementations.
  - Acceptance: scoped directory state from native selected project/session; files edit/save, Git status/diff/basic stage/worktrees, actual PTY attach/resize/reconnect/close; no old GitView/TerminalView store imports.
  - Happy/failure QA: edit qa.txt and verify bytes/diff; worktree lifecycle; terminal printf marker; missing directory and terminal auth failures visible.
  - Evidence: web/workspace and terminal captures.
  - Commit: native-web increment.

- [ ] 10. Localize native UI and verify consistent visible copy.
  - Recommended task executor category: writing; central dictionary ownership and actual translations.
  - Scope: ui/src/lib/i18n/messages/* only plus owning locale tests if machine keys require them. Depends on 6-9.
  - References: locale-ui-patterns and communication-style; all new component t() keys.
  - Acceptance: every used native key exists in every locale with genuine translations; product names literal; no shared dictionary races or untranslated key labels.
  - Happy/failure QA: locale switch preserves selected session/input; desktop/mobile text fits; missing-key checker passes.
  - Evidence: web/locales.
  - Commit: native-web increment.

- [ ] 11. Cut web/default server startup over to native application.
  - Recommended task executor category: deep-low; cross-workspace entrypoint and runtime isolation.
  - Scope: web/src/{omo-main.tsx,omo-runtime.ts}, web/index.html/vite.config.ts, server/{index.js,index.d.ts,legacy-opencode.js}, dev launch wiring, legacy-test import path adjustments; browser QA script scripts/qa/omochamber-browser.mjs. Depends on 6-10.
  - References: web/src/main.tsx/runtimeConfig.ts, ui/src/main.tsx, web/server/index.js/index.d.ts.
  - Acceptance: native default and HMR/built UI; dormant legacy implementation only explicitly imported by existing tests; no legacy UI/runtime restoration/controllers; safe same-origin native auth and runtime URLs.
  - Happy/failure QA: built/HMR native sentinel workflows, no OpenCode launch/request, unauthenticated/malformed responses, browser reload/session switch.
  - Evidence: web/startup, chat, controls, layout.
  - Commit: native-web increment.

- [ ] 12. Implement local native Electron entrypoint and ownership.
  - Recommended task executor category: deep-low; inherently native window/preload and in-process lifecycle.
  - Scope: electron/omo/{entry,main,preload}.mjs, tests, native launch/bundle scripts, electron/package.json and Electron QA script scripts/qa/omochamber-electron.mjs.
  - References: desktop-shell, existing Electron lifecycle/privilege conventions, NativeServerHandle.
  - Acceptance: local native window with in-process server, folder/file actions/notifications, isolated preload gated to app; separate OmoChamber app identity/data; no legacy SSH/update/OpenCode bootstrap or native engine packaging; quit cleans owned server/PTys while retained native work remains.
  - Happy/failure QA: actual OS-level HMR/bundled launches and screenshots, folder selection and quit; rejected foreign IPC; partial startup cleanup.
  - Evidence: product/electron-hmr and electron-bundled.
  - Commit: native-desktop increment.

- [ ] 13. Rebrand runnable product and default build/CLI paths.
  - Recommended task executor category: unspecified-low; mechanical product changes across known manifests/scripts.
  - Scope: root/web manifests/scripts, web public manifest/branding assets and CLI branding checks; no Electron manifest overlap.
  - References: existing package scripts, native entrypoints, user-approved product identity.
  - Acceptance: CLI/window/manifest/documentation identify OmoChamber; default build targets UI/web/local Electron, not deferred package release flows; no OMO build/install or staged OpenCode binary; retain internal workspace names where useful.
  - Happy/failure QA: actual CLI help/start and built app title; script execution doesn't invoke forbidden engine preparation.
  - Evidence: product/branding.
  - Commit: native-product increment.

- [ ] 14. Document native ownership, setup and deferred boundaries.
  - Recommended task executor category: writing; concise owning documentation.
  - Scope: root/web/Electron READMEs, native owning DOCUMENTATION.md and necessary root AGENTS native routing; no changelog.
  - References: implemented code, approved scope, communication-style/writing-for-agents.
  - Acceptance: existing OMO prerequisites, native CLI/run commands, ownership/persistence/recovery and explicit unsupported boundaries; preserve upstream/SUL notices and no misleading all-platform claims.
  - Happy/failure QA: run documented startup/help commands against final code; syntax/link review, no prose tests.
  - Evidence: product/docs.
  - Commit: native-product increment.

## Final verification wave

- [ ] F1. Verify each phase with actual commands before its downstream run.
  - Evidence-only verification node depends on every producer and integration node. Run native web tests, isolated native client/UI/Electron tests as applicable, diagnostics, typecheck and changed-path checks. Capture exit codes and every failure. No source repairs by verifier; parent routes failures to owners through existing run retry/amend.

- [ ] F2. Run parent-owned native/browser/desktop scenarios and cleanup.
  - Start dedicated task-owned QA host with existing R/dist/rpc-entry.js and unchanged OMO extensions. Never use the live orchestration shard. Unique QA cwd/state/shard root; manifest every resource.
  - Exact startup: `bun scripts/qa/omochamber-native.mjs --scenario startup --port 4317 --evidence-dir .tmp/omochamber-evidence/startup`.
  - Browser: `bun scripts/qa/omochamber-browser.mjs --scenario chat --base-url http://127.0.0.1:4317 --width 1440 --height 900 --evidence-dir .tmp/omochamber-evidence/chat`. Fill `[data-testid=omo-composer]` with `Reply with exactly OMOCHAMBER_QA_OK.` and click `[data-testid=omo-send]`; reload and send `Reply with exactly OMOCHAMBER_CONTINUE_OK.`. Both native responses appear once with preserved durable history.
  - Late attach: native script scenario late-attach creates real native goal/todo/task/two-node dependent DAG before GUI attachment; first GUI snapshot contains them without model refresh.
  - Controls: browser scenario controls exercises goal pause/resume/replacement, question/permission response, task output/send/cancel and cross-owner refusal.
  - Workspace: browser scenario workspace edits/saves qa.txt, reads bytes, observes Git diff/worktree lifecycle and renders `printf 'OMO_TERMINAL_OK\n'` through the actual terminal.
  - Layout: scenario layout at 1440x900 and 390x844, light/dark, every exposed tab/panel/dialog; inspect screenshots for blank/clipped/overlapping output.
  - Security/reconnect: native security and browser reconnect scenarios assert 401/403/400/409 boundaries, no secret exposure, no duplicate uncertain mutation, preserved failed-read state and retained work after GUI closure.
  - Desktop: `node scripts/qa/omochamber-electron.mjs --mode hmr` and `--mode bundled`, with evidence directories. OS automation/screenshots, not substitute HTTP proof.
  - Cleanup only manifest-owned sessions/processes/sockets/profiles/temp directories. Verify ports/processes gone. Evidence/notepad survive cleanup.

- [ ] F3. Run final broad checks and fresh criterion-based review.
  - Repeat applicable focused/broad commands on final changed inputs. No skipped tests/lint suppressions. Parent inspects full diff, diagnostics, all criteria and cleanup receipts.
  - Fresh reviewer reads this plan, diff, notepad and evidence; resolve criterion-cited blockers and rerun changed proof. Approval with only non-blocking notes is recorded with exact revision.

- [ ] F4. Publish verified commits and completion evidence.
  - Confirm no unrelated changes; signed Conventional Commits; push prefixed branch to requested origin without force/merge/PR. Completion audit maps every user decision, IS row and QA criterion to current evidence. Mark goal complete only after all tasks and resources are closed.

## Commit strategy

User explicitly authorizes commits through ultrawork and the fork request. Create flavien.darche/omochamber-native and change origin to git@github.com:e-n-0/omochamber.git after plan approval. Destination main already exists; do not replace it.

Commit plan and each independently verified buildable phase. Conventional Commits, signed. Inspect staged paths/full relevant diff before each commit. Retry Touch ID signing only per the user's three-attempt preference. No child commits, unverified WIP, force push or unrequested PR.

## Success criteria

| Criterion | Binary evidence | Ideal-state rows |
|-|-|-|
| SC-1 native startup | GET http://127.0.0.1:4317/api/omo/status is 200 with protocol/capabilities; process/import proof shows no OpenCode controller or spawned executable | IS-1, IS-6 |
| SC-2 native history/continuation | Real browser sentinel responses occur once; reload and continuation preserve durable session/history | IS-2 |
| SC-3 native interactions/panels | Actual native dialogs answered once; initial/reconnect goal/task/DAG/todo state recovered; goal controls mutate only native authority | IS-3, IS-4 |
| SC-4 retained tools/layout | Actual file/Git/worktree/PTY workflows pass and every exposed browser tab/panel/dialog fits desktop/mobile light/dark | IS-5, IS-6 |
| SC-5 boundaries/lifecycle | Invalid/auth/origin/stale epoch requests rejected; failed reads preserve data; GUI closure preserves retained work/foreign hosts; local Electron proof passes | IS-7 |
| SC-6 checks/publication | Applicable checks and review pass, cleanup receipts recorded, verified signed commits pushed to requested branch | IS-8 |

Stop immediately when all rows pass on the current code, all owned QA resources are cleaned, required review is approved, and verified commits are pushed. Runtime availability or a green suite alone is not completion.
