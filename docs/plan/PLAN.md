# Chat-native capabilities for OpenCode

Status: DRAFT. Gate G0 decided. Gate G2 decided (direct write with backups). Q7 decided (look work parked on its own branch).

## 0. Decisions

| # | Decision | Value |
|---|---|---|
| D1 | Surface | Patched build of this repo (`packages/app`, `packages/gui-plugins`). Not a plugin. |
| D2 | Default scope | Project (`opencode.json` in the project root). |
| D3 | Per-chat override | Stored server-side per session. Shown as a chip when active. |
| D4 | UI label | "MCP servers". Never "Connectors". |
| D5 | Platforms | Windows, macOS, Linux from day one. CI matrix on all three. |
| D6 | Config writes | Direct write with backups (owner decision, Q6). Last 10 backups, atomic rename. |

## 1. Architecture facts that constrain the design

These come from the OpenCode architecture reference and change what each kind can do in the UI.

### 1.1 Skills are text, not runtime
- A skill is `SKILL.md` plus optional sibling files. Nothing is started, connected or authenticated.
- The only lifecycle is discovery and permission.
- "Enable/disable" for a skill = a permission rule on the `skill` tool (`allow` / `ask` / `deny`, last match wins). `deny` hides the skill from the model entirely.
- A skill with no `description`, or with `opencode/autoinvoke: false`, is not advertised. It can still be loaded by exact ID or `@skill-id`.
- The skill detail page has no Connect button. Its state is: files on disk, permission rule, source precedence.
- Source precedence: `.opencode/skills/<id>` overrides `~/.config/opencode/skills/<id>`.

### 1.2 MCP servers: config is input, runtime is the steering wheel
- Config (`mcp` in `opencode.json`) is the source of truth, per project. Adding or editing an entry is a file edit.
- Runtime connect / disconnect / sign-in is what `/mcps` does. Disconnecting does NOT edit config.
- OAuth credentials are stored outside config. Signing in is not a config change.
- Tools appear as `<server>_<tool>`, or as `tools.<server>.<tool>(...)` under Code Mode (default). `"codemode": false` exposes them directly.
- Prompts become `<server>:<prompt>` slash commands. Resources use `list_mcp_resources` / `read_mcp_resource`.
- Consequence for the UI: two separate actions.
  - "Connect / Disconnect" = runtime endpoint (P2.3). No config write.
  - "Add / Remove / Edit" = config write (P4.7, P4.8). Depends on G2.

### 1.3 Plugins: one entry, several parts
- One entry in the `plugins` array loads all parts: server (`.`, `./server`), TUI (`./tui`), GUI (`./gui-experimental`), RPC (`./rpc`).
- The GUI switch in Settings turns off that plugin's GUI only. The server part keeps running.
- Full disable = `"-plugin-id"` in `plugins`.
- A plugin whose server part fails has no GUI.
- The existing Plugins settings page only works against the app's own server. It lists only plugins with a GUI part.
- Some plugin IDs and the `opencode` namespace are reserved; a collision shows a row with no UI.

### 1.4 Effect on the plan
- P3 "toggle" rows: skills toggle permission; MCP servers toggle connection (runtime); plugins toggle GUI (runtime) or full disable (config). Three different verbs. The UI must say which one it is doing.
- P5.9 to P5.11 (skill page): no Connect button. Permission and file state only.

## 2. Repo state at plan time

- Branch: `main`. Baseline commit: `18b6cc82 baseline: opencode 2.2.5 source`.
- Existing uncommitted work in the tree (NOT part of this plan, do not commit with it):
  - `packages/app/src/runtime/i18n/en.ts`
  - `packages/app/src/runtime/plugin/settings-page-view.tsx`
  - `packages/app/src/runtime/plugin/settings-pages.ts`
  - `packages/app/src/settings/appearance/appearance.tsx`
  - `packages/app/src/settings/search-index.ts`
  - `packages/desktop/src/main/windows/appearance.ts`
  - `packages/gui-plugins/src/main.ts`
  - `packages/gui-plugins/src/renderer.ts`
  - `packages/plugin/src/gui/registries.ts`
  - `packages/gui-plugins/src/look/` (untracked)
