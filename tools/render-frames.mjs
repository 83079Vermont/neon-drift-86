/* ==========================================================================
 * NEON DRIFT '86 — tools/render-frames.mjs
 *
 * Runs the REAL src/*.js inside the Node canvas shim, drives it with scripted
 * input, and exports PNG snapshots of the actual game canvas at every key
 * beat: title → select → countdown → race → off-road → crash → paused →
 * stage 2 → stage 3 → stage clear → game over.
 *
 * Chromium is unavailable in this sandbox, so these PNGs are the only pixels a
 * human can review; they are written to .verify/frames/ together with a
 * manifest.json holding per-frame statistics (so "is it blank?" is a fact, not
 * an opinion).
 *
 * Exit codes:  0 = all frames present and non-blank
 *              3 = incomplete (modules missing, or some frame missing/blank)
 *              1 = harness failure
 *
 * Owner: verifier.
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createShim, wallNow, out } from './canvas-shim.mjs';
import { loadSrc, bootGame, Driver, globalKeys, diffGlobals, ROOT, srcPath } from './loader.mjs';
import { encodePNG, imageStats, isBlank, diffStats } from './png.mjs';

const FRAMES_DIR = path.join(ROOT, '.verify', 'frames');
const DT_MS = 1000 / 60;

/** Provenance: which revision of src/ produced these pixels. */
export function srcHashes() {
  const h = {};
  for (const n of ['core', 'road', 'sprites', 'audio', 'render', 'input', 'game']) {
    const p = srcPath(n);
    if (!fs.existsSync(p)) { h[n] = null; continue; }
    const buf = fs.readFileSync(p);
    h[n] = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
  }
  h.__combined = crypto.createHash('sha256')
    .update(Object.keys(h).map(k => k + ':' + h[k]).join('|')).digest('hex').slice(0, 16);
  return h;
}

function parseArgs(argv) {
  const a = {};
  for (const s of argv) {
    if (s.startsWith('--')) { const [k, v] = s.slice(2).split('='); a[k] = v === undefined ? true : v; }
  }
  return a;
}

/* --------------------------------------------------------------- helpers */
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

class FrameRecorder {
  constructor(shim, dir, opts) {
    this.shim = shim;
    this.dir = dir;
    this.frames = [];
    this.started = wallNow();
    this.stale = !!(opts && opts.stale);           /* no RENDER yet: pixels are placeholders */
    this.staleReason = (opts && opts.staleReason) || '';
  }
  capture(name, meta) {
    meta = meta || {};
    const cv = meta.canvas || this.shim.gameCanvas;
    if (!cv) throw new Error('capture(' + name + '): no canvas');
    const w = cv._w, h = cv._h;
    const data = Uint8ClampedArray.from(cv._buf);
    const stats = imageStats(data, w, h);
    const png = encodePNG(w, h, data, { level: 6 });
    const file = name + '.png';
    fs.writeFileSync(path.join(this.dir, file), png);
    const st = meta.state;
    const expected = meta.expectedMode ? [].concat(meta.expectedMode) : null;
    const rec = {
      name, file, w, h,
      bytes: png.length,
      blank: isBlank(stats),
      stale: this.stale,
      staleReason: this.stale ? this.staleReason : '',
      mode: st ? st.mode : (meta.mode || null),
      stageIndex: st ? st.stageIndex : (meta.stageIndex === undefined ? null : meta.stageIndex),
      expectedMode: meta.expectedMode || null,
      expectedStage: meta.expectedStage === undefined ? null : meta.expectedStage,
      ok: !isBlank(stats),
      modeMismatch: false,
      note: meta.note || '',
      stats: {
        distinct: stats.distinct, dominantFrac: +stats.dominantFrac.toFixed(4),
        edgeFrac: +stats.edgeFrac.toFixed(4),
        mean: stats.mean.slice(0, 3).map(v => Math.round(v)),
        lumaRange: Math.round(stats.lumaRange)
      }
    };
    if (expected && !expected.includes(rec.mode)) {
      rec.modeMismatch = true;
      rec.note = (rec.note ? rec.note + ' | ' : '') + 'expected mode ' + expected.join('/') + ', saw "' + rec.mode + '"';
    }
    if (rec.expectedStage !== null && rec.stageIndex !== rec.expectedStage) {
      rec.note = (rec.note ? rec.note + ' | ' : '') + 'expected stage ' + rec.expectedStage + ', saw ' + rec.stageIndex;
    }
    this.frames.push(rec);
    return rec;
  }
  /** Native 384x216 frame rendered straight through RENDER.draw(). */
  captureNative(name, ctx, state, meta) {
    meta = meta || {};
    const cv = ctx.canvas;
    return this.capture(name, Object.assign({}, meta, { canvas: cv, state: state }));
  }
}

