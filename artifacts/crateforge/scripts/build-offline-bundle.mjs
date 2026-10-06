import { createHash } from 'node:crypto';
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = resolve(SCRIPT_DIR, '..');
const TAURI_DIR = join(ARTIFACT_DIR, 'src-tauri');
const config = JSON.parse(readFileSync(join(TAURI_DIR, 'tauri.conf.json'), 'utf8'));
const installerName = `${config.productName}_${config.version}_x64-setup.exe`;
const installerPath = join(
  TAURI_DIR,
  'target',
  'x86_64-pc-windows-msvc',
  'release',
  'bundle',
  'nsis',
  installerName,
);
const stageDir = mkdtempSync(join(tmpdir(), 'drop-theory-offline-bundle-'));
const originalInstallerPath = join(stageDir, 'original-runtime-only-installer.exe');
const freshInstallerPath = join(stageDir, installerName);
let originalHash;
let hasOriginalInstaller = existsSync(installerPath);

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: ARTIFACT_DIR,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${result.status}.`);
  }
}

async function restoreOriginalInstaller() {
  if (!hasOriginalInstaller) return;
  copyFileSync(originalInstallerPath, installerPath);
  const restoredHash = await sha256(installerPath);
  if (restoredHash !== originalHash) {
    throw new Error('The existing runtime-only installer could not be restored byte-for-byte.');
  }
  console.log(`Restored the existing runtime-only installer unchanged (SHA-256 ${restoredHash}).`);
}

try {
  if (hasOriginalInstaller) {
    copyFileSync(installerPath, originalInstallerPath);
    originalHash = await sha256(originalInstallerPath);
    console.log(`Saved existing runtime-only installer (SHA-256 ${originalHash}).`);
  }

  run(process.execPath, [join(SCRIPT_DIR, 'prepare-stem-models.mjs')]);

  const buildArgs = [
    'build',
    '--bundles',
    'nsis',
    '--target',
    'x86_64-pc-windows-msvc',
    '--no-sign',
  ];
  if (process.platform !== 'win32') buildArgs.push('--runner', 'cargo-xwin');
  run('tauri', buildArgs);

  if (!existsSync(installerPath)) {
    throw new Error(`The Windows runtime-only installer was not generated: ${installerPath}`);
  }
  copyFileSync(installerPath, freshInstallerPath);
  await restoreOriginalInstaller();

  run(process.execPath, [join(SCRIPT_DIR, 'package-offline-bundle.mjs')], {
    ...process.env,
    DROP_THEORY_OFFLINE_INSTALLER: freshInstallerPath,
  });
} finally {
  await restoreOriginalInstaller();
  rmSync(stageDir, { recursive: true, force: true });
}