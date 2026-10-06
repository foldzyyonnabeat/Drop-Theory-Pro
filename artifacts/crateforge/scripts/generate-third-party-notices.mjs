import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const artifactRoot = path.resolve(scriptDirectory, '..');
const workspaceRoot = path.resolve(artifactRoot, '../..');
const sourceRoot = path.join(artifactRoot, 'src', 'lib');
const docsRoot = path.join(artifactRoot, 'docs');
const releaseMode = process.argv.includes('--release');

function normalizeLicense(value) {
  if (typeof value === 'string') return value.trim() || 'UNKNOWN';
  if (Array.isArray(value)) return value.map(item => typeof item === 'string' ? item : item?.type).filter(Boolean).join(' OR ') || 'UNKNOWN';
  if (value && typeof value === 'object') return String(value.type ?? 'UNKNOWN');
  return 'UNKNOWN';
}

function classifyLicense(license) {
  const value = license.toUpperCase();
  if (/(AGPL|\bGPL|SSPL|NON.?COMMERCIAL|CC-BY-NC|PROPRIETARY)/.test(value)) {
    if (/\bOR\b/.test(value) && /(MIT|ISC|APACHE|BSD|0BSD|UNLICENSE)/.test(value)) {
      return { verdict: '⚠️ conditions', note: 'A permissive alternative appears in the declared expression; confirm the selected license and distribution obligations.' };
    }
    return { verdict: '❌ needs license or replacement', note: 'Copyleft, non-commercial, or proprietary terms need legal review before release.' };
  }
  if (/(LGPL|MPL|EUPL|CDDL|CPL|EPL|CC-BY|ARTISTIC|ZLIB)/.test(value)) {
    return { verdict: '⚠️ conditions', note: 'Review the specific license, linking, attribution, and redistribution obligations.' };
  }
  if (/(MIT|ISC|APACHE-2\.0|BSD|0BSD|CC0|UNLICENSE|BLUEOAK|ZLIB)/.test(value)) {
    return { verdict: '✅ safe', note: 'Declared permissive license; preserve the upstream license and copyright notices.' };
  }
  return { verdict: '⚠️ conditions', note: 'License metadata is missing or not in the simple permissive allow-list; verify with the package owner.' };
}

function packageUrl(packageJson) {
  const repository = packageJson.repository;
  const repositoryUrl = typeof repository === 'string' ? repository : repository?.url;
  return String(repositoryUrl ?? packageJson.homepage ?? '').replace(/^git\+/, '').replace(/\.git$/, '');
}

async function readNotices(packageDirectory) {
  let names = [];
  try {
    names = await fs.readdir(packageDirectory);
  } catch {
    return [];
  }
  const licenseNames = names
    .filter(name => /^(LICENSE|LICENCE|COPYING|NOTICE)([._ -].*)?$/i.test(name))
    .sort((left, right) => left.localeCompare(right));
  const notices = [];
  for (const name of licenseNames) {
    const filePath = path.join(packageDirectory, name);
    try {
      const content = await fs.readFile(filePath, 'utf8');
      notices.push({ file: name, text: content });
    } catch {
      // A broken or binary license file is still listed in the package inventory.
    }
  }
  return notices;
}

function collectTree(project) {
  const packages = new Map();
  const seenObjects = new Set();
  const visit = dependency => {
    if (!dependency || typeof dependency !== 'object' || seenObjects.has(dependency)) return;
    seenObjects.add(dependency);
    const name = String(dependency.from ?? dependency.name ?? 'unknown');
    const version = String(dependency.version ?? 'unknown');
    const key = `${name}@${version}`;
    if (!packages.has(key)) {
      packages.set(key, {
        name,
        version,
        path: dependency.path ?? null,
        dependencies: dependency.dependencies ?? {},
      });
    }
    for (const child of Object.values(dependency.dependencies ?? {})) visit(child);
  };
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const dependency of Object.values(project[field] ?? {})) visit(dependency);
  }
  return [...packages.values()];
}

const listOutput = execFileSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['list', '--filter', '@workspace/crateforge', '--depth', 'Infinity', '--json'],
  { cwd: workspaceRoot, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 16 * 1024 * 1024 },
);
const projects = JSON.parse(listOutput);
const project = projects.find(item => item.name === '@workspace/crateforge');
if (!project) throw new Error('pnpm did not return the Drop Theory Pro dependency tree.');

