/* ==========================================================================
 * NEON DRIFT '86 — tools/canvas-shim.mjs
 *
 * A deliberately strict, deterministic Canvas2D + minimal DOM implementation
 * for Node.  It exists because this session's sandbox blocks Chromium's named
 * pipes, so headless-browser screenshots are impossible: instead of faking the
 * game, we give the real `src/*.js` a canvas they can genuinely draw into and
 * export the result as a PNG.
 *
 * Design rules (these are the point of the file):
 *   1. UNKNOWN API NEVER FAILS SILENTLY.  Reading a property/method on a
 *      context that is not part of the Canvas2D surface throws a
 *      CanvasShimError carrying the call site.  Real-but-unimplemented
 *      members record a violation and degrade predictably.
 *   2. DETERMINISM.  performance.now / Date.now / rAF / setTimeout /
 *      Math.random are all driven by one virtual clock, so two runs of the
 *      harness produce byte-identical frames.
 *   3. TRIPWIRES for the contract's hard rules: network image loads, fetch(),
 *      Math.random(), ctx.fillText(), shadowBlur are recorded as violations
 *      instead of being silently accepted.
 *
 * Owner: verifier.  Nobody else edits this file.
 * ========================================================================== */
import { encodePNG } from './png.mjs';

const REAL_PERF = globalThis.performance;
const REAL_CONSOLE = globalThis.console;
const HAS = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** Real stdout, immune to the console proxy the shim installs. */
export function out(...args) { REAL_CONSOLE.log(...args); }
export function outRaw(text) { process.stdout.write(text); }

/** Wall-clock ms, immune to both the shim's virtual clock and its console. */
export function wallNow() { return Number(process.hrtime.bigint() / 1000n) / 1000; }

/* ========================================================== colour parsing */
const NAMED = {
  transparent: [0, 0, 0, 0], black: [0, 0, 0, 1], white: [255, 255, 255, 1],
  red: [255, 0, 0, 1], green: [0, 128, 0, 1], lime: [0, 255, 0, 1], blue: [0, 0, 255, 1],
  yellow: [255, 255, 0, 1], cyan: [0, 255, 255, 1], aqua: [0, 255, 255, 1],
  magenta: [255, 0, 255, 1], fuchsia: [255, 0, 255, 1], gray: [128, 128, 128, 1],
  grey: [128, 128, 128, 1], silver: [192, 192, 192, 1], maroon: [128, 0, 0, 1],
  olive: [128, 128, 0, 1], teal: [0, 128, 128, 1], navy: [0, 0, 128, 1],
  purple: [128, 0, 128, 1], orange: [255, 165, 0, 1], pink: [255, 192, 203, 1],
  brown: [165, 42, 42, 1], gold: [255, 215, 0, 1], indigo: [75, 0, 130, 1],
  violet: [238, 130, 238, 1], salmon: [250, 128, 114, 1], tan: [210, 180, 140, 1],
  beige: [245, 245, 220, 1], ivory: [255, 255, 240, 1], khaki: [240, 230, 140, 1],
  coral: [255, 127, 80, 1], crimson: [220, 20, 60, 1], turquoise: [64, 224, 208, 1],
  plum: [221, 160, 221, 1], orchid: [218, 112, 214, 1], skyblue: [135, 206, 235, 1],
  steelblue: [70, 130, 180, 1], midnightblue: [25, 25, 112, 1], darkblue: [0, 0, 139, 1],
  darkred: [139, 0, 0, 1], darkgreen: [0, 100, 0, 1], darkgray: [169, 169, 169, 1],
  darkgrey: [169, 169, 169, 1], lightgray: [211, 211, 211, 1], lightgrey: [211, 211, 211, 1],
  lightblue: [173, 216, 230, 1], lightgreen: [144, 238, 144, 1], lightyellow: [255, 255, 224, 1],
  lightpink: [255, 182, 193, 1], whitesmoke: [245, 245, 245, 1], snow: [255, 250, 250, 1]
};

const colorCache = new Map();

function hue2rgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function num(tok, scale) {
  tok = String(tok).trim();
  if (tok.endsWith('%')) return parseFloat(tok) / 100 * scale;
  return parseFloat(tok);
}

function clamp255(v) { return v < 0 ? 0 : (v > 255 ? 255 : Math.round(v)); }

/**
 * Parse a CSS colour subset. Returns {r,g,b,a} with a in 0..1, or null.
 */
export function parseColor(input) {
  if (input === null || input === undefined) return null;
  const str = String(input).trim();
  if (str === '') return null;
  if (colorCache.has(str)) return colorCache.get(str);
  let out = null;
  const low = str.toLowerCase();

  if (str[0] === '#') {
    const hex = str.slice(1);
    if (/^[0-9a-fA-F]{3}$/.test(hex)) {
      out = { r: parseInt(hex[0] + hex[0], 16), g: parseInt(hex[1] + hex[1], 16), b: parseInt(hex[2] + hex[2], 16), a: 1 };
    } else if (/^[0-9a-fA-F]{4}$/.test(hex)) {
      out = {
        r: parseInt(hex[0] + hex[0], 16), g: parseInt(hex[1] + hex[1], 16),
        b: parseInt(hex[2] + hex[2], 16), a: parseInt(hex[3] + hex[3], 16) / 255
      };
    } else if (/^[0-9a-fA-F]{6}$/.test(hex)) {
      out = { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: 1 };
    } else if (/^[0-9a-fA-F]{8}$/.test(hex)) {
      out = {
        r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16), a: parseInt(hex.slice(6, 8), 16) / 255
      };
    }
  } else if (/^rgba?\(/.test(low)) {
    const inner = str.slice(str.indexOf('(') + 1, str.lastIndexOf(')'));
    const parts = inner.split(/[,\/\s]+/).filter(s => s.length);
    if (parts.length >= 3) {
      out = {
        r: clamp255(num(parts[0], 255)), g: clamp255(num(parts[1], 255)), b: clamp255(num(parts[2], 255)),
        a: parts.length > 3 ? Math.max(0, Math.min(1, num(parts[3], 1))) : 1
      };
    }
  } else if (/^hsla?\(/.test(low)) {
    const inner = str.slice(str.indexOf('(') + 1, str.lastIndexOf(')'));
    const parts = inner.split(/[,\/\s]+/).filter(s => s.length);
    if (parts.length >= 3) {
      const h = ((parseFloat(parts[0]) % 360) + 360) % 360 / 360;
      const s = num(parts[1], 1), l = num(parts[2], 1);
      let r, g, b;
      if (s === 0) { r = g = b = l; } else {
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        r = hue2rgb(p, q, h + 1 / 3); g = hue2rgb(p, q, h); b = hue2rgb(p, q, h - 1 / 3);
      }
      out = { r: clamp255(r * 255), g: clamp255(g * 255), b: clamp255(b * 255), a: parts.length > 3 ? num(parts[3], 1) : 1 };
    }
  } else if (HAS(NAMED, low)) {
    const n = NAMED[low];
    out = { r: n[0], g: n[1], b: n[2], a: n[3] };
  }

  colorCache.set(str, out);
  return out;
}

/* ============================================================== ImageData */
class ShimImageData {
  constructor(a, b, c) {
    if (a instanceof Uint8ClampedArray || a instanceof Uint8Array) {
      this.width = b | 0; this.height = c | 0;
      const need = this.width * this.height * 4;
      this.data = a instanceof Uint8ClampedArray ? a : new Uint8ClampedArray(a.buffer, a.byteOffset, a.length);
      if (this.data.length !== need) throw new Error('ImageData: bad data length');
    } else {
      this.width = a | 0; this.height = b | 0;
      this.data = new Uint8ClampedArray(this.width * this.height * 4);
    }
    this.colorSpace = 'srgb';
  }
}

/* ============================================================== gradients */
class ShimGradient {
  constructor(kind) { this.kind = kind; this.stops = []; }
  addColorStop(t, color) {
    const c = parseColor(color);
    if (!c) throw new Error('addColorStop: bad colour ' + JSON.stringify(color));
    this.stops.push({ t: Math.max(0, Math.min(1, +t || 0)), c });
    this.stops.sort((a, b) => a.t - b.t);
  }
  _stopsOrThrow(ctx) {
    if (this.stops.length === 0) {
      ctx._violate('gradient-no-stops', 'gradient used with zero colour stops -> transparent black');
      return [{ t: 0, c: { r: 0, g: 0, b: 0, a: 0 } }];
    }
    return this.stops;
  }
}

class LinearGradient extends ShimGradient {
  constructor(x0, y0, x1, y1) { super('linear'); this.x0 = x0; this.y0 = y0; this.x1 = x1; this.y1 = y1; }
  /** @returns {[number,number,number,number]} */
  sample(x, y, ctx) {
    const stops = this._stopsOrThrow(ctx);
    const dx = this.x1 - this.x0, dy = this.y1 - this.y0;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((x - this.x0) * dx + (y - this.y0) * dy) / len2;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    return sampleStops(stops, t);
  }
}

class RadialGradient extends ShimGradient {
  constructor(x0, y0, r0, x1, y1, r1) {
    super('radial');
    this.x0 = x0; this.y0 = y0; this.r0 = r0; this.x1 = x1; this.y1 = y1; this.r1 = r1;
  }
  sample(x, y, ctx) {
    const stops = this._stopsOrThrow(ctx);
    const d = Math.hypot(x - this.x1, y - this.y1);
    const span = this.r1 - this.r0;
    let t = span === 0 ? (d <= this.r1 ? 1 : 0) : (d - this.r0) / span;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    return sampleStops(stops, t);
  }
}

function sampleStops(stops, t) {
  if (t <= stops[0].t) { const c = stops[0].c; return [c.r, c.g, c.b, c.a]; }
  const last = stops[stops.length - 1];
  if (t >= last.t) return [last.c.r, last.c.g, last.c.b, last.c.a];
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i], b = stops[i + 1];
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t;
      const u = span === 0 ? 0 : (t - a.t) / span;
      return [
        a.c.r + (b.c.r - a.c.r) * u,
        a.c.g + (b.c.g - a.c.g) * u,
        a.c.b + (b.c.b - a.c.b) * u,
        a.c.a + (b.c.a - a.c.a) * u
      ];
    }
  }
  return [last.c.r, last.c.g, last.c.b, last.c.a];
}

class ShimPattern {
  constructor(image, repetition) { this.image = image; this.repetition = repetition || 'repeat'; }
  sample(x, y) {
    const w = this.image.width | 0, h = this.image.height | 0;
    if (!w || !h) return [0, 0, 0, 0];
    let sx = Math.floor(x) % w; if (sx < 0) sx += w;
    let sy = Math.floor(y) % h; if (sy < 0) sy += h;
    const d = this.image.data, o = (sy * w + sx) * 4;
    return [d[o], d[o + 1], d[o + 2], d[o + 3] / 255];
  }
}

/* ============================================================ shim errors */
export class CanvasShimError extends Error {
  constructor(message, where) {
    super(message);
    this.name = 'CanvasShimError';
    this.where = where || 'unknown';
  }
}

