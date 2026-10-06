import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = resolve(SCRIPT_DIR, '..');
const TAURI_DIR = join(ARTIFACT_DIR, 'src-tauri');
const CONFIG_PATH = join(TAURI_DIR, 'tauri.conf.json');
const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const installerName = `${config.productName}_${config.version}_x64-setup.exe`;
const installerCandidates = [
  join(TAURI_DIR, 'target', 'x86_64-pc-windows-msvc', 'release', 'bundle', 'nsis', installerName),
  join(TAURI_DIR, 'target', 'release', 'bundle', 'nsis', installerName),
];
const installerPath = process.env.DROP_THEORY_OFFLINE_INSTALLER
  ? resolve(process.env.DROP_THEORY_OFFLINE_INSTALLER)
  : installerCandidates.find(existsSync);

if (!installerPath) {
  throw new Error(`Could not find the standard Windows NSIS installer: ${installerName}`);
}

const releaseDir = join(ARTIFACT_DIR, 'release-installers');
mkdirSync(releaseDir, { recursive: true });
const slug = config.productName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const archiveName = `${slug}-${config.version}-windows-x64-offline-bundle.zip`;
const archivePath = join(releaseDir, archiveName);
const pythonScript = join(SCRIPT_DIR, 'package-offline-bundle.py');
const bundledPython = join(TAURI_DIR, 'resources', 'stem-runtime', 'python.exe');
const python = process.platform === 'win32' ? bundledPython : (process.env.PYTHON || 'python3');

if (process.platform === 'win32' && !existsSync(bundledPython)) {
  throw new Error('The bundled Windows Python runtime is missing; build the desktop app before packaging.');
}

const packageResult = spawnSync(
  python,
  [pythonScript, ARTIFACT_DIR, installerPath, archivePath],
  { stdio: 'inherit' },
);
if (packageResult.error) throw packageResult.error;
if (packageResult.status !== 0) {
  throw new Error(`Offline bundle packaging failed with exit code ${packageResult.status}.`);
}

const hash = createHash('sha256');
for await (const chunk of createReadStream(archivePath)) hash.update(chunk);
const digest = hash.digest('hex');
writeFileSync(`${archivePath}.sha256`, `${digest}  ${basename(archivePath)}\n`);
console.log(`Offline bundle ready: ${archivePath}`);
console.log(`SHA-256: ${digest}`);