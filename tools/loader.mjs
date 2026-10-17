/* ==========================================================================
 * NEON DRIFT '86 — tools/loader.mjs
 * Loads the real `src/*.js` the way index.html does: classic scripts, fixed
 * order, one global each, evaluated with vm.runInThisContext so `var NAME`
 * lands on globalThis exactly like a <script> tag would.
 *
 * Tolerates files that do not exist yet or that are half-written: every module
 * is loaded independently and its failure is reported instead of aborting the
 * whole harness, so this can be re-run continuously while the team works.
 *
 * Owner: verifier.
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** index.html load order, frozen by CONTRACT.md §0. */
export const SRC_ORDER = ['core', 'road', 'sprites', 'audio', 'render', 'input', 'game'];

/** The only globals src/*.js is allowed to create. */
export const EXPECTED_GLOBALS = ['CORE', 'ROAD', 'SPRITES', 'AUDIO', 'RENDER', 'INPUT', 'GAME'];

export function srcPath(name) { return path.join(ROOT, 'src', name + '.js'); }

export function srcExists(name) { return fs.existsSync(srcPath(name)); }

/**
 * Evaluate every module that exists, in order.
 * @returns {{loaded:string[], missing:string[], failed:Array<{name:string,error:string,line:string}>, ok:boolean}}
 */
export function loadSrc(opts) {
  opts = opts || {};
  const order = opts.order || SRC_ORDER;
  const loaded = [], missing = [], failed = [];
  for (const name of order) {
    const file = srcPath(name);
    if (!fs.existsSync(file)) { missing.push(name); continue; }
    let code;
    try {
      code = fs.readFileSync(file, 'utf8');
    } catch (e) {
      failed.push({ name, error: 'read failed: ' + e.message, line: '' });
      continue;
    }
    try {
      vm.runInThisContext(code, { filename: file, displayErrors: true });
      loaded.push(name);
    } catch (e) {
      const line = firstSrcLine(e, file);
      failed.push({ name, error: String((e && e.message) || e), line, stack: String(e && e.stack || '').split('\n').slice(0, 6).join('\n') });
    }
  }
  return {
    loaded, missing, failed,
    ok: missing.length === 0 && failed.length === 0
  };
}

function firstSrcLine(err, file) {
  const stack = String((err && err.stack) || '');
  const norm = file.replace(/\\/g, '\\\\');
  const re = new RegExp(norm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':(\\d+):(\\d+)');
  const m = stack.match(re);
  return m ? m[1] + ':' + m[2] : '';
}

/**
 * Snapshot of own global keys, used to prove modules do not leak extras.
 */
export function globalKeys() {
  return new Set(Object.getOwnPropertyNames(globalThis));
}

export function diffGlobals(before, after) {
  const added = [];
  for (const k of after) if (!before.has(k)) added.push(k);
  return added.sort();
}

/**
 * Boot the game the way index.html would: create the visible canvas, run the
 * asset init hooks, then GAME.boot(canvas).
 *
 * Returns a Driver that advances frames deterministically.  If GAME never
 * schedules an animation frame we fall back to calling GAME.update/GAME.render
 * ourselves, so the harness works no matter how the loop is wired.
 */
export function bootGame(shim, opts) {
  opts = opts || {};
  const notes = [];
  const canvas = opts.canvas || shim.makeGameCanvas(opts.cssW || 1152, opts.cssH || 648);
  shim.gameCanvas = canvas;

  if (typeof SPRITES !== 'undefined' && SPRITES && typeof SPRITES.init === 'function') {
    try { SPRITES.init(); } catch (e) { notes.push('SPRITES.init threw: ' + e.message); }
  } else notes.push('SPRITES.init unavailable');

  if (typeof AUDIO !== 'undefined' && AUDIO && typeof AUDIO.init === 'function') {
    try { AUDIO.init(); } catch (e) { notes.push('AUDIO.init threw: ' + e.message); }
  } else notes.push('AUDIO.init unavailable');

  let ok = false, error = null;
  if (typeof GAME !== 'undefined' && GAME && typeof GAME.boot === 'function') {
    try { GAME.boot(canvas); ok = true; } catch (e) { error = e; }
  } else error = new Error('GAME.boot unavailable');

  return { canvas, ok, error, notes, manual: false };
}

