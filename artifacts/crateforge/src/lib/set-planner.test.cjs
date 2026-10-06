const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const camelotSourcePath = path.join(__dirname, 'camelot.ts');
const camelotCompiled = ts.transpileModule(fs.readFileSync(camelotSourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const camelotModule = { exports: {} };
vm.runInNewContext(camelotCompiled, {
  module: camelotModule,
  exports: camelotModule.exports,
}, { filename: camelotSourcePath });

const sourcePath = path.join(__dirname, 'set-planner.ts');
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const moduleValue = { exports: {} };
const testRequire = id => id === './camelot' ? camelotModule.exports : require(id);
vm.runInNewContext(compiled, { module: moduleValue, exports: moduleValue.exports, require: testRequire }, { filename: sourcePath });
const { camelotDistance, explainTransition, planSet, targetEnergy } = moduleValue.exports;

const track = (id, bpm, key, energy, durationSeconds = 240, rating = 3) => ({
  id, title: `Track ${id}`, artist: 'Test artist', album: '', genre: '', year: null,
  durationSeconds, bpm, key, energy, rating, fileName: `${id}.mp3`, fileSize: 1000,
  contentHash: null, source: 'demo', analyzed: true, createdAt: '2026-01-01T00:00:00.000Z',
});

test('Camelot distance identifies exact, relative, adjacent, and distant keys', () => {
  assert.equal(camelotDistance('8A', '8A'), 0);
  assert.equal(camelotDistance('8A', '8B'), 1);
  assert.equal(camelotDistance('8A', '9A'), 1);
  assert.equal(camelotDistance('A major', 'D major'), 1);
  assert.equal(camelotDistance('C♯ minor', 'D♭ minor'), 0);
  assert.ok(camelotDistance('1A', '7B') > 1);
  assert.equal(camelotDistance(null, '8A'), 3);
});

test('energy arcs stay inside the 1–10 scale and follow the requested shape', () => {
  assert.ok(targetEnergy('steady-rise', 0) < targetEnergy('steady-rise', 1));
  assert.ok(targetEnergy('peak-and-valley', 0.34) > targetEnergy('peak-and-valley', 0.62));
  assert.equal(targetEnergy('plateau', 0.5), 6.5);
  for (const arc of ['steady-rise', 'wave', 'peak-and-valley', 'plateau']) {
    for (let step = 0; step <= 20; step += 1) {
      const energy = targetEnergy(arc, step / 20);
      assert.ok(energy >= 1 && energy <= 10, `${arc} energy ${energy} is out of range`);
    }
  }
});

test('set planner chooses unique tracks, tracks duration, and reports incomplete coverage', () => {
  const tracks = [
    track('low', 100, '4A', 3),
    track('mid', 110, '5A', 6),
    track('high', 120, '6A', 9),
  ];
  const complete = planSet(tracks, { durationMinutes: 8, startBpm: 100, endBpm: 120, arc: 'steady-rise' });
  assert.equal(complete.complete, true);
  assert.equal(new Set(complete.tracks.map(item => item.id)).size, complete.tracks.length);
  assert.ok(complete.plannedSeconds >= 480);
  const short = planSet(tracks.slice(0, 1), { durationMinutes: 20, startBpm: 100, endBpm: 120, arc: 'wave' });
  assert.equal(short.complete, false);
  assert.equal(short.tracks.length, 1);
});

test('transition explanations are explicit about metadata-only limits', () => {
  const reason = explainTransition(track('a', 120, '8A', 5), track('b', 121, '8B', 6));
  assert.match(reason, /harmonically close/);
  assert.match(reason, /8A/);
  assert.match(reason, /metadata estimate/);
});