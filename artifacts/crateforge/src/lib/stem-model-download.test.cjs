const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

function loadDownloads(invoke) {
  const callbacks = [];
  let cleanups = 0;
  let nextId = 0;
  const compiled = ts.transpileModule(
    fs.readFileSync(path.join(__dirname, 'stem-model-download.ts'), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } },
  ).outputText;
  const moduleValue = { exports: {} };
  vm.runInNewContext(compiled, {
    module: moduleValue,
    exports: moduleValue.exports,
    Error,
    crypto: { randomUUID: () => `download-${++nextId}` },
    require: name => {
      if (name === 'react') return { useSyncExternalStore: (_subscribe, snapshot) => snapshot() };
      if (name === '@tauri-apps/api/core') return { invoke };
      if (name === '@tauri-apps/api/event') return {
        listen: async (_name, callback) => {
          callbacks.push(callback);
          return () => { cleanups++; };
        },
      };
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  return { ...moduleValue.exports, callbacks, cleanupCount: () => cleanups };
}

test('model downloads are shared across repeated requests and screen remounts', async () => {
  let complete;
  const pending = new Promise(resolve => { complete = resolve; });
  const calls = [];
  const downloads = loadDownloads(async (command, args) => {
    calls.push({ command, args });
    await pending;
  });
  const first = downloads.downloadModelWeights('htdemucs-ft');
  const second = downloads.downloadModelWeights('htdemucs-ft');
  assert.equal(first, second);
  await new Promise(setImmediate);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'download_stem_model');
  downloads.callbacks[0]({ payload: {
    jobId: calls[0].args.jobId, percent: 45, message: 'Downloading file 2 of 4',
  } });
  assert.equal(downloads.useStemModelDownload('htdemucs-ft').percent, 45);
  assert.equal(downloads.useStemModelDownload('htdemucs-ft').status, 'downloading');
  complete();
  await first;
  assert.equal(downloads.useStemModelDownload('htdemucs-ft').status, 'ready');
  assert.equal(downloads.cleanupCount(), 1);
  await downloads.downloadModelWeights('htdemucs-ft');
  assert.equal(calls.length, 1);
});

test('download errors remain visible and a retry starts a fresh request', async () => {
  let calls = 0;
  const downloads = loadDownloads(async () => {
    calls++;
    if (calls === 1) {
      throw new Error(
        'Could not prepare model weights: Connection interrupted. Retry the model download; completed files remain in the local cache.',
      );
    }
  });
  await downloads.downloadModelWeights('htdemucs-speed');
  assert.equal(downloads.useStemModelDownload('htdemucs-speed').status, 'error');
  assert.match(downloads.useStemModelDownload('htdemucs-speed').message, /Retry the model download/);
  await downloads.downloadModelWeights('htdemucs-speed');
  assert.equal(calls, 2);
  assert.equal(downloads.useStemModelDownload('htdemucs-speed').status, 'ready');
  assert.equal(downloads.cleanupCount(), 2);
});

test('unrelated jobs cannot update the selected model download', async () => {
  let complete;
  const pending = new Promise(resolve => { complete = resolve; });
  const downloads = loadDownloads(() => pending);
  const task = downloads.downloadModelWeights('htdemucs-ft-compact');
  await new Promise(setImmediate);
  downloads.callbacks[0]({ payload: { jobId: 'unrelated', percent: 99, message: 'Wrong model' } });
  assert.equal(downloads.useStemModelDownload('htdemucs-ft-compact').percent, 0);
  assert.equal(downloads.useStemModelDownload('htdemucs-speed').status, 'idle');
  complete();
  await task;
});
