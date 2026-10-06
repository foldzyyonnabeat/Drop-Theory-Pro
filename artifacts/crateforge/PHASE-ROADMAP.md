# Drop Theory Pro — full product roadmap

## Product boundary

Drop Theory Pro is a local-first Windows DJ workstation. Music files stay in user-selected folders; the app stores library metadata and analysis results on-device. No account, cloud library, paid audio API, or audio upload is part of the plan.

The existing React/Vite browser preview remains available for development and library-only use. The desktop target is Tauri 2 with a Rust native layer so persistent Windows file access and audio/hardware work do not depend on browser file-picker permissions.

## Phases

| Phase | Scope | Exit criteria | Status |
| --- | --- | --- | --- |
| 1. Browser library preview | Local browser metadata, demo data, imports/exports, track editing, crates, and health view. | Core library flows work in the preview; limitations and Windows checks are documented. | Complete |
| 2. Windows library foundation | Tauri desktop shell, user-selected music folders, durable local metadata database, tag reading, re-scan and source-missing states. Keep audio files in place. | Folder access survives restart; scanning/import and library edits persist; browser preview still works; Windows file paths never leave the machine. | Local scanning, persistent metadata, metadata-only backup/restore, and missing-source deck handling are implemented. Moved-file reconciliation and Windows path/restart behavior remain unverified. |
| 3. Playback and mixing | Native audio engine, two decks, transport, cue/loop controls, tempo/pitch, waveforms, gain, EQ, and crossfader. | Two local tracks can mix reliably with clear device/error states and no accidental clipping. | Native CPAL/Symphonia playback and two-deck mixing are implemented, with recoverable device errors and locally persisted output selection. Windows device/codec behavior and no-clipping performance still require hardware verification. |
| 4. On-device track preparation | Offline BPM, key, beat-grid, waveform, and energy analysis with editable results and a local analysis cache. | Analysis can be cancelled/retried; results are reproducible and clearly separated from imported/manual metadata. | Local BPM/key/energy estimates, bounded beat-grid and waveform previews, and persisted per-track analysis results are implemented. Trusted-track accuracy validation remains; synthetic tests do not establish real-world accuracy. |
| 5. Offline stems | Legally redistributable or explicitly user-installed local separation model; vocal, drums, bass, and other controls. | Separation works without sending audio off-device; model size, compatibility, progress, cancellation, and cached output are handled. | User-installed CPU ONNX separation and runtime failure coverage are implemented. Windows model/runtime, memory, and audio-device verification remain. |
| 6. Controller and audio-device support | MIDI device discovery, controller mappings, user-editable bindings, audio output selection, and monitoring/routing where supported. | Supported devices are documented and tested on Windows; disconnects and unsupported controls fail visibly. | Web MIDI mappings, local output selection persistence, and recoverable disconnect errors are implemented. Windows controller/device testing and monitoring/routing verification remain. |
| 7. Windows packaging and release verification | Installer, upgrades, backup/recovery, migration, and performance checks. | Clean Windows 10/11 install and upgrade are tested; library survives restart and recovery; supported codecs and representative hardware pass. | NSIS bundling is enabled and a Windows icon is configured; no installer has been built or installed on Windows. Clean install/upgrade, recovery, codec, performance, and hardware checks remain unverified (see the Windows verification checklist in `PHASE-1-STATUS.md`). |

The implementation statuses above do not mean the release exit criteria have passed. Windows installation, device, codec, and representative-track checks still require a real Windows environment.
## Implementation rules

- Keep the browser preview useful; native APIs must have a clear unsupported state in a normal browser rather than breaking the preview.
- Store file references, tags, settings, analysis, and crate data locally. Do not copy audio unless the user explicitly requests an export or model cache.
- Offline stem separation never bundles or downloads model weights. Require a user-selected model folder, an explicitly checked permissive license, and a local Python/ONNX Runtime CPU installation; see `STEM-MODEL-GUIDE.md`.
- Keep audio decoding and real-time mixing off the React render path.
- Do not claim Windows readiness until the Windows verification phase has passed on Windows hardware.
