# Drop Theory Pro

Drop Theory Pro is an early local-first DJ library and set-preparation app. The current project is a React/Vite interface with a Tauri 2 desktop shell and Rust native services. It is **not** the Electron/Python/FastAPI architecture described in the source prompt; that larger migration was not performed.

## What currently works

- Local library records, manual crates, metadata backup/restore, CSV/M3U playlists, and local audio import/playback.
- Local BPM/key/energy estimates and waveform/beat-grid summaries for supported audio paths.
- Two-deck playback/mixing, MIDI mapping UI, and optional CPU stem inference with a model installed by the user.
- Set templates with metadata-based order suggestions, explanations, manual reorder, saved plans, and M3U8 export.
- Import/export of a limited subset of rekordbox XML. The live rekordbox database is never opened or changed.
- A generated dependency-license inventory for the current JavaScript dependency tree.

See [`FEATURES.md`](./FEATURES.md) for the complete status. “Implemented” does not mean Windows-verified or commercially cleared.

## Privacy and safety

Audio files and model weights remain on the user's device. The app does not automatically download models, upload audio, or depend on a cloud analysis service. No cloud accounts, streaming OAuth, portal, payments, or telemetry are implemented. User-installed model/runtime dependencies are described in [`STEM-MODEL-GUIDE.md`](./STEM-MODEL-GUIDE.md).

Backups contain library metadata and file references, not audio, external files, models, or stem-cache data. Rekordbox export is a reviewable XML file only; it does not create a CDJ USB drive or modify a live rekordbox library.

## Development

From the workspace root:

```sh
pnpm --filter @workspace/crateforge run dev
pnpm --filter @workspace/crateforge run typecheck
pnpm --filter @workspace/crateforge run test:audio
pnpm --filter @workspace/crateforge run test:stems
pnpm --filter @workspace/crateforge run build
pnpm --filter @workspace/crateforge run verify
```

`dev` is the browser preview. To run the Tauri desktop shell locally, follow [`docs/WINDOWS_DEV.md`](./docs/WINDOWS_DEV.md). Native audio, MIDI hardware, codecs, installer behavior, and the full desktop flow have not been verified on Windows.

## Licensing inventory

Regenerate the resolved JavaScript dependency inventory and notices:

```sh
pnpm --filter @workspace/crateforge run licenses:generate
pnpm --filter @workspace/crateforge run drop-theory-pro -- licenses
```

Before preparing a release:

```sh
pnpm --filter @workspace/crateforge run licenses:check-release
```

That release guard blocks declared copyleft/non-commercial/proprietary JavaScript package licenses. It does not clear model weights, codecs, fonts, media, trademarks, Python packages, or service terms. Review [`docs/LICENSES_TO_PURCHASE.md`](./docs/LICENSES_TO_PURCHASE.md) and [`docs/LEGAL_CHECKLIST.md`](./docs/LEGAL_CHECKLIST.md).

## Windows status

The GitHub Actions workflow is a proposed build/test gate, not evidence of user acceptance. No Windows install, upgrade, audio-device, MIDI, codec, removable-drive, real-model, or rekordbox round-trip test has been completed. Do not describe this build as Windows-ready.