# History Implementation

## Sections
- Unframed page header and filter strip on the near-black canvas.
- Always-visible player search and season scope; optional labelled date range.
- Matchday headings with rounded, keyboard-operable match records.
- Player names, explicit ATK/DEF/FLEX labels and individual points deltas remain together.
- Central score with textual winner status and penalty icons.
- Clear no-results state and incremental matchday loading.

## Modal Continuity
Records open the existing match-detail modal. Existing edit, delete, profile links, Escape handling and focus restoration are preserved. No duplicate modal or scoring implementation.

## Filter Behaviour
- Archive links retain the chosen season.
- Clear filters preserves season scope.
- Date ranges use local calendar days and include the entire final day.
- Invalid ranges show an explicit error.
- Changing filters resets the displayed matchday batch.

## Verification
Production build and fixture-backed browser checks cover four viewport widths, filters, archive scope, match details and keyboard focus. No live backend writes.
