# St. Marylebone Table Tracker

A foosball league app with player rankings, match history, statistics, championship brackets, season archives, and staff management tools. Built with React 18 and Vite 6, with Supabase for shared data and staff sign-in.

## Current features

- **Ranks:** standings, player profiles, placement progress, streaks, recent results, and a Stats view.
- **History:** matchday records, player/season/date filters, and match details. Signed-in staff can edit or delete results.
- **Champions:** automatic or custom bracket setup, live scores, a finals countdown, and championship awards.
- **Seasons:** active-season dates and archived results, with links into the relevant History and Stats views.
- **Log game:** batch entry, ATK/DEF/FLEX assignments, score previews, penalties, saved templates, and undo.
- **Manage:** roster, announcements, JSON/CSV exports, backup recovery, account management, and sync diagnostics.
- **Rules:** a stored rulebook that staff can edit.

Public visitors can browse the league without signing in. Accounts currently exist for staff roles only: `referee`, `gameadmin`, and `sysadmin`. Player records and login accounts are separate; there is no player self-registration, account-to-player linking, or referee approval queue for player-submitted games yet.

## Run locally

You need Node.js, npm, and access to a configured Supabase project.

```sh
npm install
```

Create an untracked `.env` in the project root:

```dotenv
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY
```

These values are used by the browser client. Keep service-role credentials out of frontend environment variables and source files.

```sh
npm run dev
```

Open the local URL printed by Vite, normally `http://localhost:5173`.

The app needs a populated `app_state` row with `id = 1`. The initial database migration creates an empty row; an empty state produces an “Unable to load league” screen. The in-code seed is not a standalone demo mode. Use a separate test project or intercepted responses for development involving data changes.

## Build and preview

```sh
npm run build
npm run preview
```

The production build writes to `dist/`. Deploy that directory using a static host, with the two frontend environment variables configured at build time. The Supabase database and Edge Function are deployed separately.

The build currently reports a bundle larger than Vite's 500 kB warning threshold. No automated test, lint, or type-check scripts are configured in `package.json`.

If a local npm installation is broken but dependencies are already installed, the build can also be invoked directly:

```sh
node node_modules/vite/bin/vite.js build
```

## Code map

| Path | Responsibility |
| --- | --- |
| `src/App.jsx` | Most views, player/game state, scoring and replay, seasons, finals, administration, and sync |
| `src/components/LeagueUI.jsx` | Shared header, navigation, management menu, loading skeleton, recent results, and countdown |
| `src/components/HistoryRecords.jsx` | Matchday records and team display |
| `src/styles/` | League, section, season, history, championship, announcement, and motion styles |
| `src/authClient.js` | Staff sign-in, session restoration, account operations, and audit requests |
| `src/supabaseClient.js` | Supabase browser client and environment configuration |
| `src/main.jsx` | React entry point |
| `supabase/migrations/` | Shared-state tables, account profiles, permissions, audit functions, and username migration |
| `supabase/functions/create-account/index.ts` | Sysadmin-only account creation Edge Function |
| `.planning/UX-*.md` | Existing UX decisions and verification notes |

Most application code remains in `App.jsx`. Styles combine an embedded CSS string with imported section styles. Navigation uses URL hashes, preserves visited views and drafts, and carries season selection between views.

## Data and sync

League data lives in the `state` JSON document on `public.app_state`, row `1`. It includes players, games, seasons, finals, rules, announcements, and a version number (`_v`).

The app loads this document from Supabase and subscribes to realtime changes. Staff edits use a debounced save queue and the `update_state_versioned` database function. Version checks coordinate writes from multiple clients; the code also handles conflicts, retries, and reconnection.

Successful saves attempt a snapshot in `app_state_history`, throttled to once per ten minutes per browser. Cleanup attempts remove snapshots older than 30 days; database permissions restrict deletion to sysadmins. JSON exports provide a separate downloadable copy.

Browser storage holds items such as saved match templates, announcement dismissals, and sync identifiers. It is not the source of truth for league results. Clearing local storage does not reset the league.

Existing UX notes identify concurrent-save/undo concerns and statistics correctness findings as separate follow-up work. The UX verification record does not establish that those concerns are resolved.

## Accounts and permissions

Staff sign in with a username and passphrase. The client maps the normalized username to an internal email-shaped identifier for Supabase Auth. `public.profiles` stores the account's username, role, call sign, and active status; these account profiles are distinct from the player records in `app_state`.

A sysadmin can create accounts through **Manage → Accounts**. The `create-account` Edge Function verifies the caller, creates the Auth user and profile, and records an audit event. It currently uses DinoPass when generating passphrases and needs server-side Supabase credentials.

The SQL migrations define database permissions. Current general league-state writes require at least `referee`; state replacement and account-management checks require `sysadmin`. Many UI controls use a shared signed-in-staff check, so the three staff roles do not imply a fully separated permission for every operation.

For a new Supabase project, review and apply the migrations in order, configure realtime for `app_state`, deploy the account function, and provision the first sysadmin. The bootstrap comments in migration `0001` describe the old passphrase-only login convention; use the current username convention in `authClient.js` and migration `0003` when provisioning an account.

## Scoring and historical results

`CONFIG`, `calcPlayerDelta`, and `replayGames` in `App.jsx` define the scoring behavior. Current settings include starting MMR of 1000, base gain/loss of 22/12, and a placement threshold of three games. Although the constant retains the name `MAX_PLACEMENTS_PER_MONTH`, placement keys also account for seasons.

Points depend on score margin, opponent strength, rank, streak, and role alignment. ATK and DEF have separate ratings. Editing/deleting matches and recalculation replay the game history.

Preferred role affects scoring: replay currently reads the player's current preference. Any future self-service role editing needs an explicit policy for historical games before it is implemented.

## UX direction and development checks

The current design uses near-black reading surfaces, forest green framing, mint actions, Outfit/DM Sans, and rounded records and controls. Four primary destinations are Ranks, History, Champions, and Seasons; Stats sits within Ranks, and Rules is in the utility menu.

The September 2026 UX work covered responsive layouts, profile and match dialogs, navigation continuity, and championship controls. See `.planning/UX-IMPLEMENTATION.md` and `.planning/UX-SECTIONS.md` for the recorded scope and checks.

For UI changes, use isolated fixture responses or a test Supabase project. For scoring, permissions, or sync changes, check the affected behavior directly. Recovery, resets, diagnostics, and signed-in edits can mutate the configured database.

## Player-account planning and security review

Player accounts, profile customization, ownership claims, and game approval are being planned in [PLAYER-ACCOUNTS-DISCUSSION.md](.planning/PLAYER-ACCOUNTS-DISCUSSION.md). They are not implemented.

Implementation preparation: [handoff](handoff.md), [technical roadmap](.planning/ROADMAP.md), [requirements](.planning/REQUIREMENTS.md), and [technical design](.planning/TECHNICAL-DESIGN.md). The first priorities are mobile interaction reliability and current security gaps, followed by the account features.

The [source security review](.planning/PLAYER-ACCOUNTS-SECURITY-REVIEW.md) records broad referee write access, unsafe Markdown rendering, audit gaps, and concurrency concerns that need addressing before registration expands. It includes proposed permissions and abuse controls for this league. Deployed Supabase settings have not been verified by that review.
