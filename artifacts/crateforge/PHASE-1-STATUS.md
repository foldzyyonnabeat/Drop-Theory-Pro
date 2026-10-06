# Drop Theory Pro — Phase 1 status

## Summary

This file records the Phase 1 browser-preview baseline, not the current implementation status. The feature table below describes that milestone; use `PHASE-ROADMAP.md` for the current phase-by-phase status. Library metadata, MIDI mappings, and imported audio bytes in the browser preview stay in this browser's IndexedDB; audio is not uploaded.

## Feature status

| Feature | Status | Notes |
| --- | --- | --- |
| Overview, library, crates, and library-health screens | Working | Responsive navigation; library search, filters, sorting, and track inspection. |
| Demo library | Working | Synthetic tracks and crates only; no real recordings are included. |
| Audio-file import | Working in browser preview | Selects common audio formats, estimates duration through browser media support, hashes files up to 150 MB for duplicate detection, and stores audio bytes in IndexedDB. Storage-quota failures are reported; native folder scanning remains a separate desktop path. |
| CSV import/export | Working | CSV import supports quoted fields; exported CSV can be used as a metadata backup. |
| M3U/M3U8 import/export | Working | Playlist entries and EXTINF titles/durations are read. Browser imports do not guarantee usable OS file paths in a separately exported playlist. |
| Track metadata editing and removal | Working | Includes a short-lived undo for removal. |
| Crate creation, editing, and membership | Working | Crates and membership are local metadata. |
| BPM/key/energy analysis | Local preview analyzer | Estimates BPM, key, and energy in a Web Worker. Results are saved separately from imported/manual metadata and require an explicit apply action. Estimates need validation against trusted references. |
| Persistent Windows library access / folder watching | Not implemented | A browser file picker cannot provide the native path and background-watching behavior required by the desktop app. |
| Playback and decks | Browser prototype | Two browser audio players can be mixed locally with 3-band EQ, pitch adjustment, a settable cue point, a 4-second loop, and a master compressor. Native low-latency playback, hardware output routing, and waveforms are not implemented. |
| Stems | Not implemented | No separation model is bundled or run. |
| MIDI controller mappings | Partial | Web MIDI discovery and learnable local bindings work where the browser or webview supports Web MIDI. Windows compatibility is unverified. |

## Local operation and limits

- No account, cloud database, paid API, or audio upload is used.
- Library metadata, controller mappings, and imported audio bytes are scoped to this browser origin and device. Clearing browser site data can remove them; export CSV before clearing data if a metadata backup is needed.
- Imported browser audio is retained in IndexedDB and restored after reload when the browser permits it. Quota varies by browser; failed writes are reported and the current session remains playable.
- Audio tags are not extracted in this phase. Initial artist/title values are inferred from filenames and can be edited manually.
- A future native Windows build needs its own local file-access, storage, installer, and audio-engine verification.

## Verification

- `pnpm --filter @workspace/crateforge run typecheck` — passed.
- `pnpm --filter @workspace/crateforge run test:audio` — passed (7 checks for mixer EQ/crossfader, beat loops, MIDI messages, and synthetic analysis).
- `cargo fmt --check` and `cargo test --lib` — passed (3 Rust tests).
- Browser and desktop-mode production builds — passed; Vite reports a non-blocking existing tooltip sourcemap warning.
- `artifacts/crateforge: web` — restarted and serving the preview.
- Browser preview screenshot — rendered at 1440×900.
- Analyzer-worker sanity check on synthetic 120 BPM audio returned 120.2 BPM, A major, and energy 6; this is not a real-library accuracy benchmark.
- Windows 10/11 — not verified; this Linux environment has no Windows host or MIDI hardware, and the Tauri installer bundle is disabled.
- Browser interaction tests for IndexedDB restoration, real MIDI devices, and real-library analysis accuracy — not yet added.

## Windows verification checklist

**Release gate: NOT PASSED.** No Windows installer was built or installed, and no Windows 10/11 machine or physical MIDI controller was available for this verification. Tauri NSIS bundling is now configured, but it has not been built or installed on Windows. These entries are not passes; run them on actual Windows machines before claiming Windows readiness.

| Verification | Windows 10 | Windows 11 | Result / evidence |
| --- | --- | --- | --- |
| Build a clean installer and install from a clean machine | Not run | Not run | No Windows build host/package available; bundling is disabled. |
| First launch, repeat launch, and launch after reboot | Not run | Not run | Requires an installed Windows package. |
| Upgrade an existing install and verify uninstall/data behavior | Not run | Not run | Requires installable packages from consecutive versions. |
| Scan a selected music folder and retain library/settings after restart | Not run | Not run | Native persistence and folder scanning have not been exercised on Windows. |
| Scan the advertised extension set (`mp3`, `flac`, `wav`, `aif`, `aiff`, `m4a`, `mp4`, `ogg`, `opus`) and verify actual decoder/metadata behavior | Not run | Not run | The native scanner has an extension allowlist; this is not proof that Windows playback or codecs support every format. |
| Read Unicode folder/file names and metadata correctly | Not run | Not run | Needs Windows paths and representative files. |
| Scan paths beyond the traditional 260-character limit | Not run | Not run | Long-path policy and behavior need verification on Windows. |
| Scan from removable storage; disconnect, reconnect, and report a missing source clearly | Not run | Not run | Needs a removable drive and Windows restart/reconnect checks. |
| Verify source audio remains in place and local library data stays local | Not run | Not run | Needs inspection during a real Windows install and scan. |
| Connect class-compliant USB MIDI and a representative DJ controller; discover inputs and learn mappings | Not run | Not run | Web MIDI behavior in the Windows WebView and device compatibility are unknown. |
| Confirm learned MIDI mappings persist, controls trigger the intended actions, and disconnect/reconnect is reported | Not run | Not run | Requires real MIDI devices and repeat-launch testing. |
| Verify audio output and device-change behavior | Not run | Not run | Requires Windows audio devices; selectable output routing is not implemented yet. |
| Verify BPM/key analysis against a trusted reference library | Not run | Not run | No Windows reference run has been performed. |

Run the full matrix on clean Windows 10 and Windows 11 machines, record OS build, app/package version, device models, observed results, and any failures here. Do not change a row to pass based only on Linux compilation or browser-preview behavior.

## Pause point

Phase 1 remains a completed browser-preview milestone, not a finished Windows DJ application. The full product scope has since been approved; implementation status and Windows verification gates are tracked in `PHASE-ROADMAP.md`.
