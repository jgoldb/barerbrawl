// Stamp version.json with a fresh build id, so returning players (and the browser
// console) can see exactly which deploy they're running. Freshness itself is
// handled by the service worker (sw.js) — this just makes the version visible.
//
//   npm run bump      # then commit + push to publish
import { readFile, writeFile } from 'node:fs/promises';

const file = new URL('./version.json', import.meta.url);
const data = JSON.parse(await readFile(file, 'utf8'));

const iso = new Date().toISOString().replace(/\.\d+Z$/, 'Z'); // e.g. 2026-07-04T18:22:05Z
data.build = iso;

await writeFile(file, JSON.stringify(data, null, 2) + '\n');
console.log(`version.json build -> ${data.build}`);
