import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = resolve(SCRIPT_DIR, '..');
const RESOURCE_DIR = join(ARTIFACT_DIR, 'src-tauri', 'resources');
const OUTPUT_DIR = join(RESOURCE_DIR, 'stem-models');
const STAGING_DIR = join(RESOURCE_DIR, '.stem-models-staging');
const LOCK_PATH = join(ARTIFACT_DIR, 'stem-models-windows.lock.json');
const LICENSE_PATH = join(ARTIFACT_DIR, 'STEM-MODEL-LICENSE.txt');
const MAX_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 30 * 60 * 1000;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function assetPath(root, asset) {
  const relativePath = asset.path
    ? asset.path.split('/')
    : [...asset.repo.split('/'), asset.filename];
  if (
    relativePath.length === 0
    || relativePath.some(part => !part || part === '.' || part === '..' || part.includes('\\'))
  ) {
    throw new Error(`The model bundle path is invalid: ${asset.path ?? asset.filename}.`);
  }
  return join(root, ...relativePath);
}

async function fileMatches(path, asset) {
  if (!existsSync(path)) return false;
  const metadata = statSync(path);
  if (!metadata.isFile() || metadata.size !== asset.sizeBytes) return false;
  return (await hashFile(path)) === asset.sha256;
}

async function bundleIsCurrent(lock, lockHash) {
  try {
    const manifest = JSON.parse(readFileSync(join(OUTPUT_DIR, 'bundle-manifest.json'), 'utf8'));
    if (manifest.lockSha256 !== lockHash) return false;
    if (!existsSync(join(OUTPUT_DIR, 'MODEL-LICENSES.txt'))) return false;
    console.log(`Verifying ${lock.files.length} staged model files against their pinned checksums.`);
    for (const [index, asset] of lock.files.entries()) {
      console.log(`Checking model file ${index + 1}/${lock.files.length}: ${asset.filename}`);
      if (!(await fileMatches(assetPath(OUTPUT_DIR, asset), asset))) {
        console.warn(`The staged model file is missing or failed verification: ${asset.filename}`);
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function downloadAsset(asset, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  const partialPath = `${destination}.part`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      if (await fileMatches(destination, asset)) return;
      if (existsSync(destination)) rmSync(destination, { force: true });
      const existingPath = assetPath(OUTPUT_DIR, asset);
      if (existingPath !== destination && await fileMatches(existingPath, asset)) {
        try {
          linkSync(existingPath, destination);
          console.log(`Reused verified ${asset.filename} from the previous offline bundle.`);
          return;
        } catch (error) {
          console.warn(`Could not hard-link ${asset.filename}; it will be downloaded again: ${error.message}`);
        }
      }

      let offset = existsSync(partialPath) ? statSync(partialPath).size : 0;
      if (offset > asset.sizeBytes) {
        rmSync(partialPath, { force: true });
        offset = 0;
      }
      if (offset === asset.sizeBytes) {
        if (await fileMatches(partialPath, asset)) {
          renameSync(partialPath, destination);
          return;
        }
        rmSync(partialPath, { force: true });
        offset = 0;
      }

      const url = asset.url
        ?? `https://huggingface.co/${asset.repo}/resolve/${asset.revision}/${encodeURIComponent(asset.filename)}?download=true`;
      const headers = offset > 0 ? { Range: `bytes=${offset}-` } : undefined;
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 404 || response.status === 401 || response.status === 403) {
        throw new Error(`Hugging Face returned HTTP ${response.status} for ${asset.repo}/${asset.filename}.`);
      }
      if (!response.ok || !response.body) {
        throw new Error(`Model download returned HTTP ${response.status} for ${asset.filename}.`);
      }

      const append = offset > 0 && response.status === 206;
      if (offset > 0 && response.status !== 206) offset = 0;
      await pipeline(
        Readable.fromWeb(response.body),
        createWriteStream(partialPath, { flags: append ? 'a' : 'w' }),
      );

      const receivedBytes = statSync(partialPath).size;
      if (receivedBytes > asset.sizeBytes) {
        rmSync(partialPath, { force: true });
        throw new Error(`The download for ${asset.filename} exceeded its locked size.`);
      }
      if (receivedBytes < asset.sizeBytes) {
        throw new Error(
          `The download for ${asset.filename} stopped at ${receivedBytes} of ${asset.sizeBytes} bytes; retrying from the saved partial file.`,
        );
      }
      const digest = await hashFile(partialPath);
      if (digest !== asset.sha256) {
        rmSync(partialPath, { force: true });
        throw new Error(`The SHA-256 check failed for ${asset.filename}; the partial file was discarded.`);
      }
      renameSync(partialPath, destination);
      console.log(`Verified ${asset.filename} (${asset.sizeBytes.toLocaleString()} bytes).`);
      return;
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) throw error;
      console.warn(`Attempt ${attempt}/${MAX_ATTEMPTS} failed for ${asset.filename}: ${error.message}`);
      await delay(Math.min(1000 * 2 ** (attempt - 1), 15000));
    }
  }
}

