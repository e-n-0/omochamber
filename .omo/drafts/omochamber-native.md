# OmoChamber native fork - approved scope and planning state

## Request state

- intent: clear
- classification: architecture
- tier: HEAVY
- review_required: true
- status: architecture-design-in-progress
- approval: The user explicitly approved the audit's focused fork and instructed "Define first the plan of things that should be done, then mass ulw." This authorizes plan creation and subsequent execution without a second approval prompt.
- plan_path: .omo/plans/omochamber-native.md
- pending_action: Integrate the read-only planning result, write the complete plan, review it, then execute phase-specific mass-ulw runs.
- planner_task: st_01a0f48a
- plan_reviewer: pending, not dispatched before a complete plan exists
- goal_thread: 01a0f45c-a9cb-7457-a103-4fc06b9af5c7
- notepad: /var/folders/qm/075ylgw94r5frj4nb_n9gxd80000gn/T/ulw-20261001-005615.XXXXXX.md.24ahF1nppU
- baseline_commit: 405e90381

## Affected user and ideal state

The user currently runs OpenChamber against OpenCode plus the older OMO plugin. They are switching to native OMO and want OmoChamber to provide the retained workspace UI without recreating the native engine.

| ID | Ideal state | Reason |
|-|-|-|
| IS-1 | OmoChamber starts with the installed native OMO executable and loads its existing tools, configuration and credentials. No OpenCode process or controller starts. | The user selected native OMO and prohibited rebuilding it. |
| IS-2 | Browser chat shows actual streamed text/tool results, normal active-branch history and continuation. Reload or reconnect never resubmits accepted prompts. | This is the main coding workflow and must retain native persistence. |
| IS-3 | Pending questions and permission dialogs can be answered from the browser and recovered after reconnect. | The GUI must not strand a native turn waiting for input. |
| IS-4 | Task, DAG, todo and goal panels show native-authoritative state, including on late attachment. OMO alone owns goal continuation. | Existing native orchestration must remain authoritative. |
| IS-5 | Project/session navigation, files, working-tree diffs, basic Git/worktrees, terminal, theme/layout and local desktop remain usable. | These are the retained OpenChamber benefits the user approved. |
| IS-6 | Unsupported/deferred workflows are not exposed as broken controls. Native mobile/VS Code packaging, relay/pairing/tunnels/SSH, multi-run/fusion/scheduling and advanced OpenCode editors are deferred. | The user explicitly chose a simple native fork. |
| IS-7 | Closing the UI preserves retained native work and never kills a foreign host. App credentials and socket access remain server-side. | Shared host ownership and local machine access are real integration boundaries. |
| IS-8 | Runnable product identity is OmoChamber. Verified commits are pushed to the requested fork remote without overwriting its existing main. | The user authorized the fork and remote, not a history rewrite. |

## Gaps from the current checkout

- GAP-1: Current startup imports/initializes OpenCode lifecycle, goal and scheduling controllers.
- GAP-2: Current UI synchronization accepts OpenCodeClient and OpenCode-specific session/config shapes.
- GAP-3: Native JSONL pending UI requests need a browser mapping distinct from OpenCode forms/permissions.
- GAP-4: Arbitrary native extension inventories are not guaranteed to replay on attach. Core JSONL state has no structured goal snapshot.
- GAP-5: Existing local files/Git/terminal services can be reused, but their dependencies and browser ownership must be adapted.
- GAP-6: Existing default web/mobile/desktop entrypoints and packaging identify OpenChamber and can reach deferred features.
- GAP-7: Current remote points to upstream. Requested remote exists with a different HEAD; use a new prefixed branch without force push.

## Accepted decisions

- Existing installed OMO 5.1.6 / Senpi 2026.9.30 is immutable. Do not install, modify or rebuild it.
- Native JSONL host API only. No app-server, experimental CBOR client or dual-engine compatibility layer.
- Native OMO owns goal state and continuation.
- Normal active-branch history and continuation first. No branch navigation, rollback or OpenCode history migration.
- Browser components for tasks, DAGs, todos and goals are in scope.
- Preserve upstream licenses/notices and unrelated work.
- No new dependency unless a concrete requirement is separately authorized; reuse declared packages.
- Local web and Electron are supported. Responsive browser layouts are supported. VS Code/native mobile packaging and remote access are deferred.
- Test strategy: focused contract/regression tests beside owning modules, followed by real browser/native-host QA and applicable broader checks. No timing sleeps or prose-pinning tests.
- Publication: git@github.com:e-n-0/omochamber.git on flavien.darche/omochamber-native, with signed Conventional Commits. No PR or merge is requested.

