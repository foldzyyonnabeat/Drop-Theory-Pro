#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const artifactRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inventoryPath = path.join(artifactRoot, 'src', 'lib', 'license-inventory.json');
const args = process.argv.slice(2).filter(argument => argument !== '--');
const command = args[0];

if (command === 'licenses') {
  let inventory;
  try {
    inventory = JSON.parse(await fs.readFile(inventoryPath, 'utf8'));
  } catch {
    console.error('License inventory is missing. Run `pnpm --filter @workspace/crateforge run licenses:generate` first.');
    process.exit(1);
  }
  if (args.includes('--json')) {
    console.log(JSON.stringify(inventory, null, 2));
  } else {
    for (const item of inventory) {
      console.log(`${item.verdict.padEnd(30)} ${item.name}@${item.version} — ${item.license}${item.source ? ` — ${item.source}` : ''}`);
    }
    console.log(`\n${inventory.length} package/version entries. See docs/THIRD_PARTY_NOTICES.md for notices and caveats.`);
  }
} else if (command === 'help' || command === '--help' || command === undefined) {
  console.log([
    'Drop Theory Pro local developer CLI',
    '',
    'Commands:',
    '  licenses [--json]    Print the generated dependency license inventory',
    '  help                 Show this help',
    '',
    'This CLI does not scan audio or connect to cloud services.',
  ].join('\n'));
} else {
  console.error(`Unknown command: ${command}`);
  process.exitCode = 2;
}