- CONFLICT RISK: Phase 3 (composer) and Phase 5 (detail pages) touch the same areas as the uncommitted look work. Owner must decide whether to land or stash that work first (step P0.0).

## 3. Agent lanes

| Code | Lane | Scope |
|---|---|---|
| REG | Registry | Capability model, adapters, store |
| API | Server | Endpoints, event stream, session overrides |
| CMP | Composer | "+" menu, `/` `$` `@` triggers, chips |
| DET | Detail pages | Routes, tabs, forms |
| CFG | Config I/O | jsonc read/write, backups, schema |
| TX | Transcript | Tool and skill cards in chat |
| QA | Test | Unit, component, E2E, visual, soak |
| DOC | Docs | User guide, dev note, ADR |
| REV | Review | Independent check at each gate |

Each step: ID, lane, dependencies, a "done when" that a reviewer can check without asking the author.

---

## Phase 0: Baseline (no feature code)

| ID | Step | Lane | Deps | Done when |
|---|---|---|---|---|
| P0.0 | Park uncommitted look work on its own branch (owner decision, Q7). Commit only those 11 paths; leave composer work on a clean tree | REV | none | Look branch exists on GitHub; `dev`-based work tree clean |
| P0.1 | Record baseline SHA and `git status` output in `docs/plan/baseline.md` | REG | P0.0 | File exists, lists all 10 modified/untracked paths |
| P0.2 | Build and run desktop app from source on Windows; capture screenshot of Settings → Plugins | QA | P0.1 | PNG in `docs/plan/baseline/` |
| P0.3 | List every file that renders the composer (input, toolbar, attach button) with line counts | CMP | P0.1 | Table in `docs/plan/baseline.md` |
| P0.4 | List every component under the Plugins settings page | DET | P0.1 | Table in `docs/plan/baseline.md` |
| P0.5 | Inventory server endpoints that list skills, plugins and MCP status | API | P0.1 | `docs/plan/endpoints.md` with request/response shape per endpoint |
| P0.6 | Check for a status event stream (SSE or WebSocket) for MCP connection state | API | P0.5 | Yes/no, with a sample event captured |
| P0.7 | Check whether session-scoped overrides exist for plugins, skills or MCP | API | P0.5 | Yes/no, with code path if yes |
| P0.8 | Confirm on Windows, macOS and Linux that `path`, process spawn and keychain code paths have no platform-specific assumptions in the files touched by Phases 1–6 | REV | P0.3, P0.4 | Checklist in `docs/plan/portability.md` |
| P0.9 | Write ADR-0001 (surface decision, D1–D5) | DOC | P0.8 | `docs/adr/0001-chat-capabilities.md` marked accepted |

Checkpoint: G1 (per-chat override storage) resolved by P0.7 result.

---

## Phase 1: Capability model (REG)

| ID | Step | Deps | Done when |
|---|---|---|---|
| P1.1 | Define `Capability` type: `id`, `kind` (`skill`/`plugin`/`mcp`), `scope` (`global`/`project`/`session`/`builtin`), `state`, `error`, `description`, `icon`, `configRef` | ADR | Compiles, exported from `capabilities/types.ts` |
| P1.2 | Define state enum split per kind (see §1): skill = `available`/`denied`/`hidden`; mcp = `disabled`/`connecting`/`connected`/`needsAuth`/`error`; plugin = `loaded`/`guiOff`/`disabled`/`failed` | P1.1 | Enum values each have a unit test |
| P1.3 | `fromSkill(info)` adapter | P1.1, P0.5 | 3 fixture skills map to expected objects, including one `deny` and one `autoinvoke: false` |
| P1.4 | `fromPlugin(info)` adapter | P1.1, P0.5 | 3 fixtures: server-only, server+GUI, failed server |
| P1.5 | `fromMcp(status)` adapter | P1.1, P0.5 | Covers connected, disconnected, needs-auth, error |
| P1.6 | Store merges adapters; `list(kind?, filter?)` | P1.3–P1.5 | 100 fixtures load under 50 ms |
| P1.7 | `search(query)`: exact name, then prefix, then substring, then description | P1.6 | Ranking test passes |
| P1.8 | `subscribe(listener)` fires once per change, no duplicates | P1.6 | Test passes |
| P1.9 | Unit tests for every adapter branch | P1.3–P1.8 | Coverage ≥ 90% on `capabilities/` |

