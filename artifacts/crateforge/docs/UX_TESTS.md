# Drop Theory Pro task-based UX tests

These scenarios define targets for manual or automated testing; they have not all been run. Use synthetic metadata or music the tester is authorized to use. Never collect song audio or personally identifying client information for these tests.

| # | Task | Acceptance target |
|---|---|---|
| 1 | Start with an empty library, load the demo data, and identify the next useful action. | Under 60 seconds; demo data is clearly labeled; a first-time DJ can find the library and set-prep flows without help. |
| 2 | Import a CSV and an M3U playlist, then locate a track by artist. | Under 2 minutes for a 100-row fixture; rows map correctly; duplicate/import errors explain what happened. |
| 3 | Import a rekordbox XML export and inspect a playlist. | Under 3 minutes for a small fixture; imported track and folder names are correct; no live rekordbox database is accessed. |
| 4 | Find tracks missing BPM/key and understand why they are suggested for review. | Under 1 minute; missing metadata is shown in plain language; analysis remains local. |
| 5 | Edit track metadata, remove a track, and undo the removal. | Under 2 minutes; user sees a confirmation before destructive action; undo restores metadata and crate membership. |
| 6 | Build a two-hour wedding set from demo data, review the order, and explain one transition. | Under 15 minutes; the preview is editable; duration coverage and metadata-only limitations are visible. |
| 7 | Reorder, rename, save, reopen, and export a set. | Under 5 minutes; reopened order matches; exported playlist contains only the planned track references. |
| 8 | Back up metadata, restore it into a fresh test library, and verify exclusions. | Under 5 minutes; tracks/crates and analysis metadata merge; no audio bytes, model files, or stem cache are in the backup. |
| 9 | Use Ctrl/Cmd+K and `?` to search, navigate, import, and discover shortcuts. | Under 2 minutes; keyboard focus is visible; shortcuts do not trigger while typing in an input. |
| 10 | Inspect licensing status and the Windows release limitations. | Under 2 minutes; blocked/review packages are filterable; the screen does not claim legal clearance or Windows readiness. |

## Measurement and privacy

- Record task completion, time, errors, and participant comments manually in a private test sheet.
- No click-path telemetry is implemented. If local UX telemetry is added later, it must be off by default, stay on-device, expose a clear opt-in and delete action, and never contain audio, track titles, file paths, or client data.
- Run keyboard-only, screen-reader, color-contrast, touchscreen-size, and 200k-track performance tests separately before claiming those requirements.