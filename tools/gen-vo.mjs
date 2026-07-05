#!/usr/bin/env node
// Build-time voice-over generator. Turns every line in src/vo-manifest.js into an
// MP3 under assets/vo/ using the ElevenLabs text-to-speech API, so the game can
// ship them as static assets (like the barer-*.png face billboards).
//
//   npm run gen-vo              # generate anything new or changed
//   npm run gen-vo -- --force   # regenerate every clip
//   npm run gen-vo -- --dry-run # show the plan, call no API, spend no credits
//   npm run gen-vo -- --only=intro-1,dvar-13
//
// The API key is read from the environment and NEVER committed:
//   - ELEVENLABS_API_KEY in the environment, or
//   - a git-ignored .env.local / .elevenlabs.key file in the repo root.
//
// Voice ids can be overridden without editing tracked code:
//   VO_VOICE_NARRATOR, VO_VOICE_REBBE, VO_VOICE_PLAYER
// and the model/format via VO_MODEL / VO_FORMAT.
//
// A sidecar assets/vo/manifest.json records a per-line hash of (text + voice +
// settings + model + format), so unchanged lines are skipped on the next run and
// only what you actually edited costs credits.

import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { VO_VOICES, VO_LINES } from '../src/vo-manifest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT_DIR = join(ROOT, 'assets', 'vo');
const SIDECAR = join(OUT_DIR, 'manifest.json');

const MODEL = process.env.VO_MODEL || 'eleven_multilingual_v2';
const FORMAT = process.env.VO_FORMAT || 'mp3_44100_128';

// ---- args -------------------------------------------------------------------
const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const DRY = args.includes('--dry-run');
const onlyArg = args.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',').map((s) => s.trim())) : null;

// ---- key loading (env first, then a git-ignored dotenv-ish file) ------------
function loadDotenv() {
  for (const name of ['.env.local', '.env', '.elevenlabs.key']) {
    const p = join(ROOT, name);
    if (!existsSync(p)) continue;
    for (const raw of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      // a bare `.elevenlabs.key` may hold just the key on its own line
      if (eq === -1) { if (!process.env.ELEVENLABS_API_KEY) process.env.ELEVENLABS_API_KEY = line; continue; }
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(k in process.env)) process.env[k] = v;
    }
  }
}
loadDotenv();

// per-speaker voice-id overrides
const VOICE_ENV = { narrator: 'VO_VOICE_NARRATOR', rebbe: 'VO_VOICE_REBBE', player: 'VO_VOICE_PLAYER' };
function resolveVoice(key) {
  const v = VO_VOICES[key];
  if (!v) throw new Error(`Unknown voice "${key}" referenced by a line in vo-manifest.js`);
  const override = process.env[VOICE_ENV[key]];
  return { ...v, voiceId: override || v.voiceId };
}

function lineHash(line, voice) {
  return createHash('sha256')
    .update(JSON.stringify({ t: line.text, v: voice.voiceId, s: voice.settings, m: MODEL, f: FORMAT }))
    .digest('hex')
    .slice(0, 16);
}

function loadSidecar() {
  if (!existsSync(SIDECAR)) return {};
  try { return JSON.parse(readFileSync(SIDECAR, 'utf8')); } catch { return {}; }
}

// Drain the ReadableStream the SDK returns into a single Buffer.
async function collect(stream) {
  const chunks = [];
  if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
    for await (const c of stream) chunks.push(Buffer.from(c));
  } else if (stream && typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(Buffer.from(value)); }
  } else {
    throw new Error('Unexpected text-to-speech response type (not a stream)');
  }
  return Buffer.concat(chunks);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const sidecar = loadSidecar();

  // Decide the work list up front so --dry-run can report it without a key.
  const plan = [];
  for (const line of VO_LINES) {
    if (ONLY && !ONLY.has(line.id)) continue;
    const voice = resolveVoice(line.voice);
    const hash = lineHash(line, voice);
    const outPath = join(OUT_DIR, `${line.id}.mp3`);
    const prev = sidecar[line.id];
    const upToDate = !FORCE && prev && prev.hash === hash && existsSync(outPath);
    plan.push({ line, voice, hash, outPath, skip: upToDate });
  }

  const todo = plan.filter((p) => !p.skip);
  const chars = todo.reduce((n, p) => n + p.line.text.length, 0);
  console.log(`Barer Brawl voice-over — ${VO_LINES.length} lines, ${todo.length} to (re)generate` +
    `${ONLY ? ` (filtered to ${ONLY.size})` : ''}${FORCE ? ' [--force]' : ''}.`);
  console.log(`Model: ${MODEL}   Format: ${FORMAT}   ~${chars} characters this run.`);
  for (const p of plan) {
    const v = VO_VOICES[p.line.voice].label;
    console.log(`  ${p.skip ? 'skip ' : (DRY ? 'plan ' : 'gen  ')} ${p.line.id.padEnd(15)} [${v}]  “${p.line.text.slice(0, 58)}${p.line.text.length > 58 ? '…' : ''}”`);
  }

  if (DRY) { console.log('\nDry run — no API calls made.'); return; }
  if (todo.length === 0) { console.log('\nNothing to do — every clip is already up to date.'); return; }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    console.error('\nERROR: no ELEVENLABS_API_KEY found.');
    console.error('Set it in your environment, or put it in a git-ignored .env.local:');
    console.error('  ELEVENLABS_API_KEY=sk_...');
    process.exit(1);
  }

  const client = new ElevenLabsClient({ apiKey });
  let ok = 0;
  for (const p of todo) {
    process.stdout.write(`  → ${p.line.id} … `);
    try {
      const stream = await client.textToSpeech.convert(p.voice.voiceId, {
        text: p.line.text,
        modelId: MODEL,
        outputFormat: FORMAT,
        voiceSettings: p.voice.settings,
      });
      const buf = await collect(stream);
      if (!buf.length) throw new Error('empty audio');
      writeFileSync(p.outPath, buf);
      sidecar[p.line.id] = { hash: p.hash, voice: p.voice.voiceId, bytes: buf.length, chars: p.line.text.length };
      writeFileSync(SIDECAR, JSON.stringify(sidecar, null, 2) + '\n');   // persist after each success
      console.log(`ok (${(buf.length / 1024).toFixed(1)} KB)`);
      ok++;
    } catch (err) {
      console.log('FAILED');
      console.error(`     ${err?.statusCode ? `HTTP ${err.statusCode}: ` : ''}${err?.message || err}`);
      if (err?.body) console.error(`     ${JSON.stringify(err.body).slice(0, 300)}`);
    }
  }
  console.log(`\nDone — ${ok}/${todo.length} clip(s) written to assets/vo/.`);
  if (ok < todo.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