---

## Phase 2: Server and data (API)

| ID | Step | Deps | Done when |
|---|---|---|---|
| P2.1 | `GET /capabilities` returns all kinds in one call | P0.5 | Matches `endpoints.md` schema |
| P2.2 | `POST /capabilities/skill/:id/permission` sets `allow`/`ask`/`deny` on the `skill` rule | P2.1 | Returns new state; rule present in config after reload |
| P2.3 | `POST /mcp/:id/connect` and `/disconnect`. Runtime only; must NOT write config | P2.1 | Connect and disconnect take effect within 2 s; config file byte-identical before and after (test) |
| P2.4 | `POST /mcp/:id/auth` starts OAuth; returns auth URL; token stored outside config | P2.3 | Token file location outside project; config unchanged |
| P2.5 | `POST /plugin/:id/gui` (on/off) and `POST /plugin/:id/reload` | P2.1 | GUI off does not stop server part (test) |
| P2.6 | SSE stream `GET /capabilities/events` | P0.6 | Client gets `state` event within 1 s of a change |
| P2.7 | Reconnect policy on stream: 1 s, 2 s, 4 s, max 30 s | P2.6 | Kill-server test reconnects within 35 s |
| P2.8 | Session override store: `PUT /session/:sid/capabilities/:id` | G1 (P0.7) | Survives reload of same session |
| P2.9 | `GET /mcp/:id/tools` (names, descriptions, input schema) | P2.3 | Matches the MCP server's own list |
| P2.10 | `GET /skill/:id/files` (SKILL.md body + sibling list; first 4 KB of each) | P2.1 | Matches disk |
| P2.11 | `GET /capabilities/:kind/:id/logs?lines=200` | P2.1 | Returns ≤200 lines |
| P2.12 | Contract tests for every endpoint | P2.1–P2.11 | Green in CI on 3 OSes |
| P2.13 | Write endpoints rate-limited to 10/s per client | P2.2 | 20 rapid writes → 10 accepted, 10 `429` |

---

## Phase 3: Composer (CMP)

Built as core components in `packages/app`. Depends on P0.8 and P1.6.

| ID | Step | Deps | Done when |
|---|---|---|---|
| P3.1 | "+" button in composer (reuse existing if present); 32 px; focusable | P0.3 | Visible, keyboard focus ring |
| P3.2 | Popover menu: max height 420 px, scrolls, closes on Escape and outside click | P3.1 | 5 interaction tests pass |
| P3.3 | Sections in order: Add (Files, Folder, Attachments), Skills, MCP servers, Plugins, Toggles | P3.2, P1.6 | Headers render in order |
| P3.4 | Row: icon, name, one-line description, state badge, chevron to detail | P3.3 | Matches spec at 1x and 2x |
| P3.5 | Row click → detail page in same window; Back restores scroll | P3.4, P5.1 | Scroll position test |
| P3.6 | Toggle rows show checkmark from session store | P3.3, P2.8 | State matches store |
| P3.7 | `/` trigger lists MCP servers, plugins and built-in commands | P3.2 | `/gi` filters to names starting "gi" |
| P3.8 | `$` trigger lists skills only | P3.7 | Only skills appear |
| P3.9 | `@` trigger lists files, folders, chats; 200 ms on 1,000 files | P3.7 | Timing test |
| P3.10 | Keyboard: Up/Down, Enter selects, Tab to detail | P3.7 | Keyboard-only test |
| P3.11 | Selected item becomes chip; Backspace on empty input removes it | P3.7 | Chip test |
| P3.12 | Chip reflects state: MCP disconnected = amber dot, changes within 1 s | P3.11, P2.6 | Dot test |
| P3.13 | ARIA roles, labels, logical tab order | P3.2–P3.12 | Axe: 0 serious issues |
| P3.14 | Empty state: "No MCP servers yet" with link to MCP page | P3.3 | Shown on empty list |
| P3.15 | Loading skeleton up to 500 ms | P3.3 | Visible while fetch pending |
| P3.16 | Error row "Failed to load" with Retry | P3.3 | Retry recovers |
| P3.17 | Cross-platform: menu renders and keyboard-navigates identically on Win/mac/Linux | P3.13 | CI screenshot diff within threshold |