## Verified bootstrap evidence

- Clean checkout on main at 405e90381; no source edits before planning.
- `omo --version`: OMO 5.1.6, engine Senpi 2026.9.30.
- `omo daemon status --all --json`: installed native hosts expose the required multi-session and extension-event contracts; task-tree shards exist. The live orchestration shard belongs to this coding session and is not app QA.
- `git ls-remote git@github.com:e-n-0/omochamber.git HEAD`: 56fbe4e3a9bf20d3c0c2599a8352592200abae4b.
- Pre-change auth tests initially found absent declared `jose`. `bun install --frozen-lockfile` restored only checkout packages and normal postinstall; tracked files stayed unchanged.
- Baseline after recovery: 9 auth tests pass; 48 Git/terminal tests pass; finite process exited 0.
- Omowright is staged and Google Chrome is installed. Use a task-owned browser profile for localhost QA; do not alter the user's main profile.
- Source audit with pinned native links: /Users/en0/docs/research/senpi-openchamber-contracts.md.

## Components and delegation

| Component | Outcome | Ownership |
|-|-|-|
| Native host | Safe JSONL transport, session ownership, persistence/history and authoritative projections | Cohesive backend lane, deep-low |
| Native browser | Chat, navigation, pending dialogs and task/DAG/todo/goal rendering | UI lanes, visual-engineering |
| Retained local tools | Files, Git/diff/worktrees and actual terminal integration | Disjoint retained-tool lane, mechanism-specific category |
| Product startup | Native-only server/web/Electron bootstrap and OmoChamber identity | Startup lane plus mechanical branding lane |
| Verification and publishing | Producer checks, real QA, cleanup, review and signed push | Verification node per graph; parent owns final QA/publishing |

Implementation DAG definitions are not created until the planner's source-backed contracts are integrated and the complete plan is reviewed. One workflow run covers one phase. A producer owns its change and tests; no parallel writers share files.

## Binding QA scenarios

- QA-1: Native server at 127.0.0.1:4317; GET /api/omo/status returns 200 with protocol/capability status and no OpenCode launch.
- QA-2: Fill [data-testid=omo-composer] with "Reply with exactly OMOCHAMBER_QA_OK.", click [data-testid=omo-send], observe actual native response. Reload and continue with OMOCHAMBER_CONTINUE_OK; persisted messages occur once.
- QA-3: Real native tools create two todos, inspect a task-owned project and ask a structured question. Answer in the browser. Native goal/task/DAG state uses real events plus authoritative initial/reconnect snapshots.
- QA-4: Pending interaction survives reconnect/session switch; no duplicate accepted prompt. Failed reads preserve previous state. Closing UI retains work and preserves foreign hosts.
- QA-5: Files/Git/terminal real-surface checks and malformed/unauthorized API checks, plus focused tests/typecheck/lint/build/oxlint/dead-code evidence.
- QA-6: Built and HMR startup, desktop runtime proof if shell changes, desktop/mobile-width captures, resource cleanup receipts and signed commits pushed to the requested branch.

## Remaining design questions

The planning child is resolving these source questions, not asking the user to repeat product decisions:

1. Exact native goal controls and task/DAG snapshot recovery without changing installed OMO.
2. The smallest native-only server/UI entrypoint that reuses local tools and existing styling.
3. Exact shared schemas and disjoint producer paths so dependent lanes can execute without guessed contracts.

No implementation has begun. This file is the approved scope ledger, not a claim that the final executable plan is complete.

## Architecture decision update

The planning lane delivered its main design. Its remaining response is the source detail that the task-output formatter omitted, not a new design pass.

