/* ==========================================================================
 * NEON DRIFT '86  —  src/core.js
 * Shared contract: constants, math, seeded RNG, palettes, bitmap font,
 * storage helpers and the frozen game-state factory.
 * Loaded FIRST. Depends on nothing. Exposes the single global `CORE`.
 * ========================================================================== */
var CORE = (function () {
  'use strict';

  var VERSION = '1.0.0';

  /* internal render resolution (integer-upscaled at present time) */
  var W = 384, H = 216, TAU = Math.PI * 2;

  /* ------------------------------------------------------------------ math */
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeIn(a, b, p) { return a + (b - a) * Math.pow(p, 2); }
  function easeOut(a, b, p) { return a + (b - a) * (1 - Math.pow(1 - p, 2)); }
  function easeInOut(a, b, p) { return a + (b - a) * (-Math.cos(p * Math.PI) / 2 + 0.5); }
  function accelerate(v, accel, dt) { return v + accel * dt; }
  function percentRemaining(n, total) { return (n % total) / total; }

  function overlap(x1, w1, x2, w2, percent) {
    var half = (percent === undefined ? 1 : percent) / 2;
    var min1 = x1 - (w1 * half), max1 = x1 + (w1 * half);
    var min2 = x2 - (w2 * half), max2 = x2 + (w2 * half);
    return !((max1 < min2) || (min1 > max2));
  }

  function increase(start, inc, max) {
    var r = start + inc;
    if (!(max > 0)) { return 0; }
    r = r % max;
    if (r < 0) { r += max; }
    return r;
  }

  function wrapZ(z, trackLength) { return increase(z, 0, trackLength); }

  /* ------------------------------------------------------- seeded prng ---- */
  /* xorshift32 — deterministic, so every stage rebuilds identically. */
  function rng(seed) {
    var s = (seed >>> 0) || 0x9e3779b9;
    return function () {
      s ^= (s << 13); s >>>= 0;
      s ^= (s >>> 17);
      s ^= (s << 5);  s >>>= 0;
      return s / 4294967296;
    };
  }
  function rnd(r, a, b) { return a + r() * (b - a); }
  function rndInt(r, a, b) { return Math.floor(a + r() * (b - a + 1)); }
  function pick(r, arr) { return arr[Math.floor(r() * arr.length) % arr.length]; }

  /* ------------------------------------------------------------- canvas --- */
  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, w | 0);
    c.height = Math.max(1, h | 0);
    return c;
  }

  function now() {
    if (typeof performance !== 'undefined' && performance.now) { return performance.now(); }
    return Date.now();
  }

  /* ------------------------------------------------------------ storage --- */
  var storage = {
    get: function (key, def) {
      try {
        var v = window.localStorage.getItem('neondrift86.' + key);
        return v === null ? def : JSON.parse(v);
      } catch (e) { return def; }
    },
    set: function (key, val) {
      try { window.localStorage.setItem('neondrift86.' + key, JSON.stringify(val)); return true; }
      catch (e) { return false; }
    }
  };

  /* ------------------------------------------------------------ format ---- */
  function pad(n, len) {
    var s = String(Math.abs(n | 0));
    while (s.length < len) { s = '0' + s; }
    return (n < 0 ? '-' : '') + s;
  }

  function formatTime(sec) {
    if (typeof sec !== 'number' || !isFinite(sec) || sec < 0) { return '--:--.--'; }
    var m = Math.floor(sec / 60);
    var s = sec - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2);
  }

  function formatScore(n) { return pad(n | 0, 7); }

  /* ============================================================== TUNING == */
  var TUNING = {
    SEGMENT_LENGTH: 200,
    RUMBLE_LENGTH: 3,
    ROAD_WIDTH: 2000,
    LANES: 3,
    FIELD_OF_VIEW: 100,
    CAMERA_HEIGHT: 1000,
    DRAW_DISTANCE: 220,
    FOG_DENSITY: 5,

    MAX_SPEED: 12000,
    ACCEL: 2400,
    BREAKING: -12000,
    DECEL: -2400,
    OFF_ROAD_DECEL: -6000,
    OFF_ROAD_LIMIT: 3000,
    CENTRIFUGAL: 0.3,

    STEP: 1 / 60,
    CAMERA_DEPTH: 1 / Math.tan((100 / 2) * Math.PI / 180),
    PLAYER_Z: 1000 * (1 / Math.tan((100 / 2) * Math.PI / 180)),
    SPRITE_SCALE: 0.3 / 48,
    ROAD_WIDTH_HALF: 1000,

    /* gameplay feel */
    CHECKPOINT_BONUS: 30,
    DRIFT_STEER_BONUS: 1.45,
    COLLISION_SPEED_LOSS: 0.35,
    HIT_INVULN: 1.2,
    GEARS: 5
  };

  /* ============================================================= THEMES === */
  /* Every colour the game ever draws comes from here. */
  var THEMES = {
    sunset: {
      key: 'sunset', label: 'SUNSET STRIP',
      sky: ['#0b0420', '#2a0a4a', '#5c1268', '#a81f66', '#e8483f', '#ff8a3d', '#ffc46b'],
      sunCore: '#fff3a8', sunGlow: '#ff9a3c', sunBand: '#c9305f',
      sunRadius: 0.34, sunY: 0.62, stars: 0,
      mountFar: '#2a1150', mountNear: '#3d1a63',
      grassDark: '#12333d', grassLight: '#17434f',
      roadDark: '#2b2b3a', roadLight: '#333345',
      rumbleDark: '#e83f6f', rumbleLight: '#f5efe2',
      lane: '#ded8c8',
      fog: '#5c1268', fogDensity: 5,
      crtTint: '#4a1f5e',
      scenery: ['palm', 'palm', 'bush', 'billboard_0', 'rock', 'billboard_1', 'lamp', 'palm']
    },
    night: {
      key: 'night', label: 'NEON NIGHT',
      sky: ['#02010a', '#070522', '#120e3d', '#1e1557', '#2c1f6b', '#3a2a78'],
      sunCore: '#cfe9ff', sunGlow: '#4a6bff', sunBand: '#1b1b4a',
      sunRadius: 0.20, sunY: 0.50, stars: 1,
      mountFar: '#0a0820', mountNear: '#141033',
      grassDark: '#0a1420', grassLight: '#0e1c2c',
      roadDark: '#1a1a26', roadLight: '#20202e',
      rumbleDark: '#22e0ff', rumbleLight: '#ff2fb9',
      lane: '#9ff6ff',
      fog: '#150f38', fogDensity: 6,
      crtTint: '#1b2a6b',
      scenery: ['lamp', 'pine', 'billboard_3', 'pine', 'rock', 'billboard_2', 'lamp', 'pine']
    },
    dawn: {
      key: 'dawn', label: 'SANDSTORM',
      sky: ['#241a4d', '#4a2a68', '#8f4470', '#c96a5c', '#f0a15e', '#ffd9a0'],
      sunCore: '#fff6d0', sunGlow: '#ffb055', sunBand: '#d98a5a',
      sunRadius: 0.26, sunY: 0.58, stars: 0,
      mountFar: '#4a3a5c', mountNear: '#5e4a6b',
      grassDark: '#8a6134', grassLight: '#9c7040',
      roadDark: '#3a3026', roadLight: '#443a2e',
      rumbleDark: '#d94f2b', rumbleLight: '#f7ead0',
      lane: '#f0e2c0',
      fog: '#c98a5a', fogDensity: 7,
      crtTint: '#5e3a1f',
      scenery: ['cactus', 'boulder', 'cactus', 'billboard_3', 'rock', 'cactus', 'boulder', 'arch']
    }
  };

  var STAGES = [
    { id: 0, code: 'S1', name: 'SUNSET STRIP', theme: 'sunset', laps: 2, traffic: 70,  timeLimit: 100, hilliness: 1.00, curviness: 1.00, seed: 1986 },
    { id: 1, code: 'S2', name: 'NEON NIGHT',   theme: 'night',  laps: 2, traffic: 95,  timeLimit: 95,  hilliness: 1.20, curviness: 1.25, seed: 2086 },
    { id: 2, code: 'S3', name: 'SANDSTORM',    theme: 'dawn',   laps: 2, traffic: 120, timeLimit: 92,  hilliness: 1.40, curviness: 1.55, seed: 2186 }
  ];

  /* ============================================================ UI COLOR == */
  var UI = {
    white: '#ffffff', black: '#000000', dim: '#8a8aa0',
    accent: '#ff2fb9', accent2: '#22e0ff', warn: '#ffd23f',
    danger: '#ff3b3b', good: '#4dff88', panel: '#0d0a1e'
  };

  /* ========================================================== BITMAP FONT = */
  /* 5 wide x 7 tall, one 5-bit row per entry, bit4 = leftmost column. */
  var FONT_W = 5, FONT_H = 7;

  var GLYPHS = {
    'A': [0x0E, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11],
    'B': [0x1E, 0x11, 0x11, 0x1E, 0x11, 0x11, 0x1E],
    'C': [0x0E, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0E],
    'D': [0x1E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1E],
    'E': [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x1F],
    'F': [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x10],
    'G': [0x0E, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0F],
    'H': [0x11, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11],
    'I': [0x0E, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0E],
    'J': [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0C],
    'K': [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
    'L': [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1F],
    'M': [0x11, 0x1B, 0x15, 0x15, 0x11, 0x11, 0x11],
    'N': [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
    'O': [0x0E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E],
    'P': [0x1E, 0x11, 0x11, 0x1E, 0x10, 0x10, 0x10],
    'Q': [0x0E, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0D],
    'R': [0x1E, 0x11, 0x11, 0x1E, 0x14, 0x12, 0x11],
    'S': [0x0F, 0x10, 0x10, 0x0E, 0x01, 0x01, 0x1E],
    'T': [0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
    'U': [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E],
    'V': [0x11, 0x11, 0x11, 0x11, 0x11, 0x0A, 0x04],
    'W': [0x11, 0x11, 0x11, 0x15, 0x15, 0x1B, 0x11],
    'X': [0x11, 0x11, 0x0A, 0x04, 0x0A, 0x11, 0x11],
    'Y': [0x11, 0x11, 0x0A, 0x04, 0x04, 0x04, 0x04],
    'Z': [0x1F, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1F],
    '0': [0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E],
    '1': [0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E],
    '2': [0x0E, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1F],
    '3': [0x1F, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0E],
    '4': [0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02],
    '5': [0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E],
    '6': [0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E],
    '7': [0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
    '8': [0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E],
    '9': [0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C],
    ' ': [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
    '.': [0x00, 0x00, 0x00, 0x00, 0x00, 0x0C, 0x0C],
    ',': [0x00, 0x00, 0x00, 0x00, 0x0C, 0x0C, 0x08],
    ':': [0x00, 0x0C, 0x0C, 0x00, 0x0C, 0x0C, 0x00],
    ';': [0x00, 0x0C, 0x0C, 0x00, 0x0C, 0x0C, 0x08],
    '-': [0x00, 0x00, 0x00, 0x1F, 0x00, 0x00, 0x00],
    '_': [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1F],
    '+': [0x00, 0x04, 0x04, 0x1F, 0x04, 0x04, 0x00],
    '=': [0x00, 0x00, 0x1F, 0x00, 0x1F, 0x00, 0x00],
    '*': [0x00, 0x0A, 0x04, 0x1F, 0x04, 0x0A, 0x00],
    '/': [0x01, 0x01, 0x02, 0x04, 0x08, 0x10, 0x10],
    '\\': [0x10, 0x10, 0x08, 0x04, 0x02, 0x01, 0x01],
    '!': [0x04, 0x04, 0x04, 0x04, 0x04, 0x00, 0x04],
    '?': [0x0E, 0x11, 0x01, 0x02, 0x04, 0x00, 0x04],
    '%': [0x11, 0x01, 0x02, 0x04, 0x08, 0x10, 0x11],
    '(': [0x04, 0x08, 0x10, 0x10, 0x10, 0x08, 0x04],
    ')': [0x04, 0x02, 0x01, 0x01, 0x01, 0x02, 0x04],
    '[': [0x0E, 0x08, 0x08, 0x08, 0x08, 0x08, 0x0E],
    ']': [0x0E, 0x02, 0x02, 0x02, 0x02, 0x02, 0x0E],
    '<': [0x02, 0x04, 0x08, 0x10, 0x08, 0x04, 0x02],
    '>': [0x08, 0x04, 0x02, 0x01, 0x02, 0x04, 0x08],
    '#': [0x0A, 0x1F, 0x0A, 0x0A, 0x1F, 0x0A, 0x00],
    '&': [0x0C, 0x12, 0x14, 0x08, 0x15, 0x12, 0x0D],
    '@': [0x0E, 0x11, 0x17, 0x15, 0x17, 0x10, 0x0E],
    '"': [0x0A, 0x0A, 0x00, 0x00, 0x00, 0x00, 0x00],
    "'": [0x04, 0x04, 0x08, 0x00, 0x00, 0x00, 0x00],
    '^': [0x04, 0x0A, 0x11, 0x00, 0x00, 0x00, 0x00],
    '~': [0x00, 0x00, 0x09, 0x16, 0x00, 0x00, 0x00],
    '$': [0x04, 0x0F, 0x14, 0x0E, 0x05, 0x1E, 0x04],
    '|': [0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
    '\u2665': [0x00, 0x0A, 0x1F, 0x1F, 0x0E, 0x04, 0x00],   /* heart  */
    '\u25B2': [0x04, 0x0E, 0x1F, 0x1F, 0x00, 0x00, 0x00],   /* up     */
    '\u25BC': [0x00, 0x00, 0x00, 0x1F, 0x1F, 0x0E, 0x04],   /* down   */
    '\u25C0': [0x01, 0x03, 0x07, 0x0F, 0x07, 0x03, 0x01],   /* left   */
    '\u25B6': [0x10, 0x18, 0x1C, 0x1E, 0x1C, 0x18, 0x10],   /* right  */
    '\u2588': [0x1F, 0x1F, 0x1F, 0x1F, 0x1F, 0x1F, 0x1F],   /* block  */
    '\u2592': [0x15, 0x0A, 0x15, 0x0A, 0x15, 0x0A, 0x15],   /* dither */
    '\u00B7': [0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00]    /* dot    */
  };

  var GLYPH_KEYS = (function () {
    var k = [], c;
    for (c in GLYPHS) { if (Object.prototype.hasOwnProperty.call(GLYPHS, c)) { k.push(c); } }
    return k;
  })();

  var GLYPH_INDEX = (function () {
    var m = {}, i;
    for (i = 0; i < GLYPH_KEYS.length; i++) { m[GLYPH_KEYS[i]] = i; }
    return m;
  })();

  var CELL_W = FONT_W + 1;              /* 1px gutter between cells in the atlas */
  var atlasCache = {};

  /* Pre-render every glyph once per colour; drawText then costs one drawImage
     per character instead of 35 fillRects. */
  function atlas(color) {
    if (atlasCache[color]) { return atlasCache[color]; }
    var cv = makeCanvas(GLYPH_KEYS.length * CELL_W, FONT_H);
    var g = cv.getContext('2d');
    g.fillStyle = color;
    var i, x, y, bits, ch;
    for (i = 0; i < GLYPH_KEYS.length; i++) {
      ch = GLYPHS[GLYPH_KEYS[i]];
      for (y = 0; y < FONT_H; y++) {
        bits = ch[y];
        for (x = 0; x < FONT_W; x++) {
          if (bits & (1 << (FONT_W - 1 - x))) { g.fillRect(i * CELL_W + x, y, 1, 1); }
        }
      }
    }
    atlasCache[color] = cv;
    return cv;
  }

  function textWidth(text, scale, spacing) {
    scale = Math.max(1, (scale | 0) || 1);
    spacing = (spacing === undefined || spacing === null) ? 1 : spacing;
    var n = String(text).length;
    if (n === 0) { return 0; }
    return (n * (FONT_W + spacing) - spacing) * scale;
  }

  function drawText(ctx, text, x, y, opts) {
    opts = opts || {};
    var scale = Math.max(1, (opts.scale | 0) || 1);
    var spacing = (opts.spacing === undefined || opts.spacing === null) ? 1 : opts.spacing;
    var color = opts.color || '#ffffff';
    var align = opts.align || 'left';
    var str = String(text).toUpperCase();
    var step = (FONT_W + spacing) * scale;

    var w = textWidth(str, scale, spacing);
    var dy = 0;
    if (opts.baseline === 'middle') { dy = -Math.round(FONT_H * scale / 2); }
    x = Math.round(x); y = Math.round(y) + dy;
    if (align === 'center') { x -= Math.round(w / 2); }
    else if (align === 'right') { x -= w; }

    if (opts.shadow) {
      drawText(ctx, str, x + scale, y + scale, {
        color: typeof opts.shadow === 'string' ? opts.shadow : '#000000',
        scale: scale, spacing: spacing, align: 'left'
      });
    }

    var a = atlas(color), i, gi;
    for (i = 0; i < str.length; i++) {
      gi = GLYPH_INDEX[str.charAt(i)];
      if (gi === undefined) { continue; }
      ctx.drawImage(a, gi * CELL_W, 0, FONT_W, FONT_H,
                    x + i * step, y, FONT_W * scale, FONT_H * scale);
    }
    return w;
  }

  /* ============================================================== STATE === */
  /* The frozen per-frame contract between GAME (writer) and RENDER (reader). */
  function createState() {
    return {
      /* timing */
      now: 0, dt: 0, frame: 0, fps: 60,

      /* flow */
      mode: 'boot', prevMode: '', modeTime: 0,

      /* player */
      position: 0, speed: 0, playerX: 0, playerY: 0,
      steer: 0, throttle: 0, brake: 0,
      gear: 1, rpm: 0, shiftTimer: 0,

      /* stage / progress */
      stageIndex: 0, stage: 0, lap: 1, laps: 2,
      trackLength: 0, track: null, segments: [], cars: [],
      checkpoint: 0, checkpoints: [], nextCheckpoint: 0,
      timeLeft: 0, lapTime: 0, lastLapTime: 0, bestLapTime: 0, totalTime: 0,
      score: 0, combo: 0, best: 0,

      /* camera / parallax */
      cameraHeight: TUNING.CAMERA_HEIGHT, cameraDepth: TUNING.CAMERA_DEPTH,
      playerZ: TUNING.PLAYER_Z,
      skyOffset: 0, hillOffset: 0, treeOffset: 0,

      /* fx */
      shake: 0, shakeX: 0, shakeY: 0, flash: 0,
      hitTimer: 0, offRoad: false, skid: false,
      crash: false, crashTimer: 0, crashX: 0, crashY: 0, crashFrame: 0,

      /* ui */
      menuIndex: 0, menuItems: [], countdown: 0,
      paused: false, muted: false, quality: 'high', showFps: false,
      hint: '',

      /* transient messages: {text,color,scale,x,y,ttl,ttl0} */
      messages: [],

      /* theme + results */
      theme: THEMES.sunset,
      results: null,

      /* debug */
      errors: []
    };
  }

  /* ============================================================ SELFTEST == */
  function selfTest() {
    var checks = [];
    function ck(name, ok, detail) { checks.push({ name: name, ok: !!ok, detail: detail || '' }); }

    ck('resolution', W === 384 && H === 216, W + 'x' + H);
    ck('math.clamp', clamp(5, 0, 3) === 3 && clamp(-1, 0, 3) === 0);
    ck('math.increase-wrap', increase(10, 5, 12) === 3, String(increase(10, 5, 12)));
    ck('math.increase-neg', increase(1, -5, 12) === 8, String(increase(1, -5, 12)));
    ck('math.wrapZ', wrapZ(-100, 1000) === 900, String(wrapZ(-100, 1000)));
    ck('math.overlap', overlap(0, 10, 4, 10, 1) === true && overlap(0, 2, 40, 2, 1) === false);

    var r1 = rng(42), r2 = rng(42);
    ck('rng.deterministic', r1() === r2(), 'first draws equal');
    var v = rng(42)();
    ck('rng.range', v >= 0 && v < 1, String(v));

    ck('font.width', textWidth('AB', 1, 1) === 11, String(textWidth('AB', 1, 1)));
    ck('font.width2', textWidth('AB', 2, 1) === 22, String(textWidth('AB', 2, 1)));
    ck('font.glyph-count', GLYPH_KEYS.length >= 60, String(GLYPH_KEYS.length));
    ck('font.has-digits', '0' in GLYPH_INDEX && '9' in GLYPH_INDEX);
    ck('font.has-letters', 'A' in GLYPH_INDEX && 'Z' in GLYPH_INDEX);

    var tk = Object.keys(THEMES);
    ck('themes.count', tk.length === 3, tk.join(','));
    var ti, th, tOk = true, tWhy = '';
    for (ti = 0; ti < tk.length; ti++) {
      th = THEMES[tk[ti]];
      var need = ['sky', 'sunCore', 'sunGlow', 'sunBand', 'mountFar', 'mountNear', 'grassDark',
        'grassLight', 'roadDark', 'roadLight', 'rumbleDark', 'rumbleLight', 'lane', 'fog',
        'crtTint', 'scenery'];
      for (var qi = 0; qi < need.length; qi++) {
        if (th[need[qi]] === undefined) { tOk = false; tWhy += tk[ti] + '.' + need[qi] + ' '; }
      }
      if (!(th.sky instanceof Array) || th.sky.length < 4) { tOk = false; tWhy += tk[ti] + '.sky '; }
    }
    ck('themes.complete', tOk, tWhy);
    ck('stages.count', STAGES.length === 3 && STAGES[2].laps === 2);

    ck('tuning.cameraDepth', TUNING.CAMERA_DEPTH > 0.8 && TUNING.CAMERA_DEPTH < 0.9,
      TUNING.CAMERA_DEPTH.toFixed(4));
    ck('tuning.step', Math.abs(TUNING.STEP - 1 / 60) < 1e-9);

    ck('format.time', formatTime(83.456) === '1:23.46', formatTime(83.456));
    ck('format.time-bad', formatTime(NaN) === '--:--.--');
    ck('format.score', formatScore(1234) === '0001234', formatScore(1234));
    ck('format.pad', pad(7, 3) === '007' && pad(-7, 3) === '-007');

    var s = createState();
    ck('state.shape', s.mode === 'boot' && s.segments instanceof Array && s.theme === THEMES.sunset);
    ck('state.required-fields',
      ['track', 'cars', 'checkpoints', 'messages', 'results', 'quality', 'skyOffset',
        'hillOffset', 'treeOffset', 'cameraDepth', 'playerZ', 'crashFrame'].every(function (k) {
          return k in s;
        }));

    var ok = true, i;
    for (i = 0; i < checks.length; i++) { if (!checks[i].ok) { ok = false; } }
    return { ok: ok, checks: checks };
  }

  /* ================================================================ EXPORT */
  return {
    VERSION: VERSION,
    W: W, H: H, TAU: TAU,

    clamp: clamp, lerp: lerp,
    easeIn: easeIn, easeOut: easeOut, easeInOut: easeInOut,
    accelerate: accelerate, percentRemaining: percentRemaining,
    overlap: overlap, increase: increase, wrapZ: wrapZ,

    rng: rng, rnd: rnd, rndInt: rndInt, pick: pick,

    makeCanvas: makeCanvas, now: now, storage: storage,
    pad: pad, formatTime: formatTime, formatScore: formatScore,

    TUNING: TUNING, THEMES: THEMES, STAGES: STAGES, UI: UI,

    FONT_W: FONT_W, FONT_H: FONT_H, GLYPHS: GLYPHS,
    textWidth: textWidth, drawText: drawText,

    createState: createState, selfTest: selfTest
  };
})();
