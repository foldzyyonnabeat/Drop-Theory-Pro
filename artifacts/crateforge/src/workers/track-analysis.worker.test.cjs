const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const camelotPath = path.join(__dirname, '../lib/camelot.ts');
const camelotCompiled = ts.transpileModule(fs.readFileSync(camelotPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const camelotModule = { exports: {} };
vm.runInNewContext(camelotCompiled, {
  module: camelotModule,
  exports: camelotModule.exports,
}, { filename: camelotPath });

function loadWorker() {
  const sourcePath = path.join(__dirname, 'track-analysis.worker.ts');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const messages = [];
  const self = {
    onmessage: null,
    postMessage: message => messages.push(message),
  };
  const exports = {};
  vm.runInNewContext(compiled, {
    self,
    exports,
    Float32Array,
    Math,
    Array,
    Number,
    Infinity,
    require: id => id === '../lib/camelot' ? camelotModule.exports : require(id),
  }, { filename: sourcePath });
  return { self, messages };
}

function readMonoPcm16Wav(fileName) {
  const wav = fs.readFileSync(path.join(__dirname, 'fixtures', 'track-analysis', fileName));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF', `${fileName} must be a RIFF WAV`);
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE', `${fileName} must be a WAVE file`);

  let format;
  let dataOffset = -1;
  let dataSize = 0;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const chunkId = wav.toString('ascii', offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    assert.ok(chunkStart + chunkSize <= wav.length, `${fileName} has a truncated WAV chunk`);
    if (chunkId === 'fmt ') {
      format = {
        encoding: wav.readUInt16LE(chunkStart),
        channels: wav.readUInt16LE(chunkStart + 2),
        sampleRate: wav.readUInt32LE(chunkStart + 4),
        bitsPerSample: wav.readUInt16LE(chunkStart + 14),
      };
    } else if (chunkId === 'data') {
      dataOffset = chunkStart;
      dataSize = chunkSize;
    }
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  assert.ok(format, `${fileName} is missing a fmt chunk`);
  assert.notEqual(dataOffset, -1, `${fileName} is missing a data chunk`);
  assert.equal(format.encoding, 1, `${fileName} must use uncompressed PCM`);
  assert.equal(format.channels, 1, `${fileName} must be mono`);
  assert.equal(format.sampleRate, 11025, `${fileName} must use the worker's target sample rate`);
  assert.equal(format.bitsPerSample, 16, `${fileName} must use 16-bit samples`);
  assert.equal(dataSize % 2, 0, `${fileName} has an incomplete PCM sample`);

  const samples = new Float32Array(dataSize / 2);
  for (let index = 0; index < samples.length; index++) {
    samples[index] = wav.readInt16LE(dataOffset + index * 2) / 32768;
  }
  return { samples, sampleRate: format.sampleRate };
}

function normalizeKey(key) {
  const match = /^([A-G](?:[#♯b])?) (major|minor)$/.exec(key ?? '');
  assert.ok(match, `unexpected key label: ${key}`);
  const pitchClasses = {
    C: 0, 'C#': 1, 'C♯': 1, Db: 1,
    D: 2, 'D#': 3, 'D♯': 3, Eb: 3,
    E: 4, F: 5, 'F#': 6, 'F♯': 6, Gb: 6,
    G: 7, 'G#': 8, 'G♯': 8, Ab: 8,
    A: 9, 'A#': 10, 'A♯': 10, Bb: 10,
    B: 11,
  };
  return `${pitchClasses[match[1]]}:${match[2]}`;
}

test('worker estimates a synthetic 120 BPM A-major signal locally', () => {
  const { self, messages } = loadWorker();
  const sampleRate = 11025;
  const seconds = 18;
  const samples = new Float32Array(sampleRate * seconds);
  for (let i = 0; i < samples.length; i++) {
    const time = i / sampleRate;
    const beat = Math.pow(Math.max(0, 1 - ((time % 0.5) / 0.5)), 8);
    samples[i] = (
      Math.sin(2 * Math.PI * 110 * time) * 0.4
      + Math.sin(2 * Math.PI * 220 * time) * 0.22
      + Math.sin(2 * Math.PI * 330 * time) * 0.18
    ) * (0.25 + 0.75 * beat);
  }

  assert.equal(typeof self.onmessage, 'function');
  self.onmessage({
    data: {
      type: 'analyze',
      sampleRate,
      channels: [samples.buffer],
    },
  });

  const result = messages.find(message => message.type === 'done')?.result;
  assert.ok(result);
  assert.ok(Math.abs(result.bpm - 120) <= 2, `expected near 120 BPM, got ${result.bpm}`);
  assert.equal(result.key, 'A major');
  assert.equal(result.camelot, '11B');
  assert.ok(result.energy >= 1 && result.energy <= 10);
  assert.equal(result.durationSeconds, seconds);
  assert.ok(result.beatGridSeconds.length >= 30);
  assert.ok(result.beatGridSeconds.every((beat, index) => beat >= 0 && (index === 0 || beat > result.beatGridSeconds[index - 1])));
  assert.ok(result.waveform.length > 0 && result.waveform.length <= 1000);
  assert.ok(result.waveform.every(value => value >= 0 && value <= 1));
});

test('worker distinguishes slower, common, and faster tempos', () => {
  for (const bpm of [60, 90, 150]) {
    const { self, messages } = loadWorker();
    const sampleRate = 11025;
    const seconds = 24;
    const samples = new Float32Array(sampleRate * seconds);
    const beatLength = 60 / bpm;
    for (let i = 0; i < samples.length; i++) {
      const time = i / sampleRate;
      const beat = Math.pow(Math.max(0, 1 - ((time % beatLength) / beatLength)), 8);
      samples[i] = Math.sin(2 * Math.PI * 110 * time) * (0.25 + 0.75 * beat);
    }
    self.onmessage({ data: { type: 'analyze', sampleRate, channels: [samples.buffer] } });
    const result = messages.find(message => message.type === 'done')?.result;
    assert.ok(result);
    assert.ok(Math.abs(result.bpm - bpm) <= 2.5, `expected near ${bpm} BPM, got ${result.bpm}`);
  }
});

test('worker bounds compact waveform and beat-grid arrays for a long synthetic signal', () => {
  const { self, messages } = loadWorker();
  const sampleRate = 11025;
  const seconds = 120;
  const samples = new Float32Array(sampleRate * seconds);
  for (let i = 0; i < samples.length; i++) {
    const time = i / sampleRate;
    const beat = Math.pow(Math.max(0, 1 - ((time % 0.5) / 0.5)), 8);
    samples[i] = Math.sin(2 * Math.PI * 110 * time) * (0.2 + 0.8 * beat);
  }
  self.onmessage({ data: { type: 'analyze', sampleRate, channels: [samples.buffer] } });
  const result = messages.find(message => message.type === 'done')?.result;
  assert.ok(result);
  assert.ok(result.waveform.length <= 1000);
  assert.ok(result.beatGridSeconds.length <= 1000);
});

test('worker estimates BPM and key on locally bundled, licensed music excerpts', () => {
  const fixtures = [
    {
      file: 'time-flux.wav',
      bpmReferences: [115.010, 57.505],
      key: 'Bb minor',
    },
    {
      file: 'telluric-undercurrent.wav',
      bpmReferences: [115.988],
      key: 'C minor',
    },
    {
      file: 'scattered-knowledge.wav',
      bpmReferences: [87.995],
      key: 'F# minor',
    },
    {
      file: 'octopussy-rock.wav',
      bpmReferences: [96.123],
      key: 'A minor',
    },
    {
      file: 'digital-lightning-rock.wav',
      bpmReferences: [176.993, 88.4965],
      key: 'F# major',
    },
    {
      file: 'stickybee-folk.wav',
      bpmReferences: [87.909, 175.818],
      key: 'E minor',
    },
  ];

  for (const fixture of fixtures) {
    const { samples, sampleRate } = readMonoPcm16Wav(fixture.file);
    const { self, messages } = loadWorker();
    self.onmessage({
      data: {
        type: 'analyze',
        sampleRate,
        channels: [samples.buffer],
      },
    });

    const result = messages.find(message => message.type === 'done')?.result;
    assert.ok(result, `${fixture.file} should produce an analysis result`);
    assert.ok(
      fixture.bpmReferences.some(reference => Math.abs(result.bpm - reference) <= 4),
      `${fixture.file}: expected within 4 BPM of ${fixture.bpmReferences.join(' or ')}, got ${result.bpm}`,
    );
    assert.equal(
      normalizeKey(result.key),
      normalizeKey(fixture.key),
      `${fixture.file}: expected ${fixture.key}, got ${result.key}`,
    );
  }
});

test('worker corrects or declines syncopated excerpts instead of reporting a wrong pulse', () => {
  const fixtures = [
    {
      file: 'time-flux-syncopated.wav',
      bpmReferences: [115.010, 57.505],
    },
    {
      file: 'the-narrative-changes-syncopated.wav',
      bpmReferences: [93, 46.5],
      mayDecline: true,
    },
  ];

  for (const fixture of fixtures) {
    const { samples, sampleRate } = readMonoPcm16Wav(fixture.file);
    const { self, messages } = loadWorker();
    self.onmessage({
      data: {
        type: 'analyze',
        sampleRate,
        channels: [samples.buffer],
      },
    });

    const result = messages.find(message => message.type === 'done')?.result;
    assert.ok(result, `${fixture.file} should produce an analysis result`);
    if (result.bpm === null) {
      assert.equal(result.bpmConfidence, null, `${fixture.file} must not report confidence without a tempo`);
      assert.ok(fixture.mayDecline, `${fixture.file} should resolve to a reference-compatible tempo`);
      continue;
    }

    assert.ok(
      fixture.bpmReferences.some(reference => Math.abs(result.bpm - reference) <= 4),
      `${fixture.file}: expected within 4 BPM of ${fixture.bpmReferences.join(' or ')} or an explicit decline, got ${result.bpm}`,
    );
    assert.ok(result.bpmConfidence > 0, `${fixture.file} should include confidence for a reported tempo`);
  }
});