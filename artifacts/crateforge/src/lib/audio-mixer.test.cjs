const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

class MockParam {
  constructor(value = 0) {
    this.value = value;
    this.target = value;
  }

  setTargetAtTime(value) {
    this.target = value;
  }
}

class MockNode {
  constructor() {
    this.connections = [];
  }

  connect(node) {
    this.connections.push(node);
  }

  disconnect() {}
}

class MockGain extends MockNode {
  constructor() {
    super();
    this.gain = new MockParam(1);
  }
}

class MockFilter extends MockNode {
  constructor() {
    super();
    this.gain = new MockParam();
    this.frequency = new MockParam();
    this.Q = new MockParam();
    this.type = '';
  }
}

class MockCompressor extends MockNode {
  constructor() {
    super();
    this.threshold = new MockParam();
    this.knee = new MockParam();
    this.ratio = new MockParam();
    this.attack = new MockParam();
    this.release = new MockParam();
  }
}

class MockAudioContext {
  constructor() {
    this.state = 'running';
    this.currentTime = 0;
    this.destination = new MockNode();
  }

  createGain() { return new MockGain(); }
  createBiquadFilter() { return new MockFilter(); }
  createDynamicsCompressor() { return new MockCompressor(); }
  createMediaElementSource(element) { return Object.assign(new MockNode(), { element }); }
  async close() { this.state = 'closed'; }
}

const sourcePath = path.join(__dirname, 'audio-mixer.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;
const audioMixerModule = { exports: {} };
vm.runInNewContext(compiled, {
  module: audioMixerModule,
  exports: audioMixerModule.exports,
  require,
  AudioContext: MockAudioContext,
  window: { AudioContext: MockAudioContext },
}, { filename: sourcePath });

const { LocalAudioMixer, crossfaderGains } = audioMixerModule.exports;

test('crossfader clamps input and uses equal-power deck gains', () => {
  const left = crossfaderGains(-2);
  const center = crossfaderGains(0.5);
  const right = crossfaderGains(2);
  assert.equal(left.a, 1);
  assert.ok(Math.abs(left.b) < 1e-12);
  assert.ok(Math.abs(center.a - Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs(center.b - Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs(right.a) < 1e-12);
  assert.equal(right.b, 1);
});

test('mixer builds per-deck EQ and master peak compression, then disposes audio nodes', async () => {
  const mixer = new LocalAudioMixer();
  mixer.setDeckEq('a', 'low', 4);
  await mixer.play('a', { play: async () => {} });
  await mixer.play('b', { play: async () => {} });

  const deckA = mixer.decks.get('a');
  const deckB = mixer.decks.get('b');
  const context = mixer.context;
  assert.equal(deckA.low.type, 'lowshelf');
  assert.equal(deckA.low.frequency.value, 250);
  assert.equal(deckA.low.gain.value, 4);
  assert.equal(deckA.mid.type, 'peaking');
  assert.equal(deckA.high.type, 'highshelf');
  assert.equal(mixer.limiter.threshold.value, -1);

  mixer.setDeckEq('a', 'low', -3);
  mixer.setDeckGain('a', 0.5);
  mixer.setCrossfader(0.5);
  assert.equal(deckA.low.gain.target, -3);
  assert.ok(Math.abs(deckA.gain.gain.target - Math.SQRT1_2 * 0.5) < 1e-12);
  assert.ok(Math.abs(deckB.gain.gain.target - Math.SQRT1_2) < 1e-12);

  await mixer.dispose();
  assert.equal(context.state, 'closed');
  assert.equal(mixer.context, null);
});

test('UVR vocals and instrumental channels follow independent levels, crossfade, and EQ', async () => {
  const mixer = new LocalAudioMixer();
  await mixer.play('a', { play: async () => {} });
  const elements = {
    vocals: { play: async () => {} },
    instrumental: { play: async () => {} },
  };
  await mixer.playStems('a', mixer.decks.get('a').element, elements);

  const deck = mixer.decks.get('a');
  assert.equal(deck.stems.size, 2);
  assert.equal(deck.gain.gain.target, 0);
  assert.ok(Math.abs(deck.stems.get('vocals').gain.gain.target - Math.SQRT1_2) < 1e-12);

  mixer.setStemGain('a', 'vocals', 0.25);
  mixer.setDeckEq('a', 'low', -6);
  assert.ok(Math.abs(deck.stems.get('vocals').gain.gain.target - Math.SQRT1_2 * 0.25) < 1e-12);
  assert.equal(deck.stems.get('vocals').low.gain.target, -6);
  assert.equal(deck.stems.get('instrumental').low.gain.target, -6);

  mixer.setCrossfader(1);
  assert.ok(Math.abs(deck.stems.get('vocals').gain.gain.target) < 1e-12);
  mixer.setCrossfader(0);
  mixer.setStemMode('a', false);
  assert.equal(deck.stems.get('vocals').gain.gain.target, 0);
  assert.equal(deck.gain.gain.target, 1);
  await mixer.dispose();
});