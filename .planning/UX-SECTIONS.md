# UX implementation by section

Updated 13 September 2026. Implementation is authorized. Latest user screenshots identify an incomplete match to the approved green mockups: overly green content areas, narrow Manage composition, and untouched dense detail modals. This section plan supersedes earlier grey-surface proposals.

## 1. Shared visual foundations

Near-black `#090e0b` is the reading canvas, including roster rows and modal content. Forest `#111a14` frames the header, table headings, and selected records. `#182318` is an interactive selected/hover state, not the default fill for every panel. Keep mint actions, Outfit/DM Sans, 12px records and 8px controls. Gold/silver/copper awards and ATK/DEF/FLEX accents retain meaning.

Use a wider desktop content measure, a compact utility header, and 16px phone gutters. Do not replace the approved identity with grey surfaces or add invented data to reproduce a mockup.

## 2. Manage

Match the reference's workspace/content proportions. Roster heading, actual player count, name-or-role search, import and add actions share a toolbar. Rows show name, recorded preferred role, placement status, game count, last played and accessible edit/remove commands. Eight-row pagination keeps the workspace manageable. Derive counts/activity from stored games; never fabricate account counts or audit-health claims. On phones, retain role/status and move secondary activity metadata beneath the name.

## 3. Player profile modal

Identity and season context lead. Awards are compact earned records, not a banner above the player's name. Primary metrics form an unframed comparison row; positional/current-season metadata is clearly labelled. Match history uses predictable result, teammate/opponents, score, delta and date columns. Selecting a match opens a detail dialog above the retained profile; Back/Escape returns to the exact profile scroll/focus. No metric or rating formula changes.

## 4. Match detail modal

First view: date, actual score, opposed teams, recorded roles and signed points. Detailed MMR/rank/position factors use one expandable row per player, closed initially. Admin editing and disciplinary changes remain available but do not dominate the public reading layout. Phone layout places the score above two usable team columns; factor rows wrap instead of shrinking text. Delete still requires confirmation.

All modals use native dialog focus containment, accessible names, Escape, labelled close controls, bounded internal scrolling and near-black content. Profile/match dialogs are wider on desktop and full-height with safe-area padding on phones. Routine confirmation/login dialogs remain compact. Nested confirmation closure must return focus to the original action.

## 5. Ranks, Stats, History, Champions and Seasons

Carry the same near-black/forest hierarchy through existing sections. Keep the combined Ranks/Stats destination, opposed-team results, rounded championship records, wireframe loading and visible Reset bracket to preview. Keep fixed countdown geometry and reduced-motion behavior. Preserve archive context and game-entry drafts.

## Verification and boundaries

Inspect rendered desktop/phone views and both modals with long names, recorded match factors, archives and an eight-plus-player roster. Exercise role search/pagination, modal return focus, edit/cancel, save failure/retry, browser back and bracket reset using intercepted test fixtures only. Run the production build. No production writes, deployment, database/schema, auth grants, scoring or MMR-visibility changes are authorized.
