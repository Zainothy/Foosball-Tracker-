# Implementation handoff

## Current implementation checkpoint (16 September 2026)

The worktree now contains the first implementation slice as well as the planning documents. Preserve all existing edits. The account list has separate desktop and mobile representations, shared Markdown and scroll-lock modules are tested, and the scoring engine is extracted with regression fixtures. Profile modals now support nickname, avatar URL, and curated accent colours with clearer competitive-preference wording. The admin diagnostics panel exposes filtered audit activity and recovery-point links. `src/authz.js` is a valid pure capability evaluator, and migrations `0005_dynamic_authorization.sql` and `0008_authz_role_commands.sql` add capability, role hierarchy, exception, seed, RLS, and role-save command foundations. The admin UI now distinguishes ordinary player accounts from staff: player sessions cannot access the admin dashboard, while the consolidated Access control workspace contains Accounts and Roles & permissions. Authoritative command coverage for all state mutations remains Phase 3/4 work. `npm run build` and `node --test tests/*.test.mjs` pass (12 tests). The older `authz_init` draft migration should be reviewed before applying; use the numbered migrations as the current backend starting point.

Prepared 15 September 2026 for the next agent. The user requested technical planning, PKM synchronization, and a handoff so implementation can continue. This session changed documentation only. Start with the first actionable phase rather than reopening settled product questions.

## Start here

1. Read `.planning/STATE.md`, `.planning/ROADMAP.md`, and `.planning/REQUIREMENTS.md`.
2. Read `.planning/TECHNICAL-DESIGN.md` for the selected data, permissions, audit, and migration architecture.
3. Read the PLAN files in `.planning/phases/01-mobile-reliability/` if that exact path exists; otherwise use the phase-01 path in ROADMAP.md. Follow plan dependencies and acceptance criteria.
4. Review current git status before editing. Source baseline at planning start: `main`, `b06890f`. README and planning documents are uncommitted work to preserve. Do not reset or clean them.

Repository: `C:/Users/mayas/GitHub ! Projects/Foosball Tracker`.

PKM: `C:/Obsidian Vaults/Main Personal/05. Programming and CS/Foosball-MMR/Player Accounts and Mobile Reliability.md`.

## Scope and authorization

Implement the local feature/refinement plans in priority order. Do not treat each reversible code change as a new approval request. Preserve the user's approved design and all existing useful game/admin behavior unless a plan explicitly replaces insecure behavior.

No production deployment, remote migration, live reset/restore, credential changes, account provisioning, paid services, destructive data cleanup, or owner transfer occurred during planning. Those remain separate operational actions requiring the appropriate authorization. Use fixtures or isolated test infrastructure for verification. The existing `.env` may point at the live league; never use that database for mutation tests.

The plan uses explicit technical defaults for details the user delegated. Distinguish those from locked user requirements. Only pause for a material unresolved decision, incompatible live data, unavailable infrastructure, or an irreversible operation; continue independent local work.

## Locked user requirements

- Mobile appearance is liked. Improve the feel: scrolling must not lock until refresh, common actions need fewer repeated steps, and account management must work on phones.
- Username/password accounts for ordinary players; staff-assisted recovery.
- Account-to-existing-player claims require staff approval. New accounts with no matching player submit a distinct **Onboarding creation request**, filterable by request type and status.
- Guests get a dismissible registration prompt and may continue browsing. Guests can prepare drafts locally; submitting requires an approved player link. Preserve drafts through registration/claim approval.
- Profiles support nickname, uploaded picture, playing preference, and restrained colour customization.
- Competitive preference changes are immediate. Preserve historical context; do not secretly impose a delay or season wait.
- Replace confusing independently editable Position Badges with a badge derived from Playing preference. Role played is recorded per match; account permissions are separate.
- Signed-in players should initially see their real leaderboard row centred/highlighted, with actual rank order preserved.
- Players submit games for approval. Game admin/Admin are initial reviewer presets; permissions are configurable, not hardcoded role-name checks.
- Multiple access roles, editable permissions/order, individual exceptions, and hierarchy protections. Lower/peer users cannot administer higher/peer accounts just because they possess a capability.
- Admin ownership scrutiny, unlink/relink, recovery, moderation, and restrictions through clear mobile/desktop controls.
- Authoritative audit events, Discord-inspired readable filters/details, and links to targeted undo or exact Time Machine recovery through both More and desktop context menus.

## Plan priority

01 mobile reliability/account list; 02 immediate security containment; 03 configurable authorization; 04 authoritative commands/audit/recovery foundation; 05 accounts/onboarding/ownership; 06 competitive preference history/personalization/personal standings; 07 game submissions/review; 08 audit explorer/undo/Time Machine/pilot.

The repo roadmap defines exact dependencies. Do not expose broad registration before backend permissions and audit controls exist. Phases 01 and 02 are useful independently of the account rollout.

