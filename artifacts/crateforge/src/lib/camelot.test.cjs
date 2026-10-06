const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const sourcePath = path.join(__dirname, 'camelot.ts');
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const moduleValue = { exports: {} };
vm.runInNewContext(compiled, { module: moduleValue, exports: moduleValue.exports }, { filename: sourcePath });
const { camelotForKey, formatKeyWithCamelot, musicalKeyForCamelot } = moduleValue.exports;

test('maps every major and minor pitch class to its Camelot wheel position', () => {
  const expected = [
    ['C major', '8B'], ['C♯ major', '3B'], ['D major', '10B'], ['D♯ major', '5B'],
    ['E major', '12B'], ['F major', '7B'], ['F♯ major', '2B'], ['G major', '9B'],
    ['G♯ major', '4B'], ['A major', '11B'], ['A♯ major', '6B'], ['B major', '1B'],
    ['C minor', '5A'], ['C♯ minor', '12A'], ['D minor', '7A'], ['D♯ minor', '2A'],
    ['E minor', '9A'], ['F minor', '4A'], ['F♯ minor', '11A'], ['G minor', '6A'],
    ['G♯ minor', '1A'], ['A minor', '8A'], ['A♯ minor', '3A'], ['B minor', '10A'],
  ];

  for (const [key, camelot] of expected) {
    assert.equal(camelotForKey(key), camelot, `${key} should map to ${camelot}`);
  }
});

test('accepts enharmonic spellings and normalized Camelot labels', () => {
  assert.equal(camelotForKey('Bb MINOR'), '3A');
  assert.equal(camelotForKey('Db major'), '3B');
  assert.equal(camelotForKey('9a'), '9A');
  assert.equal(musicalKeyForCamelot('9b'), 'G major');
});

test('formats key and Camelot together while leaving ambiguous keys unclassified', () => {
  assert.equal(formatKeyWithCamelot('A MAJOR'), 'A major · 11B');
  assert.equal(formatKeyWithCamelot('8A'), 'A minor · 8A');
  assert.equal(formatKeyWithCamelot('A'), 'A · —');
  assert.equal(camelotForKey(null), null);
  assert.equal(camelotForKey('A'), null);
});