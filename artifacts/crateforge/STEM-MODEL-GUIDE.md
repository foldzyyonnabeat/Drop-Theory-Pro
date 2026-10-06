# Local stem separation

The Windows x64 Drop Theory Pro installer includes CPython 3.13.15 and the pinned `demucs-onnx` and ONNX Runtime DirectML packages. Users do not need to select Python or install packages. Audio is processed on the device and is never uploaded.

## GPU and CPU processing

The bundled ONNX Runtime selects DirectML on compatible Windows systems and keeps its CPU provider available as a fallback. The Decks setup panel reports the provider exposed by the installed runtime. The build currently targets the Windows x64 NSIS installer; it does not claim GPU support for the browser preview or other desktop platforms.

## Model profiles and installer options

Choose one of the built-in four-stem profiles in the Decks view:

- **HTDemucs FT** — highest benchmarked quality; about 1.26 GB of model weights.
- **HTDemucs FT Compact** — smaller model weights; about 660 MB.
- **HTDemucs** — faster, single-model profile; about 316 MB.

The standard Windows installer stays small and includes the runtime only. Use **Download model weights** in the model setup panel to prepare the selected profile before separating audio. It shows progress across each weight file and offers **Retry model download** after a failure. Completed files remain in the local cache. If you skip this step, first separation still downloads the weights automatically and needs an internet connection.

Cached weights are checked locally without contacting Hugging Face again. Downloads use resumable HTTPS with longer network timeouts and bounded retries for interrupted connections or temporary server errors. Audio is never sent to Hugging Face.

The separate **all-model offline bundle** is a ZIP package containing the small Windows app installer and the weights for all three profiles (about 2.25 GB). Extract the ZIP and run `Install-Offline.ps1`; it installs the app, verifies the model files, and copies them into the app's resource folder. After setup, all profiles work without downloading model files or connecting to Hugging Face. Track audio remains local in either option. Allow about 5 GB of temporary free disk space while the extracted bundle and installed models coexist.

The offline bundle includes files from pinned Hugging Face revisions and records each file's source revision, size, and SHA-256 in `stem-models/bundle-manifest.json`. The setup script verifies these hashes before and after copying. The standard installer remains runtime-only and lets the upstream runtime download selected weights to its local cache.

## Batch analysis and manual tags

Library Health can analyze available audio tracks sequentially, shows progress, and supports cancellation. BPM, key, and energy estimates remain separate until applied. Use **Edit BPM/key** on any track row to enter or correct BPM and key manually; those saved values can be protected from later estimates with the manual-value lock.

## Local cache and device limits

Separated vocals, drums, bass, and other stems are stored in Drop Theory Pro's local app-data cache and reused for the same track and model profile. Model weights and generated stems can use substantial disk space. Deleting cache folders while the app is open is not recommended.

Separation speed and memory use depend on the selected profile, track length, CPU, GPU, and drivers. CPU fallback may take several minutes per track. Test with a short, non-sensitive audio file before processing a large library.

## Building the Windows app

The standard installer build remains:

```powershell
pnpm --filter @workspace/crateforge run desktop -- build --bundles nsis
```

Build the offline bundle separately:

```powershell
pnpm --filter @workspace/crateforge run bundle:windows:offline
```

The offline build stages all pinned model files, verifies SHA-256 digests, and resumes interrupted model downloads. It creates a ZIP under `artifacts/crateforge/release-installers/` containing the regular runtime-only installer, model files, a manifest, and the offline setup script. Building requires Python 3.12 or newer with pip and internet access on the build machine. Installing the offline bundle requires no network connection on the Windows PC.