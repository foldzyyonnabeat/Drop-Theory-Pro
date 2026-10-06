# rekordbox adapter scope

## Current implementation

Drop Theory Pro supports a limited, file-based XML route:

- Import reads a user-selected exported XML file and extracts collection track metadata, file locations, ratings, and ordinary playlist folders.
- Export writes a reviewable XML file containing tracks and manual playlists/crates.
- The user chooses when and where to import the XML in rekordbox.
- Drop Theory Pro never opens, edits, migrates, or writes to rekordbox's live encrypted database.
- No audio is uploaded.

The parser rejects DTD-bearing XML, has file-size, element-count, and nesting limits, and does not resolve external entities. The importer/exporter is not a complete implementation of all rekordbox XML fields.

## Not supported

Hot cues, memory cues, loops, cue colors/comments, beatgrid nodes and tempo changes, My Tag, intelligent playlist rules, track history/play counts, related tracks, artwork, cloud-library entries, device-library formats, USB export, process detection/warnings, and full field-level diff/round-trip validation are not implemented. Ratings, paths, and metadata may require conversion review. Exporting an XML file does not prepare a CDJ-ready USB.

## Safe validation procedure

1. Read AlphaTheta's current [rekordbox developer XML guidance](https://rekordbox.com/en/support/developer/) and applicable license/terms.
2. Use a copied XML export and a disposable rekordbox test library, never the user's production library.
3. Record the rekordbox version, Windows build, sample XML source, field mapping, import warnings, and any lossy conversions.
4. Export from Drop Theory Pro to a new filename; inspect the XML and compare it with a fresh rekordbox export.
5. Import into the disposable library and verify track paths, playlist hierarchy, ratings, and any supported fields.
6. Update `FEATURES.md` only for the fields and versions actually validated.

## Trademark and compatibility language

Use “rekordbox” only to describe compatibility. Do not imply endorsement, partnership, certification, or access to proprietary interfaces. Camelot notation is associated with Mixed In Key; legal review is required before positioning it as a branded feature. Open Key and standard musical-key notation remain future work.