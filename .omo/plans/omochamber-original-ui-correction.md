# OmoChamber original UI correction

Date: October 1, 2026
Parent plan: `omochamber-native.md`

## Decision

The maintainer clarified: “Please use the normal openchamber UI? what's stopping you to use it? not all feature have to work right now on it, but the main ones only”.

Use the actual original OpenChamber presentation, not the separate native shell with similar geometry. Extract the existing rendering bodies into dependency-clean components, have the original wrappers consume those same components, and bind the native app to them. Preserve their semantic classes, icons, typography, spacing, editor and scrolling behavior.

`OmoApp` may remain the native data/lifecycle coordinator. It must render the shared original shell, navigation, chat and context components rather than its own parallel visual shell. Import the clean presentation modules directly; do not mount legacy controllers, create an OpenCode SDK facade, or introduce a live runtime switch.

The accepted native backend, NativeClient/NativeStore contracts, native workspace services, JSONL transport and installed OMO/Senpi build remain unchanged. Earlier headless proofs remain evidence for those unchanged mechanisms, not acceptance of the corrected UI.

## Main workflows

- Registered project/directory navigation, session selection and native session creation.
- Native history, streaming, continuation, prompt/steer/follow-up, stop, model and thinking controls.
- The existing native structured-question and permission owner.
- Files/edit/save, Git diff/stage/unstage/worktree operations and the real PTY terminal.
- Native goal/task/DAG/todo panels, with OMO remaining the sole work authority.
- Supported appearance controls and desktop capabilities already implemented.

Other original features may remain unavailable. Do not activate remote/SSH/relay, extensions, advanced OpenCode configuration, rollback/branch navigation, scheduling or deferred packaging to make their original controls work. Unavailable controls must not claim success or dispatch legacy actions.

## Shared presentation boundaries

### Navigation lane

Extract the existing header, sidebar and persistent titlebar-left controls into `HeaderView`, `SidebarView` and `TitlebarLeftControlsView`. Reuse `SidebarTopBar` unchanged.

Extract the original project header, directory header and grouped session row presentation into `ProjectHeaderView`, `DirectoryHeaderView` and `SessionRowView`. Preserve the original header picker, row selection geometry and supported plus/toggle actions. Do not implement optional tab ordering, badges or hierarchy that native summaries do not provide.

`omo/navigation/NativeNavigation.tsx` projects existing native projects/session summaries into display inputs and callbacks. Route selection through `sessionKey`; never substitute a durable history ID. Keep inventory fetching in the existing owner and preserve prior inventory on read failure. Views do not fetch, poll, probe folders or prefetch OpenCode messages.

### Chat lane

Share the original transcript/list/message presentation, markdown implementation, core composer/footer and model-picker presentation through four modules under `components/chat/presentation/`: `ChatTranscriptView`, `ChatMarkdownView`, `ChatComposerView` and `ChatModelControlsView`.

Reuse the actual `ComposerEditor` and send/stop chrome. Native adapters retain drafts, request correlation, uncertainty handling, history/live reconciliation, content validation and native busy send modes. Add synchronous per-intent guards for model/thinking/abort and regressions that demonstrate repeated interaction cannot issue different duplicate requests.

Use native roles/content directly; do not fabricate OpenCode messages, parts or forms. Keep markdown rendering separate from legacy filesystem probes, runtime actions and asset preparation. Keep the single existing native question/permission owner. Do not expand this phase into extraction of optional attachments, dictation, queue, form-dock or tool controllers.

The shell supplies surrounding chat-column/composer geometry and any work-status slot. Chat does not own work-status, context-panel or workspace state.

### Context and native work lane

Extract the actual context frame and rail into `ContextPanelFrame` and `ContextPanelRailView`. Extract the original work-status frame and store-free row/section vocabulary into `WorkStatusFrame` and `WorkStatusPresentation`.

Keep current native files/Git/PTY controllers. Add `NativeContextPanel` around one retained native workspace owner, with explicit visibility gating. Preserve the exported NativeWorkbench props; share its retained contents internally rather than mounting two workspaces. Closing or expanding the context panel must not lose drafts or close a PTY. Hidden tools must stop active subscriptions/effects.

Add `NativeWorkStatusPanel` around existing native goal/task/DAG/todo children. Preserve their selectors, ownership checks, action correlation, output epochs and recorded status. Keep sections as direct children of the original work-status scroller. Do not mount upstream work-status loaders or pass native section IDs through the upstream persisted registry.

