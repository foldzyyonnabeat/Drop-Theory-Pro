const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const sourcePath = path.join(__dirname, 'midi-types.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;
const midiModule = { exports: {} };
vm.runInNewContext(compiled, {
  module: midiModule,
  exports: midiModule.exports,
  require,
}, { filename: sourcePath });

const { getMidiActions } = midiModule.exports;
const normalizedActions = (...args) => JSON.parse(JSON.stringify(getMidiActions(...args)));

test('MIDI note bindings trigger once per press and release cleanly', () => {
  const bindings = [{ action: 'deck-a-play', channel: 1, command: 0x90, data1: 36 }];
  const activeButtons = new Set();
  assert.deepEqual(normalizedActions(Uint8Array.from([0x90, 36, 127]), bindings, activeButtons), [
    { action: 'deck-a-play', value: 1 },
  ]);
  assert.equal(activeButtons.has('deck-a-play'), true);
  assert.deepEqual(normalizedActions(Uint8Array.from([0x90, 36, 127]), bindings, activeButtons), []);
  assert.deepEqual(normalizedActions(Uint8Array.from([0x80, 36, 0]), bindings, activeButtons), []);
  assert.equal(activeButtons.has('deck-a-play'), false);
  assert.deepEqual(normalizedActions(Uint8Array.from([0x90, 36, 127]), bindings, activeButtons), [
    { action: 'deck-a-play', value: 1 },
  ]);
});

test('MIDI continuous controls normalize values and respect channel bindings', () => {
  const bindings = [{ action: 'crossfader', channel: 10, command: 0xb0, data1: 7 }];
  assert.deepEqual(normalizedActions(Uint8Array.from([0xb9, 7, 64]), bindings, new Set()), [
    { action: 'crossfader', value: 64 / 127 },
  ]);
  assert.deepEqual(normalizedActions(Uint8Array.from([0xb0, 7, 64]), bindings, new Set()), []);
  assert.deepEqual(normalizedActions(Uint8Array.from([0xb9, 7]), bindings, new Set()), [
    { action: 'crossfader', value: 0 },
  ]);
});