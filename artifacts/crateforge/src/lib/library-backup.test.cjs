const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const sourcePath = path.join(__dirname, 'library-backup.ts');
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const moduleValue = { exports: {} };
vm.runInNewContext(compiled, { module: moduleValue, exports: moduleValue.exports, require, globalThis }, { filename: sourcePath });
const { createLibraryBackup, mergeLibraryBackup, parseLibraryBackup } = moduleValue.exports;

const track = (id, extra = {}) => ({
  id, title: `Track ${id}`, artist: 'Artist', album: 'Album', genre: 'House', year: 2024,
  durationSeconds: 120, bpm: 120, key: '8A', energy: 6, rating: 4, fileName: `${id}.mp3`,
  filePath: `/music/${id}.mp3`, fileSize: 100, contentHash: `hash-${id}`, source: 'audio',
  analyzed: true, analysis: { bpm: 120, key: '8A', energy: 6, durationSeconds: 120, analyzedAt: '2024-01-01', version: '1', ...extra },
  createdAt: '2024-01-01',
});
const crate = (id, trackIds) => ({ id, name: id, color: '#fff', trackIds, createdAt: '2024-01-01', updatedAt: '2024-01-01' });

test('backup round trips metadata and preserves analysis without audio payloads', () => {
  const audioBytes = [68, 82, 79, 80, 84, 72, 69, 79, 82, 89];
  const sourceTrack = {
    ...track('one'),
    audio: audioBytes,
    audioBytes,
    sourceAudio: audioBytes,
  };
  const backup = createLibraryBackup({ tracks: [sourceTrack], crates: [crate('set', ['one'])] }, '2024-01-02');
  const parsed = parseLibraryBackup(JSON.stringify(backup));
  assert.equal(parsed.exportedAt, '2024-01-02');
  assert.deepEqual(Array.from(parsed.crates[0].trackIds), ['one']);
  assert.equal(parsed.tracks[0].analysis.bpm, 120);
  assert.equal(parsed.tracks[0].audio, undefined);
  assert.equal(parsed.tracks[0].audioBytes, undefined);
  assert.equal(parsed.tracks[0].sourceAudio, undefined);
  assert.equal(JSON.stringify(backup).includes(JSON.stringify(audioBytes)), false);
});

test('restore merges duplicates and remaps crate membership for imported tracks', () => {
  const existing = { tracks: [track('existing')], crates: [crate('existing-set', ['existing'])] };
  const incoming = createLibraryBackup({ tracks: [track('existing'), track('new')], crates: [crate('new-set', ['existing', 'new'])] });
  const result = mergeLibraryBackup(existing, incoming);
  assert.equal(result.duplicateTracks, 1);
  assert.equal(result.importedTracks, 1);
  assert.equal(result.importedCrates, 1);
  assert.equal(result.tracks.length, 2);
  assert.deepEqual(Array.from(result.crates.find(item => item.name === 'new-set').trackIds), ['existing', result.tracks.find(item => item.title === 'Track new').id]);
});

test('future and malformed backup versions are rejected visibly', () => {
  assert.throws(() => parseLibraryBackup(JSON.stringify({ format: 'crateforge-library-backup', version: 99, tracks: [], crates: [] })), /Unsupported backup version/);
  assert.throws(() => parseLibraryBackup('{not-json}'), /valid JSON/);
});