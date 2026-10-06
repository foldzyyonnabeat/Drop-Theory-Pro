import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = resolve(SCRIPT_DIR, '..');
const TAURI_DIR = join(ARTIFACT_DIR, 'src-tauri');
const RESOURCE_DIR = join(TAURI_DIR, 'resources');
const OUTPUT_DIR = join(RESOURCE_DIR, 'stem-runtime');
const REQUIREMENTS = join(ARTIFACT_DIR, 'stem-runtime-windows.lock');
const PYTHON_VERSION = '3.13.15';
const PYTHON_ARCHIVE_URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embeddable-amd64.zip`;
const PYTHON_ARCHIVE_SHA256 = '791ada5e20aba24524f8d939cdeb069976d632a699fe5cb65274b23f4545e68a';
const DEMUCS_VERSION = '0.3.4';
const DIRECTML_VERSION = '1.24.4';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `${command} exited with ${result.status}`).trim());
  }
  return result.stdout.trim();
}

function findBuilderPython() {
  const candidates = process.platform === 'win32'
    ? [
        ['py', ['-3.12']],
        ['py', ['-3.13']],
        ['python3.12', []],
        ['python3.13', []],
        ['python', []],
      ]
    : [
        ['python3.12', []],
        ['python3.13', []],
        ['python3', []],
        ['python', []],
      ];

  for (const [command, prefix] of candidates) {
    try {
      const version = run(command, [...prefix, '-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")']);
      if (Number(version.split('.')[0]) < 3 || (version.startsWith('3.') && Number(version.split('.')[1]) < 12)) continue;
      run(command, [...prefix, '-m', 'pip', '--version']);
      return { command, prefix };
    } catch {
      // Try the next installed build-time interpreter.
    }
  }

  throw new Error('Building the bundled Windows runtime requires Python 3.12 or newer with pip. Install it for the build machine; end users do not need Python.');
}

function runtimeIsCurrent(requirementsHash) {
  try {
    const manifest = JSON.parse(readFileSync(join(OUTPUT_DIR, 'runtime-manifest.json'), 'utf8'));
    return manifest.pythonVersion === PYTHON_VERSION
      && manifest.demucsVersion === DEMUCS_VERSION
      && manifest.directmlVersion === DIRECTML_VERSION
      && manifest.requirementsSha256 === requirementsHash
      && manifest.pythonArchiveSha256 === PYTHON_ARCHIVE_SHA256
      && existsSync(join(OUTPUT_DIR, 'python.exe'))
      && existsSync(join(OUTPUT_DIR, 'python313.zip'))
      && existsSync(join(OUTPUT_DIR, 'Lib', 'site-packages', 'demucs_onnx', '__init__.py'))
      && existsSync(join(OUTPUT_DIR, 'Lib', 'site-packages', 'onnxruntime', '__init__.py'))
      && existsSync(join(OUTPUT_DIR, 'Lib', 'site-packages', 'onnxruntime', 'capi', 'DirectML.dll'))
      && existsSync(join(OUTPUT_DIR, 'THIRD_PARTY_NOTICES.txt'));
  } catch {
    return false;
  }
}

function collectDllSearchDirectories(sitePackages) {
  const directories = [];
  const visit = directory => {
    const entries = readdirSync(directory, { withFileTypes: true });
    let hasDll = false;
    for (const entry of entries) {
      if (entry.isFile() && /\.dll$/i.test(entry.name)) {
        hasDll = true;
      } else if (entry.isDirectory()) {
        visit(join(directory, entry.name));
      }
    }
    if (hasDll) {
      directories.push(relative(sitePackages, directory).split(sep).join('/') || '.');
    }
  };
  visit(sitePackages);
  return directories.sort();
}

function ensureDllSearchDirectoryManifest(runtimeDir) {
  const sitePackages = join(runtimeDir, 'Lib', 'site-packages');
  const manifestPath = join(runtimeDir, 'dll-search-directories.json');
  if (existsSync(manifestPath)) {
    try {
      const cached = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (Array.isArray(cached) && cached.length > 0
        && cached.every(directory => typeof directory === 'string' && existsSync(resolve(sitePackages, directory)))) {
        return;
      }
    } catch {
      // Rebuild the small path manifest if it is missing or malformed.
    }
  }

  const directories = collectDllSearchDirectories(sitePackages);
  if (directories.length === 0) {
    throw new Error('The bundled runtime contains no DLL search directories.');
  }
  writeFileSync(manifestPath, `${JSON.stringify(directories, null, 2)}\n`);
  console.log(`Cached ${directories.length} Windows DLL search directories in the runtime.`);
}

async function downloadPythonArchive(destination) {
  const response = await fetch(PYTHON_ARCHIVE_URL);
  if (!response.ok || !response.body) {
    throw new Error(`Could not download the official CPython ${PYTHON_VERSION} embeddable runtime (HTTP ${response.status}).`);
  }
  await pipeline(response.body, createWriteStream(destination));
  const digest = createHash('sha256').update(readFileSync(destination)).digest('hex');
  if (digest !== PYTHON_ARCHIVE_SHA256) {
    throw new Error(`The CPython runtime download failed its SHA-256 check (received ${digest}).`);
  }
}

function extractPythonArchive(builder, archive, destination) {
  const code = [
    'import sys, zipfile',
    'with zipfile.ZipFile(sys.argv[1]) as archive:',
    '    archive.extractall(sys.argv[2])',
  ].join('\n');
  run(builder.command, [...builder.prefix, '-c', code, archive, destination]);
}

function enableSitePackages(builder, runtimeDir) {
  const pthName = readdirSync(runtimeDir).find(name => /^python313.*_pth$/i.test(name));
  if (!pthName) throw new Error('The CPython archive does not contain its expected python313._pth file.');
  const pthPath = join(runtimeDir, pthName);
  const lines = readFileSync(pthPath, 'utf8').split(/\r?\n/).filter(Boolean);
  const enabledLines = lines.filter(line => line.trim() !== '#import site');
  if (!enabledLines.some(line => line.toLowerCase() === 'lib\\site-packages')) {
    enabledLines.push('Lib\\site-packages');
  }
  if (!enabledLines.includes('import site')) enabledLines.push('import site');
  writeFileSync(pthPath, `${enabledLines.join('\n')}\n`);
}

function writeRuntimeNotices(runtimeDir, sitePackages) {
  const packages = readdirSync(sitePackages)
    .filter(name => name.endsWith('.dist-info'))
    .map(directory => {
      const metadataPath = join(sitePackages, directory, 'METADATA');
      const metadata = existsSync(metadataPath) ? readFileSync(metadataPath, 'utf8') : '';
      const value = field => metadata
        .split(/\r?\n/)
        .find(line => line.startsWith(`${field}:`))
        ?.slice(field.length + 1)
        .trim();
      const name = value('Name') || directory.replace(/\.dist-info$/, '');
      const version = value('Version') || 'unknown version';
      const license = value('License-Expression') || value('License') || 'See the bundled .dist-info metadata and license files.';
      return `${name} ${version} — ${license}`;
    })
    .sort((left, right) => left.localeCompare(right));

  writeFileSync(join(runtimeDir, 'THIRD_PARTY_NOTICES.txt'), [
    'Drop Theory Pro bundled stem runtime',
    '',
    `CPython ${PYTHON_VERSION} is distributed under the Python Software Foundation License; see LICENSE.txt.`,
    'The bundled wheel distributions retain their upstream .dist-info metadata and license files.',
    '',
    ...packages,
    '',
  ].join('\n'));
}

async function main() {
  const requirementsText = readFileSync(REQUIREMENTS);
  const requirementsHash = createHash('sha256').update(requirementsText).digest('hex');
  if (runtimeIsCurrent(requirementsHash)) {
    ensureDllSearchDirectoryManifest(OUTPUT_DIR);
    console.log(`Bundled CPython ${PYTHON_VERSION} and DirectML runtime are already staged.`);
    return;
  }

  const builder = findBuilderPython();
  mkdirSync(RESOURCE_DIR, { recursive: true });
  const stageDir = join(RESOURCE_DIR, `.stem-runtime-staging-${process.pid}`);
  const archivePath = join(stageDir, 'python-embed.zip');
  const runtimeDir = join(stageDir, 'runtime');
  const sitePackages = join(runtimeDir, 'Lib', 'site-packages');
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(runtimeDir, { recursive: true });

  try {
    console.log(`Downloading the verified CPython ${PYTHON_VERSION} Windows x64 runtime for the installer…`);
    await downloadPythonArchive(archivePath);
    extractPythonArchive(builder, archivePath, runtimeDir);
    rmSync(archivePath, { force: true });

    mkdirSync(sitePackages, { recursive: true });
    const pipEnvironment = {
      ...process.env,
      // Avoid a builder's global "user install" default; keep configured package indexes intact.
      PIP_CONFIG_FILE: process.platform === 'win32' ? 'NUL' : '/dev/null',
    };
    console.log('Resolving the pinned Windows CPU/DirectML wheels into the installer runtime…');
    run(builder.command, [
      ...builder.prefix,
      '-m', 'pip', 'install',
      '--disable-pip-version-check',
      '--no-input',
      '--progress-bar', 'off',
      '--target', sitePackages,
      '--platform', 'win_amd64',
      '--only-binary=:all:',
      '--implementation', 'cp',
      '--python-version', '3.13',
      '--abi', 'cp313',
      '--no-deps',
      '--no-compile',
      '-r', REQUIREMENTS,
    ], { env: pipEnvironment });

    enableSitePackages(builder, runtimeDir);
    writeRuntimeNotices(runtimeDir, sitePackages);
    ensureDllSearchDirectoryManifest(runtimeDir);
    writeFileSync(join(runtimeDir, 'runtime-manifest.json'), JSON.stringify({
      format: 'drop-theory-pro-stem-runtime',
      pythonVersion: PYTHON_VERSION,
      demucsVersion: DEMUCS_VERSION,
      directmlVersion: DIRECTML_VERSION,
      requirementsSha256: requirementsHash,
      pythonArchiveSha256: PYTHON_ARCHIVE_SHA256,
      target: 'windows-x86_64',
    }, null, 2));

    rmSync(OUTPUT_DIR, { recursive: true, force: true });
    renameSync(runtimeDir, OUTPUT_DIR);
    rmSync(stageDir, { recursive: true, force: true });
    console.log(`Staged bundled CPython ${PYTHON_VERSION} with CPU fallback and ONNX Runtime DirectML.`);
  } catch (error) {
    rmSync(stageDir, { recursive: true, force: true });
    throw error;
  }
}

main().catch(error => {
  console.error(`Could not prepare the bundled stem runtime: ${error.message}`);
  process.exitCode = 1;
});