const COMPOSITE = {
  'source-over': 0, 'source-in': 1, 'source-out': 2, 'source-atop': 3,
  'destination-over': 4, 'destination-in': 5, 'destination-out': 6, 'destination-atop': 7,
  lighter: 8, copy: 9, xor: 10, multiply: 11, screen: 12, overlay: 13,
  'darken': 14, 'lighten': 15, 'color-dodge': 16, 'color-burn': 17,
  'hard-light': 18, 'soft-light': 19, 'difference': 20, 'exclusion': 21
};

/* Members that exist on a real CanvasRenderingContext2D but that this shim
   does not need to emulate faithfully.  They are recorded as violations. */
const KNOWN_BUT_UNSUPPORTED = new Set([
  'fillText', 'strokeText', 'drawFocusIfNeeded', 'scrollPathIntoView',
  'createConicGradient', 'getLineDash', 'setLineDash', 'isContextLost',
  'getContextAttributes', 'reset', 'roundRect', 'filter', 'letterSpacing',
  'fontKerning', 'fontStretch', 'fontVariantCaps', 'textRendering',
  'wordSpacing', 'direction', 'textAlign', 'textBaseline', 'font'
]);

/* ============================================================ the context */
class Context2D {
  constructor(canvas, shim) {
    this.canvas = canvas;
    this._shim = shim;
    this._matrix = [1, 0, 0, 1, 0, 0];      /* a b c d e f */
    this._stack = [];
    this._clip = null;                       /* {x0,y0,x1,y1} device space  */
    this._lineDash = [];
    this._path = newPath();

    this._fillStyle = { r: 255, g: 255, b: 255, a: 1 };
    this._strokeStyle = { r: 0, g: 0, b: 0, a: 1 };
    this._fillPaint = null;                  /* gradient / pattern or null  */
    this._strokePaint = null;
    this.lineWidth = 1;
    this.lineCap = 'butt';
    this.lineJoin = 'miter';
    this.miterLimit = 10;
    this.globalAlpha = 1;
    this.globalCompositeOperation = 'source-over';
    this._op = 0;
    this.imageSmoothingEnabled = true;
    this.imageSmoothingQuality = 'low';
    this.shadowBlur = 0;
    this.shadowColor = 'rgba(0,0,0,0)';
    this.shadowOffsetX = 0;
    this.shadowOffsetY = 0;
    this.filter = 'none';
    this.font = '10px sans-serif';
    this.textAlign = 'start';
    this.textBaseline = 'alphabetic';
    this.direction = 'inherit';
    this.lineDashOffset = 0;
    this.miterLimit = 10;
  }

  /* --------------------------------------------------------- violations */
  _violate(kind, detail) { this._shim._violate(kind, detail, 4); }

  /* --------------------------------------------------------- properties */
  get fillStyle() { return this._fillStyleRaw === undefined ? '#ffffff' : this._fillStyleRaw; }
  set fillStyle(v) {
    if (v === null || v === undefined || v === '') return;      /* canvas ignores */
    if (v instanceof ShimGradient || v instanceof ShimPattern) {
      this._fillPaint = v; this._fillStyleRaw = v; return;
    }
    const c = parseColor(v);
    if (!c) {
      this._violate('bad-color', 'fillStyle = ' + JSON.stringify(String(v)) + ' is not a colour this shim understands');
      this._fillStyle = { r: 255, g: 0, b: 255, a: 1 };          /* loud magenta */
      this._fillStyleRaw = String(v);
      this._fillPaint = null;
      return;
    }
    this._fillStyle = c; this._fillPaint = null; this._fillStyleRaw = String(v);
  }
  get strokeStyle() { return this._strokeStyleRaw === undefined ? '#000000' : this._strokeStyleRaw; }
  set strokeStyle(v) {
    if (v === null || v === undefined || v === '') return;
    if (v instanceof ShimGradient || v instanceof ShimPattern) {
      this._strokePaint = v; this._strokeStyleRaw = v; return;
    }
    const c = parseColor(v);
    if (!c) {
      this._violate('bad-color', 'strokeStyle = ' + JSON.stringify(String(v)) + ' is not a colour this shim understands');
      this._strokeStyle = { r: 255, g: 0, b: 255, a: 1 };
      this._strokeStyleRaw = String(v);
      this._strokePaint = null;
      return;
    }
    this._strokeStyle = c; this._strokePaint = null; this._strokeStyleRaw = String(v);
  }
  set globalAlpha(v) {
    const n = +v;
    if (!isFinite(n)) { this._violate('bad-alpha', 'globalAlpha = ' + v); return; }
    this._globalAlpha = n < 0 ? 0 : (n > 1 ? 1 : n);
  }
  get globalAlpha() { return this._globalAlpha === undefined ? 1 : this._globalAlpha; }
  set globalCompositeOperation(v) {
    const s = String(v);
    if (HAS(COMPOSITE, s)) { this._op = COMPOSITE[s]; this._gco = s; }
    else {
      this._violate('bad-composite', 'globalCompositeOperation = ' + JSON.stringify(s) + ' unsupported -> source-over');
      this._op = 0; this._gco = 'source-over';
    }
  }
  get globalCompositeOperation() { return this._gco || 'source-over'; }
  set imageSmoothingEnabled(v) { this._ise = !!v; }
  get imageSmoothingEnabled() { return this._ise === undefined ? true : this._ise; }
  set shadowBlur(v) {
    const n = +v;
    if (n > 0) this._violate('shadowBlur', 'shadowBlur = ' + n + ' — the contract requires hard-edged pixels (effect ignored)');
    this._shadowBlur = n;
  }
  get shadowBlur() { return this._shadowBlur || 0; }
  set filter(v) {
    if (v && v !== 'none') this._violate('filter', 'ctx.filter = ' + JSON.stringify(String(v)) + ' (effect ignored)');
    this._filter = v;
  }
  get filter() { return this._filter === undefined ? 'none' : this._filter; }
  set font(v) { this._font = v; }
  get font() { return this._font === undefined ? '10px sans-serif' : this._font; }

