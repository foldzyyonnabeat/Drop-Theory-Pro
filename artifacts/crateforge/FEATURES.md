# Drop Theory Pro feature status

This is the project status source of truth. “Implemented” means code exists; it does not imply Windows validation, production suitability, or legal clearance. No feature is marked **Verified on Windows** until it is exercised on a real supported Windows installation.

Status key: **Working (local)** = implemented for the current local-first app; **Partial** = useful subset exists; **Stubbed** = visible contract or interface only; **Not started** = no implementation; **Requires Windows verification** = code exists but platform behavior is unproven.

## Product and platform

| Requirement | Status | Notes |
|---|---|---|
| Local-first library; source audio is not uploaded | Working (local) | Browser storage / local Tauri app data. No cloud audio-processing service is present. |
| Current desktop architecture | Partial | React/Vite + Tauri 2 / Rust, not the prompt’s Electron + Python + FastAPI architecture. Kept to avoid a destructive shell/runtime migration. |
| Optional metadata-only cloud service | Not started | Website account, membership, and billing flows are currently unavailable; there is no in-app account system, metadata sync, team mode, or cloud audio processing. |
| Windows 10 22H2 / Windows 11 x64 support | Requires Windows verification | No Windows install, upgrade, device, codec, or end-to-end acceptance evidence yet. |
| macOS/Linux release support | Not started | Not a release target. Replit web preview is for development only. |
| Replit preview and local web development | Working (local) | Vite preview; not a substitute for desktop validation. |

## Phase 1 — Foundation, rekordbox import, core analysis

| Feature | Status | Notes |
|---|---|---|
| Persistent local library, tracks, crates, settings | Working (local) | Browser IndexedDB and Tauri local persistence paths. |
| Audio file import and folder scan | Partial | Supported formats depend on browser/native decoder; no watcher or complete codec matrix. |
| CSV and M3U/M3U8 import/export | Working (local) | Metadata/playlists only. |
| rekordbox XML import/export | Partial | Reads/writes exported XML tracks and playlist folders only. Never accesses the live encrypted database. Cues, loops, beatgrids, history, My Tag, and intelligent playlist rules are not represented. |
| rekordbox installation/database detection | Not started | No read-only DB adapter or automatic install discovery. |
| Diff preview before rekordbox import/export | Partial | Export requires confirmation; imported records merge locally, but there is no full field-level diff screen. |
| Track metadata and file identity | Partial | Title, artist, album, genre, year, duration, BPM, key, energy, rating, path, size and small-file hash. No acoustic fingerprint or complete rekordbox field model. |
| BPM/key/energy analysis | Partial | Local estimates with waveform and beat-grid data; no independent dual-backend consensus or published accuracy report. |
| Variable tempo, key changes, LUFS, phrases, section/cue detection, vocals | Not started | Not inferred. |
| Manual metadata edits and protected values | Working (local) | BPM, key, energy, and duration can be locked so applying estimates changes only unlocked fields. |
| Persistent resumable/cancellable analysis queue | Not started | Work is not a crash-resumable job queue. |
| Safe tag writing, original tag backup | Not started | File tags are not written by analysis. |
| CLI `scan/analyze/export/doctor/snapshot` | Not started | The current small Node CLI only prints license inventory/help. |
| Accuracy self-test and confusion report | Not started | Existing tests use synthetic signals; not a real-library accuracy benchmark. |

## Phase 2 — Library UI, crates, harmonic tools, library health

| Feature | Status | Notes |
|---|---|---|
| Library search, sort, basic filters, track inspector | Working (local) | Not virtualized for 200k tracks. |
| Manual crates | Working (local) | Local membership and M3U export. |
| Saved sets distinct from crates | Working (local) | Set plans are stored locally with the library. |
| Beginner / Standard / Pro density | Partial | Mode selector; Beginner trims primary navigation. Power features remain reachable through the command palette. |
| Ctrl/Cmd+K command palette and `?` help | Partial | Navigation, import, demo data and text search. No remappable keys or complete natural-language query engine. |
| Next-best-action prompt | Partial | Surfaces missing BPM/key as a local review action. |
| Camelot wheel, Open Key and notation conversion | Not started | Key values display as imported/detected; Camelot distance is used only in set suggestions. |
| Smart crates, nested crate folders, saved layouts, bulk selection | Not started | |
| Full health score and safe-fix preview | Not started | Current warning counts are limited. |
| Duplicate finder / quarantine / version families | Not started | Hashes exist for some imported files; no review workflow or deletion quarantine. |
| Relink wizard for changed drives | Not started | Missing source paths can be reported; bulk path repair is absent. |
| Metadata fixer, quality checker, storage manager, wishlist | Not started | |

## Phase 3 — Deck player, mashup mode, DJ mix mode, transition intelligence

| Feature | Status | Notes |
|---|---|---|
| Two-deck local playback and mixer controls | Partial | Core local playback/mixing exists. Device behavior is not verified on Windows. |
| EQ, crossfader, cue/loop and MIDI mapping | Partial | Present local controls; physical controller/output combinations are unverified. |
| Harmonic/BPM set ordering and transition explanation | Partial | The set planner estimates based on metadata only; it does not listen to or audition transitions. |
| Full transition score, vocal-clash and play-history intelligence | Not started | |
| Waveform section preview, DJ Mix timeline and saved transition ideas | Not started | |
| Transition recipes, low-end clash, mixability, tempo bridge, key rescue | Not started | No rendered automation or audio audition claims. |

## Phase 4 — Stems, key/tempo rendering, edit maker

