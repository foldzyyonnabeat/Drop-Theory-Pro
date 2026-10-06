import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = resolve(SCRIPT_DIR, '..');
const PACKAGE_DIR = join(SCRIPT_DIR, 'offline-setup-launcher');
const SOURCE_ZIP = join(
  ARTIFACT_DIR,
  'release-installers',
  'drop-theory-pro-0.1.0-windows-x64-offline-bundle.zip',
);
const TARGET_DIR = join(ARTIFACT_DIR, 'src-tauri', 'target', 'offline-setup-launcher');
const LAUNCHER = join(
  TARGET_DIR,
  'x86_64-pc-windows-msvc',
  'release',
  'drop-theory-offline-launcher.exe',
);
const OUTPUT_NAME = 'drop-theory-pro-0.1.0-windows-x64-all-models-setup.exe';
const OUTPUT = join(ARTIFACT_DIR, 'release-installers', OUTPUT_NAME);
const STAGED_OUTPUT = `${OUTPUT}.partial`;
const STAGED_CHECKSUM = `${STAGED_OUTPUT}.sha256`;
const CHECKSUM = `${OUTPUT}.sha256`;
const PACKAGER = join(SCRIPT_DIR, 'create-self-extracting-zip.py');

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: ARTIFACT_DIR,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${result.status}.`);
  }
}

try {
  if (!existsSync(SOURCE_ZIP)) {
    throw new Error(`The verified offline ZIP is missing: ${SOURCE_ZIP}`);
  }

  mkdirSync(dirname(TARGET_DIR), { recursive: true });
  run('cargo-xwin', [
    'build',
    '--manifest-path',
    join(PACKAGE_DIR, 'Cargo.toml'),
    '--target',
    'x86_64-pc-windows-msvc',
    '--release',
    '--target-dir',
    TARGET_DIR,
  ]);

  if (!existsSync(LAUNCHER)) {
    throw new Error(`The Windows setup launcher was not generated: ${LAUNCHER}`);
  }

  run('python3', [PACKAGER, LAUNCHER, SOURCE_ZIP, STAGED_OUTPUT, STAGED_CHECKSUM, OUTPUT_NAME]);
  const digest = readFileSync(STAGED_CHECKSUM, 'utf8').split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error('The self-extracting setup checksum is missing or malformed.');
  }
  renameSync(STAGED_OUTPUT, OUTPUT);
  renameSync(STAGED_CHECKSUM, CHECKSUM);
  console.log(`Created ${OUTPUT} (${digest}).`);
} finally {
  rmSync(STAGED_OUTPUT, { force: true });
  rmSync(STAGED_CHECKSUM, { force: true });
}