  /* ------------------------------------------------------------ matrix */
  save() {
    this._stack.push({
      m: this._matrix.slice(), clip: this._clip, fill: this._fillStyle, stroke: this._strokeStyle,
      fillPaint: this._fillPaint, strokePaint: this._strokePaint, op: this._op, gco: this._gco,
      alpha: this.globalAlpha, lw: this.lineWidth, lc: this.lineCap, lj: this.lineJoin,
      ise: this.imageSmoothingEnabled, sb: this.shadowBlur, sc: this.shadowColor,
      sox: this.shadowOffsetX, soy: this.shadowOffsetY, dash: this._lineDash.slice(),
      font: this.font, tA: this.textAlign, tB: this.textBaseline, fil: this.filter,
      fillRaw: this._fillStyleRaw, strokeRaw: this._strokeStyleRaw
    });
    return this;
  }
  restore() {
    const s = this._stack.pop();
    if (!s) { this._violate('restore-underflow', 'restore() with an empty state stack'); return this; }
    this._matrix = s.m; this._clip = s.clip; this._fillStyle = s.fill; this._strokeStyle = s.stroke;
    this._fillPaint = s.fillPaint; this._strokePaint = s.strokePaint;
    this._op = s.op; this._gco = s.gco; this._globalAlpha = s.alpha; this._lineWidth = s.lw;
    this._lineCap = s.lc; this._lineJoin = s.lj; this._ise = s.ise; this._shadowBlur = s.sb;
    this._shadowColor = s.sc; this._shadowOffsetX = s.sox; this._shadowOffsetY = s.soy;
    this._lineDash = s.dash; this._font = s.font; this._textAlign = s.tA; this._textBaseline = s.tB;
    this._filter = s.fil; this._fillStyleRaw = s.fillRaw; this._strokeStyleRaw = s.strokeRaw;
    return this;
  }
  translate(x, y) {
    const m = this._matrix;
    m[4] += m[0] * x + m[2] * y;
    m[5] += m[1] * x + m[3] * y;
    return this;
  }
  scale(x, y) { const m = this._matrix; m[0] *= x; m[1] *= x; m[2] *= y; m[3] *= y; return this; }
  rotate(a) {
    const m = this._matrix, c = Math.cos(a), s = Math.sin(a);
    const a0 = m[0], b0 = m[1], c0 = m[2], d0 = m[3];
    m[0] = a0 * c + c0 * s; m[1] = b0 * c + d0 * s;
    m[2] = a0 * -s + c0 * c; m[3] = b0 * -s + d0 * c;
    return this;
  }
  transform(a, b, c, d, e, f) {
    const m = this._matrix;
    const a0 = m[0], b0 = m[1], c0 = m[2], d0 = m[3], e0 = m[4], f0 = m[5];
    m[0] = a0 * a + c0 * b; m[1] = b0 * a + d0 * b;
    m[2] = a0 * c + c0 * d; m[3] = b0 * c + d0 * d;
    m[4] = a0 * e + c0 * f + e0; m[5] = b0 * e + d0 * f + f0;
    return this;
  }
  setTransform(a, b, c, d, e, f) {
    if (typeof a === 'object' && a !== null) {
      const m = a; this._matrix = [m.a, m.b, m.c, m.d, m.e, m.f];
    } else {
      this._matrix = [a, b, c, d, e, f];
    }
    return this;
  }
  resetTransform() { this._matrix = [1, 0, 0, 1, 0, 0]; return this; }
  getTransform() {
    const m = this._matrix;
    return {
      a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5],
      is2D: true, isIdentity: m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0,
      inverse() { const o = invert(m); return { a: o[0], b: o[1], c: o[2], d: o[3], e: o[4], f: o[5] }; },
      multiply() { return this; }
    };
  }
  _apply(x, y) {
    const m = this._matrix;
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  }

  /* -------------------------------------------------------------- path */
  beginPath() { this._path = newPath(); return this; }
  moveTo(x, y) { pathMoveTo(this._path, x, y); return this; }
  lineTo(x, y) { pathLineTo(this._path, x, y); return this; }
  closePath() { pathClose(this._path); return this; }
  rect(x, y, w, h) { pathRect(this._path, x, y, w, h); return this; }
  roundRect(x, y, w, h, r) {
    this._violate('roundRect', 'roundRect() is approximated with square corners');
    pathRect(this._path, x, y, w, h); return this;
  }
  quadraticCurveTo(cx, cy, x, y) { pathQuad(this._path, cx, cy, x, y); return this; }
  bezierCurveTo(c1x, c1y, c2x, c2y, x, y) { pathCubic(this._path, c1x, c1y, c2x, c2y, x, y); return this; }
  arcTo(x1, y1, x2, y2) { pathLineTo(this._path, x1, y1); pathLineTo(this._path, x2, y2); return this; }
  arc(cx, cy, r, a0, a1, ccw) { pathArc(this._path, cx, cy, r, a0, a1, ccw); return this; }
  ellipse(cx, cy, rx, ry, rot, a0, a1, ccw) { pathEllipse(this._path, cx, cy, rx, ry, rot, a0, a1, ccw); return this; }

  fill(ruleOrPath) {
    const path = (ruleOrPath && ruleOrPath._path) ? ruleOrPath._path : this._path;
    this._fillPath(path);
    return this;
  }
  stroke(pathArg) {
    const path = (pathArg && pathArg._path) ? pathArg._path : this._path;
    this._strokePath(path);
    return this;
  }
  clip(ruleOrPath) {
    const path = (ruleOrPath && ruleOrPath._path) ? ruleOrPath._path : this._path;
    const b = pathBounds(path);
    if (!b) { this._violate('empty-clip', 'clip() with an empty path clips everything away'); this._clip = { x0: 1, y0: 1, x1: 0, y1: 0 }; return this; }
    const pts = [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]].map(p => this._apply(p[0], p[1]));
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    let rect = {
      x0: Math.min(...xs), y0: Math.min(...ys),
      x1: Math.max(...xs), y1: Math.max(...ys)
    };
    /* exact for a single axis-aligned subpath; bbox otherwise (documented) */
    if (!isAxisAligned(this._matrix) || path.subs.length > 1 || !pathLooksRectangular(path)) {
      this._violate('clip-approx', 'clip() with a non-rectangular path is approximated by its bounding box');
    }
    this._clip = intersectClip(this._clip, rect, this.canvas);
    return this;
  }
  isPointInPath(x, y) {
    if (typeof x === 'object' && x !== null) { y = arguments[2]; x = arguments[1]; }
    const p = this._apply(x, y);
    return pointInPath(this._path, p[0], p[1]);
  }
  isPointInStroke(x, y) { return this.isPointInPath(x, y); }

  /* --------------------------------------------------------- rectangles */
  fillRect(x, y, w, h) {
    const r = this._rectDevice(x, y, w, h);
    if (!r) return this;
    this._paintRect(r, this._fillStyle, this._fillPaint);
    return this;
  }
  clearRect(x, y, w, h) {
    const r = this._rectDevice(x, y, w, h);
    if (!r) return this;
    this._forEachPixel(r, (buf, o) => { buf[o] = 0; buf[o + 1] = 0; buf[o + 2] = 0; buf[o + 3] = 0; });
    return this;
  }
  strokeRect(x, y, w, h) {
    const t = Math.max(1, this.lineWidth);
    this.fillRect(x - t / 2, y - t / 2, w + t, t);
    this.fillRect(x - t / 2, y + h - t / 2, w + t, t);
    this.fillRect(x - t / 2, y + t / 2, t, h - t);
    this.fillRect(x + w - t / 2, y + t / 2, t, h - t);
    return this;
  }

  /* ------------------------------------------------------------ drawing */
  drawImage(img) {
    const src = imageSource(img);
    if (!src) {
      this._violate('drawImage-bad-source', 'drawImage() called with ' + describe(img));
      return this;
    }
    let sx = 0, sy = 0, sw = src.width, sh = src.height, dx, dy, dw, dh;
    if (arguments.length <= 3) { dx = arguments[1]; dy = arguments[2]; dw = sw; dh = sh; }
    else if (arguments.length <= 5) { dx = arguments[1]; dy = arguments[2]; dw = arguments[3]; dh = arguments[4]; }
    else {
      sx = arguments[1]; sy = arguments[2]; sw = arguments[3]; sh = arguments[4];
      dx = arguments[5]; dy = arguments[6]; dw = arguments[7]; dh = arguments[8];
    }
    if (!(dw > 0) || !(dh > 0)) return this;              /* canvas: no-op, not an error */
    if (!(sw > 0) || !(sh > 0)) { this._violate('drawImage-empty-src', 'drawImage() with a zero-size source rect'); return this; }
    this._blit(src, sx, sy, sw, sh, dx, dy, dw, dh);
    return this;
  }

  /* --------------------------------------------------------- image data */
  createImageData(a, b) {
    if (a instanceof ShimImageData) return new ShimImageData(a.width, a.height);
    return new ShimImageData(a | 0, b | 0);
  }
  getImageData(x, y, w, h) {
    const cw = this.canvas._w, ch = this.canvas._h;
    const out = new ShimImageData(w | 0, h | 0);
    const d = out.data, buf = this.canvas._buf;
    for (let j = 0; j < out.height; j++) {
      const sy = (y | 0) + j;
      if (sy < 0 || sy >= ch) continue;
      for (let i = 0; i < out.width; i++) {
        const sx = (x | 0) + i;
        if (sx < 0 || sx >= cw) continue;
        const so = (sy * cw + sx) * 4, o = (j * out.width + i) * 4;
        d[o] = buf[so]; d[o + 1] = buf[so + 1]; d[o + 2] = buf[so + 2]; d[o + 3] = buf[so + 3];
      }
    }
    return out;
  }
  putImageData(img, dx, dy, dirtyX, dirtyY, dirtyW, dirtyH) {
    if (!img || !img.data) { this._violate('putImageData-bad', 'putImageData() without ImageData'); return this; }
    const cw = this.canvas._w, ch = this.canvas._h, buf = this.canvas._buf;
    let x0 = 0, y0 = 0, w = img.width, h = img.height;
    if (dirtyX !== undefined) { x0 = dirtyX | 0; y0 = dirtyY | 0; w = dirtyW | 0; h = dirtyH | 0; }
    for (let j = 0; j < h; j++) {
      const ty = (dy | 0) + y0 + j;
      if (ty < 0 || ty >= ch) continue;
      for (let i = 0; i < w; i++) {
        const tx = (dx | 0) + x0 + i;
        if (tx < 0 || tx >= cw) continue;
        const so = ((y0 + j) * img.width + (x0 + i)) * 4, o = (ty * cw + tx) * 4;
        buf[o] = img.data[so]; buf[o + 1] = img.data[so + 1];
        buf[o + 2] = img.data[so + 2]; buf[o + 3] = img.data[so + 3];
      }
    }
    return this;
  }

  /* ------------------------------------------------------------ factories */
  createLinearGradient(x0, y0, x1, y1) { return new LinearGradient(x0, y0, x1, y1); }
  createRadialGradient(x0, y0, r0, x1, y1, r1) { return new RadialGradient(x0, y0, r0, x1, y1, r1); }
  createConicGradient(a0, x, y) {
    this._violate('conic-gradient', 'createConicGradient() unsupported -> flat sweep replaced by a radial ramp');
    return new RadialGradient(x, y, 0, x, y, 200);
  }
  createPattern(image, repetition) {
    const src = imageSource(image);
    if (!src) { this._violate('pattern-bad-source', 'createPattern() with ' + describe(image)); return null; }
    return new ShimPattern({ width: src.width, height: src.height, data: src.data }, repetition);
  }

  /* --------------------------------------------------------------- text */
  measureText(text) {
    this._violate('measureText', 'measureText() used — the contract requires the built-in bitmap font (CORE.drawText)');
    const w = String(text).length * 6;
    return {
      width: w, actualBoundingBoxLeft: 0, actualBoundingBoxRight: w,
      actualBoundingBoxAscent: 7, actualBoundingBoxDescent: 2,
      fontBoundingBoxAscent: 8, fontBoundingBoxDescent: 2, emHeightAscent: 8, emHeightDescent: 2
    };
  }
  fillText(text, x, y) {
    this._violate('fillText', 'fillText(' + JSON.stringify(String(text)) + ') used — the contract requires CORE.drawText / the bitmap font');
    const w = String(text).length * 6;
    const p = this.fillStyle;                      /* loud placeholder: magenta box */
    this._fillStyle = { r: 255, g: 0, b: 255, a: 1 }; this._fillPaint = null;
    this.fillRect(x, y - 7, w, 9);
    this._fillStyle = (p && p.r !== undefined) ? p : { r: 255, g: 255, b: 255, a: 1 };
    return this;
  }
  strokeText(text, x, y) { return this.fillText(text, x, y); }

  /* -------------------------------------------------------------- dashes */
  setLineDash(a) { this._lineDash = (a || []).slice(); return this; }
  getLineDash() { return this._lineDash.slice(); }

  /* ====================================================== rasterisation */
  _rectDevice(x, y, w, h) {
    if (!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h)) {
      this._violate('nan-geometry', 'fillRect/clearRect with non-finite args: ' + [x, y, w, h].join(','));
      return null;
    }
    if (w === 0 || h === 0) return null;
    if (w < 0) { x += w; w = -w; }
    if (h < 0) { y += h; h = -h; }
    if (isAxisAligned(this._matrix)) {
      const m = this._matrix;
      const x0 = m[0] * x + m[4], x1 = m[0] * (x + w) + m[4];
      const y0 = m[3] * y + m[5], y1 = m[3] * (y + h) + m[5];
      return {
        x0: Math.ceil(Math.min(x0, x1) - 0.5 - 1e-9), x1: Math.ceil(Math.max(x0, x1) - 0.5 - 1e-9) - 1,
        y0: Math.ceil(Math.min(y0, y1) - 0.5 - 1e-9), y1: Math.ceil(Math.max(y0, y1) - 0.5 - 1e-9) - 1
      };
    }
    const p = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(q => this._apply(q[0], q[1]));
    const xs = p.map(q => q[0]), ys = p.map(q => q[1]);
    return {
      x0: Math.ceil(Math.min(...xs) - 0.5), x1: Math.ceil(Math.max(...xs) - 0.5) - 1,
      y0: Math.ceil(Math.min(...ys) - 0.5), y1: Math.ceil(Math.max(...ys) - 0.5) - 1,
      quad: p
    };
  }

  _clipRect() {
    const cw = this.canvas._w, ch = this.canvas._h;
    let r = { x0: 0, y0: 0, x1: cw - 1, y1: ch - 1 };
    if (this._clip) {
      r = {
        x0: Math.max(r.x0, Math.ceil(this._clip.x0)), y0: Math.max(r.y0, Math.ceil(this._clip.y0)),
        x1: Math.min(r.x1, Math.floor(this._clip.x1)), y1: Math.min(r.y1, Math.floor(this._clip.y1))
      };
    }
    return r;
  }

  _forEachPixel(r, fn) {
    const clip = this._clipRect();
    const x0 = Math.max(r.x0, clip.x0), x1 = Math.min(r.x1, clip.x1);
    const y0 = Math.max(r.y0, clip.y0), y1 = Math.min(r.y1, clip.y1);
    if (x1 < x0 || y1 < y0) return;
    const buf = this.canvas._buf, cw = this.canvas._w;
    for (let y = y0; y <= y1; y++) {
      const row = y * cw;
      for (let x = x0; x <= x1; x++) fn(buf, (row + x) * 4, x, y);
    }
  }

  _paintRect(r, color, paint) {
    const alpha = this.globalAlpha;
    const op = this._op;
    const clip = this._clipRect();
    const x0 = Math.max(r.x0, clip.x0), x1 = Math.min(r.x1, clip.x1);
    const y0 = Math.max(r.y0, clip.y0), y1 = Math.min(r.y1, clip.y1);
    if (x1 < x0 || y1 < y0) return;
    const buf = this.canvas._buf, cw = this.canvas._w;
    const quad = r.quad;

    /* Fast path: opaque source-over solid fill — the overwhelming majority of
       gameplay pixels.  Skips the generic blend entirely. */
    if (!quad && !paint && op === 0 && color.a * alpha >= 1) {
      const R = color.r < 0 ? 0 : (color.r > 255 ? 255 : color.r | 0);
      const G = color.g < 0 ? 0 : (color.g > 255 ? 255 : color.g | 0);
      const B = color.b < 0 ? 0 : (color.b > 255 ? 255 : color.b | 0);
      const width = x1 - x0 + 1;
      for (let y = y0; y <= y1; y++) {
        const row = y * cw;
        let o = (row + x0) * 4;
        for (let i = 0; i < width; i++, o += 4) {
          buf[o] = R; buf[o + 1] = G; buf[o + 2] = B; buf[o + 3] = 255;
        }
      }
      return;
    }

    for (let y = y0; y <= y1; y++) {
      const cy = y + 0.5;
      const row = y * cw;
      for (let x = x0; x <= x1; x++) {
        const cx = x + 0.5;
        if (quad && !pointInQuad(quad, cx, cy)) continue;
        let cr, cg, cb, ca;
        if (paint) { const s = paint.sample(cx, cy, this); cr = s[0]; cg = s[1]; cb = s[2]; ca = s[3]; }
        else { cr = color.r; cg = color.g; cb = color.b; ca = color.a; }
        blendPixel(buf, (row + x) * 4, cr, cg, cb, ca * alpha, op);
      }
    }
  }

  _fillPath(path) {
    const paint = this._fillPaint, color = this._fillStyle;
    this._scanline(path, null, (buf, o, cx, cy) => {
      let cr, cg, cb, ca;
      if (paint) { const s = paint.sample(cx, cy, this); cr = s[0]; cg = s[1]; cb = s[2]; ca = s[3]; }
      else { cr = color.r; cg = color.g; cb = color.b; ca = color.a; }
      blendPixel(buf, o, cr, cg, cb, ca * this.globalAlpha, this._op);
    });
  }

  _strokePath(path) {
    const lw = Math.max(0.1, this.lineWidth);
    const half = lw / 2;
    const segs = [];
    const push = (x0, y0, x1, y1) => {
      const dx = x1 - x0, dy = y1 - y0;
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) return;
      const nx = -dy / len * half, ny = dx / len * half;
      segs.push([[x0 + nx, y0 + ny], [x1 + nx, y1 + ny], [x1 - nx, y1 - ny], [x0 - nx, y0 - ny]]);
    };
    for (const sub of path.subs) {
      const pts = sub.pts;
      for (let i = 0; i < pts.length - 1; i++) push(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
      if (sub.closed && pts.length > 2) push(pts[pts.length - 1][0], pts[pts.length - 1][1], pts[0][0], pts[0][1]);
    }
    const paint = this._strokePaint, color = this._strokeStyle;
    for (const quad of segs) {
      const dev = quad.map(p => this._apply(p[0], p[1]));
      this._scanQuad(dev, paint, color);
    }
  }

  _scanQuad(devQuad, paint, color) {
    const xs = devQuad.map(p => p[0]), ys = devQuad.map(p => p[1]);
    const clip = this._clipRect();
    const x0 = Math.max(Math.ceil(Math.min(...xs) - 0.5), clip.x0), x1 = Math.min(Math.ceil(Math.max(...xs) - 0.5) - 1, clip.x1);
    const y0 = Math.max(Math.ceil(Math.min(...ys) - 0.5), clip.y0), y1 = Math.min(Math.ceil(Math.max(...ys) - 0.5) - 1, clip.y1);
    if (x1 < x0 || y1 < y0) return;
    const buf = this.canvas._buf, cw = this.canvas._w, op = this._op, ga = this.globalAlpha;
    for (let y = y0; y <= y1; y++) {
      const cy = y + 0.5, row = y * cw;
      for (let x = x0; x <= x1; x++) {
        const cx = x + 0.5;
        if (!pointInQuad(devQuad, cx, cy)) continue;
        let cr, cg, cb, ca;
        if (paint) { const s = paint.sample(cx, cy, this); cr = s[0]; cg = s[1]; cb = s[2]; ca = s[3]; }
        else { cr = color.r; cg = color.g; cb = color.b; ca = color.a; }
        blendPixel(buf, (row + x) * 4, cr, cg, cb, ca * ga, op);
      }
    }
  }

  /** Nonzero-winding scanline fill of already-transformed subpaths. */
  _scanline(path, _unused, writer) {
    const cw = this.canvas._w, ch = this.canvas._h, buf = this.canvas._buf;
    const clip = this._clipRect();
    const subpaths = [];
    let minY = Infinity, maxY = -Infinity;
    for (const sub of path.subs) {
      if (sub.pts.length < 2) continue;
      const dev = sub.pts.map(p => this._apply(p[0], p[1]));
      subpaths.push(dev);
      for (const p of dev) { if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
    }
    if (subpaths.length === 0) return;
    let y0 = Math.max(Math.ceil(minY - 0.5), clip.y0, 0);
    let y1 = Math.min(Math.ceil(maxY - 0.5) - 1, clip.y1, ch - 1);
    const xs = [];
    for (let y = y0; y <= y1; y++) {
      const cy = y + 0.5;
      xs.length = 0;
      for (const dev of subpaths) {
        for (let i = 0; i < dev.length; i++) {
          const a = dev[i], b = dev[(i + 1) % dev.length];
          if (a[1] === b[1]) continue;
          const lo = Math.min(a[1], b[1]), hi = Math.max(a[1], b[1]);
          if (cy < lo || cy >= hi) continue;
          const t = (cy - a[1]) / (b[1] - a[1]);
          xs.push({ x: a[0] + t * (b[0] - a[0]), dir: b[1] > a[1] ? 1 : -1 });
        }
      }
      if (xs.length < 2) continue;
      xs.sort((p, q) => p.x - q.x);
      let wind = 0;
      for (let i = 0; i < xs.length - 1; i++) {
        wind += xs[i].dir;
        if (wind === 0) continue;
        const sx = xs[i].x, ex = xs[i + 1].x;
        let px0 = Math.max(Math.ceil(sx - 0.5), clip.x0, 0);
        const px1 = Math.min(Math.ceil(ex - 0.5) - 1, clip.x1, cw - 1);
        const row = y * cw;
        for (let x = px0; x <= px1; x++) writer(buf, (row + x) * 4, x + 0.5, cy);
      }
    }
  }

  _blit(src, sx, sy, sw, sh, dx, dy, dw, dh) {
    const identity = isAxisAligned(this._matrix);
    const clip = this._clipRect();
    const buf = this.canvas._buf, cw = this.canvas._w, ch = this.canvas._h;
    const op = this._op, ga = this.globalAlpha;
    const sdata = src.data, swidth = src.width, sheight = src.height;

    if (identity && this._matrix[0] > 0 && this._matrix[3] > 0) {
      const m = this._matrix;
      const X0 = m[0] * dx + m[4], X1 = m[0] * (dx + dw) + m[4];
      const Y0 = m[3] * dy + m[5], Y1 = m[3] * (dy + dh) + m[5];
      const px0 = Math.max(Math.ceil(Math.min(X0, X1) - 0.5 - 1e-9), clip.x0, 0);
      const px1 = Math.min(Math.ceil(Math.max(X0, X1) - 0.5 - 1e-9) - 1, clip.x1, cw - 1);
      const py0 = Math.max(Math.ceil(Math.min(Y0, Y1) - 0.5 - 1e-9), clip.y0, 0);
      const py1 = Math.min(Math.ceil(Math.max(Y0, Y1) - 0.5 - 1e-9) - 1, clip.y1, ch - 1);
      if (px1 < px0 || py1 < py0) return;
      const invW = 1 / (X1 - X0), invH = 1 / (Y1 - Y0);
      const mapX = new Int32Array(px1 - px0 + 1);
      for (let x = px0; x <= px1; x++) {
        const u = (x + 0.5 - Math.min(X0, X1)) * invW;
        let v = sx + u * sw;
        v = v < 0 ? 0 : (v > swidth - 1 ? swidth - 1 : v);
        mapX[x - px0] = Math.floor(v);
      }
      for (let y = py0; y <= py1; y++) {
        const u = (y + 0.5 - Math.min(Y0, Y1)) * invH;
        let v = sy + u * sh;
        v = v < 0 ? 0 : (v > sheight - 1 ? sheight - 1 : v);
        const srow = (Math.floor(v)) * swidth;
        const drow = y * cw;
        for (let x = px0; x <= px1; x++) {
          const so = (srow + mapX[x - px0]) * 4;
          const sa = sdata[so + 3];
          if (sa === 0) continue;
          blendPixel(buf, (drow + x) * 4, sdata[so], sdata[so + 1], sdata[so + 2], (sa / 255) * ga, op);
        }
      }
      return;
    }

    /* transformed / rotated: inverse-map the destination quad */
    const inv = invert(this._matrix);
    const corners = [[dx, dy], [dx + dw, dy], [dx + dw, dy + dh], [dx, dy + dh]]
      .map(p => [inv[0] * p[0] + inv[2] * p[1] + inv[4], inv[1] * p[0] + inv[3] * p[1] + inv[5]]);
    const xs2 = corners.map(p => p[0]), ys2 = corners.map(p => p[1]);
    const bx0 = Math.max(Math.ceil(Math.min(...xs2) - 0.5), 0, clip.x0);
    const bx1 = Math.min(Math.ceil(Math.max(...xs2) - 0.5) - 1, cw - 1, clip.x1);
    const by0 = Math.max(Math.ceil(Math.min(...ys2) - 0.5), 0, clip.y0);
    const by1 = Math.min(Math.ceil(Math.max(...ys2) - 0.5) - 1, ch - 1, clip.y1);
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        const ux = x + 0.5, uy = y + 0.5;
        if (!pointInQuad(corners, ux, uy)) continue;
        const u = (ux - dx) / dw, v = (uy - dy) / dh;
        let px = Math.floor(sx + u * sw), py = Math.floor(sy + v * sh);
        if (px < 0 || py < 0 || px >= swidth || py >= sheight) continue;
        const so = (py * swidth + px) * 4;
        const sa = sdata[so + 3];
        if (sa === 0) continue;
        blendPixel(buf, (y * cw + x) * 4, sdata[so], sdata[so + 1], sdata[so + 2], (sa / 255) * ga, op);
      }
    }
  }
}