/* ----------------------------------------------------------- scenarios -- */
function autopilot(d, st) {
  if (!st) return;
  const x = st.playerX;
  if (x > 0.12) { d.hold('ArrowLeft'); if (x > 0.35) { d.hold('ArrowDown'); } else d.release('ArrowDown'); }
  else if (x < -0.12) { d.hold('ArrowRight'); if (x < -0.35) d.hold('ArrowDown'); else d.release('ArrowDown'); }
  else { d.release('ArrowLeft'); d.release('ArrowRight'); d.release('ArrowDown'); }
  d.hold('ArrowUp');
  d.release('Space');
}

function releaseAll(d) {
  for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space']) d.release(k);
}

function tapEnterUntil(d, pred, budget) {
  return d.until(pred, budget, (i) => { if (i % 12 === 0) d.key('Enter'); });
}

/**
 * Robust menu navigation: tap Enter every 25 frames until the target mode is
 * reached.  Works whether the menu is "press any key" or cursor+Enter, and
 * whether the cursor starts on START RACE or on SELECT STAGE.
 */
function enterMode(d, target, budget) {
  return d.until((s) => s && s.mode === target, budget || 400, (i) => { if (i > 0 && i % 25 === 0) d.key('Enter'); });
}

function reachStage(d, target, budget, log) {
  const ok = d.until(
    (st) => st && st.stageIndex >= target,
    budget,
    (i, st) => {
      if (!st) return;
      if (st.mode === 'race' || st.mode === 'countdown') autopilot(d, st);
      else if (st.mode === 'stageclear' || st.mode === 'results' || st.mode === 'select') {
        releaseAll(d);
        if (i % 20 === 0) d.key('Enter');
      } else if (st.mode === 'gameover') {
        releaseAll(d);
        if (i % 20 === 0) d.key('Enter');
      }
    });
  if (!ok) log('reachStage(' + target + '): budget of ' + budget + ' frames exhausted');
  return ok;
}

/** White-box fallback when real racing cannot reach the next stage in budget.
 *
 *  NOTE (verified 2026-10-17): as built, ROAD.build() returns checkpoints
 *  WITHOUT the trailing lap-line entry, e.g. [0,408,817,1226] for a 1635
 *  segment track, while CONTRACT.md §3 says "last one == first index (lap
 *  line)" and GAME.completeLap() fires on checkpoint index n-1.  So the lap
 *  trigger is checkpoint[n-1], NOT world z=0 — the forcing below targets
 *  checkpoint[n-1] so it works on both the current and the contract-correct
 *  layout.
 */
function lapTriggerZ(state) {
  const cps = state.checkpoints || [];
  const seg = CORE.TUNING.SEGMENT_LENGTH;
  if (!cps.length) return state.trackLength - 240;
  const last = cps[cps.length - 1];
  const z = (last === 0) ? state.trackLength : last * seg;
  return z - 300;
}