const rows = [];
for (const dependency of collectTree(project)) {
  let metadata = {};
  if (dependency.path) {
    try {
      metadata = JSON.parse(await fs.readFile(path.join(dependency.path, 'package.json'), 'utf8'));
    } catch {
      metadata = {};
    }
  }
  const license = normalizeLicense(metadata.license ?? metadata.licenses);
  const { verdict, note } = classifyLicense(license);
  const notices = dependency.path ? await readNotices(dependency.path) : [];
  rows.push({
    name: dependency.name,
    version: dependency.version,
    license,
    verdict,
    note,
    source: packageUrl(metadata),
    author: typeof metadata.author === 'string' ? metadata.author : metadata.author?.name ?? '',
    noticeFiles: notices.map(item => item.file),
    noticeTexts: notices,
  });
}
rows.sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));

const generatedAt = new Date().toISOString().slice(0, 10);
await fs.mkdir(docsRoot, { recursive: true });
await fs.writeFile(
  path.join(sourceRoot, 'license-inventory.generated.ts'),
  `// Generated by scripts/generate-third-party-notices.mjs on ${generatedAt}. Do not edit by hand.\nexport const licenseInventory = ${JSON.stringify(rows.map(({ noticeTexts, ...row }) => row), null, 2)} as const;\n`,
);
await fs.writeFile(
  path.join(sourceRoot, 'license-inventory.json'),
  `${JSON.stringify(rows.map(({ noticeTexts, ...row }) => row), null, 2)}\n`,
);

const summary = rows.reduce((counts, row) => {
  counts[row.verdict] = (counts[row.verdict] ?? 0) + 1;
  return counts;
}, {});
const markdown = [
  '# Third-party notices',
  '',
  `Generated on ${generatedAt} from the resolved Drop Theory Pro dependency tree. This is an automated inventory, not legal advice. It does not scan model weights, media assets, fonts, operating-system codecs, or external runtimes.`,
  '',
  `Summary: ${rows.length} package/version entries; ${summary['❌ needs license or replacement'] ?? 0} need a license or replacement; ${summary['⚠️ conditions'] ?? 0} require manual review.`,
  '',
  '## Inventory',
  '',
  '| Package | Version | Declared license | Review status | Source |',
  '|---|---:|---|---|---|',
  ...rows.map(row => `| ${row.name.replace(/\|/g, '\\|')} | ${row.version} | ${row.license.replace(/\|/g, '\\|')} | ${row.verdict} ${row.note} | ${row.source ? `[source](${row.source})` : 'Not declared'} |`),
  '',
  '## Upstream attribution notices',
  '',
  'Retain the applicable upstream copyright, license, and notice text for each shipped component. The text below is copied from license/notice files in the installed package where available. A missing text block does not mean no notice is required; verify the package source before shipping.',
  '',
];
for (const row of rows) {
  const notices = row.noticeTexts ?? [];
  markdown.push(`### ${row.name} ${row.version}`, '', `Declared license: ${row.license}. Status: ${row.verdict}.`, row.author ? `Author: ${row.author}.` : '', row.source ? `Source: ${row.source}` : '');
  if (!notices.length) {
    markdown.push('', 'No readable LICENSE/COPYING/NOTICE file was found in the installed package. Obtain the exact notice from the upstream source before distribution.', '');
    continue;
  }
  for (const notice of notices) markdown.push('', `#### ${notice.file}`, '', '```text', notice.text.trim(), '```', '');
}
await fs.writeFile(path.join(docsRoot, 'THIRD_PARTY_NOTICES.md'), `${markdown.filter(Boolean).join('\n')}\n`);

console.log(`Generated ${rows.length} package notices: ${summary['✅ safe'] ?? 0} permissive, ${summary['⚠️ conditions'] ?? 0} review, ${summary['❌ needs license or replacement'] ?? 0} blocked.`);
if (releaseMode && rows.some(row => row.verdict === '❌ needs license or replacement')) {
  console.error('Release blocked: resolve every ❌ license finding before distributing a release build.');
  process.exitCode = 1;
}