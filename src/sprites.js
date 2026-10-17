/* ==========================================================================
 * NEON DRIFT '86  —  src/sprites.js
 * 100% procedural pixel art.  Nothing is ever loaded from disk or network:
 * every sprite is painted at boot into an offscreen canvas, pixel by pixel,
 * from hand-authored pixel-map strings plus a small parametric painter used
 * for the organic shapes (palm fronds, fir tiers, explosions, arches).
 *
 *   - hard edges only: every mark is an integer fillRect on a 1px grid,
 *     plus a 1px ink outline stamped around each silhouette so scenery reads
 *     against the sunset / night / dawn skies alike
 *   - no shadowBlur, no gradients, no anti-aliased curves, no text fonts
 *   - the module top level touches no DOM: everything happens in init()
 *   - missing/broken canvas support degrades to get() -> null, never throws
 *
 * Exposes the single global SPRITES.  Requires CORE (loaded first).
 * ========================================================================== */
var SPRITES = (function () {
  'use strict';

  var OUTLINE = '#100a18';   /* one ink for every silhouette */

  var reg = {};              /* name -> {canvas,w,h,anchor} */
  var order = [];            /* registration order */
  var inited = false;

  /* ====================================================================== *
   *  1. colour helpers
   * ====================================================================== */

  var INK_RGB = [0x10, 0x0a, 0x18];

  function hex2rgb(h) {
    var s = String(h === undefined || h === null ? '#000000' : h).replace(/^\s*#/, '');
    if (s.length === 3) {
      s = s.charAt(0) + s.charAt(0) + s.charAt(1) + s.charAt(1) + s.charAt(2) + s.charAt(2);
    }
    var n = parseInt(s, 16);
    if (!isFinite(n)) { n = 0; }
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function hex2(v) {
    var s = Math.round(v);
    if (s < 0) { s = 0; }
    if (s > 255) { s = 255; }
    var t = s.toString(16);
    return t.length < 2 ? '0' + t : t;
  }

  function rgb2hex(r, g, b) { return '#' + hex2(r) + hex2(g) + hex2(b); }

  /* amt < 0 shades toward the outline ink, amt > 0 toward white */
  function shade(hex, amt) {
    var c = hex2rgb(hex), i, out = [];
    if (amt < 0) {
      for (i = 0; i < 3; i++) { out[i] = c[i] + (INK_RGB[i] - c[i]) * (-amt); }
    } else {
      for (i = 0; i < 3; i++) { out[i] = c[i] + (255 - c[i]) * amt; }
    }
    return rgb2hex(out[0], out[1], out[2]);
  }

  function mix(a, b, t) {
    var ca = hex2rgb(a), cb = hex2rgb(b), i, out = [];
    for (i = 0; i < 3; i++) { out[i] = ca[i] + (cb[i] - ca[i]) * t; }
    return rgb2hex(out[0], out[1], out[2]);
  }

  function rgba(hex, a) {
    var c = hex2rgb(hex);
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
  }

  /* average of one field across all three stage themes (used to keep scenery
     harmonised with CORE.THEMES without giving it a per-theme variant) */
  function themeAvg(field, amt) {
    var keys = ['sunset', 'night', 'dawn'], r = 0, g = 0, b = 0, i, c, n = 0, th;
    if (typeof CORE === 'undefined' || !CORE || !CORE.THEMES) { return '#808080'; }
    for (i = 0; i < keys.length; i++) {
      th = CORE.THEMES[keys[i]];
      if (!th || !th[field]) { continue; }
      c = hex2rgb(th[field]);
      r += c[0]; g += c[1]; b += c[2]; n++;
    }
    if (!n) { return '#808080'; }
    return shade(rgb2hex(r / n, g / n, b / n), amt || 0);
  }

  function themeColor(key, field, amt) {
    var th;
    if (typeof CORE === 'undefined' || !CORE || !CORE.THEMES) { return '#808080'; }
    th = CORE.THEMES[key];
    if (!th || !th[field]) { return '#808080'; }
    return shade(th[field], amt || 0);
  }

  /* ====================================================================== *
   *  2. canvas + painter
   * ====================================================================== */

  function newSurface(w, h) {
    var cv = null, g = null;
    try {
      if (typeof CORE !== 'undefined' && CORE && typeof CORE.makeCanvas === 'function') {
        cv = CORE.makeCanvas(w, h);
      }
    } catch (e) { cv = null; }
    if (!cv) { return null; }
    try {
      if (typeof cv.getContext !== 'function') { return null; }
      g = cv.getContext('2d');
      if (!g || typeof g.fillRect !== 'function') { return null; }
      g.imageSmoothingEnabled = false;
    } catch (e2) { return null; }
    return { canvas: cv, g: g };
  }

  /* A painter is a small integer grid with a parallel coverage mask, so the
     ink outline can be stamped around the union of everything drawn. */
  function Painter(w, h, opts) {
    opts = opts || {};
    this.w = Math.max(1, w | 0);
    this.h = Math.max(1, h | 0);
    this.pad = opts.outline ? 1 : 0;
    this.ink = opts.outline || null;
    var s = newSurface(this.w + this.pad * 2, this.h + this.pad * 2);
    this.surf = s;
    this.g = s ? s.g : null;
    this.cv = s ? s.canvas : null;
    this.mask = new Array(this.w * this.h);
  }

  Painter.prototype.px = function (x, y, col) {
    x = Math.round(x); y = Math.round(y);
    if (!this.g || !col || x < 0 || y < 0 || x >= this.w || y >= this.h) { return; }
    this.g.fillStyle = col;
    this.g.fillRect(x + this.pad, y + this.pad, 1, 1);
    this.mask[y * this.w + x] = 1;
  };

  Painter.prototype.fill = function (x, y, w, h, col) {
    if (!this.g || !col) { return; }
    x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
    var x0 = x < 0 ? 0 : x, y0 = y < 0 ? 0 : y;
    var x1 = x + w > this.w ? this.w : x + w, y1 = y + h > this.h ? this.h : y + h;
    if (x1 <= x0 || y1 <= y0) { return; }
    this.g.fillStyle = col;
    this.g.fillRect(x0 + this.pad, y0 + this.pad, x1 - x0, y1 - y0);
    var i, j;
    for (j = y0; j < y1; j++) {
      for (i = x0; i < x1; i++) { this.mask[j * this.w + i] = 1; }
    }
  };

  /* checkerboard fill — the 1986 way of faking transparency */
  Painter.prototype.dither = function (x, y, w, h, col, phase) {
    if (!this.g || !col) { return; }
    x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
    phase = phase || 0;
    var i, j;
    for (j = 0; j < h; j++) {
      for (i = 0; i < w; i++) {
        if (((x + i + y + j + phase) & 1) === 0) { this.px(x + i, y + j, col); }
      }
    }
  };

  /* a 1px frame around a box (inside the box) */
  Painter.prototype.frame = function (x, y, w, h, col) {
    this.fill(x, y, w, 1, col);
    this.fill(x, y + h - 1, w, 1, col);
    this.fill(x, y, 1, h, col);
    this.fill(x + w - 1, y, 1, h, col);
  };

  /* stamped pixel-map:  rows[y] is a string of single-char colour keys.
     Runs of one key collapse into a single fillRect;  clip = {x0,x1} trims
     columns in destination space (used to foreshorten the player car). */
  Painter.prototype.map = function (rows, pal, ox, oy, clip) {
    if (!this.g) { return; }
    ox = Math.round(ox || 0); oy = Math.round(oy || 0);
    var j, i, k, col, row, y, rx, rw, lo, hi;
    lo = clip && clip.x0 !== undefined ? clip.x0 : -1e9;
    hi = clip && clip.x1 !== undefined ? clip.x1 : 1e9;
    for (j = 0; j < rows.length; j++) {
      y = oy + j;
      if (y < 0 || y >= this.h) { continue; }
      row = rows[j];
      i = 0;
      while (i < row.length) {
        col = pal[row.charAt(i)];
        if (!col) { i++; continue; }
        k = i;
        while (k < row.length && pal[row.charAt(k)] === col) { k++; }
        rx = ox + i; rw = k - i;
        if (rx < lo) { rw -= (lo - rx); rx = lo; }
        if (rx + rw > hi + 1) { rw = hi + 1 - rx; }
        if (rw > 0) { this.fill(rx, y, rw, 1, col); }
        i = k;
      }
    }
  };

  Painter.prototype.stroke = function (col) {
    if (!this.g || !col) { return; }
    this.g.fillStyle = col;
    var w = this.w, h = this.h, m = this.mask, x, y, i;
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        i = y * w + x;
        if (m[i]) { continue; }
        if ((x > 0 && m[i - 1]) || (x < w - 1 && m[i + 1]) ||
            (y > 0 && m[i - w]) || (y < h - 1 && m[i + w])) {
          this.g.fillRect(x + this.pad, y + this.pad, 1, 1);
        }
      }
    }
  };

  Painter.prototype.finish = function (anchor) {
    if (!this.cv) { return null; }
    if (this.ink) { try { this.stroke(this.ink); } catch (e) { /* keep the art */ } }
    return {
      canvas: this.cv, w: this.cv.width, h: this.cv.height,
      anchor: anchor || { x: 0.5, y: 1 }
    };
  };

  /* ====================================================================== *
   *  3. pixel-map helpers
   * ====================================================================== */

  function rev(s) {
    var o = '', i;
    for (i = s.length - 1; i >= 0; i--) { o += s.charAt(i); }
    return o;
  }

  /* mirror a half-width sketch into a full symmetric map:
     sym(rows) -> half + reverse(half);  sym(rows, c) -> half + c + reverse(half) */
  function sym(rows, c) {
    var out = [], i, h;
    for (i = 0; i < rows.length; i++) {
      h = rows[i];
      out.push(c === undefined || c === null ? h + rev(h) : h + c + rev(h));
    }
    return out;
  }

  function flip(rows) {
    var out = [], i;
    for (i = 0; i < rows.length; i++) { out.push(rev(rows[i])); }
    return out;
  }

  /* ====================================================================== *
   *  4. palettes
   * ====================================================================== */

  /* Player car: works-livery red with a cream stripe.  A saturated body is
     what makes a 48px sprite read at a glance — white/silver turns to mush
     once the renderer scales it down. */
  var HERO_PAL = {
    k: OUTLINE,
    D: '#6d0e1d', d: '#a8172f', b: '#e01f3a', h: '#f04a5f', H: '#ff8f9c',
    w: '#1a1226', W: '#3d4d8a',
    t: '#111119', T: '#34343f',
    r: '#9c0f22', R: '#ff5a68', g: '#ffb020',
    c: '#dce0ea', C: '#666b7a',
    x: '#0c0912',
    m: '#f5efe0', n: '#22e0ff', y: '#ffd23f'
  };

  var HERO_PAL_BRAKE = (function () {
    var p = {}, key;
    for (key in HERO_PAL) {
      if (Object.prototype.hasOwnProperty.call(HERO_PAL, key)) { p[key] = HERO_PAL[key]; }
    }
    p.r = '#ff3b4a'; p.R = '#ffd6da'; p.g = '#ffe08a';
    return p;
  })();

  function carPal(base, accent) {
    return {
      k: OUTLINE,
      D: shade(base, -0.60), d: shade(base, -0.36), b: base,
      h: shade(base, 0.16), H: shade(base, 0.40),
      w: '#171232', W: '#2c3c72',
      t: '#111119', T: '#34343f',
      r: '#c8102e', R: '#ff5568', g: '#ff97a4',
      c: '#a9aebd', C: '#5c6272',
      x: '#0c0912', y: '#ffd23f',
      m: accent || '#ff2fb9', n: '#22e0ff'
    };
  }

  /* ====================================================================== *
   *  5. player car — rear 3/4, 48 x 27
   * ====================================================================== */

  var H_W = 48, H_H = 27;

  /* roof panel (half width 8 -> 16) */
  var H_ROOF = sym([
    '...kkkkk',
    '..kdbbbm'
  ]);

  /* cabin: dark rear window in a trapezoid, sky sheen along the top edge,
     C-pillars widening downward into the rear fenders (half 12 -> 24) */
  var H_WINDOW = sym([
    '.....kkkkkkk',
    '...kkddWWWWW',
    '..kdddWWWWWW',
    '..kddwWWWWWW',
    '.kddwwwwWWWW',
    '.kdddddddddd'
  ]);

  /* rear wing blade, lit top edge + livery band (half 18 -> 36).
     Endplates and posts are added by the composer so they can lean. */
  var H_WING = sym([
    '..kkkkkkkkkkkkkkkk',
    '..kdHHbbmmmmmmbbbb',
    '..kDDDDDDDDDDDDDDD'
  ]);

  /* engine deck: lit lip over a louvred cover (half 20 -> 40) */
  var H_DECK = sym([
    '.....kkkkkkkkkkkkkkk',
    '...kkhhhhbbbbbbbbbbb',
    '...kkddbbmmmmmmbbbbb',
    '..kkddbbbbbbbbbbbbbb',
    '..kkkkkkkkkkkkkkkkkk'
  ]);

  /* tail panel (half 22 -> 44): a chunky vertical lens at each corner and a
     slatted black engine grille down the middle — the 1986 read. */
  var H_TAIL = sym([
    '...kkkkkkkkkkkkkkkkkkk',
    '...kddhhhhhhhhhhhhhhhh',
    '...kddrrrrrkkkkkkkkkkk',
    '...kddRRRRRDDDDDDDDDDD',
    '...kddRRRRRkkkkkkkkkkk',
    '...kddRRRRRDDDDDDDDDDD',
    '...kddrrrrrkkkkkkkkkkk',
    '...kkddddddddddddddddd'
  ]);

  /* bumper + valance (half 22 -> 44), inset by the composer so the rear
     tyres stay visible either side of it */
  var H_LOWER = sym([
    '...kkkkkkkkkkkkkkkkkkk',
    '...kccccccccccccccccccc',
    '...kCCCCCCCCCCCCCCCCCCC',
    '...kkkkkkkkkkkkkkkkkkk',
    '....kkddddddddddddddddd',
    '.....kkkkkkkkkkkkkkkkkk'
  ]);

  /* tyre, 13 x 12 (half 6 + centre column) */
  var H_WHEEL = sym([
    '...kkk',
    '..kktt',
    '.kkttt',
    '.ktttt',
    'kTTttt',
    'kTTttt',
    'kTTttt',
    'kTTttt',
    'kTTttt',
    'kTtttt',
    '.ktttt',
    '..kktt'
  ], 't');

  /* The exposed left flank for the steering frames — the only asymmetric
     sketch.  It is a full-bleed side panel: the body is stamped on top of its
     right half, so only the outer 10-13 px ever show.  Bottom rows are the
     open wheel arch (transparent, so the tyre underneath reads through). */
  var FLANK_W = 24, FLANK_H = 22;
  var FLANK_X = 1, FLANK_Y = 2;
  var H_FLANK = [
    '....................kkkk',
    '................kkkkbbbb',
    '............kkkkbbbbbbbb',
    '........kkkkbbbbbbbbbbbb',
    '....kkkkbbbbbbbbbbbbbbbb',
    '..kkdbbbbbbbbbbbbbbbbbbb',
    '.kddbbbbbbbbbbbbbbbbbbbb',
    '.kdwwwwwwwwwwwbbbbbbbbbb',
    '.kdwwwwwwwwwwwbbbbbbbbbb',
    '.kdwwwwwwwwwwwbbbbbbbbbb',
    '.kddwwwwwwwwwwbbbbbbbbbb',
    '.kddddddddddddbbbbbbbbbb',
    '.kdhbbbbbbbbbbbbbbbbbbbb',
    '.kdhbbbbbbbbbbbbbbbbbbbb',
    '.kdhbbbbbbbbbbbbbbbbbbbb',
    '.kddbbbbbbbbbbbbbbbbbbbb',
    '.kkkkkkkkkkkkkkkkkkkkkkk',
    '........................',
    '........................',
    '........................',
    '........................',
    '........................'
  ];

  function clipAnd(a, b) {
    return {
      x0: Math.max(a.x0 === undefined ? -1e9 : a.x0, b.x0 === undefined ? -1e9 : b.x0),
      x1: Math.min(a.x1 === undefined ? 1e9 : a.x1, b.x1 === undefined ? 1e9 : b.x1)
    };
  }

  /* the whole car, parameterised by lean: -1 = steering left (we see the
     left flank, rear face pushed right and foreshortened), 0 = straight,
     +1 = right.  brake adds weight transfer + a hot light bloom. */
  function heroCar(lean, brake) {
    var pal = brake ? HERO_PAL_BRAKE : HERO_PAL;
    var p = new Painter(H_W, H_H, { outline: OUTLINE });
    var turn = lean === 0 ? 0 : (lean < 0 ? -1 : 1);
    var lift = brake ? 1 : 0;                 /* nose dives, tail rises */
    var dx = turn === 0 ? 0 : turn * -6;      /* rear face slides opposite the turn */
    var topShift = turn === 0 ? 0 : turn * -2;/* upper body leans out of the turn */
    var clip = {
      x0: turn === 0 ? -1e9 : (turn < 0 ? 11 : 2),
      x1: turn === 0 ? 1e9 : (turn < 0 ? 46 : 37)
    };
    var lowClip = clipAnd(clip, { x0: 7 + dx, x1: 40 + dx });
    var cx = 24 + dx;
    var i, wx;

    /* --- wheels first: the fenders overlap them --- */
    for (i = 0; i < 2; i++) {
      p.map(i === 0 ? H_WHEEL : flip(H_WHEEL), pal, i === 0 ? 0 : H_W - 13, 15, null);
    }

    /* --- exposed flank (right turn = mirrored art on the right edge) --- */
    if (turn !== 0) {
      p.map(turn < 0 ? H_FLANK : flip(H_FLANK), pal,
        turn < 0 ? FLANK_X : H_W - FLANK_X - FLANK_W, FLANK_Y, null);
    }

    /* --- wing: endplates + posts are placed by hand so they lean with the car.
       One row of sky shows between blade and deck, the way a real wing sits. */
    p.fill(5 + dx + topShift, 4 - lift, 2, 7, pal.d);
    p.fill(41 + dx + topShift, 4 - lift, 2, 7, pal.d);
    p.px(5 + dx + topShift, 4 - lift, pal.H);
    p.px(42 + dx + topShift, 4 - lift, pal.H);

    /* --- body, bottom to top --- */
    p.map(H_LOWER, pal, 2 + dx, 21 - lift, lowClip);
    p.map(H_TAIL, pal, 2 + dx, 13 - lift, clip);
    p.map(H_DECK, pal, 4 + dx, 9 - lift, clip);
    p.map(H_WING, pal, 6 + dx + topShift, 5 - lift, clip);
    p.fill(13 + dx + topShift, 8 - lift, 2, 2, pal.d);
    p.fill(33 + dx + topShift, 8 - lift, 2, 2, pal.d);
    /* louvres across the engine cover */
    p.fill(9 + dx, 11 - lift, 30, 1, pal.d);
    p.fill(9 + dx, 12 - lift, 30, 1, pal.d);
    p.map(H_WINDOW, pal, 12 + dx + topShift, 2 - lift, clip);
    p.map(H_ROOF, pal, 16 + dx + topShift, 0 - lift, clip);

    /* --- trim: plate, exhausts, third brake light --- */
    p.fill(cx - 5, 22 - lift, 10, 3, pal.h);
    p.frame(cx - 5, 22 - lift, 10, 3, pal.k);
    p.fill(cx - 4, 23 - lift, 8, 1, pal.d);
    p.fill(cx - 15, 24 - lift, 5, 2, pal.x);
    p.fill(cx + 10, 24 - lift, 5, 2, pal.x);
    p.fill(cx - 15, 24 - lift, 5, 1, pal.c);
    p.fill(cx + 10, 24 - lift, 5, 1, pal.c);
    p.fill(cx - 4, 13 - lift, 8, 1, brake ? pal.R : pal.r);
    p.px(cx - 5, 13 - lift, pal.k);
    p.px(cx + 4, 13 - lift, pal.k);

    /* --- brake bloom, over the body, around both clusters --- */
    if (brake) {
      p.dither(cx - 19, 13 - lift, 15, 9, rgba(pal.R, 0.40), 0);
      p.dither(cx + 4, 13 - lift, 15, 9, rgba(pal.R, 0.40), 0);
    }

    return p;
  }

  /* soft contact shadow, 46 x 12, dithered ellipse */
  function heroShadow() {
    var w = 46, h = 12, p = new Painter(w, h, {});
    var y, x, half, t, col;
    for (y = 0; y < h; y++) {
      t = (y - (h - 1) / 2) / ((h - 1) / 2);
      half = Math.round((w / 2 - 1) * Math.sqrt(Math.max(0, 1 - t * t)));
      for (x = -half; x <= half; x++) {
        col = Math.abs(x) > half - 3 ? rgba('#000000', 0.20) : rgba('#000000', 0.42);
        if (Math.abs(x) > half - 3 && ((x + y) & 1)) { continue; }
        p.px(w / 2 + x, y, col);
      }
    }
    return p;
  }

  /* ====================================================================== *
   *  6. traffic — rear view hatchbacks, saloons, vans + two trucks
   * ====================================================================== */

  function paintCar(p, spec, pal) {
    var W = spec.w, H = spec.h;
    var cx = W / 2;
    var bodyX = spec.inset, bodyW = W - spec.inset * 2;
    var feet = H - 1;
    var wheelW = spec.wheelW, wheelH = spec.wheelH;
    var lowerTop = H - spec.lower;
    var tailTop = lowerTop - 5;
    var deckTop = tailTop - spec.deck;
    var cabBot = deckTop - 1;
    var cabTop = cabBot - spec.cab + 1;
    var i, r, half, lit;
    var wl;

    /* wheels (under the body) */
    for (i = 0; i < 2; i++) {
      wl = i === 0 ? 0 : W - wheelW;
      p.fill(wl, H - wheelH, wheelW, wheelH, pal.t);
      p.fill(wl + (i === 0 ? 0 : wheelW - 2), H - wheelH + 1, 2, wheelH - 2, pal.T);
      p.fill(wl + 1, feet - 1, wheelW - 2, 2, pal.t);
      p.fill(wl + (i === 0 ? 1 : 0), feet, wheelW - 1, 1, pal.k);
      p.fill(wl + (i === 0 ? 0 : wheelW - 1), H - wheelH + 1, 1, wheelH - 1, pal.k);
    }

    /* lower valance + bumper */
    p.fill(bodyX, lowerTop, bodyW, feet - lowerTop + 1, pal.x);
    p.fill(bodyX + 1, lowerTop + 1, bodyW - 2, 2, pal.c);
    p.fill(bodyX + 1, lowerTop + 3, bodyW - 2, 1, pal.C);
    p.fill(bodyX + 2, feet - 1, 3, 1, pal.C);
    p.fill(W - bodyX - 5, feet - 1, 3, 1, pal.C);
    p.fill(bodyX, lowerTop, bodyW, 1, pal.k);
    /* licence plate */
    p.fill(cx - 4, feet - 3, 8, 3, pal.h);
    p.frame(cx - 4, feet - 3, 8, 3, pal.k);
    p.fill(cx - 3, feet - 2, 6, 1, pal.d);

    /* tail panel: shoulders + light clusters + centre seam */
    p.fill(bodyX, tailTop, bodyW, 5, pal.b);
    p.fill(bodyX + 1, tailTop, bodyW - 2, 1, pal.h);
    p.fill(bodyX, tailTop + 4, bodyW, 1, pal.d);
    p.fill(bodyX, tailTop, 1, 5, pal.d);
    p.fill(bodyX + bodyW - 1, tailTop, 1, 5, pal.d);
    for (i = 0; i < 2; i++) {
      lit = i === 0 ? bodyX + 2 : W - bodyX - 2 - spec.light;
      p.fill(lit, tailTop + 1, spec.light, 3, pal.r);
      p.fill(lit, tailTop + 1, spec.light, 1, pal.R);
      p.fill(lit, tailTop + 3, spec.light, 1, pal.k);
      p.fill(lit + spec.light - 1, tailTop + 1, 1, 3, pal.k);
      p.fill(lit - 1, tailTop + 1, 1, 3, pal.k);
    }
    p.fill(cx - 1, tailTop + 1, 2, 3, pal.d);

    /* deck / boot lid */
    p.fill(bodyX + 2, deckTop, bodyW - 4, spec.deck + 1, pal.b);
    p.fill(bodyX + 3, deckTop, bodyW - 6, 1, pal.h);
    p.fill(bodyX + 2, deckTop + spec.deck, bodyW - 4, 1, pal.d);
    p.fill(bodyX + 2, deckTop, 1, spec.deck + 1, pal.d);
    p.fill(bodyX + bodyW - 3, deckTop, 1, spec.deck + 1, pal.d);

    /* cabin: pillars + glass trapezoid */
    for (r = 0; r < spec.cab; r++) {
      var y = cabTop + r;
      var tt = spec.cab <= 1 ? 1 : r / (spec.cab - 1);
      half = Math.round((spec.cabW + (spec.roofW - spec.cabW) * tt) / 2);
      p.fill(cx - half, y, half * 2, 1, pal.b);
      p.fill(cx - half, y, 1, 1, pal.d);
      p.fill(cx + half - 1, y, 1, 1, pal.d);
      if (r > 0 && r < spec.cab - 1) {
        var gw = half - 2;
        if (gw > 1) {
          p.fill(cx - gw, y, gw * 2, 1, pal.w);
          p.fill(cx - gw, y, 1, 1, pal.d);
          p.fill(cx + gw - 1, y, 1, 1, pal.d);
          if (r < spec.cab / 2) { p.fill(cx - gw + 1, y, Math.max(1, gw - 1), 1, pal.W); }
        }
      }
    }
    /* roof line */
    p.fill(cx - Math.round(spec.roofW / 2), cabTop, spec.roofW, 1, pal.h);
    p.fill(cx - Math.round(spec.roofW / 2) + 1, cabTop - 1, spec.roofW - 2, 1, pal.b);

    /* optional rear wing */
    if (spec.wing) {
      var wy = deckTop + 1;
      var ww2 = Math.round(W * 0.34);
      p.fill(cx - ww2, wy, ww2 * 2, 2, pal.d);
      p.fill(cx - ww2, wy, ww2 * 2, 1, pal.h);
      p.fill(cx - ww2, wy + 2, 2, Math.max(1, cabBot - wy - 1), pal.d);
      p.fill(cx + ww2 - 2, wy + 2, 2, Math.max(1, cabBot - wy - 1), pal.d);
    }

    /* panel seams + wheel arches */
    p.fill(bodyX + 1, tailTop - 1, bodyW - 2, 1, pal.d);
    p.fill(0, H - wheelH - 1, wheelW + 1, 1, pal.d);
    p.fill(W - wheelW - 1, H - wheelH - 1, wheelW + 1, 1, pal.d);
    return p;
  }

  function paintTruck(p, spec, pal) {
    var W = spec.w, H = spec.h;
    var cx = W / 2;
    var boxX = 2, boxW = W - 4;
    var feet = H - 1;
    var boxBot = feet - spec.chassis;
    var boxH = boxBot - spec.top + 1;
    var wheelW = spec.wheelW, wheelH = spec.wheelH;
    var i, x, wl, dy;

    /* dual rear wheels */
    for (i = 0; i < 2; i++) {
      wl = i === 0 ? 0 : W - wheelW * 2 - 1;
      p.fill(wl, H - wheelH, wheelW * 2, wheelH, pal.t);
      p.fill(wl + wheelW - 1, H - wheelH, 2, wheelH, pal.x);
      p.fill(wl + 1, feet - 1, wheelW * 2 - 2, 2, pal.t);
      p.fill(wl + (i === 0 ? 0 : wheelW * 2 - 1), H - wheelH + 1, 1, wheelH - 1, pal.k);
    }

    /* chassis + mudflaps + bumper */
    p.fill(boxX, boxBot, boxW, feet - boxBot + 1, pal.x);
    p.fill(1, feet - 2, 5, 3, pal.x);
    p.fill(W - 6, feet - 2, 5, 3, pal.x);
    p.fill(boxX + 1, feet - 4, boxW - 2, 2, pal.c);
    p.fill(boxX + 1, feet - 2, boxW - 2, 1, pal.C);
    p.fill(boxX + 2, feet - 3, 4, 1, pal.r);
    p.fill(W - boxX - 6, feet - 3, 4, 1, pal.r);

    /* cargo box */
    p.fill(boxX, spec.top, boxW, boxH, pal.b);
    p.fill(boxX, spec.top, boxW, 1, pal.h);
    p.fill(boxX, spec.top + 1, boxW, 1, pal.h);
    p.fill(boxX, boxBot - 1, boxW, 1, pal.d);
    p.fill(boxX, spec.top, 1, boxH, pal.d);
    p.fill(boxX + boxW - 1, spec.top, 1, boxH, pal.d);

    /* vertical ribs */
    for (x = boxX + 5; x < boxX + boxW - 5; x += 6) {
      p.fill(x, spec.top + 2, 1, boxH - 3, pal.d);
      p.fill(x + 1, spec.top + 2, 1, boxH - 3, pal.h);
    }

    /* roller shutter door */
    dy = spec.top + 3;
    p.fill(cx - 8, dy, 16, boxH - 6, mix(pal.b, '#ffffff', 0.10));
    p.frame(cx - 8, dy, 16, boxH - 6, pal.d);
    for (i = dy + 2; i < dy + boxH - 7; i += 2) {
      p.fill(cx - 7, i, 14, 1, pal.d);
      p.fill(cx - 7, i + 1, 14, 1, mix(pal.b, '#ffffff', 0.22));
    }
    p.fill(cx - 2, boxBot - 6, 4, 2, pal.C);

    /* marker lights along the roof */
    for (i = 0; i < spec.markers; i++) {
      x = Math.round(boxX + 4 + i * ((boxW - 8) / (spec.markers - 1)));
      p.fill(x, spec.top + 1, 2, 1, pal.y);
    }
    return p;
  }

  /* ====================================================================== *
   *  7. scenery
   * ====================================================================== */

  /* palette shared by the foliage sprites — lifted from CORE.THEMES so the
     verge belongs to the same world as the road */
  function foliagePal() {
    var base = mix('#1d6b3a', themeAvg('grassLight', 0.10), 0.30);
    return {
      k: OUTLINE,
      b: base,
      l: shade(base, 0.26),
      L: shade(base, 0.46),
      d: shade(base, -0.34),
      D: shade(base, -0.55),
      t: mix('#6b4526', themeAvg('grassDark', 0.05), 0.22),
      T: '#8a5c33',
      u: '#3d2716'
    };
  }

  function stonePal() {
    var base = mix('#6d6259', themeAvg('roadDark', 0.25), 0.35);
    return {
      k: OUTLINE,
      b: base,
      l: shade(base, 0.22),
      h: shade(base, 0.40),
      d: shade(base, -0.30),
      D: shade(base, -0.52),
      s: mix('#8e8377', base, 0.35)
    };
  }

  function metalPal() {
    return {
      k: OUTLINE,
      b: '#3a3f52', l: '#565d74', h: '#7d86a3',
      d: '#252a3a', D: '#14161f',
      y: '#ffd23f', o: '#ff8a1e',
      n: '#22e0ff', m: '#ff2fb9', w: '#f4f7ff'
    };
  }

  /* --- palm: curved trunk (parametric) + 9 fronds (parametric lanes) ----- */
  function paintPalm(p, pal) {
    var W = 48, H = 96, cx = 24, i, y, t, x, half;
    var baseX = 25, topX = 21, topY = 26;

    /* trunk: tapers, drifts, rings every 4px */
    for (y = H - 1; y >= topY; y--) {
      t = (H - 1 - y) / (H - 1 - topY);
      x = Math.round(baseX + (topX - baseX) * Math.pow(t, 1.35) + 2.2 * Math.sin(t * 2.2));
      half = Math.max(1, Math.round(3.2 - 1.9 * t));
      p.fill(x - half, y, half * 2, 1, pal.t);
      p.fill(x - half, y, 1, 1, pal.u);
      p.fill(x + half - 1, y, 1, 1, pal.u);
      if ((y % 4) === 1) { p.fill(x - half, y, half * 2, 1, pal.u); }
      else { p.px(x - half + 1, y, pal.T); }
    }
    /* root flare */
    p.fill(baseX - 5, H - 3, 11, 3, pal.t);
    p.fill(baseX - 6, H - 1, 13, 1, pal.u);

    /* fronds: an outer ring of long ones, then a shorter inner ring in front
       for density — every one droops under its own weight */
    var F = [
      [Math.PI * 0.04, 19, 1.25, 1.9],
      [Math.PI * 0.30, 20, 1.00, 2.0],
      [Math.PI * 0.58, 19, 0.72, 1.9],
      [Math.PI * 0.86, 17, 0.45, 1.7],
      [Math.PI * 1.14, 17, 0.42, 1.7],
      [Math.PI * 1.42, 19, 0.72, 1.9],
      [Math.PI * 1.70, 20, 1.00, 2.0],
      [Math.PI * 1.96, 19, 1.25, 1.9],
      [Math.PI * 0.18, 13, 0.70, 1.5],
      [Math.PI * 0.70, 12, 0.35, 1.4],
      [Math.PI * 1.30, 12, 0.35, 1.4],
      [Math.PI * 1.82, 13, 0.70, 1.5]
    ];
    for (i = 0; i < F.length; i++) {
      frond(p, topX - 1, topY + 1, F[i][0], F[i][1], F[i][2], F[i][3], pal);
    }
    /* crown knot + coconuts */
    p.fill(topX - 3, topY - 1, 6, 4, pal.d);
    p.px(topX - 4, topY + 3, pal.u); p.px(topX - 3, topY + 3, pal.t);
    p.px(topX + 2, topY + 4, pal.u); p.px(topX + 3, topY + 4, pal.t);
    p.px(topX - 1, topY + 5, pal.u);
    return p;
  }

  /* one palm frond: spine + leaflets drawn perpendicular to it, drooping */
  function frond(p, x0, y0, ang, len, curve, fat, pal) {
    var i, t, sx, sy, nx, ny, w, k, dx, dy;
    var ca = Math.cos(ang), sa = Math.sin(ang);
    for (i = 0; i <= len; i++) {
      t = i / Math.max(1, len);
      dx = ca * i;
      dy = -sa * i + curve * t * t * len * 0.22;
      sx = x0 + dx; sy = y0 + dy;
      w = Math.max(0, Math.round(fat * 3.1 * Math.sin(Math.PI * Math.pow(t, 0.62))));
      nx = -sa; ny = ca;
      for (k = -w; k <= w; k++) {
        var col = k < 0 ? pal.l : (k > w - 2 && w > 1 ? pal.d : pal.b);
        p.px(Math.round(sx + nx * k), Math.round(sy + ny * k), col);
      }
      if (i % 3 === 0) { p.px(Math.round(sx), Math.round(sy), pal.L); }
      if (i % 4 === 0 && w > 0) { p.px(Math.round(sx + nx * (-w - 1)), Math.round(sy + ny * (-w - 1)), pal.L); }
    }
  }

  /* --- fir / pine: stacked jagged tiers ---------------------------------- */
  function paintPine(p, pal) {
    var W = 40, H = 76, cx = 20, i, y, half, t, j;
    var tiers = [[6, 22], [16, 34], [27, 46], [38, 57], [49, 68]];
    /* trunk */
    p.fill(cx - 3, H - 14, 6, 14, pal.t);
    p.fill(cx - 3, H - 14, 1, 14, pal.u);
    p.fill(cx + 2, H - 14, 1, 14, pal.u);
    p.fill(cx - 5, H - 2, 10, 2, pal.t);
    for (i = 0; i < tiers.length; i++) {
      var y0 = tiers[i][0], y1 = tiers[i][1];
      for (y = y0; y <= y1; y++) {
        t = (y - y0) / Math.max(1, y1 - y0);
        half = Math.round(1.5 + t * (4.5 + i * 1.6) + (((y * 7 + i * 3) % 3) - 1) * 0.6);
        if (half < 1) { half = 1; }
        p.fill(cx - half, y, half * 2, 1, i % 2 ? pal.b : pal.d);
        for (j = 0; j < 2; j++) {
          p.px(cx - half + j, y, pal.l);
          p.px(cx + half - 1 - j, y, pal.D);
        }
      }
      /* skirt shadow under each tier */
      p.fill(cx - Math.round(2 + i * 1.2), y1 + 1, Math.round(4 + i * 2.4), 1, pal.D);
    }
    /* tip */
    p.fill(cx - 1, 2, 2, 5, pal.L);
    p.px(cx, 1, pal.k);
    return p;
  }

  /* --- saguaro ---------------------------------------------------------- */
  function paintCactus(p, pal) {
    var W = 32, H = 64, cx = 15, i, y;
    var green = mix('#2f7d4a', themeAvg('grassLight', 0.12), 0.25);
    var lit = shade(green, 0.30), dark = shade(green, -0.36), deep = shade(green, -0.58);

    /* core column */
    p.fill(cx - 4, 6, 9, H - 6, green);
    p.fill(cx - 4, 6, 2, H - 6, lit);
    p.fill(cx + 3, 6, 2, H - 6, dark);
    p.fill(cx - 4, 6, 9, 1, lit);
    /* rounded crown */
    p.fill(cx - 3, 5, 7, 1, green);
    p.fill(cx - 2, 4, 5, 1, lit);
    /* ribs */
    for (i = 0; i < 2; i++) {
      p.fill(cx - 1 + i * 3, 8, 1, H - 10, i ? dark : lit);
    }
    /* left arm */
    p.fill(4, 26, 8, 6, green);
    p.fill(4, 26, 8, 1, lit);
    p.fill(4, 31, 8, 1, deep);
    p.fill(4, 14, 6, 13, green);
    p.fill(4, 14, 2, 13, lit);
    p.fill(9, 14, 1, 13, dark);
    p.fill(5, 13, 4, 1, lit);
    p.fill(10, 26, 5, 1, dark);
    /* right arm */
    p.fill(21, 34, 8, 6, green);
    p.fill(21, 34, 8, 1, lit);
    p.fill(21, 39, 8, 1, deep);
    p.fill(24, 20, 6, 15, green);
    p.fill(24, 20, 2, 15, lit);
    p.fill(29, 20, 1, 15, dark);
    p.fill(25, 19, 4, 1, lit);
    /* spines */
    for (y = 8; y < H - 2; y += 5) {
      p.px(cx - 5, y, '#e9e2c0');
      p.px(cx + 5, y + 2, '#e9e2c0');
    }
    /* base shadow */
    p.fill(cx - 5, H - 2, 11, 2, deep);
    return p;
  }

  /* --- rocks & scrub: irregular polygons scan-filled with a lit top plane,
         a body plane and a shadow plane, then faceted with one break line --- */
  function polyFill(p, pts, colorFn) {
    var n = pts.length, i, j, k, y, xs = [], t, xa, xb;
    var minY = 1e9, maxY = -1e9;
    for (i = 0; i < n; i++) {
      if (pts[i][1] < minY) { minY = pts[i][1]; }
      if (pts[i][1] > maxY) { maxY = pts[i][1]; }
    }
    for (y = minY; y <= maxY; y++) {
      xs.length = 0;
      for (i = 0; i < n; i++) {
        var a = pts[i], b = pts[(i + 1) % n];
        if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) {
          t = (y - a[1]) / (b[1] - a[1]);
          xs.push(a[0] + (b[0] - a[0]) * t);
        }
      }
      xs.sort(function (m, q) { return m - q; });
      for (j = 0; j + 1 < xs.length; j += 2) {
        xa = Math.round(xs[j]); xb = Math.round(xs[j + 1]);
        for (k = xa; k < xb; k++) { p.px(k, y, colorFn(k, y)); }
      }
    }
  }

  function rockSprite(w, h, pts, facet, pal) {
    var p = new Painter(w, h, { outline: OUTLINE });
    var minY = 1e9, maxY = -1e9, i, span;
    for (i = 0; i < pts.length; i++) {
      if (pts[i][1] < minY) { minY = pts[i][1]; }
      if (pts[i][1] > maxY) { maxY = pts[i][1]; }
    }
    span = Math.max(1, maxY - minY);
    polyFill(p, pts, function (x, y) {
      var t = (y - minY) / span;
      var far = x > facet;
      if (t < 0.16) { return far ? pal.l : pal.h; }
      if (t < 0.42) { return far ? pal.b : pal.l; }
      if (t < 0.72) { return far ? pal.d : pal.b; }
      return pal.d;
    });
    return p;
  }

  /* silhouettes: irregular on purpose, a smooth dome reads as a puddle */
  var ROCK_PTS = [[4, 21], [1, 17], [2, 13], [5, 8], [9, 6], [12, 9], [17, 4],
    [22, 5], [26, 8], [31, 12], [32, 17], [30, 21]];
  var BOULDER_PTS = [[3, 29], [0, 24], [2, 19], [6, 11], [12, 6], [17, 9],
    [23, 3], [31, 4], [37, 9], [44, 14], [47, 21], [46, 27], [41, 29]];
  var BUSH_PTS = [[3, 17], [0, 13], [3, 8], [7, 6], [10, 9], [14, 3],
    [19, 6], [22, 4], [26, 9], [29, 13], [27, 17]];

  function bushSprite(pal) {
    var p = new Painter(30, 18, { outline: OUTLINE });
    var minY = 3, span = 14;
    polyFill(p, BUSH_PTS, function (x, y) {
      var t = (y - minY) / span;
      if (t < 0.22) { return pal.L; }
      if (t < 0.55) { return pal.l; }
      if (t < 0.85) { return pal.b; }
      return pal.d;
    });
    /* a couple of shadow notches so it is scrub, not a pillow */
    p.px(6, 10, pal.d); p.px(7, 11, pal.d); p.px(8, 12, pal.d);
    p.px(23, 11, pal.d); p.px(24, 12, pal.d);
    p.fill(14, 3, 3, 1, pal.b);
    return p;
  }

  /* --- highway lamp: pole + arm + glowing head -------------------------- */
  function paintLamp(p, pal) {
    var W = 20, H = 84, i, y;
    var pole = '#2c3145', poleD = '#171a26', poleL = '#4b5470';
    var head = '#3a3f52';
    /* base */
    p.fill(6, H - 5, 8, 5, pole);
    p.fill(5, H - 2, 10, 2, poleD);
    p.fill(6, H - 5, 8, 1, poleL);
    /* pole */
    p.fill(8, 12, 3, H - 15, pole);
    p.fill(8, 12, 1, H - 15, poleL);
    p.fill(10, 12, 1, H - 15, poleD);
    /* arm curving out to the right */
    for (i = 0; i < 8; i++) {
      p.fill(9 + i, 12 - Math.round(i * 0.45), 2, 2, pole);
      p.px(9 + i, 11 - Math.round(i * 0.45), poleL);
    }
    /* head */
    p.fill(14, 6, 6, 4, head);
    p.fill(14, 6, 6, 1, poleL);
    p.fill(15, 9, 4, 1, '#ffe9a0');
    p.fill(15, 10, 4, 1, '#ffd23f');
    /* glow: hard dithered cone under the head */
    p.dither(12, 11, 10, 8, rgba('#ffd23f', 0.30), 1);
    p.dither(10, 13, 14, 10, rgba('#ffd23f', 0.16), 2);
    p.fill(15, 11, 4, 1, rgba('#ffe9a0', 0.7));
    return p;
  }

  /* --- start/finish arch (94 px + 1px ink = 96, the contract's cap) ------- */
  function paintArch(p, pal) {
    var W = 94, H = 58, i, x, y, top;
    var spanX0 = 12, spanX1 = W - 13;
    var legW = 8;
    var stone = '#4a4f66', stoneD = '#242a3a', stoneL = '#6b7392';
    var neonA = themeColor('sunset', 'rumbleDark', 0.10);
    var neonB = themeColor('night', 'rumbleLight', 0.05);
    var neonC = themeColor('night', 'rumbleDark', 0.0);

    /* legs */
    for (i = 0; i < 2; i++) {
      var lx = i === 0 ? 4 : W - 4 - legW;
      p.fill(lx, 20, legW, H - 20, stone);
      p.fill(lx, 20, 1, H - 20, stoneD);
      p.fill(lx + legW - 1, 20, 1, H - 20, stoneL);
      p.fill(lx - 1, H - 3, legW + 2, 3, stoneD);
      for (y = 26; y < H - 4; y += 6) { p.fill(lx, y, legW, 1, stoneD); }
    }

    /* the span: a shallow arc drawn row by row */
    for (x = spanX0; x <= spanX1; x++) {
      var t = (x - spanX0) / (spanX1 - spanX0);
      top = 20 - Math.round(11 * Math.sin(Math.PI * t));
      p.fill(x, top, 1, 9, stone);
      p.px(x, top, stoneL);
      p.px(x, top + 8, stoneD);
      /* neon tube under the span, alternating colours */
      var seg = Math.floor(x / 4) % 3;
      p.px(x, top + 10, seg === 0 ? neonA : (seg === 1 ? neonB : neonC));
      p.px(x, top + 9, seg === 0 ? neonB : (seg === 1 ? neonC : neonA));
    }

    /* chequered banner across the span */
    for (x = spanX0 + 2; x < spanX1 - 1; x++) {
      var ty = 20 - Math.round(11 * Math.sin(Math.PI * ((x - spanX0) / (spanX1 - spanX0))));
      p.fill(x, ty + 3, 1, 3, ((x >> 1) & 1) ? '#f7f3e6' : '#1a1a26');
    }
    /* crown lights */
    for (x = spanX0 + 6; x < spanX1 - 4; x += 8) {
      var ly = 20 - Math.round(11 * Math.sin(Math.PI * ((x - spanX0) / (spanX1 - spanX0))));
      p.fill(x, ly - 2, 2, 2, '#ffd23f');
    }
    return p;
  }

  /* --- billboards: panel art in the built-in bitmap font ---------------- */
  function paintBillboard(p, idx) {
    var W = 64, H = 48, pal = metalPal();
    var legY = 30;
    var panel = [
      { bg: '#241a3d', fg: '#22e0ff', fg2: '#ff2fb9', t1: 'NEON', t2: 'DRIFT' },
      { bg: '#3a1020', fg: '#ffd23f', fg2: '#ffffff', t1: 'TURBO', t2: 'ZONE' },
      { bg: '#102a34', fg: '#4dff88', fg2: '#ffd23f', t1: 'SUNSET', t2: 'STRIP' },
      { bg: '#1a1030', fg: '#ff2fb9', fg2: '#22e0ff', t1: 'SINCE', t2: '1986' }
    ][idx % 4];

    /* legs */
    p.fill(14, legY, 4, H - legY, pal.d);
    p.fill(14, legY, 1, H - legY, pal.l);
    p.fill(W - 18, legY, 4, H - legY, pal.d);
    p.fill(W - 18, legY, 1, H - legY, pal.l);
    p.fill(11, H - 3, 10, 3, pal.D);
    p.fill(W - 21, H - 3, 10, 3, pal.D);

    /* panel */
    p.fill(2, 2, W - 4, legY - 2, pal.D);
    p.fill(4, 4, W - 8, legY - 6, panel.bg);
    p.fill(4, 4, W - 8, 1, shade(panel.bg, 0.30));
    p.fill(4, legY - 3, W - 8, 1, shade(panel.bg, -0.45));
    p.frame(3, 3, W - 6, legY - 4, pal.l);
    p.frame(2, 2, W - 4, legY - 2, pal.D);

    /* sun disc + strip band */
    var cx = W / 2, i, y2, j;
    for (y2 = 0; y2 < 9; y2++) {
      var half = Math.round(Math.sqrt(Math.max(0, 81 - (y2 - 4) * (y2 - 4))) * 1.5);
      p.fill(cx - half, 8 + y2, half * 2, 1, mix(panel.fg, panel.bg, 0.45));
    }
    for (i = 0; i < 6; i++) { p.fill(cx - 12 + i * 4, 13 + (i & 1) * 2, 3, 1, panel.bg); }
    for (j = 0; j < 3; j++) { p.fill(5, legY - 6 + j, W - 10, 1, mix(panel.fg2, panel.bg, 0.55)); }

    /* slogan in the built-in font */
    try {
      if (typeof CORE !== 'undefined' && CORE && typeof CORE.drawText === 'function') {
        CORE.drawText(p.g, panel.t1, p.w / 2, 9, { color: panel.fg, align: 'center', scale: 1, shadow: '#100a18' });
        CORE.drawText(p.g, panel.t2, p.w / 2, 19, { color: panel.fg2, align: 'center', scale: 1, shadow: '#100a18' });
      }
    } catch (e) { /* font is optional, the panel still reads */ }
    return p;
  }

  /* ====================================================================== *
   *  8. crash FX — four beats: burst -> flash -> ring -> smoke
   * ====================================================================== */

  var BLAST_MOD = [
    1.00, 1.14, 0.92, 1.06, 0.84, 1.10, 0.96, 1.18,
    0.88, 1.08, 0.94, 1.16, 0.90, 1.04, 0.86, 1.12
  ];

  var BOOM = [
    { r: 11, core: 0.50, mid: 0.80, hole: 0.00, c0: '#fffbe0', c1: '#ffd23f', c2: '#ff8a1e', c3: '#e8483f', smoke: 0, spark: 16, spIn: 0.35 },
    { r: 15, core: 0.56, mid: 0.84, hole: 0.00, c0: '#ffffff', c1: '#ffe86a', c2: '#ff9a20', c3: '#e8483f', smoke: 0, spark: 20, spIn: 0.25 },
    { r: 15, core: 0.10, mid: 0.55, hole: 0.38, c0: '#ffe86a', c1: '#ff9a20', c2: '#e8483f', c3: '#a02a4a', smoke: 1, spark: 14, spIn: 0.55 },
    { r: 14, core: 0.00, mid: 0.30, hole: 0.42, c0: '#8a7fa0', c1: '#5c526e', c2: '#3a3350', c3: '#241f36', smoke: 2, spark: 7, spIn: 0.70 }
  ];

  function paintBoom(p, frame) {
    var S = 33, c = 16, prof = BOOM[frame];
    var x, y, dx, dy, d, ang, k, rr, t, col, i;
    var rng = null;
    try { rng = CORE.rng(0x5eed + frame * 977); } catch (e) { rng = null; }
    function rnd(a, b) { return rng ? a + rng() * (b - a) : (a + b) / 2; }

    for (y = 0; y < S; y++) {
      for (x = 0; x < S; x++) {
        dx = x - c; dy = y - c;
        d = Math.sqrt(dx * dx + dy * dy);
        if (d > prof.r + 2) { continue; }
        ang = Math.atan2(dy, dx);
        k = Math.floor(((ang + Math.PI) / (Math.PI * 2)) * 16) & 15;
        rr = prof.r * BLAST_MOD[k];
        t = d / rr;
        if (t > 1.0) {
          /* dithered fringe */
          if (t > 1.28 || (((x + y) & 1) === 0)) { continue; }
          col = prof.smoke ? prof.c3 : prof.c2;
          p.px(x, y, col);
          continue;
        }
        if (t < prof.hole) { continue; }
        if (t < prof.core) { col = prof.c0; }
        else if (t < prof.mid) { col = prof.c1; }
        else if (t < 0.94) { col = prof.c2; }
        else { col = prof.c3; }
        /* the dissipating frame is broken smoke, not a disc */
        if (prof.smoke === 2 && t > 0.35 && ((x * 3 + y * 5 + frame) % 4 === 0)) { continue; }
        if (prof.smoke === 1 && t > 0.72 && ((x + y * 2) % 3 === 0)) { continue; }
        p.px(x, y, col);
      }
    }
    /* sparks flung out of the fireball */
    for (i = 0; i < prof.spark; i++) {
      ang = rnd(-Math.PI, Math.PI);
      d = prof.r * rnd(prof.spIn + 0.1, 1.55);
      x = Math.round(c + Math.cos(ang) * d);
      y = Math.round(c + Math.sin(ang) * d);
      col = i % 3 === 0 ? prof.c0 : (i % 3 === 1 ? prof.c1 : prof.c2);
      p.px(x, y, col);
      if (i % 4 === 0) { p.px(x + (i & 1 ? 1 : -1), y, col); }
    }
    return p;
  }

  /* ====================================================================== *
   *  9. build everything
   * ====================================================================== */

  function define(name, painter, anchor) {
    var spr = null;
    try { spr = painter.finish(anchor); } catch (e) { spr = null; }
    if (!spr) { return null; }
    reg[name] = spr;
    order.push(name);
    return spr;
  }

  /* a sprite that is nothing but one stamped pixel map */
  function mapOnly(w, h, rows, pal) {
    var p = new Painter(w, h, { outline: OUTLINE });
    p.map(rows, pal, 0, 0, null);
    return p;
  }

  /* per-car styling: ride height, cabin height, wing — silhouettes differ */
  var CAR_STYLE = [
    { name: 'car_red', base: '#d81e3a', accent: '#ffd23f', w: 44, h: 24, inset: 3, lower: 5, deck: 4, cab: 7, cabW: 30, roofW: 20, light: 11, wheelW: 9, wheelH: 11, wing: 1 },
    { name: 'car_blue', base: '#2456d8', accent: '#22e0ff', w: 44, h: 26, inset: 3, lower: 6, deck: 5, cab: 9, cabW: 32, roofW: 24, light: 10, wheelW: 9, wheelH: 11, wing: 0 },
    { name: 'car_green', base: '#22a04c', accent: '#f7f3e6', w: 46, h: 28, inset: 3, lower: 6, deck: 4, cab: 12, cabW: 34, roofW: 30, light: 10, wheelW: 9, wheelH: 12, wing: 0 },
    { name: 'car_yellow', base: '#e8bf1c', accent: '#ff2fb9', w: 40, h: 22, inset: 3, lower: 5, deck: 4, cab: 7, cabW: 26, roofW: 18, light: 10, wheelW: 8, wheelH: 10, wing: 1 },
    { name: 'car_purple', base: '#8a2fc4', accent: '#22e0ff', w: 46, h: 24, inset: 2, lower: 5, deck: 4, cab: 7, cabW: 32, roofW: 20, light: 12, wheelW: 10, wheelH: 12, wing: 1 },
    { name: 'truck_white', base: '#dfe2ec', accent: '#d81e3a', w: 46, h: 32, chassis: 6, top: 1, wheelW: 9, wheelH: 13, markers: 5, truck: 1 },
    { name: 'truck_blue', base: '#2a4a9a', accent: '#ffd23f', w: 46, h: 30, chassis: 6, top: 1, wheelW: 8, wheelH: 12, markers: 4, truck: 1 }
  ];

  function buildAll() {
    var i, st, pal, p;

    /* ---- player ---- */
    define('player_straight', heroCar(0, false), { x: 0.5, y: 1 });
    define('player_left', heroCar(-1, false), { x: 0.5, y: 1 });
    define('player_right', heroCar(1, false), { x: 0.5, y: 1 });
    define('player_brake', heroCar(0, true), { x: 0.5, y: 1 });
    define('player_shadow', heroShadow(), { x: 0.5, y: 0.5 });

    /* ---- traffic ---- */
    for (i = 0; i < CAR_STYLE.length; i++) {
      st = CAR_STYLE[i];
      pal = carPal(st.base, st.accent);
      p = new Painter(st.w, st.h, { outline: OUTLINE });
      if (st.truck) { paintTruck(p, st, pal); } else { paintCar(p, st, pal); }
      define(st.name, p, { x: 0.5, y: 1 });
    }

    /* ---- scenery: every theme draws from this pool ---- */
    var fol = foliagePal(), stone = stonePal(), metal = metalPal();
    define('palm', paintPalm(new Painter(48, 96, { outline: OUTLINE }), fol), { x: 0.5, y: 1 });
    define('pine', paintPine(new Painter(40, 76, { outline: OUTLINE }), fol), { x: 0.5, y: 1 });
    define('cactus', paintCactus(new Painter(32, 64, { outline: OUTLINE }), fol), { x: 0.5, y: 1 });
    define('rock', rockSprite(34, 22, ROCK_PTS, 15, stone), { x: 0.5, y: 1 });
    define('bush', bushSprite(fol), { x: 0.5, y: 1 });
    define('boulder', rockSprite(50, 30, BOULDER_PTS, 22, stone), { x: 0.5, y: 1 });
    define('lamp', paintLamp(new Painter(20, 84, { outline: OUTLINE }), metal), { x: 0.5, y: 1 });
    define('arch', paintArch(new Painter(94, 58, { outline: OUTLINE }), metal), { x: 0.5, y: 1 });
    for (i = 0; i < 4; i++) {
      define('billboard_' + i, paintBillboard(new Painter(64, 48, { outline: OUTLINE }), i), { x: 0.5, y: 1 });
    }

    /* ---- crash FX ---- */
    for (i = 0; i < 4; i++) {
      define('boom_' + i, paintBoom(new Painter(33, 33, { outline: null }), i), { x: 0.5, y: 0.5 });
    }
    return true;
  }

  /* ====================================================================== *
   * 10. static tables (available without init — ROAD reads them at build time)
   * ====================================================================== */

  var SCENERY = {
    sunset: ['palm', 'palm', 'bush', 'billboard_0', 'rock', 'billboard_1', 'lamp', 'palm'],
    night: ['lamp', 'pine', 'billboard_3', 'pine', 'rock', 'billboard_2', 'lamp', 'pine'],
    dawn: ['cactus', 'boulder', 'cactus', 'billboard_3', 'rock', 'cactus', 'boulder', 'arch']
  };

  var OPPONENTS = {
    sunset: ['car_red', 'car_blue', 'car_yellow', 'car_green', 'car_red', 'truck_white'],
    night: ['car_blue', 'car_purple', 'car_green', 'car_blue', 'truck_blue', 'truck_white'],
    dawn: ['car_yellow', 'car_red', 'truck_blue', 'car_purple', 'car_green', 'truck_white']
  };

  var HERO = {
    straight: 'player_straight',
    left: 'player_left',
    right: 'player_right',
    brake: 'player_brake',
    shadow: 'player_shadow'
  };

  /* every key the contract demands, in one place (used by init + tooling) */
  var REQUIRED = [
    'player_straight', 'player_left', 'player_right', 'player_brake', 'player_shadow',
    'car_red', 'car_blue', 'car_green', 'car_yellow', 'car_purple',
    'truck_white', 'truck_blue',
    'palm', 'pine', 'cactus', 'rock', 'bush', 'boulder', 'lamp', 'arch',
    'billboard_0', 'billboard_1', 'billboard_2', 'billboard_3',
    'boom_0', 'boom_1', 'boom_2', 'boom_3'
  ];

  /* ====================================================================== *
   * 11. public API
   * ====================================================================== */

  /* init() latches only on success; the implicit path below tries at most once
     so a canvas-less environment does not rebuild on every lookup, while an
     explicit later init() (after the DOM exists) still can. */
  var tried = false;

  function init() {
    if (inited) { return; }
    if (typeof CORE === 'undefined' || !CORE) { return; }
    tried = true;
    try {
      buildAll();
    } catch (e) {
      /* A broken/hostile canvas must never take the game down: whatever was
         painted before the failure stays registered, the rest reads as null. */
    }
    /* only latch once the contract is actually satisfied, so a browser that
       was not ready yet can be retried by calling init() again */
    var i;
    for (i = 0; i < REQUIRED.length; i++) {
      if (!reg[REQUIRED[i]]) { return; }
    }
    inited = true;
  }

  /* has()/get() are answerable before an explicit init() — ROAD builds its
     scenery list by asking SPRITES.has(), and that may happen first. */
  function ensure() {
    if (!inited && !tried) { init(); }
  }

  function get(name) {
    ensure();
    var s = reg[name];
    return s ? s : null;
  }

  function has(name) {
    ensure();
    return Object.prototype.hasOwnProperty.call(reg, name);
  }

  function names() {
    ensure();
    return order.slice(0);
  }

  return {
    init: init,
    get: get,
    has: has,
    names: names,

    SCENERY: SCENERY,
    OPPONENTS: OPPONENTS,
    HERO: HERO,
    REQUIRED: REQUIRED,

    /* handy for the verifier / debug overlay */
    isReady: function () { return inited; }
  };
})();
