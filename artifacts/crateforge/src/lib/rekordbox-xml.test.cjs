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
const runtimeRequire = name => name === '@tauri-apps/api/core'
  ? { invoke: async () => undefined, isTauri: () => false }
  : require(name);
vm.runInNewContext(compiled, {
  module: moduleValue,
  exports: moduleValue.exports,
  require: runtimeRequire,
  globalThis,
  crypto: globalThis.crypto,
  URL,
}, { filename: sourcePath });
const { exportRekordboxXml, parseRekordboxXml } = moduleValue.exports;

const track = {
  id: 'one', title: 'One & Two', artist: 'A DJ', album: 'Set "One"', genre: 'House',
  year: 2024, durationSeconds: 210, bpm: 124, key: '8A', energy: 7, rating: 5,
  fileName: 'one.mp3', filePath: 'C:\\Music\\one.mp3', fileSize: 1000, contentHash: null,
  source: 'audio', analyzed: true, createdAt: '2026-01-01T00:00:00.000Z',
};
const crate = {
  id: 'crate-1', name: 'Wedding / Dinner', color: '#62d5c4', trackIds: ['one'],
  kind: 'crate', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};

test('rekordbox XML export escapes metadata and includes collection and playlists', () => {
  const xml = exportRekordboxXml([track], [crate]);
  assert.match(xml, /Name="One &amp; Two"/);
  assert.match(xml, /Album="Set &quot;One&quot;"/);
  assert.match(xml, /Year="2024"/);
  assert.match(xml, /Rating="255"/);
  assert.match(xml, /<NODE Type="0" Name="Wedding \/ Dinner"/);
  assert.match(xml, /<TRACK Key="1" \/>/);
});

test('rekordbox XML import reads tracks and nested playlist folders without touching a live database', () => {
  const xml = `<?xml version="1.0"?>
    <DJ_PLAYLISTS Version="1.0">
      <COLLECTION Entries="1">
        <TRACK TrackID="15" Name="One &amp; Two" Artist="A DJ" Album="Set &quot;One&quot;" Genre="House" Year="2024" TotalTime="210" AverageBpm="124.4" Tonality="8A" Rating="204" Location="file://localhost/C:/Music/one.mp3" />
      </COLLECTION>
      <PLAYLISTS><NODE Type="0" Name="ROOT"><NODE Type="1" Name="Wedding"><NODE Type="0" Name="Dinner"><TRACK Key="15" /></NODE></NODE></NODE></PLAYLISTS>
    </DJ_PLAYLISTS>`;
  const parsed = parseRekordboxXml(xml);
  assert.equal(parsed.tracks.length, 1);
  assert.equal(parsed.tracks[0].title, 'One & Two');
  assert.equal(parsed.tracks[0].bpm, 124.4);
  assert.equal(parsed.tracks[0].rating, 4);
  assert.equal(parsed.tracks[0].filePath, 'C:\\Music\\one.mp3');
  assert.equal(parsed.crates.length, 1);
  assert.equal(parsed.crates[0].name, 'Wedding / Dinner');
  assert.deepEqual(Array.from(parsed.crates[0].trackIds), [parsed.tracks[0].id]);
});

test('rekordbox XML rejects DTDs and missing collections', () => {
  assert.throws(() => parseRekordboxXml('<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///etc/passwd">]><x/>'), /DOCTYPE/);
  assert.throws(() => parseRekordboxXml('<DJ_PLAYLISTS><PLAYLISTS/></DJ_PLAYLISTS>'), /COLLECTION/);
  assert.throws(() => parseRekordboxXml('<DJ_PLAYLISTS><COLLECTION></DJ_PLAYLISTS></COLLECTION>'), /unmatched closing/);
});