async function main() {
  const lockBytes = readFileSync(LOCK_PATH);
  const lock = JSON.parse(lockBytes.toString('utf8'));
  const lockHash = sha256(lockBytes);
  if (lock.format !== 'drop-theory-stem-models-lock' || lock.version !== 1 || !Array.isArray(lock.files)) {
    throw new Error('The pinned Windows model lock file is invalid.');
  }

  if (await bundleIsCurrent(lock, lockHash)) {
    console.log('All pinned model files are already staged and verified.');
    return;
  }

  mkdirSync(STAGING_DIR, { recursive: true });
  const totalBytes = lock.files.reduce((total, asset) => total + asset.sizeBytes, 0);
  console.log(
    `Preparing ${lock.files.length} pinned model files (${(totalBytes / 1_000_000_000).toFixed(2)} GB); partial downloads can resume on the next build.`,
  );
  for (const asset of lock.files) {
    if (
      (typeof asset.url === 'string'
        ? !asset.url.startsWith('https://') || typeof asset.path !== 'string'
        : typeof asset.repo !== 'string'
          || typeof asset.revision !== 'string'
          || !/^[a-f0-9]{40}$/.test(asset.revision)
          || typeof asset.filename !== 'string')
      || !Number.isSafeInteger(asset.sizeBytes)
      || !/^[a-f0-9]{64}$/.test(asset.sha256)
    ) {
      throw new Error('The pinned model lock file contains an invalid file entry.');
    }
    await downloadAsset(asset, assetPath(STAGING_DIR, asset));
  }

  const licenseDestination = join(STAGING_DIR, 'MODEL-LICENSES.txt');
  const license = readFileSync(LICENSE_PATH);
  writeFileSync(licenseDestination, license);
  const manifest = {
    format: 'drop-theory-stem-model-bundle',
    version: 1,
    license: lock.license,
    modelDocsUrl: lock.modelDocsUrl,
    lockSha256: lockHash,
    totalBytes,
    profiles: lock.profiles,
    files: lock.files.map(asset => ({
      profile: asset.profile,
      ...(asset.repo ? { repo: asset.repo } : {}),
      ...(asset.revision ? { revision: asset.revision } : {}),
      filename: asset.filename ?? asset.path.split('/').at(-1),
      path: asset.path ?? asset.repo.split('/').join(sep) + sep + asset.filename,
      ...(asset.url ? { sourceUrl: asset.url } : {}),
      sizeBytes: asset.sizeBytes,
      sha256: asset.sha256,
    })),
  };
  writeFileSync(join(STAGING_DIR, 'bundle-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const oldDir = `${OUTPUT_DIR}.previous`;
  rmSync(oldDir, { recursive: true, force: true });
  if (existsSync(OUTPUT_DIR)) renameSync(OUTPUT_DIR, oldDir);
  try {
    renameSync(STAGING_DIR, OUTPUT_DIR);
    rmSync(oldDir, { recursive: true, force: true });
  } catch (error) {
    if (!existsSync(OUTPUT_DIR) && existsSync(oldDir)) renameSync(oldDir, OUTPUT_DIR);
    throw error;
  }

  if (!(await bundleIsCurrent(lock, lockHash))) {
    throw new Error('The staged model bundle did not pass its final checksum verification.');
  }
  console.log(`Verified all model files and staged the offline bundle (${(totalBytes / 1_000_000_000).toFixed(2)} GB).`);
}

main().catch(error => {
  console.error(`Could not prepare the offline stem models: ${error.message}`);
  process.exitCode = 1;
});