/* ------------------------------------------------------- pixel blending */
function blendPixel(buf, o, cr, cg, cb, a, op) {
  if (!(a > 0)) return;
  if (a > 1) a = 1;
  let dr = buf[o], dg = buf[o + 1], db = buf[o + 2], da = buf[o + 3] / 255;
  let r, g, b, na;
  switch (op) {
    case 0:                                   /* source-over */
      r = cr * a + dr * (1 - a); g = cg * a + dg * (1 - a); b = cb * a + db * (1 - a);
      na = a + da * (1 - a); break;
    case 8:                                   /* lighter */
      r = dr + cr * a; g = dg + cg * a; b = db + cb * a;
      na = Math.min(1, da + a); break;
    case 9:                                   /* copy */
      r = cr; g = cg; b = cb; na = a; break;
    case 6:                                   /* destination-out */
      r = dr; g = dg; b = db; na = da * (1 - a); break;
    case 4:                                   /* destination-over */
      r = dr * da + cr * a * (1 - da); g = dg * da + cg * a * (1 - da); b = db * da + cb * a * (1 - da);
      na = a + da * (1 - a); break;
    case 11:                                  /* multiply */
      r = dr * (cr / 255) * a + dr * (1 - a); g = dg * (cg / 255) * a + dg * (1 - a); b = db * (cb / 255) * a + db * (1 - a);
      na = a + da * (1 - a); break;
    case 12:                                  /* screen */
      r = (255 - (255 - dr) * (255 - cr) / 255) * a + dr * (1 - a);
      g = (255 - (255 - dg) * (255 - cg) / 255) * a + dg * (1 - a);
      b = (255 - (255 - db) * (255 - cb) / 255) * a + db * (1 - a);
      na = a + da * (1 - a); break;
    default:                                  /* unsupported ops degrade to source-over */
      r = cr * a + dr * (1 - a); g = cg * a + dg * (1 - a); b = cb * a + db * (1 - a);
      na = a + da * (1 - a); break;
  }
  buf[o] = r < 0 ? 0 : (r > 255 ? 255 : r);
  buf[o + 1] = g < 0 ? 0 : (g > 255 ? 255 : g);
  buf[o + 2] = b < 0 ? 0 : (b > 255 ? 255 : b);
  buf[o + 3] = na * 255;
}

