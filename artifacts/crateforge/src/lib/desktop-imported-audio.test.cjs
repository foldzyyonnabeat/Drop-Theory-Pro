const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

function loadTypeScriptModule(sourcePath) {
  const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const moduleValue = { exports: {} };
  vm.runInNewContext(compiled, {
    module: moduleValue,
    exports: moduleValue.exports,
    require,
    Blob,
    Uint8Array,
  }, { filename: sourcePath });
  return moduleValue.exports;
}

const libDirectory = __dirname;
const {
  deleteDesktopImportedAudio,
  findMissingDesktopImportedAudioTrackIds,
  listDesktopImportedAudio,
  loadDesktopImportedAudioTrack,
  releaseDesktopImportedAudioTrack,
  retainDesktopImportedAudioTrack,
  selectNewDesktopAudioAssignments,
  saveDesktopImportedAudio,
} = loadTypeScriptModule(path.join(libDirectory, 'desktop-imported-audio.ts'));

test('desktop import saves only returned new track IDs with their original source files', async () => {
  const importedTracks = [
    { id: 'new-first' },
    { id: 'duplicate-track' },
    { id: 'new-last' },
  ];
  const audioFiles = [
    { name: 'first.wav', bytes: [1, 2] },
    { name: 'duplicate.wav', bytes: [3, 4] },
    { name: 'last.wav', bytes: [5, 6] },
  ];
  const addedTracks = [importedTracks[0], importedTracks[2]];
  const assignments = selectNewDesktopAudioAssignments(importedTracks, audioFiles, addedTracks);

  assert.deepEqual(assignments.map(({ trackId, file }) => [trackId, file.name]), [
    ['new-first', 'first.wav'],
    ['new-last', 'last.wav'],
  ]);

  const savedAudio = new Map([
    ['duplicate-track', [99]],
  ]);
  const saveCalls = [];
  const invoke = async (command, args) => {
    saveCalls.push({ command, args });
    if (command === 'save_imported_audio') {
      savedAudio.set(args.trackId, Array.from(args.audioBytes));
    }
  };
  for (const { trackId, file } of assignments) {
    await saveDesktopImportedAudio(trackId, file.name, new Blob([new Uint8Array(file.bytes)]), invoke);
  }

  assert.deepEqual(saveCalls.map(({ args }) => args.trackId), ['new-first', 'new-last']);
  assert.deepEqual(savedAudio.get('new-first'), [1, 2]);
  assert.deepEqual(savedAudio.get('new-last'), [5, 6]);
  assert.deepEqual(savedAudio.get('duplicate-track'), [99]);
});

test('desktop import rejects mismatched track and source-file lists', () => {
  assert.throws(
    () => selectNewDesktopAudioAssignments([{ id: 'track-one' }], [], [{ id: 'track-one' }]),
    /Imported audio tracks and source files are out of sync/,
  );
});

test('a failed desktop audio save can be retried for the same track without changing another track', async () => {
  const trackId = 'retry-track';
  const otherTrackId = 'untouched-track';
  const originalAudio = new Blob([new Uint8Array([7, 8, 9])]);
  const managedAudio = new Map([[otherTrackId, [44, 55]]]);
  const calls = [];
  let saveAttempts = 0;
  const invoke = async (command, args) => {
    calls.push({ command, args });
    if (command === 'save_imported_audio') {
      saveAttempts++;
      if (saveAttempts === 1) throw new Error('Temporary disk error.');
      managedAudio.set(args.trackId, Array.from(args.audioBytes));
      return undefined;
    }
    if (command === 'load_imported_audio') {
      return Object.fromEntries(args.trackIds.flatMap(id => managedAudio.has(id) ? [[id, managedAudio.get(id)]] : []));
    }
  };

  await assert.rejects(
    saveDesktopImportedAudio(trackId, 'retry.wav', originalAudio, invoke),
    /Temporary disk error/,
  );
  const retainedSource = await loadDesktopImportedAudioTrack(trackId, invoke);
  assert.deepEqual(Array.from(new Uint8Array(await retainedSource.arrayBuffer())), [7, 8, 9]);

  await saveDesktopImportedAudio(trackId, 'retry.wav', retainedSource, invoke);
  assert.deepEqual(managedAudio.get(trackId), [7, 8, 9]);
  assert.deepEqual(managedAudio.get(otherTrackId), [44, 55]);
  assert.deepEqual(calls.filter(call => call.command === 'save_imported_audio').map(call => call.args.trackId), [
    trackId,
    trackId,
  ]);

  const savedAudio = await loadDesktopImportedAudioTrack(trackId, invoke);
  assert.deepEqual(Array.from(new Uint8Array(await savedAudio.arrayBuffer())), [7, 8, 9]);
  assert.equal(calls.filter(call => call.command === 'load_imported_audio').length, 1);
  releaseDesktopImportedAudioTrack(trackId);
});

