const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const sourcePath = path.join(__dirname, 'local-library.ts');
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const moduleValue = { exports: {} };
const testRequire = id => id === '@tauri-apps/api/core' ? { invoke: async () => null, isTauri: () => false } : require(id);
vm.runInNewContext(compiled, { module: moduleValue, exports: moduleValue.exports, require: testRequire }, { filename: sourcePath });
const { analysisApplyPatch } = moduleValue.exports;

const track = {
  bpm: 118,
  key: '8A',
  energy: 4,
  durationSeconds: 200,
  analysis: { bpm: 122, key: '9A', energy: 7, durationSeconds: 190, analyzedAt: '2026-01-01T00:00:00.000Z', version: 'test' },
  lockedFields: [],
};

test('applying an analysis updates unlocked values', () => {
  const patch = analysisApplyPatch(track);
  assert.equal(patch.bpm, 122);
  assert.equal(patch.key, '9A');
  assert.equal(patch.energy, 7);
  assert.equal(patch.durationSeconds, 190);
  assert.equal(patch.analyzed, true);
});

test('manual locks preserve selected metadata while other estimates apply', () => {
  const patch = analysisApplyPatch({ ...track, lockedFields: ['bpm', 'durationSeconds'] });
  assert.equal(patch.bpm, 118);
  assert.equal(patch.durationSeconds, 200);
  assert.equal(patch.key, '9A');
  assert.equal(patch.energy, 7);
});

test('a track without an analysis has no apply patch', () => {
  assert.equal(Object.keys(analysisApplyPatch({ ...track, analysis: null })).length, 0);
});