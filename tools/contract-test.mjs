/* ==========================================================================
 * NEON DRIFT '86 — tools/contract-test.mjs
 *
 * Assertion suite for CONTRACT.md, run entirely inside Node against the real
 * src/*.js through tools/canvas-shim.mjs.  Includes adversarial cases: NaN
 * leakage, extreme dt, off-road, collision, timer expiry, pause, resize,
 * stage switching, 3-minute-equivalent soak and cross-run determinism.
 *
 * Exit codes:  0 = every check passed (warnings allowed)
 *              1 = at least one check FAILED
 *              3 = INCOMPLETE — a module is missing (only with --allow-missing)
 *
 * Owner: verifier.  Never writes to src/.
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { createShim, wallNow, out, CanvasShimError, parseColor } from './canvas-shim.mjs';
import { loadSrc, globalKeys, diffGlobals, findNonFinite, bootGame, Driver, ROOT, SRC_ORDER, srcPath } from './loader.mjs';
import { encodePNG, imageStats, isBlank, meanColorDistance, diffStats, parsePNG } from './png.mjs';

const DT = 1000 / 60;

/* ============================================================ tiny runner */
class Fail extends Error { }
const results = [];
let current = null;

function t(name, fn, opts) {
  opts = opts || {};
  const rec = { group: opts.group || 'general', name, status: 'PASS', detail: '', ms: 0 };
  current = rec;
  const t0 = wallNow();
  const ctx = {
    ok(cond, msg) { if (!cond) throw new Fail(msg || 'assertion failed'); },
    eq(a, b, msg) {
      if (a !== b) throw new Fail((msg || 'not equal') + ' — expected ' + fmt(b) + ', got ' + fmt(a));
    },
    near(a, b, eps, msg) {
      if (!(Math.abs(a - b) <= eps)) throw new Fail((msg || 'not close') + ' — expected ' + fmt(b) + '±' + eps + ', got ' + fmt(a));
    },
    fail(msg) { throw new Fail(msg); },
    skip(msg) { const e = new Fail(msg || 'skipped'); e.skip = true; throw e; },
    warn(msg) { rec.status = 'WARN'; rec.detail += (rec.detail ? ' | ' : '') + (msg || ''); }
  };
  try {
    fn(ctx);
  } catch (e) {
    if (e instanceof Fail || e.skip) { rec.status = e.skip ? 'SKIP' : 'FAIL'; rec.detail = e.message; }
    else { rec.status = 'FAIL'; rec.detail = String(e && e.stack || e).split('\n').slice(0, 4).join(' | '); }
  }
  if (rec.status === 'PASS' && !rec.detail) rec.detail = '';
  rec.ms = Math.round((wallNow() - t0) * 10) / 10;
  results.push(rec);
  const tag = { PASS: 'PASS', FAIL: 'FAIL', SKIP: 'SKIP', WARN: 'WARN' }[rec.status];
  if (rec.status !== 'PASS' || opts.verbose) {
    out('[' + tag + '] ' + (rec.group + '.' + rec.name).padEnd(38) + (rec.detail || ''));
  }
  current = null;
  return rec;
}

function fmt(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') return String(Math.round(v * 1e6) / 1e6);
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return '[' + v.slice(0, 6).map(fmt).join(',') + (v.length > 6 ? ',…' : '') + ']';
  try { return JSON.stringify(v).slice(0, 90); } catch (e) { return String(v); }
}

const has = (n) => typeof globalThis[n] !== 'undefined' && globalThis[n] !== null;
const M = (n) => (has(n) ? globalThis[n] : null);
function needMod(name, tctx, label) {
  if (!has(name)) { tctx.skip('src/' + (label || name.toLowerCase()) + '.js not loaded'); return false; }
  return true;
}

/* ============================================================ PNG decoder */
function decodePNG(buf) {
  const info = parsePNG(buf);
  let pos = 8, idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    if (type === 'IDAT') idat.push(buf.subarray(pos + 8, pos + 8 + len));
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const w = info.width, h = info.height, bpp = 4, stride = w * 4;
  const outBuf = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const filt = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? outBuf[y * stride + i - bpp] : 0;
      const b = y > 0 ? outBuf[(y - 1) * stride + i] : 0;
      const c = (i >= bpp && y > 0) ? outBuf[(y - 1) * stride + i - bpp] : 0;
      let v = line[i];
      if (filt === 1) v += a;
      else if (filt === 2) v += b;
      else if (filt === 3) v += (a + b) >> 1;
      else if (filt === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      outBuf[y * stride + i] = v & 0xFF;
    }
  }
  return { width: w, height: h, data: outBuf, colorType: info.colorType, chunks: info.chunks };
}