/* ------------------------------------------------------------ geometry -- */
function isAxisAligned(m) { return m[1] === 0 && m[2] === 0; }
function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return [1, 0, 0, 1, 0, 0];
  const id = 1 / det;
  return [
    m[3] * id, -m[1] * id, -m[2] * id, m[0] * id,
    (m[2] * m[5] - m[3] * m[4]) * id, (m[1] * m[4] - m[0] * m[5]) * id
  ];
}
function pointInQuad(q, x, y) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const cross = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    if (cross === 0) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s; else if (s !== sign) return false;
  }
  return true;
}
function intersectClip(clip, rect, canvas) {
  let r = { x0: rect.x0, y0: rect.y0, x1: rect.x1, y1: rect.y1 };
  if (clip) {
    r = {
      x0: Math.max(clip.x0, r.x0), y0: Math.max(clip.y0, r.y0),
      x1: Math.min(clip.x1, r.x1), y1: Math.min(clip.y1, r.y1)
    };
  }
  return r;
}
function pathLooksRectangular(path) {
  if (path.subs.length !== 1) return false;
  const pts = path.subs[0].pts;
  if (pts.length !== 4 && pts.length !== 5) return false;
  return true;
}

class Path2D {
  constructor(arg) {
    this._path = newPath();
    if (arg && arg._path) this._path = clonePath(arg._path);
  }
  moveTo(x, y) { pathMoveTo(this._path, x, y); return this; }
  lineTo(x, y) { pathLineTo(this._path, x, y); return this; }
  closePath() { pathClose(this._path); return this; }
  rect(x, y, w, h) { pathRect(this._path, x, y, w, h); return this; }
  arc() { pathArc(this._path, ...arguments); return this; }
  ellipse() { pathEllipse(this._path, ...arguments); return this; }
  quadraticCurveTo() { pathQuad(this._path, ...arguments); return this; }
  bezierCurveTo() { pathCubic(this._path, ...arguments); return this; }
  roundRect(x, y, w, h) { pathRect(this._path, x, y, w, h); return this; }
  addPath(p) { if (p && p._path) this._path.subs.push(...clonePath(p._path).subs); return this; }
}

function newPath() { return { subs: [] }; }
function clonePath(p) { return { subs: p.subs.map(s => ({ pts: s.pts.map(q => q.slice()), closed: s.closed })) }; }
function cur(path) {
  if (!path.subs.length) path.subs.push({ pts: [], closed: false });
  return path.subs[path.subs.length - 1];
}
function pathMoveTo(path, x, y) { path.subs.push({ pts: [[x, y]], closed: false }); }
function pathLineTo(path, x, y) {
  const s = path.subs.length ? path.subs[path.subs.length - 1] : null;
  if (!s || s.closed) { pathMoveTo(path, x, y); return; }
  s.pts.push([x, y]);
}
function pathClose(path) {
  if (path.subs.length) path.subs[path.subs.length - 1].closed = true;
}
function pathRect(path, x, y, w, h) {
  pathMoveTo(path, x, y); pathLineTo(path, x + w, y); pathLineTo(path, x + w, y + h);
  pathLineTo(path, x, y + h); pathClose(path);
}
function pathQuad(path, cx, cy, x, y) {
  const s = path.subs.length ? path.subs[path.subs.length - 1] : null;
  if (!s || !s.pts.length) { pathMoveTo(path, x, y); return; }
  const p0 = s.pts[s.pts.length - 1];
  for (let i = 1; i <= 8; i++) {
    const t = i / 8, u = 1 - t;
    pathLineTo(path, u * u * p0[0] + 2 * u * t * cx + t * t * x, u * u * p0[1] + 2 * u * t * cy + t * t * y);
  }
}
function pathCubic(path, c1x, c1y, c2x, c2y, x, y) {
  const s = path.subs.length ? path.subs[path.subs.length - 1] : null;
  if (!s || !s.pts.length) { pathMoveTo(path, x, y); return; }
  const p0 = s.pts[s.pts.length - 1];
  for (let i = 1; i <= 12; i++) {
    const t = i / 12, u = 1 - t;
    pathLineTo(path,
      u * u * u * p0[0] + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x,
      u * u * u * p0[1] + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y);
  }
}
function pathArc(path, cx, cy, r, a0, a1, ccw) {
  let start = a0 === undefined ? 0 : a0, end = a1 === undefined ? Math.PI * 2 : a1;
  if (ccw && end > start) end -= Math.PI * 2;
  if (!ccw && end < start) end += Math.PI * 2;
  const span = Math.abs(end - start);
  const steps = Math.max(6, Math.min(180, Math.ceil(span / (Math.PI / 16))));
  for (let i = 0; i <= steps; i++) {
    const a = start + (end - start) * (i / steps);
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    if (i === 0) pathMoveTo(path, x, y); else pathLineTo(path, x, y);
  }
}
function pathEllipse(path, cx, cy, rx, ry, rot, a0, a1, ccw) {
  let start = a0 === undefined ? 0 : a0, end = a1 === undefined ? Math.PI * 2 : a1;
  if (ccw && end > start) end -= Math.PI * 2;
  if (!ccw && end < start) end += Math.PI * 2;
  const steps = Math.max(8, Math.min(180, Math.ceil(Math.abs(end - start) / (Math.PI / 16))));
  const cr = Math.cos(rot || 0), sr = Math.sin(rot || 0);
  for (let i = 0; i <= steps; i++) {
    const a = start + (end - start) * (i / steps);
    const ex = Math.cos(a) * rx, ey = Math.sin(a) * ry;
    const x = cx + ex * cr - ey * sr, y = cy + ex * sr + ey * cr;
    if (i === 0) pathMoveTo(path, x, y); else pathLineTo(path, x, y);
  }
}
function pathBounds(path) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, any = false;
  for (const s of path.subs) for (const p of s.pts) {
    any = true;
    if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
  }
  return any ? { x0, y0, x1, y1 } : null;
}
function pointInPath(path, x, y) {
  let wind = 0;
  for (const s of path.subs) {
    const pts = s.pts;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if (a[1] === b[1]) continue;
      const lo = Math.min(a[1], b[1]), hi = Math.max(a[1], b[1]);
      if (y < lo || y >= hi) continue;
      const t = (y - a[1]) / (b[1] - a[1]);
      const ix = a[0] + t * (b[0] - a[0]);
      if (ix > x) wind += b[1] > a[1] ? 1 : -1;
    }
  }
  return wind !== 0;
}

function imageSource(img) {
  if (!img) return null;
  if (img._buf && img._w) return { data: img._buf, width: img._w, height: img._h };
  if (img.data && img.width && img.height) return { data: img.data, width: img.width, height: img.height };
  if (typeof img.getContext === 'function') {
    const c = img.getContext('2d');
    if (c && c.canvas) return { data: c.canvas._buf, width: c.canvas._w, height: c.canvas._h };
  }
  return null;
}
function safeStr(v) {
  try {
    if (typeof v === 'string') return v;
    if (v instanceof Error) return v.stack || v.message;
    if (typeof v === 'function') return '[function ' + (v.name || 'anonymous') + ']';
    if (typeof v === 'object' && v !== null) {
      if (v.tagName) return '<' + String(v.tagName).toLowerCase() + '>';
      const s = JSON.stringify(v);
      return s === undefined ? String(v) : (s.length > 300 ? s.slice(0, 300) + '...' : s);
    }
    return String(v);
  } catch (e) { return '[unprintable]'; }
}

function describe(v) {  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'object') return 'object{' + Object.keys(v).slice(0, 6).join(',') + '}';
  return typeof v + '(' + String(v) + ')';
}

/* ================================================================ events */
class ShimEventTarget {
  constructor() { this._ls = new Map(); }
  addEventListener(type, fn) {
    if (typeof fn !== 'function' && (!fn || typeof fn.handleEvent !== 'function')) return;
    if (!this._ls.has(type)) this._ls.set(type, []);
    const arr = this._ls.get(type);
    if (!arr.includes(fn)) arr.push(fn);
  }
  removeEventListener(type, fn) {
    const arr = this._ls.get(type);
    if (!arr) return;
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }
  dispatchEvent(ev) {
    ev.target = ev.target || this;
    this._fire(ev);
    return !ev.defaultPrevented;
  }
  _fire(ev) {
    const arr = this._ls.get(ev.type);
    ev.currentTarget = this;
    if (arr) for (const fn of arr.slice()) {
      try {
        if (typeof fn === 'function') fn.call(this, ev); else fn.handleEvent(ev);
      } catch (e) {
        this._shimErrors ? this._shimErrors.push(e) : console.error('[shim] listener threw:', e && e.stack || e);
      }
      if (ev._stopped) break;
    }
    const on = this['on' + ev.type];
    if (typeof on === 'function' && !ev._stopped) {
      try { on.call(this, ev); } catch (e) { /* recorded by the harness */ }
    }
  }
  _listenerCount(type) { const a = this._ls.get(type); return a ? a.length : 0; }
}

/* ============================================================== elements */
class StyleDecl {
  constructor() { this._props = new Map(); }
  setProperty(k, v) { this._props.set(k, v); this[k] = v; }
  getPropertyValue(k) { return this[k] !== undefined ? String(this[k]) : (this._props.get(k) || ''); }
  removeProperty(k) { delete this[k]; this._props.delete(k); }
}

