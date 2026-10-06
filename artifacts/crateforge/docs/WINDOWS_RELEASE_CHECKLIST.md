# Windows release acceptance checklist

**Current result: not run.** This file is a release gate, not evidence that the listed checks passed.

## Supported operating systems and install

- [ ] Clean install on Windows 10 22H2 x64 and Windows 11 x64.
- [ ] Install as a standard user without administrator privileges.
- [ ] Confirm WebView2 behavior when the runtime is present and absent.
- [ ] Upgrade from the prior signed build; verify settings, library records, and audio references remain intact.
- [ ] Verify the standard installer remains the small runtime-only package and downloads only the selected model on first use.
- [ ] Extract the all-model offline ZIP and run its setup script without network access; check all three profiles and confirm stem separation works for each.
- [ ] Confirm the offline bundle manifest hashes and the bundled model license notice match the installed files.
- [ ] Uninstall with both “keep user data” and “remove user data” choices, if implemented.
- [ ] Verify Start-menu shortcut, file associations, process exit, and installer rollback.
- [ ] Verify Authenticode signature, timestamp, publisher identity, SmartScreen behavior, and update channel before public distribution.

## Library and file-system behavior

- [ ] Import and scan MP3, FLAC, WAV, AIFF, M4A/AAC/ALAC, OGG, OPUS, and WMA with documented codec outcomes.
- [ ] Test Unicode, case-only filename differences, UNC paths, paths beyond 260 characters, locked files, and unsupported/corrupt files.
- [ ] Disconnect and reconnect an external drive with a changed drive letter; verify the app does not silently replace or discard records.
- [ ] Verify backup and restore on a different machine; confirm audio and stem caches are explicitly excluded.
- [ ] Verify rekordbox XML import/export using copied sample files and a disposable rekordbox test library. Never test by overwriting the user's live library.

## Audio, MIDI, stems, and hardware

- [ ] Test output-device selection, device disconnect/reconnect, sample rates, shared/exclusive behavior, latency, clipping, and two-deck playback.
- [ ] Test supported MIDI controllers and permissions in the packaged app; verify learn, mapping, and device re-open after restart.
- [ ] Test the stem model/runtime pair only with a model whose source and weights licenses permit the intended use.
- [ ] Measure CPU, peak memory, progress, cancellation, cache reuse, and audio quality on short and long files.
- [ ] Verify codec support for every imported audio format and every export encoder actually shipped.
- [ ] Verify no audio, model, or stem data leaves the machine during any of these checks.

## Acceptance evidence

- [ ] Attach logs, screenshots, installer checksum/signature details, OS build, device/driver versions, exact audio samples/licenses, model manifest/license, and test results.
- [ ] All P0/P1 issues resolved; all unsupported paths have an explicit user-facing explanation.
- [ ] Update `FEATURES.md` with **Verified on Windows** only for individually completed checks.