test('repeated desktop audio save failures keep the original source available for another retry', async () => {
  const trackId = 'repeat-failure-track';
  const originalAudio = new Blob([new Uint8Array([12, 34, 56])]);
  const calls = [];
  const invoke = async (command, args) => {
    calls.push({ command, args });
    if (command === 'save_imported_audio') throw new Error('Disk remains full.');
    if (command === 'load_imported_audio') return {};
  };

  await assert.rejects(
    saveDesktopImportedAudio(trackId, 'repeat.wav', originalAudio, invoke),
    /Disk remains full/,
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    const retainedSource = await loadDesktopImportedAudioTrack(trackId, invoke);
    assert.deepEqual(Array.from(new Uint8Array(await retainedSource.arrayBuffer())), [12, 34, 56]);
    await assert.rejects(
      saveDesktopImportedAudio(trackId, 'repeat.wav', retainedSource, invoke),
      /Disk remains full/,
    );
  }

  assert.deepEqual(calls.filter(call => call.command === 'save_imported_audio').map(call => call.args.trackId), [
    trackId,
    trackId,
    trackId,
  ]);
  assert.equal(calls.filter(call => call.command === 'load_imported_audio').length, 0);
  releaseDesktopImportedAudioTrack(trackId);
});

test('undo keeps restored audio playable after a rejected save and retry clears the fallback', async () => {
  const track = { id: 'undo-track', title: 'Restored Track', fileName: 'restored.wav' };
  const restoredTracks = [];
  const playableTrackIds = new Set();
  const failedSaves = new Map();
  const originalAudio = new Blob([new Uint8Array([21, 34, 55])]);
  const managedAudio = new Map();
  const calls = [];
  let rejectSave = true;
  const invoke = async (command, args) => {
    calls.push({ command, args });
    if (command === 'save_imported_audio' && rejectSave) {
      throw new Error('Temporary disk error.');
    }
    if (command === 'save_imported_audio') {
      managedAudio.set(args.trackId, args.audioBytes);
      return undefined;
    }
    if (command === 'load_imported_audio') {
      return Object.fromEntries(args.trackIds.flatMap(id => managedAudio.has(id) ? [[id, managedAudio.get(id)]] : []));
    }
    throw new Error(`Unexpected command: ${command}`);
  };

  restoredTracks.push(track);
  try {
    await saveDesktopImportedAudio(track.id, track.fileName, originalAudio, invoke);
    playableTrackIds.add(track.id);
  } catch (error) {
    playableTrackIds.add(track.id);
    failedSaves.set(track.id, {
      fileName: track.fileName,
      audio: originalAudio,
      error: error instanceof Error ? error.message : 'Could not restore the saved local audio.',
    });
  }

  assert.deepEqual(restoredTracks, [track]);
  assert.equal(playableTrackIds.has(track.id), true);
  assert.match(failedSaves.get(track.id).error, /Temporary disk error/);
  const availableAfterFailure = await loadDesktopImportedAudioTrack(track.id, invoke);
  assert.deepEqual(
    Array.from(new Uint8Array(await availableAfterFailure.arrayBuffer())),
    [21, 34, 55],
  );
  assert.equal(calls.filter(call => call.command === 'load_imported_audio').length, 0);

  rejectSave = false;
  const failedSave = failedSaves.get(track.id);
  await saveDesktopImportedAudio(track.id, failedSave.fileName, failedSave.audio, invoke);
  playableTrackIds.add(track.id);
  failedSaves.delete(track.id);

  assert.equal(failedSaves.has(track.id), false);
  assert.equal(playableTrackIds.has(track.id), true);
  assert.deepEqual(Array.from(managedAudio.get(track.id)), [21, 34, 55]);
  const availableAfterRetry = await loadDesktopImportedAudioTrack(track.id, invoke);
  assert.deepEqual(
    Array.from(new Uint8Array(await availableAfterRetry.arrayBuffer())),
    [21, 34, 55],
  );
  assert.equal(calls.filter(call => call.command === 'load_imported_audio').length, 1);

  const app = fs.readFileSync(path.join(libDirectory, '..', 'App.tsx'), 'utf8');
  const undoStart = app.indexOf('setUndo({ message: `${track.title} removed`');
  const undoEnd = app.indexOf('window.setTimeout(() => setUndo(null)', undoStart);
  const undoAction = app.slice(undoStart, undoEnd);
  assert.match(undoAction, /setDesktopImportedAudioIds\(previous => new Set\(previous\)\.add\(track\.id\)\)/);
  assert.match(undoAction, /setFailedDesktopAudioSaves\(previous => new Map\(previous\)\.set\(track\.id,\s*\{/);
  assert.match(undoAction, /audio: audioSnapshot/);
});

test('startup checks which managed files exist without requesting their audio bytes', async () => {
  const trackIds = ['audio-one', 'audio-two'];
  const commands = [];
  const available = await listDesktopImportedAudio(trackIds, async (command, args) => {
    commands.push({ command, args });
    return ['audio-one', 'not-in-library'];
  });

  assert.equal(commands.length, 1);
  assert.equal(commands[0].command, 'list_imported_audio');
  assert.deepEqual(Array.from(commands[0].args.trackIds), trackIds);
  assert.deepEqual(Array.from(available), ['audio-one']);
});

test('missing managed-audio detection excludes saved audio and externally referenced tracks', () => {
  const missing = findMissingDesktopImportedAudioTrackIds([
    { id: 'saved-audio', source: 'audio' },
    { id: 'missing-audio', source: 'audio' },
    { id: 'external-audio', source: 'audio', filePath: '/music/external.wav' },
    { id: 'metadata-only', source: 'csv' },
  ], new Set(['saved-audio']));

  assert.deepEqual(Array.from(missing), ['missing-audio']);
});

test('restoring desktop audio replaces the saved bytes under the existing track ID', async () => {
  const storedAudio = new Map([['existing-track', [1, 2, 3]]]);
  const calls = [];
  await saveDesktopImportedAudio(
    'existing-track',
    'restored.wav',
    new Blob([new Uint8Array([9, 8, 7])]),
    async (command, args) => {
      calls.push({ command, args });
      if (command === 'save_imported_audio') storedAudio.set(args.trackId, Array.from(args.audioBytes));
    },
  );

  assert.deepEqual(calls.map(call => [call.command, call.args.trackId]), [
    ['save_imported_audio', 'existing-track'],
  ]);
  assert.deepEqual(storedAudio.get('existing-track'), [9, 8, 7]);
});

test('selected playback or processing loads only that track into a Blob', async () => {
  const commands = [];
  const audio = await loadDesktopImportedAudioTrack('audio-one', async (command, args) => {
    commands.push({ command, args });
    return { 'audio-one': [1, 2, 3] };
  });

  assert.equal(commands.length, 1);
  assert.equal(commands[0].command, 'load_imported_audio');
  assert.deepEqual(Array.from(commands[0].args.trackIds), ['audio-one']);
  assert.deepEqual(Array.from(new Uint8Array(await audio.arrayBuffer())), [1, 2, 3]);
  assert.equal(await loadDesktopImportedAudioTrack('missing', async () => ({})), null);
});

test('removal deletes only the managed copy and undo restores it under the same track ID', async () => {
  const originalAudio = new Blob([new Uint8Array([11, 22, 33])]);
  const managedCopies = new Map([
    ['audio-track', originalAudio],
    ['other-audio-track', new Blob([new Uint8Array([44])])],
  ]);
  const externalFiles = new Map([['/music/keep.wav', new Uint8Array([55, 66])]]);
  const calls = [];
  const invoke = async (command, args) => {
    calls.push({ command, args });
    if (command === 'delete_imported_audio') managedCopies.delete(args.trackId);
    if (command === 'save_imported_audio') {
      managedCopies.set(args.trackId, new Blob([new Uint8Array(args.audioBytes)]));
    }
  };

  await deleteDesktopImportedAudio('audio-track', invoke);
  assert.equal(managedCopies.has('audio-track'), false);
  assert.equal(managedCopies.has('other-audio-track'), true);
  assert.deepEqual(Array.from(externalFiles.get('/music/keep.wav')), [55, 66]);

  await saveDesktopImportedAudio('audio-track', 'track.wav', originalAudio, invoke);
  assert.deepEqual(
    Array.from(new Uint8Array(await managedCopies.get('audio-track').arrayBuffer())),
    [11, 22, 33],
  );
  assert.deepEqual(calls.map(call => [call.command, call.args.trackId]), [
    ['delete_imported_audio', 'audio-track'],
    ['save_imported_audio', 'audio-track'],
  ]);
  assert.equal(calls[1].args.fileName, 'track.wav');
});

test('a rejected desktop audio deletion keeps the track audio available and allows retry', async () => {
  const track = { id: 'audio-track', title: 'Test Track' };
  const tracks = [track];
  const originalAudio = new Blob([new Uint8Array([11, 22, 33])]);
  const calls = [];
  let rejectDelete = true;
  const invoke = async (command, args) => {
    calls.push({ command, args });
    if (command === 'load_imported_audio') return { 'audio-track': [11, 22, 33] };
    if (command === 'delete_imported_audio' && rejectDelete) {
      throw new Error('Audio file is in use.');
    }
    if (command === 'delete_imported_audio') return undefined;
  };
  const audioSnapshot = await loadDesktopImportedAudioTrack(track.id, invoke);

  await assert.rejects(deleteDesktopImportedAudio(track.id, invoke), /Audio file is in use/);
  retainDesktopImportedAudioTrack(track.id, audioSnapshot);
  assert.deepEqual(tracks, [track]);

  const availableAudio = await loadDesktopImportedAudioTrack(track.id, invoke);
  assert.deepEqual(
    Array.from(new Uint8Array(await availableAudio.arrayBuffer())),
    Array.from(new Uint8Array(await originalAudio.arrayBuffer())),
  );
  assert.equal(calls.filter(call => call.command === 'load_imported_audio').length, 1);

  rejectDelete = false;
  await deleteDesktopImportedAudio(track.id, invoke);
  tracks.splice(0, 1);
  assert.deepEqual(tracks, []);

  await loadDesktopImportedAudioTrack(track.id, invoke);
  assert.equal(calls.filter(call => call.command === 'load_imported_audio').length, 2);
  assert.deepEqual(
    calls.filter(call => call.command === 'delete_imported_audio').map(call => call.args.trackId),
    ['audio-track', 'audio-track'],
  );
});

test('App startup checks audio presence and components load imported audio on demand', () => {
  const app = fs.readFileSync(path.join(libDirectory, '..', 'App.tsx'), 'utf8');
  const decks = fs.readFileSync(path.join(libDirectory, '..', 'components', 'DecksWorkspace.tsx'), 'utf8');
  const stems = fs.readFileSync(path.join(libDirectory, '..', 'components', 'StemStudioWorkspace.tsx'), 'utf8');

  assert.match(app, /listDesktopImportedAudio\(trackIds, invoke\)/);
  assert.match(app, /selectNewDesktopAudioAssignments\(importedAudioTracks, audioFiles, addedTracks\)/);
  assert.match(app, /saveDesktopImportedAudio\(trackId, file\.name, file, invoke\)/);
  assert.match(app, /findMissingDesktopImportedAudioTrackIds\(\s*workspace\.tracks,\s*desktopImportedAudioIds,\s*\)/);
  assert.match(app, /Playback and analysis are unavailable until audio is restored/);
  assert.match(app, /onRestoreManagedAudio/);
  assert.match(app, /failedDesktopAudioSaves/);
  assert.match(app, /retryDesktopAudioSave\(trackId\)/);
  assert.match(app, /Retry save/);
  assert.match(app, /setDesktopImportedAudioIds\(previous => new Set\(previous\)\.add\(trackId\)\)/);
  assert.match(app, /DecksWorkspace[^>]*importedAudioTrackIds=\{desktopImportedAudioIds\}/);
  assert.match(app, /StemStudioWorkspace[^>]*importedAudioTrackIds=\{desktopImportedAudioIds\}/);
  assert.match(decks, /loadDesktopImportedAudioTrack\(track\.id, invoke\)/);
  assert.match(stems, /loadDesktopImportedAudioTrack\(selectedTrack\.id, invoke\)/);
});

test('missing-audio restore writes to the selected track instead of importing a duplicate', () => {
  const app = fs.readFileSync(path.join(libDirectory, '..', 'App.tsx'), 'utf8');
  const restoreStart = app.indexOf('const restoreMissingDesktopAudio = async');
  const restoreEnd = app.indexOf('const chooseDesktopAudioRestore', restoreStart);
  const restoreAction = app.slice(restoreStart, restoreEnd);

  assert.match(restoreAction, /saveDesktopImportedAudio\(trackId, file\.name, file, invoke\)/);
  assert.match(restoreAction, /workspace\.updateTrack\(trackId, \{ fileName: file\.name \}\)/);
  assert.doesNotMatch(restoreAction, /workspace\.addTracks/);
});

test('App removal and undo use the managed-audio delete and restore commands', () => {
  const app = fs.readFileSync(path.join(libDirectory, '..', 'App.tsx'), 'utf8').replace(/\r\n/g, '\n');
  const removeTrack = app.slice(
    app.indexOf('const removeTrack = async'),
    app.indexOf('const nav =', app.indexOf('const removeTrack = async')),
  );
  const catchStart = removeTrack.indexOf('} catch {');
  const catchEnd = removeTrack.indexOf('\n      }\n    }\n    removingTrackIdsRef.current.delete', catchStart);
  const failureBranch = removeTrack.slice(catchStart, catchEnd);

  assert.match(app, /deleteDesktopImportedAudio\(track\.id, invoke\)/);
  assert.notEqual(catchStart, -1);
  assert.notEqual(catchEnd, -1);
  assert.match(failureBranch, /if \(desktopAudioSnapshot\) retainDesktopImportedAudioTrack\(track\.id, desktopAudioSnapshot\)/);
  assert.match(failureBranch, /The track and audio are still available; try again\./);
  assert.match(failureBranch, /removingTrackIdsRef\.current\.delete\(track\.id\)/);
  assert.match(failureBranch, /return;/);
  assert.ok(
    failureBranch.indexOf('removingTrackIdsRef.current.delete(track.id)')
      < failureBranch.indexOf('return;'),
  );
  assert.ok(removeTrack.indexOf('workspace.deleteTrack(track.id)') > catchEnd);
  assert.match(app, /saveDesktopImportedAudio\(\s*track\.id,\s*snapshot\.fileName \?\? snapshot\.title/);
});