---

## Phase 4: Config I/O (CFG). Unblocked: G2 = direct write with backups

| ID | Step | Deps | Done when |
|---|---|---|---|
| P4.1 | jsonc reader that preserves comments and trailing commas | P0.5 | Round-trip identical on 10 fixtures |
| P4.2 | jsonc writer that patches only the target key path | P4.1 | Diff touches only target lines |
| P4.3 | Schema validator for `opencode.json(c)` (`plugins`, `mcp`, `skills`, `permission`) | P4.1 | Rejects 10 invalid, accepts 10 valid |
| P4.4 | Backup before every write: `opencode.json.bak-<ts>`, keep last 10 | G2 | 11th write prunes oldest |
| P4.5 | Atomic write: temp file, fsync, rename | G2 | Kill mid-write leaves original intact |
| P4.6 | External-edit detection: conflict instead of overwrite | G2 | Conflict test |
| P4.7 | Add MCP entry (stdio: command, args, env, cwd; http: url, headers) with validation | G2, P4.3 | Form-to-config test per transport |
| P4.8 | Remove MCP entry with confirmation | G2, P4.7 | Entry gone; backup exists |
| P4.9 | Skill frontmatter round-trip (`name`, `description`, `opencode/autoinvoke`) | P4.1 | Round-trip test |
| P4.10 | Create skill from template (folder + SKILL.md) in project or global scope | P4.9 | Appears in registry within 2 s |
| P4.11 | Plugin full disable writes `"-plugin-id"` into `plugins` | G2, P4.2 | Plugin off after reload |
| P4.12 | Scope routing: global, project, session go to the right file | G2, P2.8 | Each scope test |

Checkpoint G2: decided (direct write with backups). Remaining choice, full-file rewrite or structured patch, follows P4.1–P4.2 test results.

---

## Phase 5: Detail pages (DET)

Routes: `/capabilities/skill/:id`, `/capabilities/mcp/:id`, `/capabilities/plugin/:id`.

| ID | Step | Deps | Done when |
|---|---|---|---|
| P5.1 | Routes for three kinds; 404 for unknown IDs | P3.5 | Each renders shell |
| P5.2 | Header: icon, name, scope badge, state badge, primary action | P5.1, P1.1 | Matches spec |
| P5.3 | Tabs: Overview, Configuration, Activity, Danger zone | P5.2 | Tab switch keeps scroll |
| P5.4 | MCP Overview: state, transport, last connected, tool count | P5.3, P2.9 | Values match server |
| P5.5 | MCP Tools tab: searchable list, expandable schema; 50-tool fixture | P2.9 | Renders and filters |
| P5.6 | MCP Connect / Disconnect / Sign-in buttons (runtime only, no config write) | P2.3, P2.4 | States: idle, pending, success, failure; response under 2 s |
| P5.7 | MCP Configuration tab: form from config entry | P4.7 | Invalid values show inline errors |
| P5.8 | Skill Overview: description, source path, autoinvoke, file count | P2.10 | Matches disk |
| P5.9 | Skill permission control: allow / ask / deny | P2.2 | Denied skill absent from model step (test) |
| P5.10 | Skill Files tab: list plus 4 KB preview | P2.10 | Preview matches disk |
| P5.11 | Plugin Overview: version, parts (server, tui, gui), load status with reason | P1.4 | "Not loaded" shows reason |
| P5.12 | Plugin GUI switch and full disable (separate controls, labelled differently) | P2.5, P4.11 | Labels distinct; each works |
| P5.13 | Plugin Reload button | P2.5 | Recovers failed GUI in test |
| P5.14 | Activity tab: last 200 log lines, copy, timestamps | P2.11 | Scrolls, copies |
| P5.15 | Danger zone: remove from config; typed-name confirmation | G2, P4.8 | Exact name enables button |
| P5.16 | Scope selector: Project (default) / This chat | P2.8 | Writes to correct target |
| P5.17 | Old Settings → Extensions → Plugins URL redirects to new Plugins list | P5.12 | Old URL opens new page |

---