| Feature | Status | Notes |
|---|---|---|
| Four-stem separation interface, user-supplied ONNX model, CPU inference | Partial | No model weights are shipped or automatically downloaded. See `STEM-MODEL-GUIDE.md`. |
| Real model accuracy/performance and Windows CPU verification | Requires Windows verification | Tested with synthetic/fake inference only in this environment. |
| Pitch/tempo rendering and export formats | Not started | |
| Mashup render and Edit Maker | Not started | |
| Acapella finder, loop/sample extractor | Not started | |

## Phase 5 — Discovery, streaming, lyrics, library intelligence

| Feature | Status | Notes |
|---|---|---|
| Playlist/chart ingestion, own-vs-missing matching | Partial | CSV/M3U metadata import only. |
| Streaming OAuth, charts, record-pool plugins, new-release watcher | Not started | No provider integrations are connected. |
| Embeddings, library map, similar-track finder, mood tags | Not started | |
| Lyrics/transcription/theme search | Not started | Copyright and provider terms must be reviewed first. |
| Personal taste, gig history, freshness and lifecycle models | Not started | |
| Natural-language set planning and library chat | Not started | The set planner has explicit controls, not a language model. |

## Phase 6 — DJ software compatibility

| Adapter | Status | Notes |
|---|---|---|
| rekordbox | Partial | Exported XML only; see `docs/ADAPTER_REKORDBOX.md`. No live DB, USB/device database, cue/grid round trip, or Windows round-trip evidence. |
| Serato, Traktor, VirtualDJ, Engine DJ, djay, Mixxx | Not started | |
| Generic PLS, iTunes/Music XML, native formats and migration wizard | Not started | M3U/M3U8 and CSV are supported. |
| Adapter conformance suite and cross-program sync | Not started | |

## Phase 7 — Live gig companion

| Feature | Status | Notes |
|---|---|---|
| Now-playing detectors, Pro DJ Link listener, audio recognition | Not started | Network and audio capture are not implemented. |
| Next Track HUD, Rescue Mode, Panic Song, Dancefloor Memory | Not started | |
| Gig energy timeline, requests inbox/API, phone PWA | Not started | |
| Livestream overlay, set recording, mix autopsy | Not started | No recording/sharing of user audio is performed. |

## Phase 8 — Gig prep automation and DJ business toolkit

| Feature | Status | Notes |
|---|---|---|
| Set Copilot templates, energy arcs, explain-my-transition, editable preview | Partial | Local metadata heuristic, manual reorder, save and M3U8 export. No required/do-not-play constraints, genre/era mix, lock/regenerate, or clean-version family handling. |
| Pre-flight / USB Export Studio / safe eject | Not started | No device-writing capability. Exported playlists are not a rekordbox USB export. |
| Gig manager, contracts/invoices, packing list, client portal | Not started | |
| Automated scheduled backup / snapshot browser / Time Machine diff | Partial | User-triggered metadata backup/restore exists; no scheduled verified snapshots or change-history browser. Audio, models and stems are excluded. |
| Team sharing and collaboration comments | Not started | |
| Cue standards engine | Not started | |

## Phase 9 — Polish and commercial launch

| Feature | Status | Notes |
|---|---|---|
| Demo library, dark UI, keyboard navigation | Partial | Demo metadata exists; no copyrighted demo audio is bundled. |
| In-app dependency licensing inventory and `drop-theory-pro licenses` CLI | Working (local) | Generated from resolved JavaScript package metadata; does not clear models, codecs, assets or trademarks. |
| Licensing/legal/UX/Windows documentation | Working (local) | See `docs/`. Legal documents are preparation checklists, not legal advice. |
| Windows build workflow | Partial | CI definition builds/checks on Windows; a passing workflow is not yet evidence of a successful user installation or hardware acceptance. |
| Code signing, updater, licensing/payment, trial, EULA acceptance | Partial | Stripe-backed license and billing flows exist. The separate Drop Theory Pro website has three monthly support levels and a one-time first-month offer; these memberships do not grant desktop-app access, and linking them is a future milestone. Desktop signing, updater, trial, EULA acceptance, and production release validation remain incomplete. |
| Screen-reader/accessibility audit, localization, first-run tour | Partial / not started | Some labels and shortcuts exist; no formal accessibility audit or tour. |
| 200k-track UI, <50 ms search, <3s cold start | Not started | No benchmark has been run. |

## Additional innovation features

| Feature | Status |
|---|---|
| Explain-my-mix | Partial — metadata-only adjacent transition explanation in Set Prep. |
| Set Copilot | Partial — templates, duration, BPM endpoints, energy arc, ordering, manual edits and saving. |
| A/B set comparison; venue/crowd profiles; time-of-night model | Not started |
| Freshness meter; track lifecycle | Not started |
| Smart auto-gain; lighting cue export | Not started |
| Clean/explicit song-family switcher | Not started |
| Seasonal auto-crates; “sounds like this” shopping list | Not started |
| Offline/online streaming-track substitution | Not started |
| On-device voice commands | Not started |
| USB/hardware health dashboard | Not started |
| Reference-track matching | Not started |
| Mashup scoring leaderboard | Not started |
| Archive-of-everything search | Not started |
| Cross-DJ-program undo | Not started |

## Verification boundary

- Replit/Linux checks can validate TypeScript, Rust unit behavior, synthetic worker signals, and fake stem inference.
- Real Windows installation, upgrade, WebView, audio-device, MIDI hardware, codecs, external drive/USB, removable-drive relinking, CPU model performance, and rekordbox round-trip are **not verified** here.
- Do not market the current build as Windows-ready or as a replacement for rekordbox/other DJ software.