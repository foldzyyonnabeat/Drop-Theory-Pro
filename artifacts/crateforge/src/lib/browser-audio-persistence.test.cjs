const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const sourcePath = path.join(__dirname, 'local-library.ts');
const appPath = path.join(__dirname, '..', 'App.tsx');

function createIndexedDb({ failFirstWrite = false } = {}) {
  const stores = new Map();
  let shouldFailWrite = failFirstWrite;
  const database = {
    objectStoreNames: {
      contains: name => stores.has(name),
    },
    createObjectStore(name) {
      stores.set(name, new Map());
    },
    transaction(storeName) {
      const transaction = {
        error: null,
        oncomplete: null,
        onerror: null,
        onabort: null,
      };
      transaction.objectStore = () => {
        const store = stores.get(storeName);
        return {
          put(value, key) {
            queueMicrotask(() => {
              if (shouldFailWrite) {
                shouldFailWrite = false;
                transaction.error = new Error('Temporary IndexedDB quota failure.');
                transaction.onerror?.();
                return;
              }
              store.set(key, value);
              transaction.oncomplete?.();
            });
          },
          get(key) {
            const request = { result: undefined, onsuccess: null, onerror: null };
            queueMicrotask(() => {
              request.result = store.get(key);
              request.onsuccess?.();
            });
            return request;
          },
        };
      };
      return transaction;
    },
    close() {},
  };

  return {
    open() {
      const request = { result: database, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      queueMicrotask(() => {
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
}

function loadLocalLibrary(indexedDB) {
  const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const moduleValue = { exports: {} };
  const testRequire = id => id === '@tauri-apps/api/core'
    ? { invoke: async () => null, isTauri: () => false }
    : require(id);
  vm.runInNewContext(compiled, {
    module: moduleValue,
    exports: moduleValue.exports,
    require: testRequire,
    indexedDB,
    Blob,
    Uint8Array,
  }, { filename: sourcePath });
  return moduleValue.exports;
}

test('failed browser audio saves can be retried under the same track ID and load after reopening', async () => {
  const indexedDB = createIndexedDb({ failFirstWrite: true });
  const firstSession = loadLocalLibrary(indexedDB);
  const trackId = 'browser-audio-retry-track';
  const originalAudio = new Blob([new Uint8Array([17, 28, 39])], { type: 'audio/wav' });

  await assert.rejects(
    firstSession.saveBrowserAudioFile(trackId, originalAudio),
    /Temporary IndexedDB quota failure/,
  );
  assert.equal((await firstSession.loadBrowserAudioFiles([trackId])).has(trackId), false);

  await firstSession.saveBrowserAudioFile(trackId, originalAudio);

  // A fresh module instance represents a reload; only IndexedDB is carried over.
  const reloadedSession = loadLocalLibrary(indexedDB);
  const restored = await reloadedSession.loadBrowserAudioFiles([trackId]);
  assert.deepEqual(Array.from(new Uint8Array(await restored.get(trackId).arrayBuffer())), [17, 28, 39]);
});

test('the app exposes browser audio durability status and a retry action', () => {
  const app = fs.readFileSync(appPath, 'utf8');

  assert.match(app, /browserAudioSavedTrackIds/);
  assert.match(app, /Audio saved in IndexedDB/);
  assert.match(app, /Audio only in this session/);
  assert.match(app, /Audio unavailable/);
  assert.match(app, /failed-browser-audio-saves/);
  assert.match(app, /retryBrowserAudioSave\(trackId\)/);
  assert.match(app, /button-retry-browser-audio-\$\{trackId\}/);
  assert.match(app, /saveBrowserAudioFile\(trackId, failedSave\.audio\)/);
});
