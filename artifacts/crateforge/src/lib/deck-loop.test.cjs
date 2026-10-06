const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const sourcePath = path.join(__dirname, 'deck-loop.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;
const loopModule = { exports: {} };
vm.runInNewContext(compiled, {
  module: loopModule,
  exports: loopModule.exports,
  require,
}, { filename: sourcePath });

const { getLoopDurationSeconds } = loopModule.exports;

test('beat-synced loop duration follows track BPM', () => {
  assert.equal(getLoopDurationSeconds(120, 4, 10), 2);
  assert.equal(getLoopDurationSeconds(110, 2, 10), 120 / 110);
});

test('loop duration falls back to four seconds without BPM and clamps to track length', () => {
  assert.equal(getLoopDurationSeconds(null, 4, 10), 4);
  assert.equal(getLoopDurationSeconds(0, 8, 10), 4);
  assert.equal(getLoopDurationSeconds(120, 8, 1), 1);
  assert.equal(getLoopDurationSeconds(120, 4, 0), 0);
});