function forceStageAdvance(d, target, log) {
  if (typeof GAME !== 'undefined' && GAME) {
    for (const fn of ['setStage', 'startStage', 'nextStage', 'gotoStage']) {
      if (typeof GAME[fn] === 'function') {
        try { GAME[fn](target); log('forceStageAdvance: used GAME.' + fn + '(' + target + ')'); return true; }
        catch (e) { /* keep trying */ }
      }
    }
  }
  const st = d.state;
  if (!st || !st.trackLength) return false;
  st.position = Math.max(0, lapTriggerZ(st));
  st.lap = st.laps;
  st.timeLeft = Math.max(st.timeLeft || 0, 25);
  st.speed = Math.max(st.speed || 0, 9000);
  const before = st.stageIndex;
  d.until((s) => s && s.stageIndex >= target, 900, (i, s) => {
    if (s.mode === 'race') autopilot(d, s);
    else if (i % 15 === 0) d.key('Enter');
  });
  log('forceStageAdvance: white-box lap completion for stage ' + target +
    ' (position -> ' + Math.round(lapTriggerZ(st)) + ', stage ' + before + ' -> ' + (d.state && d.state.stageIndex) + ')');
  return d.state && d.state.stageIndex >= target;
}

/* ------------------------------------------------- diagnostic renderers */
function spriteContactSheet(shim, rec) {
  if (typeof SPRITES === 'undefined' || !SPRITES || typeof SPRITES.names !== 'function') return null;
  const names = SPRITES.names().slice().sort();
  if (!names.length) return null;
  const cols = 8, cellW = 104, cellH = 56;
  const rows = Math.ceil(names.length / cols);
  const sheet = shim.createCanvas(cols * cellW, rows * cellH);
  const g = sheet.getContext('2d');
  g.fillStyle = '#101018';
  g.fillRect(0, 0, sheet.width, sheet.height);
  g.fillStyle = '#2a2a3a';
  for (let r = 0; r <= rows; r++) g.fillRect(0, r * cellH - 1, sheet.width, 1);
  for (let c = 0; c <= cols; c++) g.fillRect(c * cellW - 1, 0, 1, sheet.height);
  let drawn = 0;
  for (let i = 0; i < names.length; i++) {
    const sp = SPRITES.get(names[i]);
    if (!sp || !sp.canvas) continue;
    const cx = (i % cols) * cellW, cy = Math.floor(i / cols) * cellH;
    const s = Math.min(1, (cellW - 8) / sp.w, (cellH - 8) / sp.h);
    g.drawImage(sp.canvas, cx + 4 + (cellW - 8 - sp.w * s) / 2, cy + 4 + (cellH - 8 - sp.h * s) / 2,
      Math.max(1, Math.round(sp.w * s)), Math.max(1, Math.round(sp.h * s)));
    g.fillStyle = '#22e0ff';
    g.fillRect(cx + 3, cy + cellH - 4, Math.min(60, names[i].length * 1), 1);
    drawn++;
  }
  const r = rec.capture('diag-sprites', {
    canvas: sheet, mode: 'diagnostic', note: drawn + ' sprites (' + names.join(',') + ')'
  });
  r.kind = 'diagnostic';
  return r;
}

