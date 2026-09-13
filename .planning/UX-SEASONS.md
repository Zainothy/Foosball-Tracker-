# Seasons UX pass

Baseline: UXoverhaul at 81405aa. Preserve the user's Stats overhaul and Seasons date/progress, minute-refresh and podium changes.

Implemented: unframed near-black active-season timeline, responsive metadata and archive records, retained labelled History/Stats links, consistent rounded podium entries, explicit empty archive and reached-date states. End-date editing displays local time, validates the date against the season start, and restores the saved value when reopened. No scoring or season-reset semantics changed.

Verification: production build passed. Intercepted browser fixtures at 1440, 800, 390 and 320px showed no page overflow or runtime errors. Invalid end dates caused no save; archive links retained the selected season in History/Stats; cancelling reset caused no write. Screenshots were visually inspected. No production data was changed.