### Parent shell

Extract the original `MainLayout` rendering frame into `MainLayoutView`, keeping controller state outside it. Mount the three lane adapters from the existing native coordinator. Preserve directory-scoped layout preferences, mobile overlay placement, original header/titlebar offsets, context expansion and the original floating-composer clearance.

Replace layout-specific `omo.css` rules that duplicate the original shell. Retain only styles genuinely owned by native-only content or bindings.

## Ownership and phase order

Run one mass-ulw workflow per phase. Independent producer paths are disjoint.

### Phase 1: shared original presentation and native adapters

| Lane | Exclusive write scope |
| --- | --- |
| Navigation | Original `Header`, `Sidebar`, `TitlebarLeftControls` wrappers; new layout views named above; original project/directory/session-row wrappers and their new views; `omo/navigation/`; adjacent navigation/view tests. |
| Chat | Original MessageList/ChatMessage/text/reasoning/markdown/composer/model wrappers required by the four shared views; those presentation modules; `omo/chat/NativeChat`, `NativeTranscript`, `NativeContent`, `NativeComposer`; their tests. Excludes ChatContainer geometry, dialogs, work-status, layout and workspace. |
| Context/work | Original ContextPanel/ContextPanelRail wrappers and their clean views; original work-status frame/primitives/visibility presentation; `omo/workbench/NativeWorkbench` and new NativeContextPanel; native panel presentation and new NativeWorkStatusPanel; their tests and owning work-status/views docs. Excludes workspace service/controller files and all navigation/chat-composer files. |
| Parent | MainLayout/MainLayoutView, OmoApp/native shell integration, remaining native CSS, native owning docs, QA drivers, this plan, final checks and publication. |

Each producer reads its matching skills and required references, keeps original wrappers consuming the shared extracted presentation, runs focused deterministic tests/diagnostics/changed-path oxlint, and reports exact edits and evidence. Producers do not use GUI, invoke providers, modify installed runtimes, commit, push or edit another lane's files.

A dependent read-only verification node inspects the combined producer changes for duplicate presentation, import leaks, authority regressions and ownership violations. Node claims are not acceptance; the parent checks the output.

### Phase 2: parent integration and non-GUI gates

After inspecting terminal producer results, the parent mounts the shared original shell and adapters. Read existing tests before updating stale layout/composer expectations; preserve their behavioral assertions.

Run focused native navigation/chat/control/dialog/panel/workspace tests plus new shared-view behavior tests. Prove exactly-once controls, retained drafts and hidden-tool inactivity. Exercise the native mount without legacy providers or SDK calls. Do not pin JSX, prose, component names or incidental wiring with tests.

Run applicable UI/root typechecks and lint, changed-path oxlint, native/product builds and dead-code inspection. Keep existing unrelated warnings explicit. A green build does not establish visual or native-provider acceptance.

No graphical QA until these gates pass.

### Phase 3: actual UI acceptance, review and publication

In the built browser, confirm the normal original shell and composer, native chat/reload/continuation, navigation and context tools. Inspect desktop/mobile and light/dark screenshots. Exercise original resize, close/expand and editor/PTY retention through the real surface. Use stable native QA hooks on the actual original editor, not a replacement textarea.

Run HMR and bundled local Electron proofs for the changed renderer. Reuse the existing signed task-owned Electron QA copy; never modify installed OMO/Senpi. Prior main/preload OS receipts cover unchanged pickers/notification/IPC mechanisms; repeat a mechanism only when a changed binding or failure warrants it.

Capture process/native-host ownership, actual actions, screenshots and cleanup. Recheck immutable installed-runtime fingerprints. Drain only proven owned hosts and remove only proven owned data/history/profile directories; preserve foreign work and evidence.

Create a fresh isolated review worktree at the final verified head, then run one implementation gate reviewer against the original goal and current UI evidence. Fix findings and revalidate affected behavior. Commit verified increments with signed Conventional Commits and push to the existing fork branch; no PR or merge is requested.

## Stop condition

The main workflows run through the actual shared original UI, native authority remains intact, non-GUI gates pass before graphical acceptance, actual browser/Electron evidence passes, review is clean, owned resources are cleaned and the verified signed head is pushed. Do not complete the existing goal on extraction, producer completion or the earlier lookalike-shell proofs.