class ShimElement extends ShimEventTarget {
  constructor(tagName, doc) {
    super();
    this.tagName = String(tagName).toUpperCase();
    this.nodeName = this.tagName;
    this.nodeType = 1;
    this.id = '';
    this.className = '';
    this.style = new StyleDecl();
    this.dataset = {};
    this.children = [];
    this.childNodes = this.children;
    this.parentNode = null;
    this.ownerDocument = doc || null;
    this._attrs = new Map();
    this.textContent = '';
    this.innerHTML = '';
    this.width = 0;
    this.height = 0;
    this.classList = {
      _e: this,
      add: (...c) => { const s = new Set(String(this.className).split(/\s+/).filter(Boolean)); c.forEach(x => s.add(x)); this.className = [...s].join(' '); },
      remove: (...c) => { const s = new Set(String(this.className).split(/\s+/).filter(Boolean)); c.forEach(x => s.delete(x)); this.className = [...s].join(' '); },
      contains: (c) => String(this.className).split(/\s+/).includes(c),
      toggle: (c) => { this.classList.contains(c) ? this.classList.remove(c) : this.classList.add(c); return this.classList.contains(c); }
    };
  }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c, ref) {
    c.parentNode = this;
    const i = this.children.indexOf(ref);
    if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
    return c;
  }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(n) { return n === this || this.children.includes(n); }
  setAttribute(k, v) {
    this._attrs.set(k, String(v));
    if (k === 'id') this.id = String(v);
    else if (k === 'class') this.className = String(v);
    else if (k === 'width') this.width = +v;
    else if (k === 'height') this.height = +v;
  }
  getAttribute(k) { return this._attrs.has(k) ? this._attrs.get(k) : null; }
  hasAttribute(k) { return this._attrs.has(k); }
  removeAttribute(k) { this._attrs.delete(k); }
  get clientWidth() { return this._clientW || 0; }
  get clientHeight() { return this._clientH || 0; }
  get offsetWidth() { return this.clientWidth; }
  get offsetHeight() { return this.clientHeight; }
  getBoundingClientRect() {
    const w = this._clientW || 0, h = this._clientH || 0;
    const x = this._rectX || 0, y = this._rectY || 0;
    return { x, y, left: x, top: y, right: x + w, bottom: y + h, width: w, height: h, toJSON() { return this; } };
  }
  getContext() { return null; }
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument && this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null; }
  click() { this.dispatchEvent(makeEvent('click', this, true)); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  getElementsByTagName() { return []; }
  matches() { return false; }
  scrollIntoView() { }
  requestPointerLock() { this._pointerLocked = true; }
  exitPointerLock() { this._pointerLocked = false; }
  setPointerCapture() { }
  releasePointerCapture() { }
  requestFullscreen() { return Promise.resolve(); }
}

class ShimCanvas extends ShimElement {
  constructor(w, h, doc) {
    super('canvas', doc);
    this._w = Math.max(1, (w === undefined ? 300 : w) | 0);
    this._h = Math.max(1, (h === undefined ? 150 : h) | 0);
    this._buf = new Uint8ClampedArray(this._w * this._h * 4);
    this._ctx = null;
    this._clientW = this._w;
    this._clientH = this._h;
    this._shim = null;
  }
  get width() { return this._w; }
  set width(v) {
    const n = Math.max(1, v | 0);
    if (n === this._w) return;
    this._w = n;
    this._buf = new Uint8ClampedArray(this._w * this._h * 4);
  }
  get height() { return this._h; }
  set height(v) {
    const n = Math.max(1, v | 0);
    if (n === this._h) return;
    this._h = n;
    this._buf = new Uint8ClampedArray(this._w * this._h * 4);
  }
  getContext(type) {
    if (String(type).toLowerCase() !== '2d') {
      throw new CanvasShimError('canvas-shim: getContext(' + JSON.stringify(String(type)) + ') — only "2d" is implemented');
    }
    if (!this._ctx) {
      const ctx = new Context2D(this, this._shim);
      this._ctx = makeStrictContext(ctx, this._shim);
    }
    return this._ctx;
  }
  toDataURL(type) {
    if (type && String(type).indexOf('png') < 0) {
      throw new CanvasShimError('canvas-shim: toDataURL only supports image/png');
    }
    return 'data:image/png;base64,' + encodePNG(this._w, this._h, this._buf).toString('base64');
  }
  toBlob(cb, type) {
    const buf = encodePNG(this._w, this._h, this._buf);
    const blob = { type: type || 'image/png', size: buf.length, _buf: buf, arrayBuffer: () => Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)) };
    if (typeof cb === 'function') cb(blob);
  }
  get data() { return this._buf; }
}

/** Wrap the context so unknown members are loud instead of undefined. */
function makeStrictContext(ctx, shim) {
  return new Proxy(ctx, {
    get(target, prop, recv) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop, recv);
      const name = String(prop);
      if (name.charCodeAt(0) === 95 /* '_' */) return Reflect.get(target, prop, recv);
      if (prop === 'then' || prop === 'catch' || prop === 'finally' || prop === 'toJSON' ||
        prop === 'inspect' || prop === 'constructor' || prop === 'valueOf' || prop === 'toString') {
        return Reflect.get(target, prop, recv);
      }
      if (Reflect.has(target, prop)) return Reflect.get(target, prop, recv);
      const where = new Error('call site').stack;
      shim._violate('unknown-ctx-member', 'ctx.' + name + ' is not part of the Canvas2D surface', 0);
      throw new CanvasShimError(
        'canvas-shim: rendering code touched ctx.' + name +
        ', which this shim does not implement and will not silently swallow.\n' + where, name);
    },
    set(target, prop, value) {
      if (typeof prop === 'symbol') return Reflect.set(target, prop, value);
      const name = String(prop);
      if (name.charCodeAt(0) === 95 /* '_' */) return Reflect.set(target, prop, value);
      if (Reflect.has(target, prop) || prop === 'canvas') return Reflect.set(target, prop, value);
      shim._violate('unknown-ctx-property', 'ctx.' + name + ' = ... is not part of the Canvas2D surface', 0);
      throw new CanvasShimError('canvas-shim: rendering code set ctx.' + name + ', which this shim does not implement.');
    }
  });
}

/* ============================================================== document */
class ShimDocument extends ShimEventTarget {
  constructor(shim) {
    super();
    this._shim = shim;
    this.nodeType = 9;
    this.readyState = 'complete';
    this.hidden = false;
    this.visibilityState = 'visible';
    this.title = '';
    this.activeElement = null;
    this.documentElement = new ShimElement('html', this);
    this.head = new ShimElement('head', this);
    this.body = new ShimElement('body', this);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.body.parentNode = this.documentElement;
    this._byId = new Map();
    this.fullscreenElement = null;
  }
  createElement(tag) {
    const t = String(tag).toLowerCase();
    let el;
    if (t === 'canvas') { el = new ShimCanvas(300, 150, this); el._shim = this._shim; }
    else if (t === 'img') {
      el = new ShimElement('img', this);
      let srcVal = '';
      Object.defineProperty(el, 'src', {
        get() { return srcVal; },
        set(v) {
          srcVal = String(v);
          this._shim._violate('network-image', 'img.src = ' + JSON.stringify(srcVal) + ' — the contract forbids image files; all art must be procedural');
        }
      });
    } else if (t === 'audio') {
      el = new ShimElement('audio', this);
      el.canPlayType = () => '';
      el.play = () => Promise.resolve();
      el.pause = () => { };
    } else el = new ShimElement(t, this);
    return el;
  }
  createElementNS(ns, tag) { return this.createElement(tag); }
  createTextNode(text) { return { nodeType: 3, textContent: String(text), parentNode: null }; }
  createDocumentFragment() { return new ShimElement('fragment', this); }
  getElementById(id) {
    if (this._byId.has(id)) return this._byId.get(id);
    const walk = (n) => {
      for (const c of n.children || []) { if (c.id === id) return c; const r = walk(c); if (r) return r; }
      return null;
    };
    return walk(this.documentElement) || walk(this.body);
  }
  _register(el) { if (el.id) this._byId.set(el.id, el); }
  getElementsByTagName(tag) {
    const out = [], t = String(tag).toLowerCase();
    const walk = (n) => { for (const c of n.children || []) { if (t === '*' || c.tagName.toLowerCase() === t) out.push(c); walk(c); } };
    walk(this.body);
    return out;
  }
  querySelector(sel) {
    if (typeof sel === 'string' && sel[0] === '#') return this.getElementById(sel.slice(1));
    return null;
  }
  querySelectorAll() { return []; }
  hasFocus() { return true; }
  exitPointerLock() { }
  addEventListener(t, f) { super.addEventListener(t, f); }
}

/* ================================================================ events */
function makeEvent(type, target, bubbles) {
  const ev = {
    type, target: target || null, currentTarget: null, bubbles: !!bubbles,
    cancelable: true, defaultPrevented: false, isTrusted: false, timeStamp: 0,
    _stopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this._stopped = true; },
    stopImmediatePropagation() { this._stopped = true; },
    composedPath() { return []; },
    initEvent(t) { this.type = t; }
  };
  return ev;
}

const KEY_CODES = {
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Enter: 13, Escape: 27, ' ': 32,
  Shift: 16, Control: 17, Alt: 18, Tab: 9, Backspace: 8, PageUp: 33, PageDown: 34, Home: 36, End: 35,
  '(': 57, ')': 48
};

/* ============================================== global property plumbing ==
 * Modern Node exposes several DOM-flavoured globals as getter-only accessors
 * (navigator, performance, fetch, WebSocket, Event...).  Assigning to them from
 * a module throws, so every global this shim installs goes through here.
 */
function makeWritable(key) {
  try {
    const d = Object.getOwnPropertyDescriptor(globalThis, key);
    if (!d || d.writable || !d.configurable) return false;
    Object.defineProperty(globalThis, key, {
      value: globalThis[key], writable: true, configurable: true, enumerable: false
    });
    return true;
  } catch (e) { return false; }
}

function setGlobal(key, value) {
  try {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true, enumerable: false });
    return true;
  } catch (e) {
    try { globalThis[key] = value; return true; } catch (e2) { return false; }
  }
}