- Use separate native server, browser and local Electron entrypoints. Keep the old OpenCode code dormant and separately addressable for its existing tests; never import it from native startup.
- Do not translate Senpi into OpenCode wire types or rewrite the legacy synchronization stores.
- Reuse lower-level filesystem/Git/terminal services, themes, primitives, editors and renderers. Native wrappers own their session/directory state.
- Do not add a companion extension. Source-backed read-only projections and existing native `/goal` actions suffice and preserve existing hosts' extension profiles.
- Never instantiate native stores whose constructors repair or migrate files. Readers validate native-owned checkpoints/sidecars without writing.
- Native todos are read-only GUI projections. Tasks support native parent-scoped output/send/cancel. DAG editing/retry is not exposed without a native RPC contract.
- Terminal-owned sessions are explicitly read-only, because their endpoint refuses direct prompt/steer/follow-up. Hosted sessions support full continuation.
- Use HTTP plus authenticated SSE for browser delivery. Keep native sockets, handles and engine credentials in the server. Preserve pending dialogs across browser reconnect; do not invent arbitrary dialog recovery after adapter-process loss.
- Initial three runs: native foundation; native UI and web cutover; local Electron and branding/documentation. Every run ends in a verifier depending on all producers.

## Independently checked goal contracts

Installed engine root: `/Users/en0/.omo/agent/runtime/6ed61b8c440e75f7-a87b340a60f5`.

- `dist/core/extensions/builtin/goal/command.js:1-14` maps `/goal pause`, `/goal resume`, `/goal clear`, and other nonblank arguments to native goal actions.
- `goal/command-registration.js:8-48,58-85` reads/updates native state and queues native continuation. Replacing a goal can emit a select dialog; the GUI must render and answer that native request.
- `goal/store-ref.js:4-12` uses `<session-directory>/extensions/goal/<encoded-thread-id>.json`.
- `goal/persistence.js:195-210` validates `{version:1, goal}`. Missing current state is null; malformed/unsupported state is failure, not an empty goal.
- `todotools/index.js:33-47` reconstructs todos from the active session branch on start/tree changes.
- `dist/rpc-entry.js:1-12` is the existing direct RPC entrypoint. Using it does not rebuild/install OMO.

## Parent corrections to freeze in the final plan

- Include `GET /api/omo/status`; the goal's startup scenario requires it even though the child API table omitted it.
- Split mixed-runner baseline commands correctly: auth uses `bun test`, while Git/terminal use the configured web Vitest command.
- Do not let every producer independently define its DTO. Freeze the shared application contract before mass-ulw dispatch.
- Preserve the remote's current main and push the new prefixed branch. No force push or automatic merge.

## Complete plan and review request

- status: plan-self-reviewed-ready-to-execute
- planner_task: st_01a0f48a completed
- planner_result: complete source-backed native recovery contracts received
- plan_path: .omo/plans/omochamber-native.md
- plan_sha256: e9c134d85353c29268b25afe1eb0394cce2d223cab1fa819946196ff469925bd
- structural_validation: PASS, 14 numbered implementation rows, 4 final-verification rows, 14 executor-category declarations, first section TL;DR
- review_required: true
- review_round_id: omochamber-plan-r1
- review_round_limit: 5
- review_round_status: self-review-complete
- review_plan_reviewer_status: unavailable-plan-gated
- pending_action: Create the authorized fork branch/remote and execute the first mass-ulw phase.
- source_worktree: Only .omo planning artifacts are untracked; application source is unchanged.

## Plan self-review receipt

The plan-reviewer tool refused the spawn because the user did not invoke the explicit ulw-plan workflow. No attempt was made to unlock or bypass that gate. Its response directs self-review instead.

Self-review: PASS. The final plan has 14 implementation rows, four final-verification rows and 14 executor declarations; every SC-1 through SC-6 and IS-1 through IS-8 is mapped. Native controls/read sources were checked, no native writer/companion extension is introduced, and producer scopes are disjoint. Fixes added the required status endpoint, explicit pendingInteractions field, a single locale owner and the quick runtime-resolver split.

This is not an independent plan-reviewer approval. Independent phase checks and a fresh implementation review remain planned against actual code and runtime evidence. The HEAVY tier holds because the work changes native session, transport and local-machine access boundaries.