function diagnosticStageFrame(shim, rec, stageIndex) {
  if (typeof RENDER === 'undefined' || typeof ROAD === 'undefined') return null;
  const cv = shim.createCanvas(CORE.W, CORE.H);
  const ctx = cv.getContext('2d');
  const state = CORE.createState();
  const track = ROAD.build(stageIndex);
  state.stageIndex = stageIndex;
  state.track = track;
  state.segments = track.segments;
  state.cars = track.cars;
  state.theme = track.theme;
  state.trackLength = track.trackLength;
  state.checkpoints = track.checkpoints;
  state.laps = CORE.STAGES[stageIndex].laps;
  state.lap = 1;
  state.mode = 'race';
  state.modeTime = 2;
  state.position = Math.floor(track.trackLength * 0.31);
  state.speed = 7200;
  state.gear = 3;
  state.rpm = 0.62;
  state.timeLeft = 62.5;
  state.lapTime = 18.4;
  state.score = 14500;
  state.skyOffset = 120;
  state.hillOffset = 40;
  state.treeOffset = 12;
  state.menuItems = ['START', 'QUALIFY', 'SOUND'];
  state.hint = 'DIAGNOSTIC FRAME (GAME not loaded yet)';
  for (let i = 0; i < 3; i++) { if (i < 2) state.messages.push({ text: 'CHECKPOINT', color: '#4dff88', scale: 1, x: CORE.W / 2, y: 40 + i * 10, ttl: 1, ttl0: 1 }); }
  try {
    RENDER.init(ctx, state);
  } catch (e) { return null; }
  try {
    RENDER.draw(ctx, state);
  } catch (e) {
    rec_frameError = String(e && e.message || e);
    return null;
  }
  const r = rec.capture('diag-stage' + (stageIndex + 1), {
    canvas: cv, state, mode: 'diagnostic',
    note: 'direct RENDER.draw() at ' + CORE.W + 'x' + CORE.H + ' — gameplay/frames pending',
    expectedMode: null
  });
  r.kind = 'diagnostic';
  return r;
}
let rec_frameError = null;