/* ================================================================ shim --- */
export function createShim(opts) {
  opts = opts || {};
  const shim = {
    options: opts,
    violations: [],
    errors: [],
    consoleCalls: [],
    clock: { t: 0 },
    frame: 0,
    _timers: new Map(),
    _timerId: 1,
    _raf: new Map(),
    _rafId: 1,
    _installed: [],
    _violateSeen: new Map()
  };

  shim._violate = function (kind, detail, skip) {
    const key = kind + '|' + detail;
    const seen = shim._violateSeen.get(key) || 0;
    shim._violateSeen.set(key, seen + 1);
    if (seen > 0 && !opts.recordAllViolations) return;      /* dedupe noise */
    const stack = new Error().stack.split('\n').slice(1 + (skip || 0));
    shim.violations.push({
      kind, detail, count: 1,
      stack: stack.slice(0, 4).map(s => s.trim()).join(' <- ')
    });
  };
  shim.violationCount = (kind) => shim.violations.filter(v => !kind || v.kind === kind).length;

  /* ------------------------------------------------------------ canvases */
  const document = new ShimDocument(shim);
  document._shimErrors = shim.errors;

  /* -------------------------------------------------------------- window */
  const win = globalThis;
  for (const k of [
    'window', 'self', 'document', 'top', 'parent', 'navigator', 'location', 'history',
    'screen', 'performance', 'console', 'localStorage', 'sessionStorage', 'devicePixelRatio',
    'innerWidth', 'innerHeight', 'outerWidth', 'outerHeight', 'scrollX', 'scrollY',
    'matchMedia', 'getComputedStyle', 'alert', 'confirm', 'prompt', 'scrollTo', 'focus', 'open',
    'close', 'Image', 'OffscreenCanvas', 'ImageData', 'Path2D', 'DOMMatrix',
    'CanvasRenderingContext2D', 'KeyboardEvent', 'MouseEvent', 'TouchEvent', 'Event',
    'CustomEvent', 'Audio', 'fetch', 'XMLHttpRequest', 'WebSocket',
    'requestAnimationFrame', 'cancelAnimationFrame', 'addEventListener', 'removeEventListener',
    'dispatchEvent', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'
  ]) makeWritable(k);
  win.window = win;
  win.self = win;
  win.document = document;
  win.top = win;
  win.parent = win;

  const winTarget = new ShimEventTarget();
  const forwardEvent = (type) => (ev) => winTarget._fire(ev);
  win.addEventListener = (t, f) => winTarget.addEventListener(t, f);
  win.removeEventListener = (t, f) => winTarget.removeEventListener(t, f);
  win.dispatchEvent = (ev) => { winTarget._fire(ev); return !ev.defaultPrevented; };
  winTarget._shimErrors = shim.errors;

  /* ------------------------------------------------------------- timers */
  const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
  const realSetInterval = globalThis.setInterval, realClearInterval = globalThis.clearInterval;
  const realNow = Date.now;

  win.setTimeout = function (fn, delay, ...args) {
    const id = shim._timerId++;
    shim._timers.set(id, { due: shim.clock.t + (+delay || 0), fn, args, interval: 0, id });
    return id;
  };
  win.setInterval = function (fn, delay, ...args) {
    const id = shim._timerId++;
    const d = Math.max(1, +delay || 0);
    shim._timers.set(id, { due: shim.clock.t + d, fn, args, interval: d, id });
    return id;
  };
  win.clearTimeout = (id) => { shim._timers.delete(id); };
  win.clearInterval = (id) => { shim._timers.delete(id); };
  win.requestAnimationFrame = function (cb) {
    const id = shim._rafId++;
    shim._raf.set(id, cb);
    return id;
  };
  win.cancelAnimationFrame = (id) => { shim._raf.delete(id); };

  /* -------------------------------------------------------- performance */
  const perfObj = (REAL_PERF && typeof REAL_PERF === 'object') ? REAL_PERF : {};
  const origPerfNow = perfObj.now;
  try { perfObj.now = () => shim.clock.t; } catch (e) { /* frozen */ }
  if (!perfObj.timeOrigin) perfObj.timeOrigin = 0;
  win.performance = perfObj;
  if (opts.freezeDate !== false) {
    try { Date.now = () => shim.clock.t; } catch (e) { /* ignore */ }
  }
  shim.realNow = realNow;
  shim.restoreRealTime = () => { try { Date.now = realNow; } catch (e) { } if (origPerfNow) try { perfObj.now = origPerfNow; } catch (e) { } };

  /* ----------------------------------------------------- Math.random --- */
  const origRandom = Math.random;
  let randState = 0x9e3779b9;
  if (opts.deterministicRandom !== false) {
    Math.random = function () {
      shim._violate('math-random', 'Math.random() used — the contract requires a seeded CORE.rng (value faked deterministically)');
      randState = (randState + 0x6D2B79F5) >>> 0;
      let t = randState;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  shim.resetRandom = () => { randState = 0x9e3779b9; };

  /* ---------------------------------------------------------- storage --- */
  function makeStorage(name) {
    const map = new Map();
    return {
      _map: map,
      _name: name,
      get length() { return map.size; },
      key: (i) => [...map.keys()][i] !== undefined ? [...map.keys()][i] : null,
      getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
      setItem: (k, v) => { map.set(String(k), String(v)); },
      removeItem: (k) => { map.delete(String(k)); },
      clear: () => map.clear()
    };
  }
  const localStorage = makeStorage('local');
  const sessionStorage = makeStorage('session');
  win.localStorage = localStorage;
  win.sessionStorage = sessionStorage;

  /* ---------------------------------------------------------- network --- */
  const origFetch = globalThis.fetch;
  if (opts.poisonNetwork !== false) {
    win.fetch = function (url) {
      shim._violate('network', 'fetch(' + JSON.stringify(String(url)) + ') — the contract forbids runtime network access');
      return Promise.reject(new Error('canvas-shim: network access is forbidden by the contract'));
    };
    win.XMLHttpRequest = function () {
      shim._violate('network', 'new XMLHttpRequest() — the contract forbids runtime network access');
      throw new Error('canvas-shim: XMLHttpRequest is forbidden by the contract');
    };
    win.WebSocket = function () {
      shim._violate('network', 'new WebSocket() — the contract forbids runtime network access');
      throw new Error('canvas-shim: WebSocket is forbidden by the contract');
    };
  }

  /* ------------------------------------------------------------- misc --- */
  /* Node's own `navigator` is not extensible, so build a fresh one: the game
     needs navigator.getGamepads() to be a real, patchable function. */
  const gamepads = { list: [] };
  const nav = {
    userAgent: 'NEON-DRIFT-VERIFY/1.0 (node canvas shim)',
    appVersion: '5.0 (NEON DRIFT verify)',
    platform: 'Node', language: 'en-US', languages: ['en-US'], onLine: true,
    hardwareConcurrency: 8, maxTouchPoints: 1, vendor: '',
    getGamepads: () => gamepads.list.slice(),
    vibrate: () => false,
    requestMIDIAccess: () => Promise.reject(new Error('unsupported'))
  };
  if (!setGlobal('navigator', nav)) {
    try {
      Object.defineProperty(win.navigator, 'getGamepads', { value: nav.getGamepads, configurable: true });
    } catch (e) { shim._violate('navigator', 'could not install navigator.getGamepads — gamepad support cannot be verified'); }
  }
  shim.setGamepads = (pads) => { gamepads.list = pads.slice(); };
  shim.navigator = win.navigator;
  win.location = { href: 'file:///D:/V4.1F%20Test/index.html', protocol: 'file:', hash: '', search: '', reload() { }, assign() { } };
  win.history = { pushState() { }, replaceState() { }, back() { } };
  win.screen = { width: 384 * 3, height: 216 * 3, availWidth: 384 * 3, availHeight: 216 * 3 };
  win.devicePixelRatio = 1;
  win.innerWidth = 1152; win.innerHeight = 648;
  win.outerWidth = 1152; win.outerHeight = 648;
  win.scrollX = 0; win.scrollY = 0;
  win.matchMedia = (q) => ({ matches: false, media: String(q), addEventListener() { }, removeEventListener() { }, addListener() { }, removeListener() { } });
  win.getComputedStyle = () => ({ getPropertyValue: () => '', width: '1152px', height: '648px' });
  win.alert = (m) => shim._violate('alert', 'alert(' + JSON.stringify(String(m)) + ')');
  win.confirm = () => false;
  win.prompt = () => null;
  win.scrollTo = () => { };
  win.focus = () => { };
  win.open = () => null;
  win.close = () => { };
  win.Image = function () { return document.createElement('img'); };
  win.OffscreenCanvas = function (w, h) { return new ShimCanvas(w, h, document); };
  win.ImageData = ShimImageData;
  win.Path2D = Path2D;
  win.DOMMatrix = function () { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; };
  win.CanvasRenderingContext2D = Context2D;
  win.KeyboardEvent = function (type, init) { const e = makeEvent(type, null, true); return Object.assign(e, init || {}); };
  win.MouseEvent = function (type, init) { const e = makeEvent(type, null, true); return Object.assign(e, init || {}); };
  win.TouchEvent = function (type, init) { const e = makeEvent(type, null, true); return Object.assign(e, init || {}); };
  win.Event = function (type, init) { const e = makeEvent(type, null, true); return Object.assign(e, init || {}); };
  win.CustomEvent = win.Event;
  win.Audio = function () { const el = document.createElement('audio'); return el; };
  /* AudioContext deliberately absent: contract §5 requires AUDIO to no-op. */
  try { delete win.AudioContext; } catch (e) { }
  try { delete win.webkitAudioContext; } catch (e) { }

  /* ------------------------------------------------------------ console */
  const realConsole = globalThis.console;
  const levels = ['log', 'info', 'warn', 'error', 'debug', 'trace'];
  const consoleProxy = {};
  for (const lv of levels) {
    consoleProxy[lv] = function (...args) {
      shim.consoleCalls.push({ level: lv, text: args.map(a => safeStr(a)).join(' '), frame: shim.frame });
      if (opts.echoConsole) realConsole[lv](...args);
    };
  }
  consoleProxy.table = consoleProxy.log;
  consoleProxy.group = consoleProxy.log;
  consoleProxy.groupEnd = () => { };
  consoleProxy.time = () => { };
  consoleProxy.timeEnd = () => { };
  consoleProxy.assert = (cond, ...a) => { if (!cond) consoleProxy.error('Assertion failed:', ...a); };
  consoleProxy.dir = consoleProxy.log;
  consoleProxy.count = () => { };
  globalThis.console = consoleProxy;
  shim.realConsole = realConsole;
  shim.flushConsole = () => {
    const bad = shim.consoleCalls.filter(c => c.level === 'error' || c.level === 'warn');
    return bad;
  };

  /* ------------------------------------------------------------- frames */
  shim._runTimers = function () {
    const due = [...shim._timers.values()].filter(t => t.due <= shim.clock.t).sort((a, b) => a.due - b.due);
    for (const t of due) {
      try {
        t.fn(...t.args);
      } catch (e) {
        shim.errors.push({ where: 'timer', error: String(e && e.stack || e) });
      }
      if (t.interval) t.due = shim.clock.t + t.interval;
      else shim._timers.delete(t.id);
    }
  };

  /**
   * Advance the virtual clock by dtMs and run one animation frame.
   * Deterministic: no wall-clock, no real timers.
   */
  shim.tick = function (dtMs) {
    shim.clock.t += (dtMs === undefined ? 1000 / 60 : dtMs);
    shim.frame++;
    shim._runTimers();
    const batch = [...shim._raf.entries()];
    shim._raf.clear();
    for (const [, cb] of batch) {
      try { cb(shim.clock.t); }
      catch (e) { shim.errors.push({ where: 'raf', frame: shim.frame, error: String(e && e.stack || e) }); }
    }
  };

  shim.frames = function (n, dtMs) { for (let i = 0; i < n; i++) shim.tick(dtMs); };
  shim.pendingFrames = () => shim._raf.size;

  /* -------------------------------------------------------------- input */
  function dispatchTo(ev, target) {
    ev.timeStamp = shim.clock.t;
    const chain = [];
    let n = target;
    while (n) { chain.push(n); n = n.parentNode || (n === document ? null : null); }
    if (!chain.includes(document)) chain.push(document);
    chain.push(winTarget);
    ev.target = target;
    for (const t of chain) {
      t._fire(ev);
      if (ev._stopped) break;
    }
    return ev;
  }

  function keyEvent(type, keyName, extra) {
    const key = String(keyName);
    let code = '';
    let keyCode = KEY_CODES[key];
    if (keyCode === undefined) {
      if (/^[a-zA-Z]$/.test(key)) { keyCode = key.toUpperCase().charCodeAt(0); code = 'Key' + key.toUpperCase(); }
      else if (/^[0-9]$/.test(key)) { keyCode = key.charCodeAt(0); code = 'Digit' + key; }
      else if (key.length && key[0] === 'F' && /^F\d+$/.test(key)) { keyCode = 111 + (+key.slice(1)); code = key; }
      else keyCode = 0;
    }
    if (!code) {
      if (key === ' ') code = 'Space';
      else if (key === 'Escape') code = 'Escape';
      else if (key === 'Enter') code = 'Enter';
      else code = key;
    }
    const ev = makeEvent(type, null, true);
    ev.key = key;
    ev.code = code;
    ev.keyCode = keyCode;
    ev.which = keyCode;
    ev.charCode = type === 'keypress' ? keyCode : 0;
    ev.repeat = !!(extra && extra.repeat);
    ev.altKey = !!(extra && extra.altKey);
    ev.ctrlKey = !!(extra && extra.ctrlKey);
    ev.metaKey = !!(extra && extra.metaKey);
    ev.shiftKey = !!(extra && extra.shiftKey) || (key.length === 1 && key !== key.toLowerCase());
    if (extra) Object.assign(ev, extra);
    return ev;
  }

  shim.keyDown = function (key, extra) {
    return dispatchTo(keyEvent('keydown', key, extra), document.activeElement || document.body);
  };
  shim.keyUp = function (key, extra) {
    return dispatchTo(keyEvent('keyup', key, extra), document.activeElement || document.body);
  };
  shim.keyPress = function (key, extra) {
    return dispatchTo(keyEvent('keypress', key, extra), document.activeElement || document.body);
  };
  shim.tap = function (key) { shim.keyDown(key); shim.keyUp(key); };
  shim.hold = function (key) { shim.keyDown(key); };
  shim.release = function (key) { shim.keyUp(key); };

  function pointerEvent(type, x, y, extra) {
    const ev = makeEvent(type, null, true);
    ev.clientX = x; ev.clientY = y; ev.pageX = x; ev.pageY = y;
    ev.screenX = x; ev.screenY = y;
    ev.button = (extra && extra.button) || 0;
    ev.buttons = type === 'mouseup' ? 0 : 1;
    ev.pointerId = 1; ev.pointerType = 'touch'; ev.isPrimary = true;
    if (extra) Object.assign(ev, extra);
    return ev;
  }
  shim.mouse = function (type, x, y, extra) {
    return dispatchTo(pointerEvent(type, x, y, extra), document.body);
  };
  function touchPoint(x, y, id) { return { clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y, identifier: id || 0, target: document.body, force: 1, radiusX: 8, radiusY: 8 }; }
  shim.touch = function (type, points) {
    const ev = makeEvent(type, null, true);
    const list = (points || []).map((p, i) => touchPoint(p[0], p[1], i));
    ev.touches = type === 'touchend' || type === 'touchcancel' ? [] : list;
    ev.targetTouches = ev.touches;
    ev.changedTouches = list;
    if (!ev.touches.length && list.length) ev.touches = list;
    return dispatchTo(ev, document.body);
  };

  /* -------------------------------------------------------- mock audio -- */
  shim.installMockAudio = function () {
    const rec = { nodes: [], params: [], started: 0, stopped: 0, contexts: 0 };
    shim.audioRecord = rec;
    function Param(v, name) {
      const p = {
        value: v, defaultValue: v, name: name || 'param', events: [],
        setValueAtTime(val, t) { p.value = val; p.events.push(['set', val, t]); return p; },
        linearRampToValueAtTime(val, t) { p.value = val; p.events.push(['linear', val, t]); return p; },
        exponentialRampToValueAtTime(val, t) { p.value = val; p.events.push(['exp', val, t]); return p; },
        setTargetAtTime(val, t, tc) { p.value = val; p.events.push(['target', val, t, tc]); return p; },
        setValueCurveAtTime(curve, t, d) { p.value = curve[curve.length - 1]; p.events.push(['curve', t, d]); return p; },
        cancelScheduledValues(t) { p.events.push(['cancel', t]); return p; },
        cancelAndHoldAtTime(t) { p.events.push(['cancelhold', t]); return p; }
      };
      rec.params.push(p);
      return p;
    }
    function node(type, extra) {
      const n = Object.assign({
        _type: type, _connections: [], _started: false,
        connect(dst) { this._connections.push(dst); return dst; },
        disconnect() { this._connections.length = 0; },
        addEventListener() { }, removeEventListener() { }
      }, extra || {});
      rec.nodes.push(n);
      return n;
    }
    function Ctx() {
      rec.contexts++;
      const ctx = {
        _type: 'AudioContext',
        sampleRate: 44100,
        state: 'suspended',
        destination: node('destination'),
        listener: {},
        get currentTime() { return shim.clock.t / 1000; },
        resume() { ctx.state = 'running'; return Promise.resolve(); },
        suspend() { ctx.state = 'suspended'; return Promise.resolve(); },
        close() { ctx.state = 'closed'; return Promise.resolve(); },
        createGain() { return node('gain', { gain: Param(1, 'gain') }); },
        createOscillator() {
          return node('oscillator', {
            type: 'sine', frequency: Param(440, 'frequency'), detune: Param(0, 'detune'),
            start(t) { this._started = true; rec.started++; this._t0 = t; },
            stop(t) { this._stopped = true; rec.stopped++; this._t1 = t; },
            setPeriodicWave() { }
          });
        },
        createBiquadFilter() { return node('biquad', { type: 'lowpass', frequency: Param(350, 'frequency'), Q: Param(1, 'Q'), gain: Param(0, 'gain') }); },
        createBufferSource() {
          return node('bufferSource', {
            buffer: null, loop: false, loopStart: 0, loopEnd: 0, playbackRate: Param(1, 'playbackRate'),
            start() { rec.started++; }, stop() { rec.stopped++; }
          });
        },
        createBuffer(ch, len, rate) { return { numberOfChannels: ch, length: len, sampleRate: rate, duration: len / rate, getChannelData: () => new Float32Array(len) }; },
        createDynamicsCompressor() {
          return node('compressor', {
            threshold: Param(-24, 'threshold'), knee: Param(30, 'knee'), ratio: Param(12, 'ratio'),
            attack: Param(0.003, 'attack'), release: Param(0.25, 'release'), reduction: 0
          });
        },
        createStereoPanner() { return node('panner', { pan: Param(0, 'pan') }); },
        createWaveShaper() { return node('shaper', { curve: null, oversample: 'none' }); },
        createDelay() { return node('delay', { delayTime: Param(0, 'delayTime') }); },
        createConvolver() { return node('convolver', { buffer: null }); },
        createChannelMerger() { return node('merger'); },
        createAnalyser() { return node('analyser', { fftSize: 2048, frequencyBinCount: 1024, getByteFrequencyData() { }, getByteTimeDomainData() { } }); },
        createScriptProcessor() { return node('scriptProcessor'); },
        createMediaElementSource() { return node('mediaElementSource'); },
        decodeAudioData() { return Promise.reject(new Error('mock')); },
        audioWorklet: { addModule: () => Promise.resolve() }
      };
      return ctx;
    }
    win.AudioContext = Ctx;
    win.webkitAudioContext = Ctx;
    shim.audioRecord = rec;
    return rec;
  };
  shim.removeMockAudio = function () {
    try { delete win.AudioContext; } catch (e) { }
    try { delete win.webkitAudioContext; } catch (e) { }
  };

  /* ---------------------------------------------------------- utilities */
  shim.createCanvas = (w, h) => { const c = new ShimCanvas(w, h, document); c._shim = shim; return c; };
  shim.document = document;
  shim.window = win;
  shim.setViewport = function (w, h) { win.innerWidth = w; win.innerHeight = h; win.outerWidth = w; win.outerHeight = h; };
  shim.makeGameCanvas = function (cssW, cssH) {
    const c = shim.createCanvas(384, 216);
    c.id = 'game';
    c._clientW = cssW || 1152;
    c._clientH = cssH || 648;
    c._rectX = 0; c._rectY = 0;
    document.body.appendChild(c);
    document._register(c);
    return c;
  };
  shim.capture = function (canvas) {
    const c = canvas || shim.gameCanvas;
    if (!c) throw new Error('shim.capture: no canvas');
    return { width: c._w, height: c._h, data: Uint8ClampedArray.from(c._buf) };
  };
  shim.toPNG = function (canvas) {
    const c = canvas || shim.gameCanvas;
    return encodePNG(c._w, c._h, c._buf);
  };
  shim.canvasStats = function (canvas) {
    const c = canvas || shim.gameCanvas;
    let distinct = new Set(), dom = new Map(), n = c._w * c._h;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const k = (c._buf[o] << 24) | (c._buf[o + 1] << 16) | (c._buf[o + 2] << 8) | c._buf[o + 3];
      if (distinct.size < 4096) distinct.add(k >>> 0);
      dom.set(k >>> 0, (dom.get(k >>> 0) || 0) + 1);
    }
    let best = 0; dom.forEach(v => { if (v > best) best = v; });
    return { distinct: distinct.size, dominantFrac: best / n };
  };

  /* ---------------------------------------------------------- uninstall */
  /* Everything this shim installed, so it can be re-installed if another
     createShim() ran in between and stole the globals (tools do that). */
  const OWNED_GLOBALS = [
    'window', 'self', 'document', 'navigator', 'location', 'history', 'screen', 'performance',
    'console', 'localStorage', 'sessionStorage', 'devicePixelRatio', 'innerWidth', 'innerHeight',
    'outerWidth', 'outerHeight', 'scrollX', 'scrollY', 'matchMedia', 'getComputedStyle',
    'alert', 'confirm', 'prompt', 'scrollTo', 'focus', 'open', 'close', 'Image', 'OffscreenCanvas',
    'ImageData', 'Path2D', 'DOMMatrix', 'CanvasRenderingContext2D', 'KeyboardEvent', 'MouseEvent',
    'TouchEvent', 'Event', 'CustomEvent', 'Audio', 'fetch', 'XMLHttpRequest', 'WebSocket',
    'requestAnimationFrame', 'cancelAnimationFrame', 'addEventListener', 'removeEventListener',
    'dispatchEvent', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'
  ];
  const ownedSnapshot = {};
  for (const k of OWNED_GLOBALS) { try { ownedSnapshot[k] = globalThis[k]; } catch (e) { } }
  shim.ownedGlobals = OWNED_GLOBALS;
  shim.installGlobals = function () {
    for (const k of OWNED_GLOBALS) {
      if (ownedSnapshot[k] !== undefined) setGlobal(k, ownedSnapshot[k]);
    }
    return shim;
  };

  shim.uninstall = function () {
    if (opts.deterministicRandom !== false) { try { Math.random = origRandom; } catch (e) { } }
    try { globalThis.console = realConsole; } catch (e) { }
    try { win.fetch = origFetch; } catch (e) { }
    shim.restoreRealTime();
  };

  return shim;
}