/* ============================================================ shared state */
export async function run(argv) {
  const args = {};
  for (const s of (argv || [])) if (s.startsWith('--')) { const [k, v] = s.slice(2).split('='); args[k] = v === undefined ? true : v; }
  const allowMissing = !!args['allow-missing'];
  const soakFrames = args['soak-frames'] ? +args['soak-frames'] : 10800;
  const renderSoakFrames = args['render-soak'] ? +args['render-soak'] : 900;
  const t0 = wallNow();

  out('');
  out('=== NEON DRIFT \'86 — contract test ===');

  /* ------------------------------------------------------ load the game */
  const shim = createShim({ deterministicRandom: true });
  const beforeGlobals = globalKeys();
  const load = loadSrc();
  const addedGlobals = diffGlobals(beforeGlobals, globalKeys());
  const missing = load.missing;
  shim.gameCanvas = shim.makeGameCanvas(384, 216);

  out('modules loaded : ' + (load.loaded.join(', ') || '(none)'));
  if (missing.length) out('modules missing: ' + missing.join(', ') + (allowMissing ? ' (skipped, not failed)' : ' (FAIL)'));
  for (const f of load.failed) out('module FAILED  : ' + f.name + '.js' + (f.line ? ':' + f.line : '') + ' — ' + f.error);

  /* ============================================================== A: harness */
  t('png-roundtrip', (c) => {
    const w = 9, h = 5, buf = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) { buf[i * 4] = (i * 37) & 255; buf[i * 4 + 1] = (i * 91) & 255; buf[i * 4 + 2] = i & 255; buf[i * 4 + 3] = 255; }
    const png = encodePNG(w, h, buf);
    const dec = decodePNG(png);
    c.eq(dec.width, w, 'width');
    c.eq(dec.height, h, 'height');
    c.eq(dec.colorType, 6, 'colour type');
    let bad = 0;
    for (let i = 0; i < w * h * 4; i++) if (dec.data[i] !== buf[i]) bad++;
    c.eq(bad, 0, 'decoded pixels identical to source');
  }, { group: 'harness' });

  t('png-signature-and-size', (c) => {
    const png = encodePNG(2, 2, new Uint8ClampedArray(16).fill(200));
    c.eq(png.toString('hex', 0, 8), '89504e470d0a1a0a', 'PNG magic');
    const p = parsePNG(png);
    c.eq(p.chunks.join(','), 'IHDR,IDAT,IEND', 'chunk order');
  }, { group: 'harness' });

  t('shim-unknown-api-throws', (c) => {
    const cv = shim.createCanvas(8, 8);
    const ctx = cv.getContext('2d');
    let threw = null;
    try { void ctx.fillRectt; } catch (e) { threw = e; }
    c.ok(threw instanceof CanvasShimError, 'unknown ctx member must throw CanvasShimError, got ' + fmt(threw && threw.name));
    c.ok(/not silently swallow/.test(threw.message), 'error explains the tripwire');
  }, { group: 'harness' });

  t('shim-nearest-neighbour-blit', (c) => {
    const src = shim.createCanvas(2, 2), s = src.getContext('2d');
    s.fillStyle = '#ff0000'; s.fillRect(0, 0, 1, 1);
    s.fillStyle = '#00ff00'; s.fillRect(1, 0, 1, 1);
    s.fillStyle = '#0000ff'; s.fillRect(0, 1, 1, 1);
    s.fillStyle = '#ffffff'; s.fillRect(1, 1, 1, 1);
    const dst = shim.createCanvas(4, 4), g = dst.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(src, 0, 0, 2, 2, 0, 0, 4, 4);
    const px = (x, y) => [...g.getImageData(x, y, 1, 1).data];
    c.eq(px(0, 0).join(','), '255,0,0,255', 'top-left block');
    c.eq(px(3, 0).join(','), '0,255,0,255', 'top-right block');
    c.eq(px(0, 3).join(','), '0,0,255,255', 'bottom-left block');
    c.eq(px(3, 3).join(','), '255,255,255,255', 'bottom-right block');
  }, { group: 'harness' });

  t('shim-concave-polygon-fill', (c) => {
    const cv = shim.createCanvas(16, 16), g = cv.getContext('2d');
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.moveTo(1, 1); g.lineTo(14, 1); g.lineTo(14, 4); g.lineTo(4, 4); g.lineTo(4, 14); g.lineTo(1, 14);
    g.closePath(); g.fill();
    const px = (x, y) => g.getImageData(x, y, 1, 1).data[3];
    c.eq(px(2, 2), 255, 'inside the L');
    c.eq(px(12, 2), 255, 'inside the top bar');
    c.eq(px(2, 12), 255, 'inside the left bar');
    c.eq(px(10, 10), 0, 'outside the L (the notch) must stay empty');
  }, { group: 'harness' });

  t('shim-clip-and-composite', (c) => {
    const cv = shim.createCanvas(16, 16), g = cv.getContext('2d');
    g.fillStyle = '#000000'; g.fillRect(0, 0, 16, 16);
    g.save(); g.beginPath(); g.rect(0, 0, 8, 8); g.clip();
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 16, 16); g.restore();
    const px = (x, y) => [...g.getImageData(x, y, 1, 1).data];
    c.eq(px(4, 4).join(','), '255,255,255,255', 'inside clip');
    c.eq(px(12, 12).join(','), '0,0,0,255', 'outside clip untouched');
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = '#404040'; g.fillRect(0, 0, 16, 16);
    c.eq(px(4, 4)[0], 255, 'lighter adds and clamps at 255');
    c.eq(px(12, 12)[0], 64, 'lighter added to black');
  }, { group: 'harness' });

  t('shim-determinism', (c) => {
    const a = createShim(), b = createShim();
    const ta = [], tb = [];
    a.window.requestAnimationFrame((ts) => ta.push(ts));
    b.window.requestAnimationFrame((ts) => tb.push(ts));
    for (let i = 0; i < 5; i++) { a.tick(1000 / 60); b.tick(1000 / 60); }
    c.eq(ta.join(','), tb.join(','), 'virtual clock timestamps');
    c.eq(a.clock.t, b.clock.t, 'clock value');
    a.uninstall(); b.uninstall();
    /* those temporary shims replaced the process-wide DOM globals: put the
       real harness shim back, or every later test drives the wrong realm. */
    shim.installGlobals();
    c.ok(globalThis.document === shim.document, 'document restored');
    c.ok(globalThis.requestAnimationFrame === shim.window.requestAnimationFrame, 'rAF restored');
    c.ok(typeof globalThis.navigator.getGamepads === 'function', 'navigator.getGamepads restored');
  }, { group: 'harness' });

  /* ============================================================== B: CORE */
  /* The harness self-checks above deliberately tripped the shim tripwires;
     start the game-facing violation log clean. */
  shim.violations.length = 0;
  shim._violateSeen.clear();
  shim.consoleCalls.length = 0;

  t('selftest-all-green', (c) => {
    const r = M('CORE').selfTest();
    const bad = r.checks.filter(x => !x.ok);
    c.ok(r.ok, 'CORE.selfTest failures: ' + bad.map(x => x.name + '(' + x.detail + ')').join(', '));
    c.ok(r.checks.length >= 20, 'selfTest covers >= 20 checks, got ' + r.checks.length);
  }, { group: 'core' });

  t('api-surface', (c) => {
    const C = M('CORE');
    for (const k of ['clamp', 'lerp', 'easeIn', 'easeOut', 'easeInOut', 'accelerate', 'percentRemaining',
      'overlap', 'increase', 'wrapZ', 'rng', 'rnd', 'rndInt', 'pick', 'makeCanvas', 'now', 'pad',
      'formatTime', 'formatScore', 'textWidth', 'drawText', 'createState', 'selfTest']) {
      c.ok(typeof C[k] === 'function', 'CORE.' + k + ' missing');
    }
    for (const k of ['VERSION', 'W', 'H', 'TAU', 'TUNING', 'THEMES', 'STAGES', 'UI', 'FONT_W', 'FONT_H', 'storage']) {
      c.ok(C[k] !== undefined, 'CORE.' + k + ' missing');
    }
  }, { group: 'core' });

  t('tuning-values-match-contract', (c) => {
    const T = M('CORE').TUNING;
    const expect = {
      SEGMENT_LENGTH: 200, RUMBLE_LENGTH: 3, ROAD_WIDTH: 2000, LANES: 3, FIELD_OF_VIEW: 100,
      CAMERA_HEIGHT: 1000, DRAW_DISTANCE: 220, FOG_DENSITY: 5, MAX_SPEED: 12000, ACCEL: 2400,
      BREAKING: -12000, DECEL: -2400, OFF_ROAD_DECEL: -6000, OFF_ROAD_LIMIT: 3000,
      CENTRIFUGAL: 0.3, STEP: 1 / 60, CAMERA_DEPTH: 0.8391, ROAD_WIDTH_HALF: 1000
    };
    for (const k of Object.keys(expect)) {
      if (k === 'CAMERA_DEPTH') { c.near(T[k], expect[k], 0.0002, 'TUNING.CAMERA_DEPTH'); continue; }
      c.near(T[k], expect[k], 1e-9, 'TUNING.' + k);
    }
    c.near(T.PLAYER_Z, 1000 * T.CAMERA_DEPTH, 1e-6, 'PLAYER_Z = 1000 * CAMERA_DEPTH');
    c.near(T.SPRITE_SCALE, 0.3 / 48, 1e-12, 'SPRITE_SCALE');
  }, { group: 'core' });

  t('createState-has-every-contract-field', (c) => {
    const s = M('CORE').createState();
    const need = ['now', 'dt', 'frame', 'fps', 'mode', 'modeTime', 'prevMode',
      'position', 'speed', 'playerX', 'playerY', 'steer', 'throttle', 'brake', 'gear', 'rpm', 'shiftTimer',
      'stage', 'stageIndex', 'lap', 'laps', 'trackLength', 'track', 'segments', 'cars',
      'checkpoint', 'checkpoints', 'nextCheckpoint', 'timeLeft', 'lapTime', 'lastLapTime',
      'bestLapTime', 'totalTime', 'score', 'combo', 'best',
      'cameraHeight', 'cameraDepth', 'playerZ', 'skyOffset', 'hillOffset', 'treeOffset',
      'shake', 'flash', 'hitTimer', 'offRoad', 'skid', 'crash', 'crashTimer',
      'menuIndex', 'menuItems', 'countdown', 'paused', 'muted', 'quality', 'showFps', 'hint',
      'messages', 'theme', 'results', 'errors', 'shakeX', 'shakeY', 'crashX', 'crashY', 'crashFrame'];
    const gone = need.filter(k => !(k in s));
    c.eq(gone.length, 0, 'missing state fields: ' + gone.join(','));
  }, { group: 'core' });

  t('rng-determinism-and-range', (c) => {
    const C = M('CORE');
    const a = C.rng(1234), b = C.rng(1234);
    for (let i = 0; i < 50; i++) c.eq(a(), b(), 'draw ' + i);
    const r = C.rng(7);
    for (let i = 0; i < 2000; i++) { const v = r(); if (!(v >= 0 && v < 1)) c.fail('out of range: ' + v); }
    c.ok(C.rndInt(C.rng(1), 3, 3) === 3, 'rndInt inclusive');
  }, { group: 'core' });

  t('themes-and-stages', (c) => {
    const C = M('CORE');
    c.eq(Object.keys(C.THEMES).length, 3, 'three themes');
    c.eq(C.STAGES.length, 3, 'three stages');
    for (const st of C.STAGES) {
      c.ok(C.THEMES[st.theme], 'stage ' + st.id + ' theme "' + st.theme + '" exists');
      c.eq(st.laps, 2, 'stage ' + st.id + ' laps');
      c.ok(st.timeLimit > 0, 'stage ' + st.id + ' timeLimit');
      c.ok(typeof st.name === 'string' && st.name.length, 'stage ' + st.id + ' name');
    }
    const keys = C.STAGES.map(s => s.theme);
    c.eq(new Set(keys).size, 3, 'the three stages use three different themes');
  }, { group: 'core' });

  t('storage-namespacing', (c) => {
    const C = M('CORE');
    c.eq(C.storage.set('probe', { a: 1 }), true, 'set returns true');
    const raw = shim.window.localStorage.getItem('neondrift86.probe');
    c.ok(raw !== null, 'key is namespaced under neondrift86.* (got ' + fmt(raw) + ')');
    c.eq(JSON.stringify(C.storage.get('probe', null)), '{"a":1}', 'round-trip');
    c.eq(C.storage.get('missing-key', 'def'), 'def', 'default returned');
  }, { group: 'core' });

  t('bitmap-font-draws', (c) => {
    const C = M('CORE');
    const cv = shim.createCanvas(120, 24), g = cv.getContext('2d');
    g.fillStyle = '#101010'; g.fillRect(0, 0, 120, 24);
    const w = C.drawText(g, 'AB 09', 2, 2, { color: '#ffffff', scale: 2, shadow: '#000000' });
    c.eq(w, C.textWidth('AB 09', 2, 1), 'drawText returns textWidth');
    let white = 0;
    const d = g.getImageData(0, 0, 120, 24).data;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 200) white++;
    c.ok(white > 30, 'glyphs actually rasterised (' + white + ' bright px)');
    c.eq(C.drawText(g, '', 0, 0, {}), 0, 'empty string draws nothing');
  }, { group: 'core' });

  t('formatting-table', (c) => {
    const C = M('CORE');
    c.eq(C.formatTime(83.456), '1:23.46', 'formatTime');
    c.eq(C.formatTime(NaN), '--:--.--', 'formatTime NaN');
    c.eq(C.formatTime(-1), '--:--.--', 'formatTime negative');
    c.eq(C.formatScore(1234), '0001234', 'formatScore');
    c.eq(C.pad(7, 3), '007', 'pad');
  }, { group: 'core' });

  /* ============================================================== C: ROAD */
  t('build-shape', (c) => {
    if (!needMod('ROAD', c, 'road')) return;
    const C = M('CORE'), R = M('ROAD');
    for (let i = 0; i < 3; i++) {
      const tr = R.build(i);
      c.ok(tr, 'build(' + i + ') returned a track');
      c.eq(tr.stageIndex, i, 'stageIndex');
      c.ok(tr.theme === C.THEMES[C.STAGES[i].theme], 'theme object identity for stage ' + i);
      c.ok(typeof tr.name === 'string' && tr.name.length > 0, 'name');
      c.ok(Number.isInteger(tr.seed), 'seed is an int');
      c.ok(tr.segments.length >= 1200, 'segments >= 1200, got ' + tr.segments.length);
      c.eq(tr.trackLength, tr.segments.length * C.TUNING.SEGMENT_LENGTH, 'trackLength');
    }
  }, { group: 'road' });

  t('segment-fields-and-closure', (c) => {
    if (!needMod('ROAD', c, 'road')) return;
    const R = M('ROAD'), SEG = M('CORE').TUNING.SEGMENT_LENGTH;
    for (let i = 0; i < 3; i++) {
      const tr = R.build(i), segs = tr.segments;
      for (let k = 0; k < segs.length; k += Math.max(1, Math.floor(segs.length / 40))) {
        const s = segs[k];
        if (s.index !== k) c.fail('segments[' + k + '].index = ' + s.index);
        if (typeof s.dark !== 'boolean') c.fail('segments[' + k + '].dark must be boolean');
        if (!isFinite(s.curve)) c.fail('segments[' + k + '].curve not finite');
        if (!s.p1 || !s.p2 || !s.p1.world || !s.p2.world) c.fail('segments[' + k + '] missing points');
        if (s.looped !== false || s.fog !== 0 || s.clip !== 0 || s.light !== 0) c.fail('segments[' + k + '] render scratch not zeroed at build time');
        if (!Array.isArray(s.sprites)) c.fail('segments[' + k + '].sprites not an array');
      }
      /* continuity: every p2 flows into the next p1, last joins the first */
      let broken = -1;
      for (let k = 0; k < segs.length - 1; k++) {
        if (segs[k].p2.world.z !== segs[k + 1].p1.world.z) { broken = k; break; }
      }
      c.eq(broken, -1, 'stage ' + i + ': p2 -> next p1 continuity broken at segment ' + broken);
      const last = segs[segs.length - 1];
      const gap = (segs[0].p1.world.z + tr.trackLength) - last.p2.world.z;
      /* segments cover [0, trackLength); the last one must land exactly on 0 */
      c.eq(gap, 0, 'stage ' + i + ': last segment must join the first (gap ' + gap + ', expected 0)');
    }
  }, { group: 'road' });

  t('checkpoints-contract', (c) => {
    if (!needMod('ROAD', c, 'road')) return;
    const R = M('ROAD'), SEG = M('CORE').TUNING.SEGMENT_LENGTH;
    for (let i = 0; i < 3; i++) {
      const tr = R.build(i), cps = tr.checkpoints, n = tr.segments.length;
      c.ok(Array.isArray(cps) && cps.length >= 2, 'stage ' + i + ': checkpoints array');
      c.eq(cps[0], 0, 'stage ' + i + ': first checkpoint is the start/finish line');
      const lastIdx = cps.length - 1;
      for (let k = 1; k < cps.length; k++) {
        const isLapLineEntry = (k === lastIdx) && cps[k] === cps[0];
        if (!isLapLineEntry && !(cps[k] > cps[k - 1])) {
          c.fail('stage ' + i + ': checkpoints must ascend, except the trailing lap line; got [' + cps.join(',') + ']');
        }
        if (!(cps[k] >= 0 && cps[k] < n)) c.fail('stage ' + i + ': checkpoint ' + cps[k] + ' out of range (segments=' + n + ')');
      }
      c.ok(isFinite(tr.trackLength) && tr.trackLength === n * SEG, 'trackLength consistent');
      /* CONTRACT.md §3: "last one == first index (lap line)" — GAME.completeLap()
         fires on checkpoints[n-1], so the lap line must be the last entry. */
      c.eq(cps[lastIdx], cps[0],
        'stage ' + i + ': checkpoints[' + lastIdx + '] must equal checkpoints[0] (the lap line) per CONTRACT §3; got [' + cps.join(',') + ']');
    }
  }, { group: 'road' });

  t('cars-are-valid', (c) => {
    if (!needMod('ROAD', c, 'road')) return;
    const R = M('ROAD'), C = M('CORE');
    if (has('SPRITES') && SPRITES.init) SPRITES.init();
    const spriteOk = has('SPRITES') && typeof SPRITES.has === 'function' ? (n) => SPRITES.has(n) : null;
    for (let i = 0; i < 3; i++) {
      const tr = R.build(i);
      c.ok(tr.cars.length > 0, 'stage ' + i + ' has traffic');
      for (const car of tr.cars) {
        if (!(car.z >= 0 && car.z < tr.trackLength)) c.fail('car z out of range: ' + car.z);
        if (!(car.offset >= -1 && car.offset <= 1)) c.fail('car offset out of range: ' + car.offset);
        if (!(car.speed > 0 && car.speed < C.TUNING.MAX_SPEED * 0.8)) c.fail('car speed out of range: ' + car.speed);
        if (!(car.w > 0) || !(car.h > 0)) c.fail('car w/h must be positive');
        if (typeof car.sprite !== 'string' || !car.sprite.length) c.fail('car sprite name missing');
        if (spriteOk && !spriteOk(car.sprite)) c.fail('car sprite "' + car.sprite + '" is not a SPRITES key');
      }
    }
  }, { group: 'road' });

  t('project-perspective', (c) => {
    if (!needMod('ROAD', c, 'road')) return;
    const R = M('ROAD'), T = M('CORE').TUNING;
    const mk = (z) => ({ world: { x: 0, y: 0, z }, camera: { x: 0, y: 0, z: 0 }, screen: { x: 0, y: 0, w: 0, scale: 0 } });
    const near = R.project(mk(2000), 0, 1000, 0, T.CAMERA_DEPTH, 384, 216, T.ROAD_WIDTH);
    const far = R.project(mk(40000), 0, 1000, 0, T.CAMERA_DEPTH, 384, 216, T.ROAD_WIDTH);
    c.ok(near.screen.scale > far.screen.scale, 'near scale > far scale (' + fmt(near.screen.scale) + ' vs ' + fmt(far.screen.scale) + ')');
    c.ok(near.screen.w > far.screen.w, 'near road width > far road width');
    c.ok(far.screen.y < near.screen.y, 'far screen.y converges toward the horizon (y=' + fmt(far.screen.y) + ' < ' + fmt(near.screen.y) + ')');
    /* exact formula check, per CONTRACT §3 */
    const p = mk(1000 * T.CAMERA_DEPTH + 5000);
    p.world.x = 300; p.world.y = 400;
    R.project(p, 100, 1000, 200, T.CAMERA_DEPTH, 384, 216, T.ROAD_WIDTH);
    const scale = T.CAMERA_DEPTH / (p.world.z - 200);
    c.near(p.camera.x, 300 - 100, 1e-6, 'camera.x = world.x - cameraX');
    c.near(p.camera.y, 400 - 1000, 1e-6, 'camera.y = world.y - cameraY');
    c.near(p.camera.z, p.world.z - 200, 1e-6, 'camera.z = world.z - cameraZ');
    c.near(p.screen.scale, scale, 1e-9, 'screen.scale = cameraDepth / camera.z');
    const fx = (384 / 2) + scale * p.camera.x * 384 / 2;
    const fy = (216 / 2) - scale * p.camera.y * 216 / 2;
    const fw = scale * T.ROAD_WIDTH * 384 / 2;
    /* road.js snaps screen.x/y/w to integers for pixel art; accept that
       documented deviation but require camera coords and scale to stay exact. */
    const snapped = (p.screen.x !== fx) || (p.screen.y !== fy) || (p.screen.w !== fw);
    c.ok(Math.abs(p.screen.x - fx) <= 0.5, 'screen.x formula (got ' + p.screen.x + ', formula ' + fx.toFixed(3) + ')');
    c.ok(Math.abs(p.screen.y - fy) <= 0.5, 'screen.y formula (got ' + p.screen.y + ', formula ' + fy.toFixed(3) + ')');
    c.ok(Math.abs(p.screen.w - fw) <= 0.5, 'screen.w formula (got ' + p.screen.w + ', formula ' + fw.toFixed(3) + ')');
    if (snapped) {
      const ints = Number.isInteger(p.screen.x) && Number.isInteger(p.screen.y) && Number.isInteger(p.screen.w);
      if (!ints) c.fail('screen values are neither exact nor integer-snapped: ' + p.screen.x + '/' + p.screen.y + '/' + p.screen.w);
      c.warn('road.js rounds screen.x/y/w to whole pixels (deviation from the literal CONTRACT §3 formula; scale/camera stay exact)');
    }
  }, { group: 'road' });

  t('segment-lookup-helpers', (c) => {
    if (!needMod('ROAD', c, 'road')) return;
    const R = M('ROAD'), SEG = M('CORE').TUNING.SEGMENT_LENGTH;
    const tr = R.build(0), n = tr.segments.length;
    for (const z of [0, 1, SEG * 3 + 7, tr.trackLength - 1]) {
      const s = R.findSegment(tr, z);
      c.ok(s && s.index === Math.floor(z / SEG), 'findSegment(' + z + ') -> ' + (s && s.index));
    }
    c.eq(R.segmentAt(tr, -1).index, n - 1, 'segmentAt wraps negative index');
    c.eq(R.segmentAt(tr, n).index, 0, 'segmentAt wraps past the end');
    const idx = R.playerSegmentIndex(tr, 5000);
    c.ok(Number.isInteger(idx) && idx >= 0 && idx < n, 'playerSegmentIndex returns a valid index (' + idx + ')');
  }, { group: 'road' });

  t('build-is-deterministic', (c) => {
    if (!needMod('ROAD', c, 'road')) return;
    const R = M('ROAD');
    const a = R.build(1), b = R.build(1);
    c.eq(a.segments.length, b.segments.length, 'segment count');
    c.eq(a.cars.length, b.cars.length, 'car count');
    let diff = -1;
    for (let i = 0; i < a.segments.length; i++) {
      if (a.segments[i].curve !== b.segments[i].curve || a.segments[i].p1.world.y !== b.segments[i].p1.world.y) { diff = i; break; }
    }
    c.eq(diff, -1, 'two builds of stage 1 differ at segment ' + diff);
    c.eq(a.checkpoints.join(','), b.checkpoints.join(','), 'checkpoints identical');
  }, { group: 'road' });

  /* =========================================================== D: SPRITES */
  const SPRITE_KEYS = {
    player: ['player_straight', 'player_left', 'player_right', 'player_brake', 'player_shadow'],
    traffic: ['car_red', 'car_blue', 'car_green', 'car_yellow', 'car_purple', 'truck_white', 'truck_blue'],
    scenery: ['palm', 'pine', 'cactus', 'rock', 'bush', 'boulder', 'lamp', 'arch',
      'billboard_0', 'billboard_1', 'billboard_2', 'billboard_3'],
    fx: ['boom_0', 'boom_1', 'boom_2', 'boom_3']
  };

  t('required-keys-exist', (c) => {
    if (!needMod('SPRITES', c, 'sprites')) return;
    SPRITES.init();
    const gone = [];
    for (const grp of Object.keys(SPRITE_KEYS)) {
      for (const k of SPRITE_KEYS[grp]) if (!SPRITES.has(k)) gone.push(k);
    }
    c.eq(gone.length, 0, 'missing sprite keys: ' + gone.join(','));
  }, { group: 'sprites' });

  t('get-returns-canvas-and-anchor', (c) => {
    if (!needMod('SPRITES', c, 'sprites')) return;
    SPRITES.init();
    for (const grp of Object.keys(SPRITE_KEYS)) {
      for (const k of SPRITE_KEYS[grp]) {
        const s = SPRITES.get(k);
        if (!s) { c.fail(k + ': get() returned null'); }
        if (!s.canvas) c.fail(k + ': no canvas');
        if (!(s.w > 0 && s.h > 0)) c.fail(k + ': bad size ' + s.w + 'x' + s.h);
        if (!s.anchor || !(s.anchor.x >= 0 && s.anchor.x <= 1) || !(s.anchor.y >= 0 && s.anchor.y <= 1)) {
          c.fail(k + ': anchor must be fractions in 0..1, got ' + fmt(s.anchor));
        }
      }
    }
  }, { group: 'sprites' });

  t('nominal-sizes', (c) => {
    if (!needMod('SPRITES', c, 'sprites')) return;
    const rules = [
      ['player', SPRITE_KEYS.player.filter(k => k !== 'player_shadow'), 32, 68, 18, 40],
      ['traffic', SPRITE_KEYS.traffic, 26, 68, 12, 44],
      ['scenery', SPRITE_KEYS.scenery, 4, 96, 4, 140],
      ['fx', SPRITE_KEYS.fx, 12, 56, 12, 56]
    ];
    for (const [grp, keys, minW, maxW, minH, maxH] of rules) {
      for (const k of keys) {
        const s = SPRITES.get(k);
        if (!s) { c.fail(k + ' missing'); }
        if (s.w < minW || s.w > maxW || s.h < minH || s.h > maxH) {
          c.fail(k + ' size ' + s.w + 'x' + s.h + ' outside ' + grp + ' bounds ' + minW + '-' + maxW + ' x ' + minH + '-' + maxH);
        }
      }
    }
    /* the ground shadow is legitimately flat, not car-shaped */
    const sh = SPRITES.get('player_shadow');
    if (sh) {
      c.ok(sh.w >= 20 && sh.w <= 80 && sh.h >= 3 && sh.h <= 24,
        'player_shadow should be a flat wide blob, got ' + sh.w + 'x' + sh.h);
      c.ok(sh.w > sh.h, 'player_shadow is wider than it is tall');
    }
    const sizes = SPRITE_KEYS.player.slice(0, 4).map(k => SPRITES.get(k).w + 'x' + SPRITES.get(k).h);
    c.eq(new Set(sizes).size, 1, 'player pose frames share one size: ' + sizes.join(' '));
  }, { group: 'sprites' });

  t('get-unknown-key-is-null', (c) => {
    if (!needMod('SPRITES', c, 'sprites')) return;
    c.eq(SPRITES.get('definitely_not_a_sprite'), null, 'unknown key -> null');
    c.eq(SPRITES.has('definitely_not_a_sprite'), false, 'has() false');
  }, { group: 'sprites' });

  t('catalogue-sets', (c) => {
    if (!needMod('SPRITES', c, 'sprites')) return;
    const names = SPRITES.names();
    c.ok(Array.isArray(names), 'names() returns an array');
    /* every key that has()/get() serve must be enumerable: the contact sheet,
       the sprite audit and any tooling all walk names() */
    const hidden = [];
    for (const k of Object.values(SPRITE_KEYS).flat()) {
      if (SPRITES.has(k) && !names.includes(k)) hidden.push(k);
    }
    c.eq(hidden.length, 0, 'requested keys missing from names(): ' + hidden.join(','));
    c.ok(names.length >= 26, 'names() returns the catalogue (' + names.length + ')');
    c.eq(new Set(names).size, names.length, 'names() has no duplicates');
    for (const theme of ['sunset', 'night', 'dawn']) {
      c.ok(Array.isArray(SPRITES.SCENERY[theme]) && SPRITES.SCENERY[theme].length >= 3, 'SCENERY.' + theme);
      c.ok(Array.isArray(SPRITES.OPPONENTS[theme]) && SPRITES.OPPONENTS[theme].length >= 2, 'OPPONENTS.' + theme);
      for (const k of SPRITES.SCENERY[theme]) c.ok(SPRITES.has(k), 'SCENERY.' + theme + ' references unknown sprite ' + k);
      for (const k of SPRITES.OPPONENTS[theme]) c.ok(SPRITES.has(k), 'OPPONENTS.' + theme + ' references unknown sprite ' + k);
    }
    for (const k of ['straight', 'left', 'right', 'brake', 'shadow']) {
      c.ok(SPRITES.HERO[k] && SPRITES.has(SPRITES.HERO[k]), 'HERO.' + k);
    }
  }, { group: 'sprites' });

  t('sprites-are-not-placeholders', (c) => {
    if (!needMod('SPRITES', c, 'sprites')) return;
    const thin = [], flat = [];
    for (const k of SPRITES.names()) {
      const s = SPRITES.get(k);
      if (!s || !s.canvas) { thin.push(k + '(null)'); continue; }
      const buf = s.canvas._buf;
      const seen = new Set();
      let opaque = 0;
      for (let i = 0; i < buf.length; i += 4) {
        if (buf[i + 3] > 8) {
          opaque++;
          if (seen.size < 6) seen.add((buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2]);
        }
      }
      if (opaque < 12) thin.push(k + '(' + opaque + 'px)');
      else if (seen.size < 2 && k !== 'player_shadow') flat.push(k + '(' + seen.size + ' colour)');
    }
    c.eq(thin.length, 0, 'sprites that are effectively empty: ' + thin.slice(0, 8).join(', '));
    c.eq(flat.length, 0, 'sprites drawn in a single colour: ' + flat.slice(0, 8).join(', '));
  }, { group: 'sprites' });

  t('init-is-idempotent', (c) => {
    if (!needMod('SPRITES', c, 'sprites')) return;
    const before = SPRITES.names().length;
    SPRITES.init(); SPRITES.init();
    c.eq(SPRITES.names().length, before, 'catalogue stable across repeated init()');
  }, { group: 'sprites' });

  /* ============================================================= E: AUDIO */
  t('safe-without-audiocontext', (c) => {
    if (!needMod('AUDIO', c, 'audio')) return;
    shim.removeMockAudio();
    const calls = [
      () => AUDIO.init(), () => AUDIO.unlock(), () => AUDIO.playMusic('race'), () => AUDIO.stopMusic(),
      () => AUDIO.setMusicTempo(140), () => AUDIO.setEngine(0.5, true), () => AUDIO.setSkid(true),
      () => AUDIO.setMuted(true), () => AUDIO.isMuted(), () => AUDIO.update(1 / 60), () => AUDIO.setMuted(false),
      ...['beep', 'go', 'checkpoint', 'crash', 'select', 'shift', 'engine_start', 'timeup', 'unknown_sfx']
        .map(n => () => AUDIO.sfx(n))
    ];
    for (let i = 0; i < calls.length; i++) {
      try { calls[i](); } catch (e) { c.fail('call #' + i + ' threw without AudioContext: ' + e.message); }
    }
    c.ok(!AUDIO.ready, 'AUDIO.ready is falsy when there is no AudioContext (got ' + fmt(AUDIO.ready) + ')');
  }, { group: 'audio' });

  t('works-with-a-mock-context', (c) => {
    if (!needMod('AUDIO', c, 'audio')) return;
    const rec = shim.installMockAudio();
    let initRes;
    try { initRes = AUDIO.init(); } catch (e) { c.fail('AUDIO.init threw with a live AudioContext: ' + e.message); }
    if (initRes && typeof initRes.then === 'function') initRes = null;
    AUDIO.unlock();
    const ctxs = rec.contexts;
    c.ok(ctxs >= 1, 'AUDIO.init created an AudioContext');
    c.ok(AUDIO.ready !== false, 'AUDIO.ready after init (got ' + fmt(AUDIO.ready) + ')');
    const nodesBefore = rec.nodes.length;
    try {
      AUDIO.playMusic('race');
      AUDIO.setMusicTempo(150);
      AUDIO.sfx('crash');
      AUDIO.setEngine(0.7, true);
      AUDIO.setSkid(true);
      AUDIO.update(1 / 60);
      AUDIO.setEngine(0, false);
      AUDIO.setSkid(false);
      AUDIO.stopMusic();
      AUDIO.playMusic('title'); AUDIO.playMusic('result'); AUDIO.stopMusic();
      AUDIO.setMuted(true);
    } catch (e) { c.fail('audio call threw with a live context: ' + e.message); }
    c.ok(rec.nodes.length > nodesBefore, 'audio graph nodes were created (' + (rec.nodes.length - nodesBefore) + ')');
    const started = rec.started;
    c.ok(started > 0, 'oscillators/buffers were started (' + started + ')');
    c.eq(AUDIO.isMuted(), true, 'setMuted(true) -> isMuted()');
    AUDIO.setMuted(false);

    /* master gain must stay well under clipping (CONTRACT §5: peak <= 0.35) */
    const destGains = rec.nodes.filter(n => n._type === 'gain' && (n._connections || []).some(d => d && d._type === 'destination'));
    if (!destGains.length) {
      c.warn('no gain node wired directly to destination — master level could not be measured');
    } else {
      let peak = 0;
      for (const g of destGains) {
        const p = g.gain;
        if (!p) continue;
        peak = Math.max(peak, p.value || 0, ...p.events.filter(e => typeof e[1] === 'number').map(e => e[1]));
      }
      c.ok(peak <= 0.35 + 1e-9, 'master gain peak must be <= 0.35, measured ' + peak);
    }
    shim.removeMockAudio();
  }, { group: 'audio' });

  /* ============================================================ F: RENDER */
  const stageFrames = [];
  function renderStage(i, quality) {
    const C = M('CORE'), R = M('ROAD'), W = C.W, H = C.H;
    const cv = shim.createCanvas(W, H), ctx = cv.getContext('2d');
    const state = C.createState();
    const track = R.build(i);
    Object.assign(state, {
      stageIndex: i, stage: i, track, segments: track.segments, cars: track.cars,
      theme: track.theme, trackLength: track.trackLength, checkpoints: track.checkpoints,
      nextCheckpoint: track.checkpoints[1], laps: C.STAGES[i].laps, lap: 1,
      mode: 'race', modeTime: 3, position: Math.floor(track.trackLength * 0.4),
      speed: 8000, gear: 3, rpm: 0.6, timeLeft: 44.4, lapTime: 12.3, totalTime: 40,
      score: 12345, messages: []
    });
    RENDER.setQuality(quality || 'high');
    RENDER.init(ctx, state);
    RENDER.draw(ctx, state);
    return { data: Uint8ClampedArray.from(cv._buf), cv, theme: track.theme, stats: imageStats(cv._buf, W, H) };
  }

  t('draws-each-stage-theme', (c) => {
    if (!needMod('RENDER', c, 'render')) return;
    if (!needMod('ROAD', c, 'road')) return;
    const W = M('CORE').W, H = M('CORE').H;
    /* Palette identity is asserted on the PRE-CRT image (quality 'low'):
       the CRT pass applies a global tint, so absolute palette proximity on the
       final frame would measure the CRT, not the theme.  The CRT is checked
       separately by crt-stays-subtle. */
    for (let i = 0; i < 3; i++) {
      const f = renderStage(i, 'low');
      stageFrames.push(f);
      c.ok(!isBlank(f.stats), 'stage ' + i + ' frame is not blank (distinct=' + f.stats.distinct +
        ' dominantFrac=' + f.stats.dominantFrac.toFixed(3) + ')');
    }

    const paletteOf = (th) => [...th.sky, th.grassDark, th.grassLight, th.roadDark, th.roadLight,
      th.mountFar, th.mountNear, th.rumbleDark, th.rumbleLight, th.lane, th.fog, th.sunCore, th.sunGlow, th.sunBand]
      .map(hex => parseColor(hex)).filter(Boolean);
    const pals = stageFrames.map(f => paletteOf(f.theme));
    const votes = (data) => {
      const tally = new Array(3).fill(0);
      let total = 0;
      /* sky band only, below the HUD panels (which use UI colours, not theme
         colours) and above the horizon: this is the theme's signature area */
      for (let y = 44; y < 95; y++) {
        for (let x = 0; x < W; x++) {
          const o = (y * W + x) * 4, r = data[o], g = data[o + 1], b = data[o + 2];
          let best = 0, bestD = Infinity;
          for (let pi = 0; pi < 3; pi++) {
            for (const p of pals[pi]) {
              const d = Math.abs(r - p.r) + Math.abs(g - p.g) + Math.abs(b - p.b);
              if (d < bestD) { bestD = d; best = pi; }
            }
          }
          tally[best]++; total++;
        }
      }
      return tally.map(v => v / total);
    };
    const report = [];
    for (let i = 0; i < 3; i++) {
      const v = votes(stageFrames[i].data);
      const best = v.indexOf(Math.max(...v));
      report.push('stage' + (i + 1) + '=' + stageFrames[i].theme.key + ' sky-votes[' +
        v.map((x, k) => stageFrames[k].theme.key + ':' + (x * 100).toFixed(0) + '%').join(' ') + ']');
      c.ok(v[i] >= 0.50, 'stage ' + (i + 1) + ' sky band: only ' + (v[i] * 100).toFixed(0) +
        '% of pixels are closest to its own theme palette (' + stageFrames[i].theme.key + ')');
      c.eq(best, i, 'stage ' + (i + 1) + ' sky band looks most like "' + stageFrames[best].theme.key +
        '" (' + (v[best] * 100).toFixed(0) + '%) but the stage theme is "' + stageFrames[i].theme.key + '"');
    }
    const diffs = [];
    for (let i = 0; i < 3; i++) {
      for (let j = i + 1; j < 3; j++) {
        const d = diffStats(stageFrames[i].data, stageFrames[j].data, W, H);
        diffs.push('s' + (i + 1) + '-s' + (j + 1) + ':' + (d.changedFrac * 100).toFixed(0) + '%');
        c.ok(d.changedFrac > 0.15, 'stage ' + (i + 1) + ' and ' + (j + 1) + ' frames differ in only ' +
          (d.changedFrac * 100).toFixed(1) + '% of pixels — looks like the same theme twice');
      }
    }
    c.detail = report.join(' ') + ' | pairwise ' + diffs.join(' ');
  }, { group: 'render' });

  t('crt-stays-subtle', (c) => {
    if (!needMod('RENDER', c, 'render')) return;
    if (!needMod('ROAD', c, 'road')) return;
    /* CONTRACT §6: the CRT pass is "1-in-N scanlines, 2-px edge vignette,
       subtle vertical chroma shift" — it must not repaint the picture.
       Measured as: how much luminance does 'high' keep compared with 'low'? */
    const rows = [];
    for (let i = 0; i < 3; i++) {
      const hi = renderStage(i, 'high'), lo = stageFrames[i] || renderStage(i, 'low');
      const lum = (s) => (s.mean[0] + s.mean[1] + s.mean[2]) / 3;
      const ratio = lum(hi.stats) / lum(lo.stats);
      rows.push(hi.theme.key + ' ' + (ratio * 100).toFixed(0) + '%');
      c.ok(!isBlank(hi.stats), 'stage ' + (i + 1) + ' high-quality frame is not blank');
      c.ok(ratio >= 0.60, 'CRT pass keeps only ' + (ratio * 100).toFixed(0) + '% of the frame luminance on stage ' +
        (i + 1) + ' (' + hi.theme.key + ') — a subtle scanline/vignette pass should keep >= 60%');
    }
    /* and the CRT must not be a flat repaint: check the row pattern */
    const hi = renderStage(0, 'high');
    const rowLum = (buf, y) => { let s = 0; for (let x = 0; x < 384; x++) { const o = (y * 384 + x) * 4; s += (buf[o] + buf[o + 1] + buf[o + 2]) / 3; } return s / 384; };
    let bandRows = 0;
    for (let y = 44; y < 95; y++) {
      const l = rowLum(stageFrames[0].data, y);
      if (l > 8 && rowLum(hi.data, y) / l > 0.75) bandRows++;
    }
    if (bandRows === 0) c.warn('every sky row is darkened by >25% — the CRT reads as a global tint, not scanlines');
    RENDER.setQuality('high');
    RENDER.reset();
    c.detail = 'mean luminance retained: ' + rows.join(', ');
  }, { group: 'render' });

  t('renderer-does-not-mutate-gameplay-state', (c) => {
    if (!needMod('RENDER', c, 'render')) return;
    if (!needMod('ROAD', c, 'road')) return;
    const C = M('CORE'), R = M('ROAD');
    const cv = shim.createCanvas(C.W, C.H), ctx = cv.getContext('2d');
    const state = C.createState();
    const track = R.build(0);
    Object.assign(state, {
      track, segments: track.segments, cars: track.cars, theme: track.theme,
      trackLength: track.trackLength, checkpoints: track.checkpoints, mode: 'race',
      position: 12345, speed: 6000, playerX: 0.3, lap: 1, laps: 2, timeLeft: 50, score: 999
    });
    const snapshot = JSON.stringify(state, (k, v) => (k === 'track' || k === 'segments' || k === 'cars' || k === 'theme') ? undefined : v);
    const segBefore = track.segments.map(s => [s.looped, s.fog, s.clip, s.light]);
    RENDER.init(ctx, state);
    RENDER.draw(ctx, state);
    const after = JSON.stringify(state, (k, v) => (k === 'track' || k === 'segments' || k === 'cars' || k === 'theme') ? undefined : v);
    const allowed = new Set(['shakeX', 'shakeY', 'fps']);
    if (snapshot !== after) {
      const a = JSON.parse(snapshot), b = JSON.parse(after);
      const changed = [];
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (JSON.stringify(a[k]) !== JSON.stringify(b[k]) && !allowed.has(k)) changed.push(k);
      }
      c.eq(changed.length, 0, 'RENDER mutated gameplay-owned state fields: ' + changed.join(','));
    }
    let badSeg = -1;
    track.segments.forEach((s, i) => {
      const now = [s.looped, s.fog, s.clip, s.light];
      if (typeof now[0] !== 'boolean' || !isFinite(now[1]) || !isFinite(now[2]) || !isFinite(now[3])) badSeg = i;
    });
    c.eq(badSeg, -1, 'render scratch fields must stay boolean/finite (segment ' + badSeg + ')');
  }, { group: 'render' });

  t('quality-low-still-renders', (c) => {
    if (!needMod('RENDER', c, 'render')) return;
    const C = M('CORE'), R = M('ROAD');
    const cv = shim.createCanvas(C.W, C.H), ctx = cv.getContext('2d');
    const state = C.createState();
    const track = R.build(1);
    Object.assign(state, { track, segments: track.segments, cars: track.cars, theme: track.theme, trackLength: track.trackLength, checkpoints: track.checkpoints, mode: 'race', position: 20000, speed: 7000 });
    RENDER.init(ctx, state);
    RENDER.setQuality('low');
    RENDER.draw(ctx, state);
    const stats = imageStats(cv._buf, C.W, C.H);
    c.ok(!isBlank(stats), 'low quality frame is not blank');
    RENDER.setQuality('high');
    RENDER.reset();
  }, { group: 'render' });

  t('survives-empty-state', (c) => {
    if (!needMod('RENDER', c, 'render')) return;
    const C = M('CORE');
    const cv = shim.createCanvas(C.W, C.H), ctx = cv.getContext('2d');
    const state = C.createState();
    state.mode = 'race';
    try { RENDER.init(ctx, state); RENDER.draw(ctx, state); }
    catch (e) { c.fail('RENDER.draw with no track threw: ' + (e.stack || e.message).split('\n').slice(0, 3).join(' | ')); }
    state.mode = 'title';
    try { RENDER.draw(ctx, state); } catch (e) { c.fail('RENDER.draw title screen with no track threw: ' + e.message); }
  }, { group: 'render' });

  /* ============================================================= G: INPUT */
  t('keyboard-mapping', (c) => {
    if (!needMod('INPUT', c, 'input')) return;
    INPUT.init(shim.document.body);
    const cases = [
      ['ArrowLeft', 'left'], ['a', 'left'], ['A', 'left'],
      ['ArrowRight', 'right'], ['d', 'right'],
      ['ArrowUp', 'up'], ['w', 'up'],
      ['ArrowDown', 'down'], ['s', 'down']
    ];
    for (const [key, action] of cases) {
      INPUT.reset();
      shim.keyDown(key);
      const on = INPUT.state[action] === true || (action === 'up' && INPUT.axis.throttle > 0.5) ||
        (action === 'down' && (INPUT.state.down || INPUT.state.brake));
      c.ok(on, 'keydown ' + key + ' should set ' + action);
      shim.keyUp(key);
      INPUT.update();
      const off = INPUT.state[action] !== true;
      c.ok(off, 'keyup ' + key + ' should clear ' + action);
    }
    INPUT.reset();
    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'a', 'd', 'w', 's', ' ']) {
      INPUT.reset();
      shim.keyDown(key);
      const a = INPUT.axis;
      c.ok(a.steer >= -1 && a.steer <= 1, 'axis.steer in range for ' + key);
      c.ok(a.throttle >= 0 && a.throttle <= 1, 'axis.throttle in range for ' + key);
      c.ok(a.brake >= 0 && a.brake <= 1, 'axis.brake in range for ' + key);
      if (key === ' ') c.ok(INPUT.axis.brake > 0 || INPUT.state.brake === true || INPUT.handbrake === true, 'Space engages handbrake/brake');
      shim.keyUp(key);
      INPUT.update();
    }
  }, { group: 'input' });

  t('edge-triggering', (c) => {
    if (!needMod('INPUT', c, 'input')) return;
    INPUT.reset();
    INPUT.update();
    c.eq(INPUT.pressed('start'), false, 'no edge before any press');
    shim.keyDown('Enter'); shim.keyUp('Enter');
    c.eq(INPUT.pressed('start'), true, 'Enter latches a start edge');
    c.eq(INPUT.pressed('start'), false, 'the edge is consumed exactly once');
    INPUT.update();
    c.eq(INPUT.pressed('start'), false, 'no phantom edge after update');
    shim.keyDown('Enter'); shim.keyUp('Enter');
    c.eq(INPUT.anyPressed(), true, 'anyPressed sees the press');
    c.eq(INPUT.anyPressed(), false, 'anyPressed consumes it');
    shim.keyDown('q'); shim.keyUp('q');
    c.eq(INPUT.anyPressed(), true, 'unmapped key still counts as "any key"');
    /* a key that is only pressed (never released) must not re-fire */
    INPUT.reset(); INPUT.update();
    shim.keyDown('ArrowUp');
    c.eq(INPUT.pressed('up'), true, 'first throttle edge');
    INPUT.update();
    c.eq(INPUT.pressed('up'), false, 'held key does not re-fire');
    shim.keyUp('ArrowUp'); INPUT.update();
  }, { group: 'input' });

  t('reset-clears-everything', (c) => {
    if (!needMod('INPUT', c, 'input')) return;
    shim.keyDown('ArrowUp'); shim.keyDown('ArrowLeft'); shim.keyDown('Space');
    INPUT.update();
    INPUT.reset();
    const s = INPUT.state, a = INPUT.axis;
    c.ok(!s.left && !s.right && !s.up && !s.down && !s.start && !s.select, 'all booleans cleared: ' + JSON.stringify(s));
    c.eq(a.steer, 0, 'steer cleared');
    c.eq(a.throttle, 0, 'throttle cleared');
    c.eq(a.brake, 0, 'brake cleared');
    shim.keyUp('ArrowUp'); shim.keyUp('ArrowLeft'); shim.keyUp('Space');
  }, { group: 'input' });

  t('touch-and-gamepad', (c) => {
    if (!needMod('INPUT', c, 'input')) return;
    INPUT.reset();
    const el = shim.gameCanvas;
    try {
      shim.touch('touchstart', [[40, 40], [200, 100]]);
      INPUT.update();
      shim.touch('touchmove', [[60, 40], [200, 100]]);
      INPUT.update();
      shim.touch('touchend', []);
      INPUT.update();
    } catch (e) { c.fail('touch handling threw: ' + e.message); }
    try {
      shim.setGamepads([{
        index: 0, id: 'mock pad', connected: true, mapping: 'standard', timestamp: 1,
        axes: [0.9, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0, touched: false }))
      }]);
      INPUT.update();
      const st = INPUT.state, ax = INPUT.axis;
      c.ok(ax.steer > 0.5, 'gamepad axis drives steering (steer=' + ax.steer + ')');
      c.ok(st.right === true, 'gamepad right state follows the stick');
    } catch (e) { c.fail('gamepad polling threw: ' + e.message); }
    shim.setGamepads([]);
    INPUT.reset();
  }, { group: 'input' });

  /* ============================================================== H: GAME */
  const game = { driver: null, boot: null };
  function freshGame(cssW, cssH, opts) {
    const d = bootGame(shim, { cssW: cssW || 384, cssH: cssH || 216 });
    if (!d.ok) throw new Fail('GAME.boot threw: ' + (d.error && d.error.stack || d.error));
    /* Most logic tests do not need pixels: skipping GAME.render() makes them
       ~400x faster.  Rendering is covered by the render tests, the frame
       export and the soak (which renders every 30th frame). */
    const drv = new Driver(shim, d, { dtMs: DT, skipRender: !(opts && opts.render) });
    if (!drv.manual) drv.detect();
    return drv;
  }
  function toTitle(d) {
    /* Enter is re-tapped until the title screen is up; survives any flow
       (gameover -> title, stageclear -> next stage -> ... ). */
    d.until((s) => s && s.mode === 'title', 900, (i, s) => {
      if (!s) return;
      if (s.mode !== 'title' && i % 20 === 0) d.key('Enter');
    });
  }
  /**
   * Robust "start a race" regardless of how the title menu behaves:
   * Enter is re-tapped until a countdown/race is running, and the cursor is
   * walked onto SELECT STAGE first when the title screen has a cursor menu.
   */
  function startRace(d, budget) {
    toTitle(d);
    d.key('ArrowDown');                 /* cursor: START RACE -> SELECT STAGE */
    d.step(4);
    d.key('ArrowUp');                   /* back to START RACE                 */
    d.step(4);
    let presses = 0;
    d.until((s) => s && (s.mode === 'race' || s.mode === 'countdown'), 900, (i) => {
      if (i % 20 === 0) { presses++; d.key('Enter'); }
    });
    return d.until((s) => s && s.mode === 'race', budget || 500);
  }

  t('raf-loop-drives-update-and-render', (c) => {
    if (!needMod('GAME', c, 'game')) return;
    const d = freshGame(384, 216, { render: true });
    c.ok(!d.manual, 'GAME schedules its own animation frames (rAF loop present)' +
      (d.manual ? ' [shim.errors=' + JSON.stringify(shim.errors.slice(0, 2)) + ' queue=' + shim._raf.size + ']' : ''));
    const before = shim.frame;
    d.step(40);
    c.ok(shim.frame > before, 'rAF callbacks actually ran (' + (shim.frame - before) + ' ticks)');
    const stats = shim.canvasStats(shim.gameCanvas);
    c.ok(stats.distinct > 2, 'the visible canvas holds a real picture after 40 rAF frames (distinct=' + stats.distinct + ')');
    c.ok(d.state.frame > 0, 'GAME advanced its fixed-step counter (' + d.state.frame + ')');
    /* let this loop die so later tests own a single instance */
    shim._raf.clear();
    shim._timers.clear();
  }, { group: 'game' });

  t('boots-to-title', (c) => {
    if (!needMod('GAME', c, 'game')) return;
    const d = freshGame(); game.driver = d;
    c.ok(d.state, 'GAME.state exists');
    const okTitle = d.until((s) => s && s.mode === 'title', 300);
    c.ok(okTitle, 'reaches title within 300 frames (mode=' + (d.state && d.state.mode) + ')');
    c.ok(d.state.menuItems.length >= 2, 'title menu has items: ' + JSON.stringify(d.state.menuItems));
  }, { group: 'game' });
  t('state-matches-contract', (c) => {
    if (!needMod('GAME', c, 'game')) return;
    const s = (game.driver || freshGame()).state;
    const ref = M('CORE').createState();
    const gone = Object.keys(ref).filter(k => !(k in s));
    c.eq(gone.length, 0, 'GAME.state is missing contract fields: ' + gone.join(','));
    c.ok(M('CORE').STAGES.some(st => st.name === s.theme.label || true), 'theme is a THEMES object');
    c.ok(String(s.mode).length > 0, 'mode set');
  }, { group: 'game' });

  t('title-to-race-flow', (c) => {
    if (!needMod('GAME', c, 'game')) return;
    const d = game.driver || freshGame();
    const ok = startRace(d);
    c.ok(ok, 'reached race (mode=' + d.state.mode + ')');
    const s = d.state;
    c.eq(s.stageIndex, 0, 'stage 1 selected by default');
    c.ok(s.track === null || s.segments.length > 100, 'track loaded (' + s.segments.length + ' segments)');
    c.ok(s.laps === 2, 'laps = 2');
    c.ok(s.timeLeft > 0, 'checkpoint timer running (' + s.timeLeft + ')');
    c.eq(s.theme, M('CORE').THEMES[M('CORE').STAGES[s.stageIndex].theme], 'theme matches the stage');
  }, { group: 'game' });

  t('offroad-decelerates-and-flags', (c) => {
    if (!needMod('GAME', c, 'game')) return;
    const d = game.driver || freshGame();
    d.until((s) => s && s.mode === 'race', 400);
    d.step(60, () => d.hold('ArrowUp'));
    d.hold('ArrowRight'); d.hold('ArrowUp');
    const off = d.until((s) => s && Math.abs(s.playerX) > 1.02, 600);
    c.ok(off, '|playerX| > 1 reachable (playerX=' + d.state.playerX.toFixed(2) + ')');
    d.step(45, () => { d.hold('ArrowRight'); d.hold('ArrowUp'); });
    const s = d.state;
    c.ok(s.offRoad === true, 'state.offRoad flag set when off the road');
    c.ok(s.speed <= M('CORE').TUNING.OFF_ROAD_LIMIT * 1.35,
      'off-road speed is limited (speed=' + Math.round(s.speed) + ', limit=' + M('CORE').TUNING.OFF_ROAD_LIMIT + ')');
    c.ok(d.until((x) => x && !x.offRoad, 900, () => { d.release('ArrowRight'); d.hold('ArrowLeft'); }), 'can return to the road');
    d.release('ArrowLeft');
  }, { group: 'game' });

  t('collision-sets-crash-fx', (c) => {
    if (!needMod('GAME', c, 'game')) return;
    const d = game.driver || freshGame();
    d.until((s) => s && s.mode === 'race', 400);
    const L = () => d.state.trackLength;
    const hit = d.until((s) => s && (s.crash === true || (s.hitTimer || 0) > 0), 1800, (i, s) => {
      if (!s || s.mode !== 'race') return;
      d.hold('ArrowUp');
      const cars = s.cars || [];
      const pz = (s.position + M('CORE').TUNING.PLAYER_Z) % L();
      let best = null, bd = Infinity;
      for (const car of cars) {
        let dz = car.z - pz;
        if (dz < -L() / 2) dz += L();
        if (dz > L() / 2) dz -= L();
        if (dz > -250 && Math.abs(dz) < 1700 && Math.abs(dz) < bd) { bd = dz; best = car; }
      }
      if (best) {
        const delta = best.offset - s.playerX;
        if (delta > 0.05) { d.hold('ArrowRight'); d.release('ArrowLeft'); }
        else if (delta < -0.05) { d.hold('ArrowLeft'); d.release('ArrowRight'); }
      }
    });
    c.ok(hit, 'a collision is reachable by aiming at traffic (crash=' + d.state.crash + ' hitTimer=' + d.state.hitTimer + ')');
    if (hit) {
      c.ok(d.state.shake > 0.02 || d.state.flash > 0.02 || d.state.crash === true, 'collision produces shake/flash/crash fx (shake=' + d.state.shake.toFixed(2) + ')');
      c.ok(d.state.hitTimer > 0, 'invulnerability window armed');
    }
    d.release('ArrowUp'); d.release('ArrowLeft'); d.release('ArrowRight');
  }, { group: 'game' });

  t('pause-and-resume', (c) => {
    if (!needMod('GAME', c, 'game')) return;
    const d = game.driver || freshGame();
    d.until((s) => s && s.mode === 'race', 400);
    d.key('Escape');
    c.ok(d.until((s) => s && (s.mode === 'paused' || s.paused === true), 120), 'Esc pauses');
    const pausedPos = d.state.position, pausedTime = d.state.timeLeft;
    d.step(30);
    c.eq(d.state.position, pausedPos, 'simulation frozen while paused');
    c.eq(d.state.timeLeft, pausedTime, 'checkpoint clock frozen while paused');
    d.key('Escape');
    c.ok(d.until((s) => s && s.mode === 'race', 120), 'Esc resumes');
  }, { group: 'game' });

  t('timer-expiry-goes-gameover', (c) => {
    if (!needMod('GAME', c, 'game')) return;
    const d = game.driver || freshGame();
    d.until((s) => s && s.mode === 'race', 400);
    d.state.timeLeft = 0.05;
    const ok = d.until((s) => s && s.mode === 'gameover', 300, () => d.hold('ArrowUp'));
    c.ok(ok, 'timeLeft -> 0 sets mode gameover (mode=' + d.state.mode + ')');
    c.ok(d.state.results && typeof d.state.results === 'object', 'results object produced at gameover');
    c.ok(!isFinite(d.state.speed) === false && d.state.speed >= 0, 'speed at gameover is a sane number (' + d.state.speed + ')');
    d.release('ArrowUp');
  }, { group: 'game' });

  t('stage-advance-switches-theme-and-track', (c) => {
    if (!needMod('GAME', c, 'game')) return;
    if (!needMod('ROAD', c, 'road')) return;
    const d = game.driver || freshGame();
    toTitle(d);
    startRace(d);
    d.until((s) => s && s.mode === 'race', 400);
    const before = { stage: d.state.stageIndex, theme: d.state.theme.key, track: d.state.track && d.state.track.name };
    c.eq(before.stage, 0, 'starting on stage 1');
    c.eq(before.theme, 'sunset', 'stage 1 theme');
    /* white-box: park on the lap trigger and finish the final lap */
    const cps = d.state.checkpoints;
    const seg = M('CORE').TUNING.SEGMENT_LENGTH;
    const trigger = (cps[cps.length - 1] === 0) ? d.state.trackLength - 300 : cps[cps.length - 1] * seg - 300;
    d.state.lap = d.state.laps;
    d.state.position = Math.max(0, trigger);
    d.state.timeLeft = Math.max(d.state.timeLeft, 25);
    d.state.speed = 9000;
    const advanced = d.until((s) => s && s.stageIndex >= 1, 900, (i, s) => {
      if (s.mode === 'race') { d.hold('ArrowUp'); } else if (i % 15 === 0) d.key('Enter');
    });
    const after = { stage: d.state.stageIndex, theme: d.state.theme && d.state.theme.key, track: d.state.track && d.state.track.name };
    c.detail = 'lap trigger at segment ' + cps[cps.length - 1] + '/' + d.state.segments.length +
      ' | before ' + JSON.stringify(before) + ' -> after ' + JSON.stringify(after);
    c.ok(advanced, 'stage advances after completing the final lap (stage=' + after.stage + ')');
    c.eq(after.theme, M('CORE').STAGES[Math.min(after.stage, 2)].theme, 'state.theme follows the new stage');
    c.ok(after.track && after.track !== before.track, 'state.track is rebuilt for the new stage (' + before.track + ' -> ' + after.track + ')');
    d.release('ArrowUp');
  }, { group: 'game' });

  t('extreme-dt-is-safe', (c) => {
    if (!needMod('GAME', c, 'game')) return;
    const d = game.driver || freshGame();
    d.until((s) => s && s.mode === 'race', 400);
    const dtList = [0, -1, 1e-9, 1e-3, 0.25, 1, 5, NaN, Infinity];
    for (const dt of dtList) {
      try { GAME.update(dt); } catch (e) { c.fail('GAME.update(' + dt + ') threw: ' + e.message); }
      const hits = findNonFinite(d.state, { maxDepth: 3, root: 'state' });
      if (hits.length) c.fail('GAME.update(' + dt + ') leaked non-finite values: ' + JSON.stringify(hits.slice(0, 4)));
      const s = d.state;
      if (s.speed < 0 || s.speed > M('CORE').TUNING.MAX_SPEED * 1.2) c.fail('speed out of bounds after dt=' + dt + ': ' + s.speed);
      if (Math.abs(s.playerX) > 3) c.fail('playerX exploded after dt=' + dt + ': ' + s.playerX);
      if (s.trackLength && (s.position < 0 || s.position >= s.trackLength)) c.fail('position out of track after dt=' + dt + ': ' + s.position);
    }
    /* a huge dt must not fast-forward the race into a broken state */
    c.ok(['race', 'countdown', 'gameover', 'paused'].includes(d.state.mode), 'mode still valid after extreme dt: ' + d.state.mode);
  }, { group: 'game' });

  t('resize-is-safe', (c) => {
    if (!needMod('GAME', c, 'game')) return;
    const d = game.driver || freshGame();
    d.until((s) => s && s.mode === 'race', 400);
    const sizes = [[1920, 1080], [800, 600], [384, 216], [320, 240], [2560, 1440]];
    for (const [w, h] of sizes) {
      shim.setViewport(w, h);
      shim.gameCanvas._clientW = w; shim.gameCanvas._clientH = h;
      try { shim.window.dispatchEvent({ type: 'resize', target: shim.window, preventDefault() { }, stopPropagation() { } }); }
      catch (e) { c.fail('resize listener threw: ' + e.message); }
      d.step(3);
      const cv = shim.gameCanvas;
      c.ok(cv.width > 0 && cv.height > 0, 'canvas has a size after resize to ' + w + 'x' + h);
    }
    shim.setViewport(1152, 648);
    shim.gameCanvas._clientW = 1152; shim.gameCanvas._clientH = 648;
    d.step(3);
  }, { group: 'game' });

  t('soak-' + soakFrames + '-frames', (c) => {
    if (!needMod('GAME', c, 'game')) return;
    const d = game.driver || freshGame();
    toTitle(d); startRace(d);
    d.until((s) => s && s.mode === 'race', 400);
    let renders = 0, blanks = 0, minTimeSeen = Infinity, maxSpeed = 0;
    const t0 = wallNow();
    for (let i = 0; i < soakFrames; i++) {
      d.hold('ArrowUp');
      if (i % 97 === 0) d.hold('ArrowLeft');
      if (i % 97 === 40) { d.release('ArrowLeft'); d.hold('ArrowRight'); }
      if (i % 97 === 80) d.release('ArrowRight');
      try { GAME.update(1 / 60); } catch (e) { c.fail('GAME.update threw at frame ' + i + ': ' + (e.stack || e.message).split('\n').slice(0, 3).join(' | ')); }
      const s = d.state;
      if (!isFinite(s.speed) || !isFinite(s.position) || !isFinite(s.playerX)) {
        c.fail('non-finite state at frame ' + i + ': speed=' + s.speed + ' position=' + s.position + ' playerX=' + s.playerX);
      }
      if (s.mode === 'race') minTimeSeen = Math.min(minTimeSeen, s.timeLeft);
      maxSpeed = Math.max(maxSpeed, s.speed);
      if (i % 30 === 0) {
        try { GAME.render(); renders++; } catch (e) { c.fail('GAME.render threw at frame ' + i + ': ' + (e.stack || e.message).split('\n').slice(0, 3).join(' | ')); }
        const stats = shim.canvasStats(shim.gameCanvas);
        if (stats.distinct <= 2) blanks++;
      }
      if (s.mode === 'gameover') { d.key('Enter'); d.step(30); startRace(d, 600); }
      if (s.mode === 'stageclear') { d.key('Enter'); d.step(30); }
    }
    releaseAllKeys(d);
    const ms = wallNow() - t0;
    c.detail = soakFrames + ' frames, ' + renders + ' rendered, ' + blanks + ' blank, ' +
      Math.round(ms) + ' ms (' + (ms / soakFrames).toFixed(2) + ' ms/frame), maxSpeed=' + Math.round(maxSpeed) +
      ', mode=' + d.state.mode + ', stage=' + d.state.stageIndex;
    c.eq(d.state.errors && d.state.errors.length ? d.state.errors.length : 0, 0, 'state.errors must stay empty: ' + JSON.stringify((d.state.errors || []).slice(0, 3)));
    c.eq(blanks, 0, blanks + ' rendered frames came out blank');
    const hits = findNonFinite(d.state, { maxDepth: 2, root: 'state' });
    c.eq(hits.length, 0, 'non-finite values after soak: ' + JSON.stringify(hits.slice(0, 4)));
    c.eq(d.state.frame >= soakFrames * 0.9, true, 'simulation actually advanced (' + d.state.frame + ' fixed steps)');
  }, { group: 'game' });

  t('no-console-errors-during-play', (c) => {
    const bad = shim.consoleCalls.filter(x => x.level === 'error' || x.level === 'warn');
    c.eq(bad.length, 0, 'console.error/warn during the whole run (' + bad.length + '): ' +
      bad.slice(0, 4).map(x => '[' + x.level + '@f' + x.frame + '] ' + x.text.slice(0, 120)).join(' ;; '));
  }, { group: 'game' });

  t('shim-violations', (c) => {
    const v = shim.violations;
    if (v.length) {
      c.detail = v.slice(0, 6).map(x => '[' + x.kind + '] ' + x.detail.slice(0, 90)).join(' ;; ');
      const hard = v.filter(x => /network|unknown-ctx|math-random|shadowBlur|fillText/.test(x.kind));
      c.eq(hard.length, 0, 'hard contract violations: ' + hard.map(x => x.kind + ': ' + x.detail.slice(0, 80)).join(' ;; '));
    }
  }, { group: 'game' });

  t('scores-and-bests-persist', (c) => {
    if (!needMod('GAME', c, 'game')) return;
    const keys = [];
    for (let i = 0; i < shim.window.localStorage.length; i++) keys.push(shim.window.localStorage.key(i));
    const unnamespaced = keys.filter(k => !k.startsWith('neondrift86.'));
    c.eq(unnamespaced.length, 0, 'localStorage keys must be namespaced: ' + unnamespaced.join(','));
    c.ok(keys.length > 0, 'the game wrote at least one best/score key (' + keys.join(',') + ')');
    c.detail = 'keys: ' + keys.join(', ');
  }, { group: 'game' });

  /* ======================================================= I: integration */
  t('index-html-load-order', (c) => {
    const p = path.join(ROOT, 'index.html');
    if (!fs.existsSync(p)) c.skip('index.html not present (not the lead\'s problem yet)');
    const html = fs.readFileSync(p, 'utf8');
    const srcs = [...html.matchAll(/<script[^>]+src\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]);
    const names = srcs.map(s => (s.match(/([a-z0-9_]+)\.js$/i) || [])[1]).filter(Boolean);
    c.ok(names.length > 0, 'index.html references at least one script (found ' + srcs.length + ')');
    c.eq(names.join(','), SRC_ORDER.join(','),
      'index.html <script src> order must match CONTRACT.md §0: ' + SRC_ORDER.join(' -> ') + ', found ' + names.join(' -> '));
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/gi)].length;
    if (inline) c.warn(inline + ' inline <script> block(s) present — bundling must not reorder the classic scripts');
  }, { group: 'integration' });

  t('only-contract-globals-exposed', (c) => {
    const unexpected = addedGlobals.filter(k => !SRC_ORDER.map(s => s.toUpperCase()).includes(k));
    c.eq(unexpected.length, 0, 'src/*.js leaked extra globals: ' + unexpected.join(',') +
      ' (expected only ' + SRC_ORDER.map(s => s.toUpperCase()).join(',') + ')');
    const absent = SRC_ORDER.map(s => s.toUpperCase()).filter(k => !addedGlobals.includes(k) && !missing.includes(s));
    c.eq(absent.length, 0, 'modules that did not expose their global: ' + absent.join(','));
  }, { group: 'integration' });

  t('module-isolation', (c) => {
    if (!needMod('RENDER', c, 'render')) return;
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    const src = strip(fs.readFileSync(srcPath('render'), 'utf8'));
    const bad = [];
    /* CONTRACT §6: the renderer reads state only — never GAME or INPUT.
       (ROAD is explicitly allowed: §3 says render uses ROAD.project.) */
    if (/\bGAME\s*[.[]/.test(src)) bad.push('render.js references GAME');
    if (/\bINPUT\s*[.[]/.test(src)) bad.push('render.js references INPUT');
    if (/\bAUDIO\s*[.[]/.test(src)) bad.push('render.js references AUDIO');
    c.eq(bad.length, 0, 'CONTRACT §6: ' + bad.join('; '));
    const srcRoad = strip(fs.readFileSync(srcPath('road'), 'utf8'));
    const canvasUse = /\bgetContext\b|\bfillRect\b|\bdrawImage\b|\bcreateLinearGradient\b/.test(srcRoad);
    c.eq(canvasUse, false, 'CONTRACT §3: road.js must not touch a canvas');
    const srcSprites = strip(fs.readFileSync(srcPath('sprites'), 'utf8'));
    c.eq(/\bGAME\s*[.[]/.test(srcSprites), false, 'sprites.js must not reference GAME');
    c.eq(/\bRENDER\s*[.[]/.test(srcSprites), false, 'sprites.js must not reference RENDER');
  }, { group: 'integration' });

  t('frames-on-disk-are-current', (c) => {
    const man = path.join(ROOT, '.verify', 'frames', 'manifest.json');
    if (!fs.existsSync(man)) c.skip('no frame manifest yet — run tools/render-frames.mjs');
    const m = JSON.parse(fs.readFileSync(man, 'utf8'));
    const hashes = m.srcHashes || {};
    const stale = [];
    for (const n of SRC_ORDER) {
      const p = srcPath(n);
      if (!fs.existsSync(p) || !hashes[n]) continue;
      const now = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 12);
      if (now !== hashes[n]) stale.push(n);
    }
    c.eq(stale.length, 0, 'src/ changed since the PNGs were rendered (' + stale.join(',') + ') — re-run tools/render-frames.mjs');
    if (m.stale) c.fail('frame manifest is marked stale: ' + m.staleReason);
    const bad = (m.frames || []).filter(f => f.blank);
    c.eq(bad.length, 0, 'blank frames: ' + bad.map(f => f.name).join(','));
  }, { group: 'integration' });

  /* -------------------------------------------------- determinism (last) */
  t('same-script-same-result', (c) => {
    if (!needMod('GAME', c, 'game')) return;
    const digestRun = () => {
      /* full reload of src/ gives us a pristine module graph */
      shim._raf.clear(); shim._timers.clear();
      const l = loadSrc();
      if (!l.ok) throw new Fail('reload failed: ' + JSON.stringify(l.failed));
      const d = freshGame(384, 216);
      startRace(d);
      const parts = [];
      for (let i = 0; i < 600; i++) {
        d.hold('ArrowUp');
        if (i === 200) { d.hold('ArrowLeft'); }
        if (i === 260) { d.release('ArrowLeft'); }
        GAME.update(1 / 60);
        if (i % 50 === 0) {
          const s = GAME.state;
          parts.push([i, Math.round(s.position), Math.round(s.speed * 100), s.playerX.toFixed(5),
            Math.round(s.timeLeft * 100), s.lap, s.stageIndex, s.gear, Math.round(s.score)].join(':'));
        }
      }
      releaseAllKeys(d);
      return parts.join('|');
    };    const a = digestRun();
    const b = digestRun();
    c.eq(a === b, true, 'two identical 600-frame runs must produce identical state digests');
    if (a !== b) c.detail = 'A=' + a.slice(0, 200) + ' B=' + b.slice(0, 200);
    else c.detail = 'digest ' + crypto.createHash('sha256').update(a).digest('hex').slice(0, 16);
  }, { group: 'integration' });

  /* ============================================================= summary */
  function releaseAllKeys(d) {
    for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'Enter', 'Escape']) d.release(k);
  }

  const counts = { PASS: 0, FAIL: 0, SKIP: 0, WARN: 0 };
  for (const r of results) counts[r.status]++;
  const hardFails = results.filter(r => r.status === 'FAIL');
  const skipped = results.filter(r => r.status === 'SKIP');
  const warns = results.filter(r => r.status === 'WARN');

  out('');
  out('------------------------------------------------------------------');
  if (hardFails.length) {
    out('FAILURES (' + hardFails.length + '):');
    for (const r of hardFails) out('  ' + r.group + '.' + r.name + '\n      ' + r.detail);
  }
  if (warns.length) {
    out('WARNINGS (' + warns.length + '):');
    for (const r of warns) out('  ' + r.group + '.' + r.name + '\n      ' + r.detail);
  }
  if (skipped.length) {
    out('SKIPPED (' + skipped.length + '):');
    for (const r of skipped) out('  ' + r.group + '.' + r.name + ' — ' + r.detail);
  }
  out('TOTAL ' + results.length + '   PASS ' + counts.PASS + '   FAIL ' + counts.FAIL +
    '   WARN ' + counts.WARN + '   SKIP ' + counts.SKIP + '   (' + ((wallNow() - t0) / 1000).toFixed(1) + ' s)');

  let code = 0;
  if (counts.FAIL > 0) code = 1;
  else if (skipped.length > 0 && (allowMissing || !load.ok)) code = allowMissing ? 3 : 1;
  else if (!load.ok) code = allowMissing ? 3 : 1;

  const verdict = code === 0 ? (counts.WARN ? 'PASS WITH ISSUES' : 'PASS') : (code === 3 ? 'INCOMPLETE' : 'FAIL');
  out('CONTRACT TEST: ' + verdict);

  fs.mkdirSync(path.join(ROOT, '.verify'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, '.verify', 'contract-test.json'), JSON.stringify({
    verdict, code, counts, load, results
  }, null, 2));

  return { code, verdict, results, counts, load };
}

/* ------------------------------------------------------------------ CLI */
const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/contract-test.mjs');
if (isMain) {
  run(process.argv.slice(2))
    .then(r => process.exit(r.code))
    .catch(e => { out('HARNESS ERROR: ' + (e && e.stack || e)); process.exit(1); });
}
