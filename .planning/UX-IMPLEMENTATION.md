# Approved UX implementation

Status: implemented locally for user review, 13 September 2026. The current section-by-section fidelity contract is [UX-SECTIONS.md](UX-SECTIONS.md), including the latest near-black content surfaces, wider Manage layout, and player/match modal strategy. The Obsidian UX hub links the section plan, delivery record and verified screenshots.

User authorized implementation on 12 September 2026 after selecting the original recording-led green mockups with rounded leaderboard corners and colour accents. The grey/graphite pass is rejected. Preserve Outfit/DM Sans and existing green backgrounds.

## Process

1. Shared icon family, green visual tokens, rounded controls, responsive shell and wireframe loading.
2. Four primary destinations; Stats within Ranks; task-based Manage. Preserve visited views and drafts; carry archive season into History/Stats and profiles.
3. Refine standings, results, roster, mobile spacing and championship bracket/countdown. Keep visible Reset bracket to preview, with confirmation.
4. Production build and isolated browser checks at desktop/mobile widths. Use intercepted fixture responses, never live database mutations. Leave a local preview running.

## Boundaries

No scoring/replay formula, season-boundary convention, MMR visibility policy, stored rulebook, database schema or permission changes. Existing sync conflict/undo concerns and statistics correctness findings remain separate work. Do not implement mockup-invented metrics, qualification guarantees or table numbers.

No deployment or live reset/restore/sync-test actions. Keep all existing batch, role/FLEX, disciplinary and administration functions reachable.

## Verification record

Production build passes. Seven views checked at 1440/800/390/320px without document overflow; profile and match dialogs, expanded factors and editing checked at desktop and phone widths. Isolated browser checks cover pagination and role filtering, modal Escape/focus restoration, edit cancellation, archive season context, browser back/forward, retained drafts, failed-save retry without duplicate match IDs, bracket reset/preview, reduced motion, expired countdown and load retry/empty-response failure. All database/auth requests were intercepted; no production mutations.

AST comparison confirms CONFIG, replayGames, calcPlayerDelta, calcDelta, computePlacements, computeWindowPlayerStats, gameInSeason, didPlayerWin, duplicate detection and the teammate/opponent/goal helpers are unchanged. Existing statistics and concurrent-sync limitations remain separate work. The build retains the existing large-chunk warning.

Preview: http://127.0.0.1:5180/. No commit or deployment was made.
