# Championship Implementation

## Direction
- Preserve school colours, near-black reading surfaces and rounded fixture frames.
- Use one event header and stage progression for preview, semifinals, final and completion.
- Keep countdown geometry stable and the existing reduced-motion behaviour.
- Separate bracket setup, fixtures, awards and previous champions.

## Behaviour Preserved
- Automatic and custom seeding, live scoring, results and profile awards.
- Reset bracket to preview remains visible to admins with destructive confirmation.
- Preferred roles are labelled as preferences, not invented match assignments.
- No scoring, qualification or award calculation changes.

## Interaction Fix
Render fixtures and countdown through stable component identities so the one-second clock does not remount score controls or steal keyboard focus.

## Verification
Production build and isolated fixture-backed browser checks at desktop, tablet and phone widths. No production data is modified by verification.