## Current source map

- `src/App.jsx`: most UI, embedded CSS, scoring/replay, whole-state synchronization, seasons, finals, account management.
- `src/components/LeagueUI.jsx`: hash navigation, preserved visited views, headers, shared controls.
- `src/components/HistoryRecords.jsx` and `src/styles/`: extracted history and visual styles.
- `src/authClient.js`: username-to-synthetic-email login, session restoration, account mutation wrappers.
- `src/supabaseClient.js`: browser environment configuration.
- `supabase/migrations/0001–0003`: current state tables, Auth-linked staff profiles, policies, RPCs.
- `supabase/functions/create-account/index.ts`: current sysadmin-only account provisioner.

## Verified findings and investigation limits

1. **Mobile empty account list:** App.jsx around 674 hides every `.tbl-wrap` at <=980px; account rows use that wrapper around 12866. The source condition was checked. Scope the leaderboard rule and implement responsive account rows. A real phone reproduction has not been performed.
2. **Scroll locking:** shared Modal around 2049 independently captures/restores body overflow. A local model leaves `hidden` after parent unmounts before child. This is a candidate mechanism, not proof of the user's exact failure. Reproduce with fixture-backed dialog/navigation journeys before settling the fix.
3. **Broad referee write power:** `update_state_versioned` accepts a whole state document from any active referee-or-higher. Separate sysadmin reset checks do not prevent equivalent general writes. A hidden delete button is insufficient.
4. **Unsafe Markdown:** a local call to `renderMd` retained raw HTML and an event attribute. It is rendered through `dangerouslySetInnerHTML`. No payload executed in a browser.
5. **Audit gaps:** roster `state.audit` is dropped by `normaliseState`; account changes and audit calls are separate; account creation ignores audit insertion failure. Existing server actor derivation is useful but arbitrary caller-supplied event details are not an authoritative change record.
6. **Sync/undo:** conflict handling can count a newer remote version as local success; snapshot undo can discard later changes. These were source-traced, not raced against a running database.
7. **Historical preferences:** replay reads current `preferredRole`. Legacy `position` is largely cosmetic but has fallback uses. Never fabricate historic preferences.
8. **Recovery:** existing backups are periodic post-save league snapshots, not exact pre-event recovery and not backups of Auth/private future tables.

Full evidence: `.planning/PLAYER-ACCOUNTS-SECURITY-REVIEW.md`. Mobile acceptance: `.planning/MOBILE-INTERACTION-CONTRACT.md`. Governance decisions: `.planning/ACCOUNT-GOVERNANCE.md`.

## Safety and product invariants during implementation

- Keep one authoritative source per domain and make cutover explicit; do not leave the legacy whole-state RPC as an alternate privilege bypass.
- Commit database mutations and authoritative audit events together. Track cross-service Auth/storage operations durably; do not pretend they share a database transaction.
- Audit is append-only for app users. Reversal adds a new event. League rewind preserves current account restrictions, permissions, owner authority, and audit history.
- Exact rewind needs coverage/version manifests, pre-change references, preview validation, and reconciliation of submissions, players, ownership links, and preferences.
- Role managers cannot self-escalate by reordering, direct exceptions, new roles, or combined batch edits. Protect owner recovery.
- Keep stable player IDs and original authorship through rename, unlink/relink, and account recovery. No implicit merging of player histories.
- Do not publish private claims, moderation notes, credentials, or pending content into the public league document.
- Preserve near-black/forest/mint, Outfit/DM Sans, semantic competitive colours, native accessible dialogs, and recorded game formulas unless explicitly addressed by the plan.

## Verification approach

Use the narrowest meaningful checks per change. Mobile acceptance includes repeated nested dialog/back/rotation/keyboard journeys, usable scroll without refresh, retained focus/drafts/queue position, and reachable touch actions. Viewport emulation is not actual iOS/Android validation; record that distinction.

Authorization, scoring migration, approval concurrency, audit completeness, ownership races, and recovery require targeted backend/integration tests. Test deny paths directly rather than trusting UI visibility. Before any data migration, export a baseline and prove replay equivalence on isolated data; stop on unexplained drift.

The production build passed at planning start with the existing large-bundle warning. The environment's npm launcher was broken; with installed dependencies, `node node_modules/vite/bin/vite.js build` worked. A sandbox directory-resolution problem required an approved escalation for that build. Do not assume local tooling or browser preview is still running.

## PKM and progress maintenance

Current PKM hub links the technical plans. INDEX, Project, Roadmap, Tasks, Features, Design, Decisions, and the UX hub were updated. March/April metrics/publication plans remain historical; live counts were not fetched. Keep implementation status, evidence, and deviations current in repo STATE/phase summaries and the PKM hub as work completes.

Do not claim deployed security is verified from the source audit. No production policies, grants, Auth configuration, or storage settings were inspected in this session.