export class Driver {
  /**
   * @param {object} shim from createShim()
   * @param {{canvas:object, ok:boolean}} game from bootGame()
   * @param {{dtMs?:number, echo?:Function}} [opts]
   */
  constructor(shim, game, opts) {
    opts = opts || {};
    this.shim = shim;
    this.game = game;
    this.dtMs = opts.dtMs === undefined ? 1000 / 60 : opts.dtMs;
    this.manual = !!opts.skipRender;
    this.skipRender = !!opts.skipRender;
    this.frames = 0;
    this.log = opts.echo || (() => { });
    this.errors = [];
  }

  get state() {
    return (typeof GAME !== 'undefined' && GAME && GAME.state) ? GAME.state : null;
  }

  /** Decide once whether GAME drives itself through rAF or needs manual calls. */
  detect() {
    const st = this.state;
    if (!st) { this.shim.tick(this.dtMs); this.frames++; return; }
    const before = { frame: st.frame, now: st.now, mode: st.mode };
    for (let i = 0; i < 5; i++) {
      this.shim.tick(this.dtMs);
      this.frames++;
      if (st.frame !== before.frame || st.now !== before.now || st.mode !== before.mode) return;
    }
    this.manual = true;
    this.log('driver: GAME does not own a rAF loop (5 ticks moved nothing) -> manual update/render');
  }

  stepOne() {
    if (!this.manual) { this.shim.tick(this.dtMs); this.frames++; return; }
    this.shim.clock.t += this.dtMs;
    this.shim.frame++;
    this.shim._runTimers();
    try { GAME.update(this.dtMs / 1000); } catch (e) { this.errors.push('update: ' + e.message); }
    if (!this.skipRender) {
      try { GAME.render(); } catch (e) { this.errors.push('render: ' + e.message); }
    }
  }

  step(n) { for (let i = 0; i < (n || 1); i++) this.stepOne(); return this; }

  /** Step until pred() is true or the frame budget runs out. */
  until(pred, budget, onTick) {
    const max = budget === undefined ? 600 : budget;
    for (let i = 0; i < max; i++) {
      if (pred(this.state, this)) return true;
      if (onTick) onTick(i, this.state, this);
      this.stepOne();
    }
    return pred(this.state, this);
  }

  key(k) { this.shim.tap(k); }
  hold(k) { this.shim.keyDown(k); }
  release(k) { this.shim.keyUp(k); }
}
export function findNonFinite(root, opts) {
  opts = opts || {};
  const maxDepth = opts.maxDepth === undefined ? 4 : opts.maxDepth;
  const maxNodes = opts.maxNodes === undefined ? 20000 : opts.maxNodes;
  const hits = [];
  const seen = new Set();
  let visited = 0;
  const skip = new Set(opts.skip || ['track', 'segments', 'cars']);
  (function walk(v, pathStr, depth) {
    if (visited > maxNodes) return;
    if (depth > maxDepth) return;
    if (v === null || v === undefined) return;
    const t = typeof v;
    if (t === 'number') {
      visited++;
      if (!isFinite(v)) hits.push({ path: pathStr, value: String(v) });
      return;
    }
    if (t !== 'object') return;
    if (seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length && i < 64; i++) walk(v[i], pathStr + '[' + i + ']', depth + 1);
      return;
    }
    for (const k of Object.keys(v)) {
      if (depth === 0 && skip.has(k)) continue;
      walk(v[k], pathStr ? pathStr + '.' + k : k, depth + 1);
    }
  })(root, opts.root || 'state', 0);
  return hits;
}