/* ================================================================ main -- */
export async function run(argv) {
  const args = parseArgs(argv || []);
  const t0 = wallNow();
  ensureDir(FRAMES_DIR);
  /* never leave yesterday's pixels lying around claiming to be today's build */
  for (const f of fs.readdirSync(FRAMES_DIR)) {
    if (f.endsWith('.png')) fs.unlinkSync(path.join(FRAMES_DIR, f));
  }

  const shim = createShim({ echoConsole: !!args.verbose, deterministicRandom: true });
  const before = globalKeys();
  const load = loadSrc();
  const added = diffGlobals(before, globalKeys());

  out('');
  out('=== NEON DRIFT \'86 — frame export ===');
  out('modules loaded : ' + (load.loaded.join(', ') || '(none)'));
  if (load.missing.length) out('modules missing: ' + load.missing.join(', '));
  for (const f of load.failed) out('module FAILED  : ' + f.name + '.js' + (f.line ? ':' + f.line : '') + ' — ' + f.error);
  out('globals added  : ' + (added.join(', ') || '(none)'));

  const rec = new FrameRecorder(shim, FRAMES_DIR, {
    stale: typeof RENDER === 'undefined',
    staleReason: typeof RENDER === 'undefined' ? 'src/render.js not loaded: GAME has no renderer, so these frames are placeholders' : ''
  });
  const missingFrames = [];
  const notes = [];

  if (typeof CORE === 'undefined') {
    out('FATAL: src/core.js did not load — cannot render anything.');
    writeManifest(rec, load, added, shim, { fatal: 'core.js missing' });
    return { code: 1, frames: rec.frames };
  }

  /* ---------------------------------------------- always-on diagnostics */
  if (typeof SPRITES !== 'undefined') {
    try { if (SPRITES.init) SPRITES.init(); } catch (e) { notes.push('SPRITES.init: ' + e.message); }
    const sheet = spriteContactSheet(shim, rec);
    if (!sheet) notes.push('sprite contact sheet not produced');
  } else notes.push('SPRITES missing -> no contact sheet');

  const haveGame = typeof GAME !== 'undefined' && GAME && typeof GAME.boot === 'function';
  const haveRender = typeof RENDER !== 'undefined' && RENDER && typeof RENDER.draw === 'function';
  const haveRoad = typeof ROAD !== 'undefined' && ROAD && typeof ROAD.build === 'function';

  if (!haveGame) {
    notes.push('GAME not loaded -> exporting diagnostic RENDER frames only');
    if (haveRender && haveRoad) {
      for (let s = 0; s < CORE.STAGES.length; s++) {
        const r = diagnosticStageFrame(shim, rec, s);
        if (!r) missingFrames.push('diag-stage' + (s + 1));
      }
      if (rec_frameError) notes.push('RENDER.draw threw: ' + rec_frameError);
    } else {
      notes.push('RENDER/ROAD missing -> no stage frames at all');
    }
    for (const n of FRAME_NAMES) missingFrames.push(n);
    writeManifest(rec, load, added, shim, { notes, missingFrames, incomplete: true });
    printSummary(rec, missingFrames, notes, t0);
    return { code: 3, frames: rec.frames };
  }

  /* ------------------------------------------------------------ boot up */
  const boot = bootGame(shim, { cssW: 1152, cssH: 648 });
  if (!boot.ok) {
    out('FATAL: GAME.boot threw: ' + (boot.error && boot.error.stack || boot.error));
    writeManifest(rec, load, added, shim, { notes: ['GAME.boot threw: ' + boot.error], fatal: true });
    return { code: 1, frames: rec.frames };
  }
  const d = new Driver(shim, boot, { dtMs: DT_MS, echo: (m) => out('  ' + m) });
  d.detect();
  const state = () => d.state;
  out('driver         : ' + (d.manual ? 'manual update/render' : 'rAF loop') + ', mode=' + (state() && state().mode));

  const phaseStart = { t: wallNow(), name: 'boot' };
  const phase = (name) => {
    const now = wallNow();
    out('  phase ' + phaseStart.name.padEnd(14) + ((now - phaseStart.t) / 1000).toFixed(1) + ' s  (' + d.frames + ' frames)');
    phaseStart.t = now; phaseStart.name = name;
  };
  phase('boot');

  const cap = (name, meta) => {
    const r = rec.capture(name, Object.assign({ state: state() }, meta));
    out('  captured ' + name.padEnd(20) + ' mode=' + String(r.mode).padEnd(11) +
      ' stage=' + r.stageIndex + ' distinct=' + r.stats.distinct +
      ' dom=' + r.stats.dominantFrac + (r.blank ? '  ** BLANK **' : ''));
    return r;
  };

  const step = (n, onTick) => {
    if (onTick) d.until(() => false, n, onTick);
    else d.step(n);
  };

  /* ------------------------------------------------------ 1. title ----- */
  try {
    d.until((s) => s && s.mode === 'title', 240);
    step(20);
    cap('01-title', { expectedMode: 'title', note: 'boot -> title, menu cursor on START RACE' });
  } catch (e) { notes.push('title: ' + e.message); missingFrames.push('01-title'); }
  phase('title');

  /* ------------------------------------------------------ 2. select ---- */
  /* Title menu = [START RACE, SELECT STAGE, QUALITY, SOUND].
     Arrow keys only move the cursor now, so: ↓ to SELECT STAGE, then Enter.
     (Re-taps Enter inside the helper, so this survives either menu style.) */
  try {
    d.key('ArrowDown');
    step(6);
    enterMode(d, 'select', 400);
    step(10);
    cap('02-select', { expectedMode: 'select', note: 'title -> ↓ -> Enter -> SELECT STAGE (menuIndex=' + state().menuIndex + ', items=' + JSON.stringify(state().menuItems) + ')' });
  } catch (e) { notes.push('select: ' + e.message); missingFrames.push('02-select'); }
  phase('select');

  /* ------------------------------------------------------ 3. countdown - */
  try {
    d.key('Enter');                       /* select screen -> start stage */
    d.until((s) => s && s.mode === 'countdown', 180);
    step(40);
    cap('03-countdown', { expectedMode: 'countdown', expectedStage: 0, note: 'countdown=' + (state().countdown || 0).toFixed(2) });
  } catch (e) { notes.push('countdown: ' + e.message); missingFrames.push('03-countdown'); }
  phase('countdown');

  /* ------------------------------------------------------ 4. race start  */
  try {
    d.until((s) => s && s.mode === 'race', 400, (i, s) => { if (s && s.mode === 'countdown') autopilot(d, s); });
    step(30, (i, s) => autopilot(d, s));
    cap('04-race-start', { expectedMode: 'race', expectedStage: 0, note: 'first 30 frames of racing, speed=' + Math.round(state().speed || 0) });
  } catch (e) { notes.push('race-start: ' + e.message); missingFrames.push('04-race-start'); }
  phase('race-start');

  /* ------------------------------------------------------ 5. fast lap --- */
  try {
    step(560, (i, s) => autopilot(d, s));
    cap('05-race-fast', { expectedMode: 'race', expectedStage: 0, note: 'speed=' + Math.round(state().speed || 0) + ' playerX=' + (state().playerX || 0).toFixed(2) + ' lap=' + state().lap + '/' + state().laps });
  } catch (e) { notes.push('race-fast: ' + e.message); missingFrames.push('05-race-fast'); }
  phase('race-fast');

  /* ------------------------------------------------------ 6. off-road --- */
  try {
    releaseAll(d); d.hold('ArrowUp'); d.hold('ArrowRight');
    d.until((s) => s && Math.abs(s.playerX) > 1.02, 420);
    step(6);
    cap('06-offroad', { expectedMode: 'race', note: 'playerX=' + (state().playerX || 0).toFixed(2) + ' offRoad=' + state().offRoad + ' speed=' + Math.round(state().speed || 0) });
    releaseAll(d);
    step(40, (i, s) => autopilot(d, s));
  } catch (e) { notes.push('offroad: ' + e.message); missingFrames.push('06-offroad'); }
  phase('offroad');

  /* ------------------------------------------------------ 7. crash ----- */
  try {
    releaseAll(d);
    let sawCrash = d.until(
      (s) => s && (s.crash === true || (s.hitTimer || 0) > 0 || (s.crashTimer || 0) > 0),
      1800,
      (i, s) => {
        autopilot(d, s);
        /* aim at traffic inside the collision window (position + PLAYER_Z) */
        const cars = (s && s.cars) || [];
        const L = s.trackLength || 1;
        const pz = (s.position + CORE.TUNING.PLAYER_Z) % L;
        let best = null, bestD = Infinity;
        for (const c of cars) {
          let dz = c.z - pz;
          if (dz < -L / 2) dz += L;
          if (dz > L / 2) dz -= L;
          if (dz > -200 && Math.abs(dz) < 1600 && Math.abs(dz) < Math.abs(bestD)) { bestD = dz; best = c; }
        }
        if (best) {
          const target = best.offset;
          if (target - (s.playerX || 0) > 0.05) { d.hold('ArrowRight'); d.release('ArrowLeft'); }
          else if (target - (s.playerX || 0) < -0.05) { d.hold('ArrowLeft'); d.release('ArrowRight'); }
        }
      });
    cap('07-crash', {
      expectedMode: 'race',
      note: sawCrash ? 'collision (crash=' + state().crash + ' hitTimer=' + (state().hitTimer || 0).toFixed(2) + ' crashFrame=' + state().crashFrame + ')'
        : 'NO collision within 1800 frames'
    });
    if (!sawCrash) notes.push('crash: no collision observed in 1800 frames of deliberately aiming at traffic');
    releaseAll(d);
  } catch (e) { notes.push('crash: ' + e.message); missingFrames.push('07-crash'); }
  phase('crash');

  /* ------------------------------------------------------ 8. paused ---- */
  try {
    step(20, (i, s) => autopilot(d, s));
    d.key('Escape');
    step(10);
    cap('08-paused', { expectedMode: 'paused', note: 'Esc during race (paused=' + state().paused + ', menu=' + JSON.stringify(state().menuItems) + ')' });
    d.key('Escape');
    step(20);
  } catch (e) { notes.push('paused: ' + e.message); missingFrames.push('08-paused'); }
  phase('paused');

  /* ------------------------------------------------- 9/10. stage 2 & 3 - */
  for (let target = 1; target <= 2; target++) {
    const name = target === 1 ? '09-stage2' : '10-stage3';
    try {
      releaseAll(d);
      let ok = false, how = '';
      if (args['real-race']) {
        ok = reachStage(d, target, args.budget ? +args.budget : 4200, (m) => notes.push(m));
        how = 'autopilot racing';
      }
      if (!ok) {
        /* Deterministic and ~50x faster than racing two real laps.  The real
           lap logic is exercised by tools/contract-test.mjs instead. */
        ok = forceStageAdvance(d, target, (m) => notes.push(m));
        how = 'forced lap completion at the lap-line checkpoint';
      }
      d.until((s) => s && s.mode === 'race', 900, (i, s) => {
        if (s.mode === 'countdown') releaseAll(d); else if (i % 25 === 0) d.key('Enter');
      });
      step(90, (i, s) => { if (s.mode === 'race') autopilot(d, s); });
      const st = state();
      cap(name, {
        expectedMode: 'race', expectedStage: target,
        note: 'theme=' + (st.theme && st.theme.key) + ' track="' + (st.track && st.track.name) +
          '" lap=' + st.lap + '/' + st.laps + ' via ' + how +
          (ok ? '' : ' | STAGE ADVANCE FAILED - FRAME IS UNVERIFIED')
      });
      if (!ok || st.stageIndex !== target || st.mode !== 'race') missingFrames.push(name);
    } catch (e) { notes.push(name + ': ' + e.message); missingFrames.push(name); }
    phase('stage' + (target + 1));
  }

  /* ------------------------------------------------------ 11. stageclear */
  try {
    releaseAll(d);
    let ok = false;
    if (args['real-race']) {
      ok = d.until((s) => s && (s.mode === 'stageclear' || s.mode === 'results'), 4200, (i, s) => {
        if (s.mode === 'race' || s.mode === 'countdown') autopilot(d, s);
        else if (i % 20 === 0) d.key('Enter');
      });
    }
    if (!ok) {
      const st = state();
      st.lap = st.laps;
      st.position = Math.max(0, lapTriggerZ(st));
      st.timeLeft = Math.max(st.timeLeft || 0, 20);
      st.speed = Math.max(st.speed || 0, 9000);
      ok = d.until((s) => s && (s.mode === 'stageclear' || s.mode === 'results'), 900, (i, s) => {
        if (s.mode === 'race') autopilot(d, s); else if (i % 15 === 0) d.key('Enter');
      });
      notes.push('stageclear: forced final lap at z=' + Math.round(lapTriggerZ(st)) + (ok ? ' (worked)' : ' (did NOT trigger stageclear)'));
    }
    step(20);
    const st = state();
    cap('11-stageclear', {
      expectedMode: ['stageclear', 'results'], expectedStage: 2,
      note: 'theme=' + (st.theme && st.theme.key) + ' track="' + (st.track && st.track.name) +
        '" results=' + (st.results ? JSON.stringify({ finished: st.results.finished, score: st.results.score }) : 'null') +
        (ok ? '' : ' | STAGECLEAR NOT REACHED - FRAME IS UNVERIFIED')
    });
    if (!ok) missingFrames.push('11-stageclear');
  } catch (e) { notes.push('stageclear: ' + e.message); missingFrames.push('11-stageclear'); }
  phase('stageclear');

  /* ------------------------------------------------------ 12. gameover -- */
  try {
    releaseAll(d);
    /* restart a race from the results/title flow, then let the clock expire.
       Enter is re-tapped until a race is actually running, so this works
       whether the flow lands on the title, the select screen or a countdown. */
    enterMode(d, 'countdown', 900);
    d.until((s) => s && s.mode === 'race', 600);
    const st = state();
    st.timeLeft = 0.05;
    const ok = d.until((s) => s && s.mode === 'gameover', 600);
    step(6);
    cap('12-gameover', {
      expectedMode: 'gameover',
      note: (ok ? 'timer forced to 0.05s -> gameover' : 'gameover not reached') +
        ' | score=' + state().score + ' (0 is expected: SCORE resets on every startStage, and the clock was forced to expire immediately) best=' + state().best
    });
    if (!ok) notes.push('gameover: timer expiry did not reach mode "gameover" within 600 frames');
  } catch (e) { notes.push('gameover: ' + e.message); missingFrames.push('12-gameover'); }
  phase('gameover');

  releaseAll(d);

  /* ------------------------------------------------------------ wrap up */
  const elapsed = wallNow() - t0;
  for (const f of rec.frames) {
    if (f.modeMismatch) missingFrames.push(f.name + '(mode)');
    if (f.expectedStage !== null && f.stageIndex !== f.expectedStage) missingFrames.push(f.name + '(stage)');
  }
  const uniq = [...new Set(missingFrames)];
  missingFrames.length = 0;
  missingFrames.push(...uniq);
  writeManifest(rec, load, added, shim, { notes, missingFrames, elapsedMs: Math.round(elapsed), driverFrames: d.frames });
  printSummary(rec, missingFrames, notes, t0);

  const code = missingFrames.length || rec.frames.some(f => f.blank) ? 3 : 0;
  return { code, frames: rec.frames, missingFrames };
}

