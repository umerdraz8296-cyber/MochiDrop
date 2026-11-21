import fs from 'node:fs';
import path from 'node:path';
import { buildStoreReadyExtensionZip } from '../src/server/extensionBuilder.ts';

function parseArg(prefix: string): string | null {
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length).trim() : null;
}

const origin =
  parseArg('--origin=') ||
  process.env.MOCHIDROP_ORIGIN ||
  'http://127.0.0.1:3000';

const outDir = path.resolve(process.cwd(), parseArg('--out=') || '.');
const { filename, buffer } = buildStoreReadyExtensionZip({
  plexoOrigin: origin.replace(/\/+$/, ''),
  name: 'MochiDrop',
});

fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, filename);
fs.writeFileSync(outPath, buffer);

console.log(`\nCreated private extension package: ${outPath}`);
console.log(`Target MochiDrop origin: ${origin}`);
console.log(`Size: ${(buffer.length / 1024).toFixed(1)} KB\n`);
console.log('Install in Chrome / Edge / Brave:');
console.log('1. Unzip the generated .zip file into a local folder on your PC.');
console.log('2. Open chrome://extensions (or edge://extensions).');
console.log('3. Enable "Developer mode" (top right).');
console.log('4. Click "Load unpacked" and select the unzipped folder.\n');
