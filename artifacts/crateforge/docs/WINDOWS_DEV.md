# Windows development setup

This guide applies to the current Tauri 2 + React/Vite project. It does not describe the Electron/Python architecture in the original product prompt.

## Prerequisites

1. Windows 10 version 22H2 or Windows 11, x64.
2. Node.js LTS compatible with the workspace and Corepack-enabled pnpm. Use the `packageManager` version in the workspace root.
3. Rust stable with the MSVC target and the Visual Studio C++ Build Tools workload (MSVC, Windows SDK, and linker).
4. Microsoft Edge WebView2 Runtime. The Tauri desktop shell uses the system WebView2 runtime.
5. Python 3.12 or newer with pip is needed on the build machine to stage the bundled Windows stem runtime. It is not a user prerequisite after installation.

The standard installer downloads a verified CPython embeddable runtime and pinned Windows x64 wheels; model weights download to the user's local cache at first use. A separate offline ZIP bundle includes the small app installer and all three model profiles (about 2.25 GB). Audio is never uploaded. See `STEM-MODEL-GUIDE.md`.

## Install and run

Open PowerShell in the workspace root:

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @workspace/crateforge run typecheck
pnpm --filter @workspace/crateforge run test:audio
pnpm --filter @workspace/crateforge run test:stems
pnpm --filter @workspace/crateforge run dev
```

The last command opens the browser preview, not the native desktop shell. To launch Tauri:

```powershell
pnpm --filter @workspace/crateforge run desktop -- dev
```

To build an unsigned NSIS installer locally:

```powershell
pnpm --filter @workspace/crateforge run verify
pnpm --filter @workspace/crateforge run desktop -- build --bundles nsis
```

The expected Tauri output is under `artifacts/crateforge/src-tauri/target/release/bundle/nsis/`. Confirm the actual generated path and installer contents for the toolchain in use.

To build the separate all-model offline bundle:

```powershell
pnpm --filter @workspace/crateforge run bundle:windows:offline
```

This build downloads and SHA-256-verifies the pinned model files, then creates a ZIP bundle in `artifacts/crateforge/release-installers/`. The ZIP contains a freshly built runtime-only app installer, all model files, and `Install-Offline.ps1`, which verifies and installs the models locally. The existing runtime-only installer is restored byte-for-byte after packaging. Interrupted model-file downloads resume on a later build. The default build command remains the small installer.

## Bundled stem runtime

The Decks setup panel checks the runtime and whether the selected model is bundled. No system Python selection or package installation is required. The bundled ONNX Runtime uses DirectML on compatible Windows devices with CPU fallback. In the standard installer, built-in model weights download to the local cache the first time a profile is used. After installing through the offline bundle's script, all three profiles are local. Test a short, non-sensitive audio file first.

## Windows verification required before release

Run `docs/WINDOWS_RELEASE_CHECKLIST.md` on a clean Windows 10 22H2 and Windows 11 x64 machine. Include a standard non-admin user, a clean install, an upgrade, a retained-library uninstall test, external drives with changed letters, long/Unicode paths, supported audio formats, at least one physical output device, MIDI hardware, and real stem separation with both DirectML and CPU fallback. Record the machine, OS build, app commit, GPU/device driver, codec, model/license, and results. A successful Linux build or CI job is not a substitute.