const FRAME_NAMES = ['01-title', '02-select', '03-countdown', '04-race-start', '05-race-fast',
  '06-offroad', '07-crash', '08-paused', '09-stage2', '10-stage3', '11-stageclear', '12-gameover'];

function printSummary(rec, missingFrames, notes, t0) {
  const real = rec.frames.filter(f => f.kind !== 'diagnostic');
  const blank = rec.frames.filter(f => f.blank);
  out('');
  out('frames exported : ' + rec.frames.length + ' (' + real.length + ' gameplay, ' + (rec.frames.length - real.length) + ' diagnostic)');
  if (missingFrames.length) out('frames missing  : ' + [...new Set(missingFrames)].join(', '));
  if (blank.length) out('BLANK frames    : ' + blank.map(f => f.name).join(', '));
  if (notes.length) { out('notes:'); for (const n of notes) out('  - ' + n); }
  const vs = rec.shim.violations;
  if (vs.length) {
    out('shim violations : ' + vs.length + ' distinct');
    for (const v of vs.slice(0, 12)) out('  [' + v.kind + '] ' + v.detail);
  }
  const cerr = rec.shim.consoleCalls.filter(c => c.level === 'error' || c.level === 'warn');
  if (cerr.length) {
    out('console errors  : ' + cerr.length);
    for (const c of cerr.slice(0, 10)) out('  [' + c.level + '@frame' + c.frame + '] ' + c.text.slice(0, 240));
  }
  if (rec.shim.errors.length) {
    out('runtime errors  : ' + rec.shim.errors.length);
    for (const e of rec.shim.errors.slice(0, 8)) out('  ' + (e.where || '') + ' @' + e.frame + ': ' + String(e.error).split('\n')[0]);
  }
  out('elapsed         : ' + ((wallNow() - t0) / 1000).toFixed(1) + ' s');
  out('frames dir      : .verify/frames');
}

function writeManifest(rec, load, added, shim, extra) {
  const ev = shim.violations.map(v => ({ kind: v.kind, detail: v.detail, stack: v.stack }));
  const manifest = Object.assign({
    generatedAt: new Date().toISOString(),
    srcHashes: srcHashes(),
    rendererPresent: typeof RENDER !== 'undefined' && !!RENDER,
    stale: rec.stale,
    staleReason: rec.staleReason,
    modules: { loaded: load.loaded, missing: load.missing, failed: load.failed },
    globalsAdded: added,
    frames: rec.frames,
    violations: ev,
    consoleErrors: shim.consoleCalls.filter(c => c.level === 'error' || c.level === 'warn'),
    consoleAll: shim.consoleCalls.length,
    runtimeErrors: shim.errors
  }, extra || {});
  fs.writeFileSync(path.join(FRAMES_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

/* ------------------------------------------------------------------ CLI */
const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/render-frames.mjs');
if (isMain) {
  run(process.argv.slice(2)).then(r => { process.exit(r.code); })
    .catch(e => { out('HARNESS ERROR: ' + (e && e.stack || e)); process.exit(1); });
}