## Phase 6: Transcript (TX)

| ID | Step | Deps | Done when |
|---|---|---|---|
| P6.1 | MCP tool call renders collapsed card: server, tool, duration | P1.5 | Fixture card |
| P6.2 | Expand shows input and output; truncate at 4 KB with "show more" | P6.1 | Truncation test |
| P6.3 | Skill load renders card with name and link to skill page | P1.3 | Link goes to right page |
| P6.4 | Error card with message; Retry where the tool allows | P6.1 | Retry re-invokes once |
| P6.5 | Keyboard accessible; screen-reader announcement | P6.1 | Axe clean |
| P6.6 | Cards restored on chat reload | P6.1 | Reload test |

---

## Phase 7: Quality (QA)

| ID | Step | Deps | Done when |
|---|---|---|---|
| P7.1 | Unit suite under 60 s locally | P1.9 | Timed |
| P7.2 | Component tests for each row state (9 states) | P3.4 | All pass |
| P7.3 | E2E: "+" → MCP server → connect → chip → message calls a tool | P3, P2, P6 | Passes 3 runs in a row |
| P7.4 | E2E: `$` enables skill; model loads it; card in transcript | P3.8 | Card present |
| P7.5 | E2E: plugin GUI off, then full disable; both verified after reload | P5.12 | Passes |
| P7.6 | Failure: kill MCP server mid-session; amber dot; Retry | P2.7 | Dot within 2 s |
| P7.7 | Failure: corrupt `opencode.json`; conflict message; no data loss | P4.6 | Original intact |
| P7.8 | Menu opens under 100 ms with 200 capabilities (median of 10) | P3.2 | Devtools numbers |
| P7.9 | 30-minute soak with event stream; heap growth under 20% | P2.6 | Chart attached |
| P7.10 | Visual snapshots (menus, detail pages; light and dark) on 3 OSes | P3, P5 | Committed |
| P7.11 | Manual checklist, 40 items, owner sign-off | all | File complete |

---

## Phase 8: Docs (DOC)

| ID | Step | Deps | Done when |
|---|---|---|---|
| P8.1 | User guide with 5 screenshots | P7.3 | `docs/user/chat-capabilities.md` |
| P8.2 | Migration note for Settings → Extensions users | P5.17 | Before/after image |
| P8.3 | Dev note: how a plugin contributes to the GUI parts | P1.1 | Example in `examples/` |
| P8.4 | Shortcut table for `/`, `$`, `@`, "+" | P3.10 | Table complete |
| P8.5 | ADR-0001 updated with G2 result | P4 gate | Marked accepted |

---

## Phase 9: Release (REV, QA)

| ID | Step | Deps | Done when |
|---|---|---|---|
| P9.1 | Feature flag `chat_capabilities`, default off | P3.1 | Flag toggles UI |
| P9.2 | One-week dogfood; log to `docs/plan/dogfood-log.md` | P9.1 | ≥20 entries |
| P9.3 | Fix top 10 dogfood errors; commit reference each | P9.2 | Each has a SHA |
| P9.4 | Default on; old page reachable one release | P9.3 | Old page works |
| P9.5 | Release notes reviewed | P8 | Merged |

---

## Dependency summary
- Phase 0 first. P0.0 (uncommitted work) gates everything.
- Phases 1 and 2 in parallel after ADR.
- Phase 3 needs Phase 1 and P0.8.
- Phase 4 read/parse steps (P4.1–P4.3) can run now. Write steps wait for G2.
- Phase 5 needs 1, 2, and 4 (for the config-backed steps).
- Phase 6 needs 1 and 2.
- Phase 7 runs throughout.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Composer or Plugins page conflicts with uncommitted look work | High | P0.0 before any Phase 3 or 5 code |
| Hand-edited `opencode.json` loses comments | High | P4.1 round-trip; P4.4 backups |
| Users read "disconnect" as "remove" | Medium | Separate verbs and labels (§1.2, P5.6, P5.15) |
| Per-chat override needs server changes | Medium | P0.7 result; fallback is session-only permission layer |
| Platform path or spawn differences | Medium | P0.8 checklist; 3-OS CI matrix |

## Open questions

- None. Q6 and Q7 are decided (see §0 and P0.0).
