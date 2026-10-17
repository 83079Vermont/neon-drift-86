/* ==========================================================================
 * NEON DRIFT '86  —  src/render.js
 * Owns every pixel the player sees: banded sky, parallax ridges, the pseudo
 * 3D road, painter-sorted sprites, the player car, the chunky bitmap HUD and
 * the CRT post pass.
 *
 * Hard rules honoured here:
 *   - ES5 syntax only (var / function), classic <script> global `RENDER`
 *   - never uses ctx.scale / ctx.translate as a world camera
 *   - no DOM access at module scope; the 2D context arrives in init()
 *   - CFRT overlays are pre-rendered ONCE per theme, never per frame
 * Depends on: CORE (required), SPRITES (optional, degrades to hard rects).
 * ========================================================================== */
var RENDER = (function () {
  'use strict';

  var W = CORE.W, H = CORE.H;
  var T = CORE.TUNING;
  var UI = CORE.UI;

  var HORIZON = H / 2;                                   /* 108: vanishing point */
  var SPR_K = T.SPRITE_SCALE * T.ROAD_WIDTH * (W / 2);   /* 2400 */
  var PAR_W = 512;                                       /* periodic parallax tile */
  var LANES = T.LANES;
  var LOW_DRAW = 110;

  /* ------------------------------------------------------------------ state */
  var ctxRef = null;
  var quality = 'high';
  var needLayers = true;
  var layerKey = '';
  var L = { ok: false, sky: null, stars: null, sun: null, far: null, near: null, tree: null, crt: null,
            sunW: 0, sunH: 0, sunX: 0, sunY: 0, starY: 0 };
  var fx0 = null, fx0c = null;      /* frame snapshot  */
  var fx1 = null, fx1c = null;      /* channel staging */
  var chromaOk = true;
  var buckets = [];                 /* reusable per-draw-slot car buckets */
  var bucketCap = 0;
  var fpsSmooth = 0;
  var lastNow = 0;

  var cam = {
    n: 0, baseIndex: 0, basePercent: 0, baseSegment: null,
    playerSegIndex: 0, playerPercent: 0, playerSegment: null,
    playerX: 0, roadY: 0, pitch: 0, cameraDepth: T.CAMERA_DEPTH, cameraHeight: T.CAMERA_HEIGHT,
    playerZ: T.PLAYER_Z, position: 0, trackLength: 0, drawDistance: T.DRAW_DISTANCE,
    camX: 0, camY: 0, theme: CORE.THEMES.sunset
  };

  /* --------------------------------------------------------------- helpers  */

  function numOr(v, def) { return (typeof v === 'number' && isFinite(v)) ? v : def; }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function ir(v) { return v < 0 ? -((-v + 0.5) | 0) : ((v + 0.5) | 0); }

  var rgbCache = {};
  function hexRgb(hex) {
    var c = rgbCache[hex];
    if (c) { return c; }
    var h = String(hex || '#000000');
    if (h.charAt(0) === '#') { h = h.substring(1); }
    if (h.length === 3) { h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2); }
    var n = parseInt(h, 16);
    if (!isFinite(n)) { n = 0; }
    c = { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    rgbCache[hex] = c;
    return c;
  }

  function mix(a, b, t) {
    var A = hexRgb(a), B = hexRgb(b);
    if (t < 0) { t = 0; } else if (t > 1) { t = 1; }
    return 'rgb(' + ((A.r + (B.r - A.r) * t) | 0) + ',' +
      ((A.g + (B.g - A.g) * t) | 0) + ',' + ((A.b + (B.b - A.b) * t) | 0) + ')';
  }

  function rgba(hex, a) {
    var c = hexRgb(hex);
    return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')';
  }

  function expFog(distance, density) {
    return 1 / Math.pow(Math.E, distance * distance * density);
  }

  /* fillStyle write-through cache.  Kept ON the context (not in a module var)
     because several scratch canvases are painted during the pre-render pass. */
  function setFill(ctx, c) {
    if (ctx.__lastFill !== c) { ctx.fillStyle = c; ctx.__lastFill = c; }
  }

  function panel(ctx, x, y, w, h, fill, border) {
    setFill(ctx, fill);
    ctx.fillRect(x, y, w, h);
    if (border) {
      setFill(ctx, border);
      ctx.fillRect(x, y, w, 1);
      ctx.fillRect(x, y + h - 1, w, 1);
      ctx.fillRect(x, y, 1, h);
      ctx.fillRect(x + w - 1, y, 1, h);
    }
  }

  /* notch the panel corners so it reads as machined plastic, not a div */
  function notch(ctx, x, y, w, h, fill) {
    setFill(ctx, fill);
    ctx.fillRect(x, y, 3, 1); ctx.fillRect(x + w - 3, y, 3, 1);
    ctx.fillRect(x, y + h - 1, 3, 1); ctx.fillRect(x + w - 3, y + h - 1, 3, 1);
  }

  /* ------------------------------------------------------------ sprite glue */

  var NOMINAL = {
    player_straight: [48, 27], player_left: [48, 27], player_right: [48, 27],
    player_brake: [48, 27], player_shadow: [48, 12],
    car_red: [44, 24], car_blue: [44, 24], car_green: [44, 24], car_yellow: [44, 24],
    car_purple: [44, 24], truck_white: [44, 34], truck_blue: [44, 34],
    palm: [40, 72], pine: [40, 72], cactus: [32, 56], rock: [32, 22], bush: [32, 18],
    boulder: [40, 30], lamp: [16, 80], arch: [96, 64],
    billboard_0: [64, 40], billboard_1: [64, 40], billboard_2: [64, 40], billboard_3: [64, 40],
    boom_0: [32, 32], boom_1: [32, 32], boom_2: [32, 32], boom_3: [32, 32]
  };

  var PLACE = ['#ff2fb9', '#22e0ff', '#ffd23f', '#4dff88', '#ff8a3d', '#c96aff', '#f5efe2'];

  function nominal(name) {
    var n = NOMINAL[name];
    if (n) { return n; }
    if (String(name).indexOf('billboard') === 0) { return [64, 40]; }
    if (String(name).indexOf('boom') === 0) { return [32, 32]; }
    return [32, 32];
  }

  function placeColour(name) {
    var s = String(name), i, h = 0;
    for (i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
    return PLACE[Math.abs(h) % PLACE.length];
  }

  function spriteFor(name) {
    if (typeof SPRITES === 'undefined' || !SPRITES || typeof SPRITES.get !== 'function') { return null; }
    try { return SPRITES.get(name) || null; } catch (e) { return null; }
  }

  /* With no SPRITES module at all we still draw something (debug/self-test);
     with SPRITES present, a missing key is simply skipped rather than painted
     as a loud placeholder block. */
  function spritesPresent() {
    return typeof SPRITES !== 'undefined' && !!SPRITES && typeof SPRITES.get === 'function';
  }

  /* Draw one sprite so that `ax,ay` of it lands on (screenX, groundY).
     Everything is rounded to whole pixels: no anti-aliased edges, ever. */
  function blitSprite(ctx, spr, name, scale, screenX, groundY, clipY, alpha, force) {
    var sw, sh, ax = 0.5, ay = 1, canvas = null;
    if (spr && spr.canvas && spr.w > 0) {
      canvas = spr.canvas; sw = spr.w; sh = spr.h;
      if (spr.anchor) { ax = spr.anchor.x; ay = spr.anchor.y; }
    } else {
      if (spritesPresent() && !force) { return; }   /* unknown key: draw nothing */
      var nom = nominal(name);
      sw = nom[0]; sh = nom[1];
    }
    var dw = ir(sw * scale * SPR_K);
    var dh = ir(sh * scale * SPR_K);
    if (dw < 1) { dw = 1; }
    if (dh < 1) { dh = 1; }
    if (dw > W * 5 || dh > H * 7) { return; }

    var dx = ir(screenX - dw * ax);
    var dy = ir(groundY - dh * ay);
    if (dx > W || dx + dw < 0) { return; }
    if (dy > H || dy + dh < -8) { return; }

    /* a roadside object that is 90% off-screen reads as a glitch, not as a
       roadside object: drop slivers entirely instead of parking half a block
       on the screen edge */
    var visL = dx > 0 ? dx : 0;
    var visR = (dx + dw) < W ? (dx + dw) : W;
    var visW = visR - visL;
    if (visW < 10 || visW < dw * 0.30) { return; }

    var clipH = 0;
    if (clipY > 0) { clipH = dy + dh - clipY; if (clipH < 0) { clipH = 0; } }
    if (clipH >= dh) { return; }
    var drawH = dh - clipH;
    if (drawH < 1) { return; }

    if (alpha !== undefined && alpha < 1) {
      ctx.globalAlpha = alpha < 0 ? 0 : alpha;
    }
    if (canvas) {
      ctx.drawImage(canvas, 0, 0, sw, sh * (drawH / dh), dx, dy, dw, drawH);
    } else {
      setFill(ctx, placeColour(name));
      ctx.fillRect(dx, dy, dw, drawH);
    }
    if (alpha !== undefined && alpha < 1) { ctx.globalAlpha = 1; }
  }

  /* fixed-size centred blit (crash FX) */
  function blitFixed(ctx, name, cx, cy, size, alpha) {
    var spr = spriteFor(name);
    var sw, sh, canvas = null;
    if (spr && spr.canvas && spr.w > 0) { canvas = spr.canvas; sw = spr.w; sh = spr.h; }
    else {
      if (spritesPresent()) { return; }
      var nom = nominal(name); sw = nom[0]; sh = nom[1];
    }
    var dh = ir(size * (sh / sw)), dw = ir(size);
    if (dw < 1 || dh < 1) { return; }
    var dx = ir(cx - dw / 2), dy = ir(cy - dh / 2);
    if (alpha !== undefined && alpha < 1) { ctx.globalAlpha = alpha < 0 ? 0 : alpha; }
    if (canvas) { ctx.drawImage(canvas, 0, 0, sw, sh, dx, dy, dw, dh); }
    else { setFill(ctx, placeColour(name)); ctx.fillRect(dx, dy, dw, dh); }
    if (alpha !== undefined && alpha < 1) { ctx.globalAlpha = 1; }
  }

  /* ====================================================== PRE-RENDER PASSES */

  function buildSky(theme) {
    var cv = CORE.makeCanvas(W, H);
    var g = cv.getContext('2d');
    var sky = (theme.sky && theme.sky.length) ? theme.sky : ['#000000', '#101010'];
    var steps = 6;                     /* sub-bands per colour pair */
    var bands = (sky.length - 1) * steps;
    var y, i, c, t;

    /* hard horizontal bands with a dithered 1px seam: 1986, not 2010 */
    for (i = 0; i < bands; i++) {
      var y0 = Math.floor(HORIZON * i / bands);
      var y1 = Math.floor(HORIZON * (i + 1) / bands);
      var f = i / steps;
      var idx = Math.floor(f);
      var frac = f - idx;
      if (idx >= sky.length - 1) { idx = sky.length - 2; frac = 1; }
      c = mix(sky[idx], sky[idx + 1], frac);
      setFill(g, c);
      g.fillRect(0, y0, W, y1 - y0);
      if (i > 0 && (i % steps) === 0) {
        /* dithered seam between two source colours */
        var a = sky[idx], b = sky[idx + 1], x;
        for (x = 0; x < W; x += 2) {
          setFill(g, a); g.fillRect(x, y0, 1, 1);
          setFill(g, b); g.fillRect(x + 1, y0, 1, 1);
        }
      }
    }

    /* ground haze below the horizon: fog -> grass, so distant gaps read deep */
    var gcol = theme.grassDark || '#000000';
    var fcol = theme.fog || '#000000';
    var gb = 7;
    for (y = HORIZON; y < H; y += 1) {
      t = (y - HORIZON) / (H - HORIZON);
      t = t * t;
      if (((y - HORIZON) % gb) === 0) { c = mix(fcol, gcol, t); }
      setFill(g, c);
      g.fillRect(0, y, W, 1);
    }
    L.sky = cv;
  }

  function buildStars(theme) {
    if (!theme.stars) { L.stars = null; return; }
    var cv = CORE.makeCanvas(W, HORIZON);
    var g = cv.getContext('2d');
    var rng = CORE.rng(97531);
    var i, x, y, b;
    for (i = 0; i < 150; i++) {
      x = Math.floor(rng() * W);
      y = Math.floor(rng() * (HORIZON - 12));
      b = rng();
      if (b > 0.94) {
        g.fillStyle = 'rgba(255,255,255,0.95)';
        g.fillRect(x, y, 2, 2);
        g.fillStyle = 'rgba(160,200,255,0.45)';
        g.fillRect(x - 1, y, 1, 1); g.fillRect(x + 2, y, 1, 1);
      } else if (b > 0.6) {
        g.fillStyle = 'rgba(220,235,255,0.75)';
        g.fillRect(x, y, 1, 1);
      } else {
        g.fillStyle = 'rgba(150,180,230,0.42)';
        g.fillRect(x, y, 1, 1);
      }
    }
    L.stars = cv;
  }

  /* big slitted sun, baked once.  sunRadius is a fraction of screen width,
     sunY a fraction of the horizon height. */
  function buildSun(theme) {
    var r = Math.max(10, Math.round(W * numOr(theme.sunRadius, 0.25) / 2));
    var size = r * 2 + 4;
    var cv = CORE.makeCanvas(size, size);
    var g = cv.getContext('2d');
    var cx = size / 2, cy = size / 2;
    var core = theme.sunCore || '#ffffff';
    var glow = theme.sunGlow || '#ff9900';
    var band = theme.sunBand || '#cc3366';
    var period = Math.max(4, Math.round(r / 6));
    var y, dy, hw, x0, x1, i, p, cut, col;

    L.sunX = ir(W / 2 - size / 2);
    L.sunY = ir(HORIZON * clamp(numOr(theme.sunY, 0.5), 0.05, 1.2) - size / 2);
    var maxRow = Math.min(size, HORIZON + 6 - L.sunY);

    /* glow halo: 4 coarse hard-edged rings */
    for (i = 4; i >= 1; i--) {
      var rr = r + i * Math.max(3, Math.round(r / 7));
      g.globalAlpha = 0.075 * (5 - i) / 4;
      g.fillStyle = glow;
      for (y = 0; y < maxRow; y++) {
        dy = (y + 0.5) - cy;
        hw = rr * rr - dy * dy;
        if (hw <= 0) { continue; }
        hw = Math.sqrt(hw);
        x0 = ir(cx - hw); x1 = ir(cx + hw);
        if (x1 > x0) { g.fillRect(x0, y, x1 - x0, 1); }
      }
    }
    g.globalAlpha = 1;

    /* disc: solid bright upper half, then hard colour bands with slits that
       widen towards the horizon.  Bands are DISCRETE (no long ramp) so the
       palette stays saturated instead of averaging the sky into an olive mud. */
    var top = Math.max(0, ir(cy - r));
    var bot = Math.min(maxRow, ir(cy + r));
    var span = Math.max(1, 2 * r);
    var BANDS = 5;
    for (y = top; y < bot; y++) {
      dy = (y + 0.5) - cy;
      hw = r * r - dy * dy;
      if (hw <= 0) { continue; }
      hw = Math.sqrt(hw);
      p = clamp(((y + 0.5) - (cy - r)) / span, 0, 1);
      if (p > 0.32) {
        cut = Math.round(period * ((p - 0.32) / 0.68) * 0.46);
        if (cut > 0 && ((y - top) % period) < cut) { continue; }
      }
      var bi = Math.floor(p * BANDS);
      if (bi <= 0) { col = core; }
      else if (bi === 1) { col = mix(core, glow, 0.55); }
      else if (bi === 2) { col = glow; }
      else if (bi === 3) { col = mix(glow, band, 0.6); }
      else { col = band; }
      setFill(g, col);
      x0 = ir(cx - hw); x1 = ir(cx + hw);
      if (x1 > x0) { g.fillRect(x0, y, x1 - x0, 1); }
    }

    L.sun = cv; L.sunW = size; L.sunH = size;
  }

  /* A seamless mountain / treeline ridge: height is the sum of harmonics that
     complete a whole number of cycles across the tile, so x=0 joins x=PAR_W. */
  function buildRidge(h, colour, fogColour, seed, lo, hi, freqBoost) {
    var cv = CORE.makeCanvas(PAR_W, h);
    var g = cv.getContext('2d');
    var rng = CORE.rng(seed);
    var tab = new Array(PAR_W);
    var i, j, v, minV = 1e9, maxV = -1e9;

    for (i = 0; i < PAR_W; i++) { tab[i] = rng(); }
    for (j = 0; j < 2; j++) {
      var out = new Array(PAR_W);
      for (i = 0; i < PAR_W; i++) {
        out[i] = (tab[(i - 1 + PAR_W) % PAR_W] + tab[i] * 2 + tab[(i + 1) % PAR_W]) / 4;
      }
      tab = out;
    }

    var prof = new Array(PAR_W);
    for (i = 0; i < PAR_W; i++) {
      var t = (i / PAR_W) * CORE.TAU;
      v = 0.50 * tab[i]
        + 0.24 * Math.abs(Math.sin(t * 3 + 0.7))
        + 0.16 * Math.abs(Math.sin(t * 7 + 2.1))
        + (0.10 + freqBoost) * Math.abs(Math.sin(t * 17 + 4.4));
      prof[i] = v;
      if (v < minV) { minV = v; }
      if (v > maxV) { maxV = v; }
    }
    var span = (maxV - minV) || 1;
    var hh = new Array(PAR_W);
    for (i = 0; i < PAR_W; i++) {
      hh[i] = Math.round(lo + ((prof[i] - minV) / span) * (hi - lo));
      if (hh[i] < 1) { hh[i] = 1; }
      if (hh[i] > h) { hh[i] = h; }
    }

    /* fill row by row so the ridge itself carries its own fog gradient; the
       weight stays low so the mountains keep their palette instead of going
       grey-brown behind the haze */
    var x, y, run, c;
    for (y = 0; y < h; y++) {
      c = mix(colour, fogColour, 0.04 + 0.36 * (y / h));
      setFill(g, c);
      run = -1;
      for (x = 0; x <= PAR_W; x++) {
        var covered = (x < PAR_W) && ((h - hh[x]) <= y);
        if (covered) { if (run < 0) { run = x; } }
        else if (run >= 0) { g.fillRect(run, y, x - run, 1); run = -1; }
      }
    }
    return cv;
  }

  /* The canvas CRT overlay is deliberately thin: scanlines live in styles.css
     (`.glass::after`, drawn at OUTPUT resolution) because a 1px row inside the
     384x216 buffer turns into a fat band once integerscaled.  What is left
     here is only what must be baked into the pixels: vignette + a whisper of
     tint.  Average brightness must stay within a few percent of the raw frame. */
  function buildCrt(theme) {
    var cv = CORE.makeCanvas(W, H);
    var g = cv.getContext('2d');
    var y, x, a, i, V = 26;

    for (i = 0; i < V; i++) {
      a = Math.pow((V - i) / V, 2.4) * 0.30;
      g.fillStyle = 'rgba(0,0,0,' + a.toFixed(3) + ')';
      g.fillRect(i, i, W - i * 2, 1);
      g.fillRect(i, H - 1 - i, W - i * 2, 1);
      g.fillRect(i, i, 1, H - i * 2);
      g.fillRect(W - 1 - i, i, 1, H - i * 2);
    }

    /* corner falloff on top of the edge vignette */
    for (i = 0; i < 20; i++) {
      a = Math.pow(i / 20, 2.2) * 0.13;
      g.fillStyle = 'rgba(0,0,0,' + a.toFixed(3) + ')';
      g.fillRect(0, i, 20 - i, 1);
      g.fillRect(W - (20 - i), i, 20 - i, 1);
      g.fillRect(0, H - 1 - i, 20 - i, 1);
      g.fillRect(W - (20 - i), H - 1 - i, 20 - i, 1);
    }

    /* a barely-there phosphor tint, weighted so it costs ~2% brightness */
    for (y = 0; y < H; y += 4) {
      g.fillStyle = rgba(theme.crtTint || '#000000', 0.045);
      g.fillRect(0, y, W, 4);
    }
    L.crt = cv;
  }

  function ensureLayers(theme) {
    if (!theme) { return; }
    var key = theme.key || 'x';
    if (!needLayers && L.ok && layerKey === key) { return; }
    needLayers = false;
    layerKey = key;
    L.ok = false;
    try {
      buildSky(theme);
      buildStars(theme);
      buildSun(theme);
      L.far = buildRidge(78, theme.mountFar || '#221133', theme.fog || '#000000', 4242, 18, 66, 0.0);
      L.near = buildRidge(58, theme.mountNear || '#332255', theme.fog || '#000000', 8484, 12, 50, 0.03);
      L.tree = buildRidge(26, theme.grassDark || '#113322', theme.fog || '#000000', 1268, 8, 24, 0.16);
      buildCrt(theme);
      L.ok = true;
    } catch (e) {
      L.ok = false;
    }
  }

  /* ================================================== PER-FRAME CAMERA SETUP */

  function idxOfZ(state, z) {
    var segs = state.segments, n = segs.length;
    var len = cam.trackLength || (n * T.SEGMENT_LENGTH);
    var i = Math.floor(CORE.wrapZ(z, len) / T.SEGMENT_LENGTH);
    if (!(i >= 0)) { i = 0; }
    if (i >= n) { i = n - 1; }
    return i;
  }

  function computeCamera(state, theme) {
    var segs = state.segments;
    var n = (segs && segs.length) ? segs.length : 0;

    cam.theme = theme;
    cam.n = n;
    cam.cameraDepth = numOr(state.cameraDepth, T.CAMERA_DEPTH);
    if (!(cam.cameraDepth > 0.01)) { cam.cameraDepth = T.CAMERA_DEPTH; }
    cam.cameraHeight = numOr(state.cameraHeight, T.CAMERA_HEIGHT);
    cam.playerZ = numOr(state.playerZ, T.PLAYER_Z);
    if (!(cam.playerZ > 0.01)) { cam.playerZ = T.PLAYER_Z; }
    cam.position = CORE.wrapZ(numOr(state.position, 0), n * T.SEGMENT_LENGTH || 1);
    cam.trackLength = numOr(state.trackLength, n * T.SEGMENT_LENGTH);
    if (!(cam.trackLength > 0)) { cam.trackLength = n * T.SEGMENT_LENGTH || 1; }
    cam.playerX = numOr(state.playerX, 0);
    cam.drawDistance = (quality === 'low') ? LOW_DRAW : T.DRAW_DISTANCE;

    if (n > 0) {
      cam.baseIndex = idxOfZ(state, cam.position);
      cam.basePercent = CORE.percentRemaining(cam.position, T.SEGMENT_LENGTH);
      if (!(cam.basePercent >= 0)) { cam.basePercent = 0; }
      cam.baseSegment = segs[cam.baseIndex];
      cam.playerSegIndex = idxOfZ(state, cam.position + cam.playerZ);
      cam.playerPercent = CORE.percentRemaining(cam.position + cam.playerZ, T.SEGMENT_LENGTH);
      if (!(cam.playerPercent >= 0)) { cam.playerPercent = 0; }
      cam.playerSegment = segs[cam.playerSegIndex];
      cam.roadY = CORE.lerp(cam.playerSegment.p1.world.y, cam.playerSegment.p2.world.y, cam.playerPercent);
      /* smoothed road pitch under the player: drives the parallax tilt.  Using
         the absolute road height instead would slide the whole sky when the
         track simply sits in a valley. */
      var ahead = segs[(cam.playerSegIndex + 6) % n];
      cam.pitch = clamp((ahead.p1.world.y - cam.roadY) / (6 * T.SEGMENT_LENGTH), -1.5, 1.5);
    } else {
      cam.baseIndex = 0; cam.basePercent = 0; cam.baseSegment = null;
      cam.playerSegIndex = 0; cam.playerPercent = 0; cam.playerSegment = null;
      cam.roadY = 0; cam.pitch = 0;
    }

    /* shake: the renderer owns state.shakeX / state.shakeY */
    var sh = clamp(numOr(state.shake, 0), 0, 12);
    if (state.offRoad) { sh = sh + 0.7; }
    if (sh > 0.001) {
      var f = numOr(state.frame, 0);
      state.shakeX = ir((Math.sin(f * 2.9) + Math.sin(f * 7.3) * 0.6) * sh * 1.35);
      state.shakeY = ir((Math.cos(f * 3.7) + Math.cos(f * 9.1) * 0.5) * sh * 0.9);
    } else {
      state.shakeX = 0;
      state.shakeY = 0;
    }

    /* the renderer owns state.fps; ignore sub-4ms deltas (double draws) */
    var now = CORE.now();
    if (lastNow > 0) {
      var dt = now - lastNow;
      if (dt > 4 && dt < 500) {
        var inst = 1000 / dt;
        fpsSmooth = fpsSmooth > 0 ? (fpsSmooth * 0.9 + inst * 0.1) : inst;
      }
    }
    lastNow = now;
    state.fps = fpsSmooth > 0 ? clamp(Math.round(fpsSmooth), 1, 240) : 60;

    /* camera vertical offset: hills move the horizon, plus shake and a small
       bounce the gameplay layer may add through state.playerY */
    var extraY = 0;
    var sy = numOr(state.playerY, 0);
    var dy = sy - cam.roadY;
    if (dy > -600 && dy < 600) { extraY = dy; }
    cam.camX = cam.playerX * T.ROAD_WIDTH - state.shakeX;
    cam.camY = cam.cameraHeight + cam.roadY + extraY + state.shakeY;
  }

  /* ============================================================ BACKGROUND */

  function drawBackground(ctx, state, theme) {
    /* horizon tilt comes from the road pitch, never from absolute altitude */
    var yOff = ir(clamp(cam.pitch * 9, -9, 9) + state.shakeY * 0.25);
    var sky = (theme.sky && theme.sky.length) ? theme.sky : ['#000000'];
    var skip = numOr(state.skyOffset, 0);
    var hill = numOr(state.hillOffset, 0);
    var tree = numOr(state.treeOffset, 0);
    var base = ir(HORIZON + yOff);
    var i, x;

    if (L.ok && L.sky) {
      setFill(ctx, sky[0]);
      ctx.fillRect(0, 0, W, yOff > 0 ? yOff : 0);
      ctx.drawImage(L.sky, 0, yOff < 0 ? yOff : 0);
    } else {
      /* degraded path (no canvas factory): flat hard bands, still cheap */
      var bands = sky.length;
      for (i = 0; i < bands; i++) {
        setFill(ctx, sky[i]);
        var y0 = ir(base * i / bands), y1 = ir(base * (i + 1) / bands);
        ctx.fillRect(0, y0, W, y1 - y0);
      }
      setFill(ctx, theme.fog || '#000000');
      ctx.fillRect(0, base, W, H - base);
    }

    /* star field (night): two blits give an endless wrap */
    if (L.stars) {
      var sx = -ir((skip - Math.floor(skip)) * W);
      ctx.drawImage(L.stars, sx, yOff);
      ctx.drawImage(L.stars, sx + W, yOff);
    }

    /* the big slitted sun sways gently with the sky offset */
    if (L.sun) {
      var sway = ir(((skip - Math.floor(skip)) - 0.5) * 34);
      ctx.drawImage(L.sun, L.sunX + sway, L.sunY + yOff);
    }

    /* two mountain ridges + a treeline, each an endless 512px tile */
    var layers = [L.far, L.near, L.tree];
    var offsets = [hill, hill * 1.7 + 0.13, tree];
    var pads = [5, 9, 13];
    for (i = 0; i < 3; i++) {
      if (!layers[i]) { continue; }
      var off = offsets[i];
      off = off - Math.floor(off);
      x = -ir(off * PAR_W);
      var ly = base + pads[i] - layers[i].height;
      ctx.drawImage(layers[i], x, ly);
      ctx.drawImage(layers[i], x + PAR_W, ly);
    }

    /* hard horizon line: one dark row pins the world to the sky */
    setFill(ctx, mix(theme.fog || '#000000', sky[sky.length - 1], 0.35));
    ctx.fillRect(0, base, W, 1);
  }

  /* ============================================================== THE ROAD */

  function drawSegment(ctx, seg, theme) {
    var s1 = seg.p1.screen, s2 = seg.p2.screen;
    var y1o = s1.y, y2o = s2.y;
    var span = y1o - y2o;
    if (!(span > 0)) { return; }
    var inv = 1 / span;
    var ya = y2o < 0 ? 0 : y2o;
    var yb = y1o > H ? H : y1o;
    if (yb <= ya) { return; }

    var dark = seg.dark;
    var x1 = s1.x, w1 = s1.w, x2 = s2.x, w2 = s2.w;
    var i, t, xx, ww, rw, l, r;

    /* verge */
    setFill(ctx, dark ? theme.grassDark : theme.grassLight);
    ctx.fillRect(0, ya, W, yb - ya);

    /* kerb: full road+kerb width in the rumble colour ... */
    setFill(ctx, dark ? theme.rumbleDark : theme.rumbleLight);
    for (i = ya; i < yb; i++) {
      t = (i - y2o) * inv;
      xx = x2 + (x1 - x2) * t;
      ww = w2 + (w1 - w2) * t;
      rw = ww / 6;
      if (rw < 0.9) { rw = 0.9; }
      l = ir(xx - ww - rw); r = ir(xx + ww + rw);
      if (r > l) { ctx.fillRect(l, i, r - l, 1); }
    }

    /* ... and the tarmac painted back over the middle, one scanline at a time
       so every edge lands on a whole pixel (no polygon anti-aliasing) */
    setFill(ctx, dark ? theme.roadDark : theme.roadLight);
    for (i = ya; i < yb; i++) {
      t = (i - y2o) * inv;
      xx = x2 + (x1 - x2) * t;
      ww = w2 + (w1 - w2) * t;
      l = ir(xx - ww); r = ir(xx + ww);
      if (r <= l) { r = l + 1; }
      ctx.fillRect(l, i, r - l, 1);
    }

    /* lane dashes */
    if (theme.lane && ((seg.index % 8) < 4)) {
      setFill(ctx, theme.lane);
      for (i = ya; i < yb; i++) {
        t = (i - y2o) * inv;
        xx = x2 + (x1 - x2) * t;
        ww = w2 + (w1 - w2) * t;
        if (ww < 3) { continue; }
        var lw = ww / 32;
        if (lw < 0.5) { lw = 0.5; }
        var laneSpan = (ww * 2) / LANES;
        var bx = xx - ww;
        for (var ln = 1; ln < LANES; ln++) {
          var cxp = bx + laneSpan * ln;
          l = ir(cxp - lw); r = ir(cxp + lw);
          if (r <= l) { r = l + 1; }
          ctx.fillRect(l, i, r - l, 1);
        }
      }
    }

    /* chequered start/finish band */
    if (seg.index < 2) {
      var blocks = 10;
      for (i = ya; i < yb; i++) {
        t = (i - y2o) * inv;
        xx = x2 + (x1 - x2) * t;
        ww = w2 + (w1 - w2) * t;
        if (ww < 4) { continue; }
        var bw = (ww * 2) / blocks;
        var b0 = xx - ww;
        for (var b = 0; b < blocks; b++) {
          setFill(ctx, ((b + (i >> 2)) % 2) ? '#f5efe2' : '#1a1a26');
          ctx.fillRect(ir(b0 + bw * b), i, ir(bw) + 1, 1);
        }
      }
    }

    /* exponential fog to the theme colour */
    var fogA = 1 - seg.fog;
    if (fogA > 0.004) {
      if (fogA > 1) { fogA = 1; }
      ctx.globalAlpha = fogA;
      setFill(ctx, theme.fog || '#000000');
      ctx.fillRect(0, ya, W, yb - ya);
      ctx.globalAlpha = 1;
    }
  }

  function drawRoad(ctx, state) {
    var segs = state.segments;
    var n = cam.n;
    var theme = cam.theme;
    var density = numOr(theme.fogDensity, T.FOG_DENSITY);
    var maxy = H;
    var x = 0;
    var dx = -(cam.baseSegment.curve * cam.basePercent);
    var k, seg, looped, zAdj;

    for (k = 0; k < cam.drawDistance; k++) {
      seg = segs[(cam.baseIndex + k) % n];
      looped = seg.index < cam.baseIndex;
      seg.looped = looped;
      seg.fog = expFog(k / cam.drawDistance, density);
      seg.clip = maxy;
      seg.light = 1 - k / cam.drawDistance;
      zAdj = cam.position - (looped ? cam.trackLength : 0);

      projectPoint(seg.p1, cam.camX - x, cam.camY, zAdj, cam.cameraDepth, W, H, T.ROAD_WIDTH);
      projectPoint(seg.p2, cam.camX - x - dx, cam.camY, zAdj, cam.cameraDepth, W, H, T.ROAD_WIDTH);

      x += dx;
      dx += seg.curve;

      if (seg.p1.camera.z <= cam.cameraDepth) { continue; }
      if (seg.p2.screen.y >= seg.p1.screen.y) { continue; }
      if (seg.p2.screen.y >= maxy) { continue; }
      drawSegment(ctx, seg, theme);
      maxy = seg.p2.screen.y;
    }
  }

  /* ------------------------------------------------------------ world pass */

  /* ROAD.project is the contract implementation; the local copy keeps the
     renderer self-sufficient if it is ever loaded without road.js. */
  var _projProject = null;
  function projectPoint(p, cx, cy, cz, cd, w, h, rw) {
    if (!_projProject) {
      _projProject = (typeof ROAD !== 'undefined' && ROAD && ROAD.project) ? ROAD.project : localProject;
    }
    return _projProject(p, cx, cy, cz, cd, w, h, rw);
  }

  function localProject(p, cameraX, cameraY, cameraZ, cameraDepth, width, height, roadWidth) {
    var w = p.world;
    var cz = (w.z || 0) - cameraZ;
    var scale = cameraDepth / cz;
    p.camera.x = (w.x || 0) - cameraX;
    p.camera.y = (w.y || 0) - cameraY;
    p.camera.z = cz;
    p.screen.scale = scale;
    p.screen.x = Math.round((width / 2) + (scale * p.camera.x * width / 2));
    p.screen.y = Math.round((height / 2) - (scale * p.camera.y * height / 2));
    p.screen.w = Math.round(scale * roadWidth * width / 2);
    return p;
  }

  /* Car buckets, one per draw slot, rebuilt every frame from state.cars.
     Falls back to segment.cars when gameplay keeps the buckets instead. */
  function fillBuckets(state) {
    var i;
    if (bucketCap < cam.drawDistance) {
      for (i = bucketCap; i < cam.drawDistance; i++) { buckets[i] = []; }
      bucketCap = cam.drawDistance;
    } else {
      for (i = 0; i < cam.drawDistance; i++) { buckets[i].length = 0; }
    }
    var cars = state.cars;
    var n = cam.n;
    var used = false;
    if (cars && cars.length) {
      for (i = 0; i < cars.length; i++) {
        var c = cars[i];
        if (!c) { continue; }
        var z = numOr(c.z, NaN);
        var si;
        if (z === z) { si = idxOfZ(state, z); }
        else { si = c.segIndex | 0; }
        var off = si - cam.baseIndex;
        if (off < 0) { off += n; }
        if (off > 0 && off < cam.drawDistance) { buckets[off].push(c); used = true; }
      }
    }
    if (!used) {
      /* gameplay may instead maintain segment.cars; copy, never alias —
         clearing a bucket must never clear gameplay's own array */
      for (i = 1; i < cam.drawDistance; i++) {
        var seg = state.segments[(cam.baseIndex + i) % n];
        if (seg.cars && seg.cars.length) {
          for (var j = 0; j < seg.cars.length; j++) {
            if (seg.cars[j]) { buckets[i].push(seg.cars[j]); }
          }
        }
      }
    }
    return buckets;
  }

  function drawWorld(ctx, state) {
    var segs = state.segments;
    var n = cam.n;
    var roadWidth = T.ROAD_WIDTH;
    var k, i, seg, spr, list, scale, sx, sy;
    var theme = cam.theme;
    var cars = fillBuckets(state);

    for (k = cam.drawDistance - 1; k > 0; k--) {
      seg = segs[(cam.baseIndex + k) % n];
      if (!(seg.p1.screen.scale > 0)) { continue; }

      list = cars[k];
      for (i = 0; i < list.length; i++) {
        var car = list[i];
        var pct = numOr(car.percent, 0.5);
        if (pct < 0) { pct = 0; } else if (pct > 1) { pct = 1; }
        scale = CORE.lerp(seg.p1.screen.scale, seg.p2.screen.scale, pct);
        sx = CORE.lerp(seg.p1.screen.x, seg.p2.screen.x, pct) +
          CORE.lerp(seg.p1.screen.w, seg.p2.screen.w, pct) * numOr(car.offset, 0);
        sy = CORE.lerp(seg.p1.screen.y, seg.p2.screen.y, pct);
        blitSprite(ctx, spriteFor(car.sprite), car.sprite, scale, sx, sy, seg.clip);
      }

      for (i = seg.sprites.length - 1; i >= 0; i--) {
        spr = seg.sprites[i];
        scale = seg.p1.screen.scale * numOr(spr.scale, 1);
        if (!(scale > 0)) { continue; }
        sx = seg.p1.screen.x + seg.p1.screen.w * numOr(spr.offset, 0);
        sy = seg.p1.screen.y;
        blitSprite(ctx, spriteFor(spr.source), spr.source, scale, sx, sy, seg.clip);
      }

      /* checkpoint gate: a pair of posts when no arch sprite exists */
      if (isCheckpoint(state, seg.index) && seg.p1.screen.w > 6) {
        drawGate(ctx, seg, theme);
      }
    }
  }

  function isCheckpoint(state, index) {
    var cps = state.checkpoints;
    if (!cps || !cps.length) { return false; }
    for (var i = 0; i < cps.length; i++) { if (cps[i] === index) { return true; } }
    return false;
  }

  function drawGate(ctx, seg, theme) {
    var s = seg.p1.screen;
    /* a 3000-unit tall gantry over a 2000-unit half-width road */
    var h = clamp(s.w * 1.5, 6, 96);
    var hw = s.w * 1.06;
    var x = s.x, y = s.y;
    setFill(ctx, theme.lane || '#ffffff');
    ctx.fillRect(ir(x - hw), ir(y - h), 2, ir(h));
    ctx.fillRect(ir(x + hw) - 2, ir(y - h), 2, ir(h));
    setFill(ctx, theme.rumbleDark || '#ff2fb9');
    ctx.fillRect(ir(x - hw), ir(y - h), ir(hw * 2), 2);
    setFill(ctx, theme.rumbleLight || '#f5efe2');
    ctx.fillRect(ir(x - hw), ir(y - h) + 2, ir(hw * 2), 1);
  }

  /* ------------------------------------------------------------- the hero -- */

  function drawPlayer(ctx, state, theme) {
    if (!cam.playerSegment) { return; }
    var seg = cam.playerSegment;
    var scale = cam.cameraDepth / cam.playerZ;
    var speedPct = clamp(numOr(state.speed, 0) / T.MAX_SPEED, 0, 1);
    var steer = clamp(numOr(state.steer, 0), -1, 1);
    var offRoad = !!state.offRoad || Math.abs(cam.playerX) > 1;
    var frame = numOr(state.frame, 0);

    var hero = null;
    if (typeof SPRITES !== 'undefined' && SPRITES && SPRITES.HERO) { hero = SPRITES.HERO; }
    var key = (numOr(state.brake, 0) > 0.5 || state.skid) ? 'brake'
      : (steer < -0.18 ? 'left' : (steer > 0.18 ? 'right' : 'straight'));
    var name = (hero && hero[key]) ? hero[key] : ('player_' + key);
    var shadowName = (hero && hero.shadow) ? hero.shadow : 'player_shadow';
    var spr = spriteFor(name);
    if (!spr && spritesPresent() && hero && hero.straight) {
      name = hero.straight; spr = spriteFor(name);
    }

    var groundY = H / 2 - scale *
      CORE.lerp(seg.p1.camera.y, seg.p2.camera.y, cam.playerPercent) * H / 2;

    var bounce = speedPct * (offRoad ? 3.2 : 1.1) *
      (Math.sin(frame * 1.9) * 0.5 + Math.sin(frame * 5.3) * 0.5);
    if (offRoad) { bounce = bounce + Math.sin(frame * 17.7) * 1.6; }
    groundY = groundY + clamp(bounce, -4, 4);

    var cx = W / 2 + steer * 9;
    var alpha = 1;
    if (numOr(state.hitTimer, 0) > 0 && (frame % 6) < 3) { alpha = 0.35; }

    /* drift smoke / skid marks under the car */
    if (state.skid && speedPct > 0.2) {
      ctx.globalAlpha = 0.45;
      setFill(ctx, '#1a1a1a');
      ctx.fillRect(ir(cx - 26), ir(groundY - 3), 8, 3);
      ctx.fillRect(ir(cx + 18), ir(groundY - 3), 8, 3);
      ctx.globalAlpha = 1;
    }

    blitSprite(ctx, spriteFor(shadowName), shadowName, scale, cx, groundY + 1, 0, alpha * 0.75, true);
    blitSprite(ctx, spr, name, scale, cx, groundY, 0, alpha, true);
  }

  /* ================================================================== HUD == */

  function txt(ctx, s, x, y, colour, scale, align) {
    return CORE.drawText(ctx, s, x, y, {
      color: colour, scale: scale, spacing: 1, align: align || 'left', shadow: '#000000'
    });
  }

  /* Full-screen arcade type: a hard 1-2px outline instead of a drop shadow, so
     it stays legible over any amount of scenery behind it. */
  function bigTxt(ctx, s, x, y, colour, scale, align, outline) {
    outline = outline || '#0a0512';
    var o = scale >= 4 ? 2 : 1;
    var dx, dy;
    for (dy = -o; dy <= o; dy += o) {
      for (dx = -o; dx <= o; dx += o) {
        if (dx === 0 && dy === 0) { continue; }
        CORE.drawText(ctx, s, x + dx, y + dy, {
          color: outline, scale: scale, spacing: 1, align: align || 'center'
        });
      }
    }
    return CORE.drawText(ctx, s, x, y, {
      color: colour, scale: scale, spacing: 1, align: align || 'center'
    });
  }

  function bar(ctx, x, y, w, h, pct, blocks, lo, mid, hi) {
    var i, on, bx, bw = (w - (blocks - 1)) / blocks;
    var filled = Math.round(clamp(pct, 0, 1) * blocks);
    for (i = 0; i < blocks; i++) {
      on = i < filled;
      bx = ir(x + i * (bw + 1));
      if (on) {
        var f = i / (blocks - 1);
        setFill(ctx, f < 0.55 ? lo : (f < 0.8 ? mid : hi));
      } else {
        setFill(ctx, '#171326');
      }
      ctx.fillRect(bx, y, ir(bw) + 1, h);
    }
  }

  function drawHud(ctx, state, theme) {
    var speed = numOr(state.speed, 0);
    var kmh = Math.round(clamp(speed / T.MAX_SPEED, 0, 1) * 320);
    var rpm = clamp(numOr(state.rpm, 0), 0, 1);
    var gear = numOr(state.gear, 1) | 0;
    if (gear < 1) { gear = 1; }
    var timeLeft = numOr(state.timeLeft, 0);
    var warn = timeLeft <= 15;
    var danger = timeLeft <= 8;
    var frame = numOr(state.frame, 0);
    var blink = (frame % 30) < 18;
    var mode = state.mode || 'race';

    /* ---- top left: countdown clock + lap ---- */
    panel(ctx, 4, 3, 104, 38, 'rgba(6,4,18,0.88)', UI.accent);
    notch(ctx, 4, 3, 104, 38, 'rgba(6,4,18,0.88)');
    txt(ctx, 'TIME', 9, 6, UI.dim, 1);
    var tcol = danger ? (blink ? UI.danger : '#7a1b1b') : (warn ? UI.warn : UI.white);
    txt(ctx, CORE.formatTime(timeLeft), 9, 14, tcol, 2);
    txt(ctx, 'LAP ' + (state.lap | 0) + '/' + (state.laps | 0), 9, 30, UI.accent2, 1);

    /* ---- top right: score ---- */
    panel(ctx, W - 108, 3, 104, 38, 'rgba(6,4,18,0.88)', UI.accent2);
    notch(ctx, W - 108, 3, 104, 38, 'rgba(6,4,18,0.88)');
    txt(ctx, 'SCORE', W - 12, 6, UI.dim, 1, 'right');
    txt(ctx, CORE.formatScore(numOr(state.score, 0)), W - 12, 14, UI.accent2, 2, 'right');
    txt(ctx, 'X' + (numOr(state.combo, 0) > 1 ? (state.combo | 0) : 1), W - 12, 30,
      numOr(state.combo, 0) > 1 ? UI.warn : UI.dim, 1, 'right');

    /* ---- top centre: track name / stage / next gate ---- */
    var tname = (state.track && state.track.name) ? state.track.name : (theme.label || '');
    txt(ctx, tname, W / 2, 6, UI.white, 1, 'center');
    txt(ctx, 'STAGE ' + ((state.stageIndex | 0) + 1), W / 2, 15, UI.dim, 1, 'center');
    var cpTxt = checkpointHint(state);
    if (cpTxt && blink) { txt(ctx, cpTxt, W / 2, 25, UI.warn, 1, 'center'); }

    /* ---- bottom left: speed ---- */
    panel(ctx, 4, H - 46, 128, 42, 'rgba(6,4,18,0.88)', UI.accent);
    notch(ctx, 4, H - 46, 128, 42, 'rgba(6,4,18,0.88)');
    txt(ctx, 'SPEED', 10, H - 42, UI.dim, 1);
    txt(ctx, CORE.pad(kmh, 3), 10, H - 34, kmh > 270 ? UI.accent : UI.white, 3);
    txt(ctx, 'KM/H', 74, H - 18, UI.dim, 1);
    bar(ctx, 10, H - 11, 116, 5, clamp(speed / T.MAX_SPEED, 0, 1), 20,
      UI.accent2, UI.warn, UI.danger);

    /* ---- bottom right: gear, rpm, lap times ---- */
    panel(ctx, W - 140, H - 46, 136, 42, 'rgba(6,4,18,0.88)', UI.accent2);
    notch(ctx, W - 140, H - 46, 136, 42, 'rgba(6,4,18,0.88)');
    txt(ctx, 'GEAR', W - 134, H - 42, UI.dim, 1);
    txt(ctx, String(gear), W - 132, H - 34, gear >= 4 ? UI.warn : UI.good, 3);
    txt(ctx, 'RPM', W - 106, H - 42, UI.dim, 1);
    bar(ctx, W - 106, H - 34, 96, 9, rpm, 12, UI.good, UI.warn, UI.danger);
    txt(ctx, 'LAP  ' + CORE.formatTime(numOr(state.lapTime, 0)), W - 106, H - 23, UI.white, 1);
    txt(ctx, 'BEST ' + CORE.formatTime(numOr(state.bestLapTime, 0)), W - 106, H - 15, UI.accent2, 1);

    /* ---- centre hints ---- */
    if (state.showFps) {
      txt(ctx, (state.fps | 0) + ' FPS', W / 2, H - 30, fpsColour(state.fps), 1, 'center');
    }
    /* OFF ROAD owns y 42-56, above the toast band, so the two never collide */
    if (state.offRoad && (frame % 20) < 12) {
      bigTxt(ctx, 'OFF ROAD', W / 2, 42, UI.danger, 2, 'center');
    }

    /* Pause is a real menu: headline, gameplay's item list, then a footer that
       reuses `state.hint` (gameplay sets it to "PAUSED", which would otherwise
       print the headline twice). */
    if (state.paused || mode === 'paused') {
      ctx.globalAlpha = 0.66;
      setFill(ctx, '#05030f');
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
      bigTxt(ctx, 'PAUSED', W / 2, 26, UI.white, 4, 'center');
      panel(ctx, 60, 74, 300, 92, 'rgba(8,5,22,0.94)', UI.accent2);
      menuList(ctx, state, 96, 86, state.menuItems, state.menuIndex, 2, 28);
      txt(ctx, hintOr(state, 'ESC TO RESUME', 'PAUSED'), W / 2, 182, UI.dim, 1, 'center');
    }
  }

  function fpsColour(f) {
    f = numOr(f, 60);
    return f >= 55 ? UI.good : (f >= 40 ? UI.warn : UI.danger);
  }

  /* `state.nextCheckpoint` is an INDEX INTO state.checkpoints (not a segment
     number): checkpoints[0] is the start/finish line and the last entry repeats
     it, so walking the index wraps you back onto the lap line. */
  function checkpointHint(state) {
    var cps = state.checkpoints;
    var n = cam.n;
    if (!cps || !cps.length || !n) { return ''; }
    var idx = numOr(state.nextCheckpoint, 0) | 0;
    if (idx < 0) { idx = 0; }
    if (idx >= cps.length) { idx = cps.length - 1; }
    var d = cps[idx] - cam.playerSegIndex;   /* cps[idx] is a segment number */
    if (d < 0) { d += n; }
    if (d < 34) { return 'CHECKPOINT'; }
    return '';
  }

  /* ============================================================== MESSAGES = */

  /* Gameplay supplies {text,color,scale,x,y,ttl,ttl0}.  Two rules keep the
     screen readable: modal screens own the whole layout (so gameplay toasts are
     suppressed there), and a toast is confined to the band between the top HUD
     block and the bottom panels so it can never collide with either. */
  var MSG_Y_MIN = 60, MSG_Y_MAX = 148;

  function drawMessages(ctx, state) {
    var msgs = state.messages;
    if (!msgs || !msgs.length) { return; }
    var mode = state.mode || 'race';
    if (mode === 'title' || mode === 'select' || mode === 'gameover' ||
      mode === 'stageclear' || mode === 'countdown' || mode === 'paused') { return; }

    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      if (!m || !m.text) { continue; }
      var ttl = numOr(m.ttl, 1);
      var ttl0 = numOr(m.ttl0, 1);
      var a = ttl0 > 0 ? clamp(ttl / ttl0, 0, 1) : 1;
      a = clamp(a * 1.8, 0, 1);
      var sc = Math.max(1, (m.scale | 0) || 2);
      var mx = numOr(m.x, 0); if (!mx) { mx = W / 2; }
      var my = numOr(m.y, 0); if (!my) { my = H / 2 - 24; }
      mx = clamp(mx, 10, W - 10);
      my = clamp(my, MSG_Y_MIN, MSG_Y_MAX);
      ctx.globalAlpha = a;
      CORE.drawText(ctx, m.text, mx, my, {
        color: m.color || UI.white, scale: sc, align: 'center', shadow: '#000000'
      });
      ctx.globalAlpha = 1;
    }
  }

  function drawCrashFx(ctx, state) {
    if (state.crash && numOr(state.crashTimer, 0) > 0) {
      var f = (numOr(state.crashFrame, 0) | 0) % 4;
      if (f < 0) { f = 0; }
      var cx = numOr(state.crashX, 0); if (!cx) { cx = W / 2; }
      var cy = numOr(state.crashY, 0); if (!cy) { cy = H / 2 + 20; }
      blitFixed(ctx, 'boom_' + f, cx, cy, 64, 1);
    }
  }

  /* the hit flash goes over everything except the CRT, so the whole cabinet
     blinks rather than just the world layer */
  function drawFlash(ctx, state) {
    var fl = numOr(state.flash, 0);
    if (fl > 0.01) {
      ctx.globalAlpha = clamp(fl, 0, 1) * 0.8;
      setFill(ctx, '#ffffff');
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
  }

  /* ========================================================= MODE SCREENS = */

  function blinkOn(state, period) {
    return (numOr(state.frame, 0) % (period || 40)) < (period || 40) * 0.62;
  }

  /* Gameplay's `state.hint` often restates the screen headline ("PAUSED").
     Printing both looks like a bug, so a hint that is only a repeat of the
     headline is dropped. */
  function sameWords(a, b) {
    var na = String(a === undefined || a === null ? '' : a).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    var nb = String(b === undefined || b === null ? '' : b).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    return na.length > 0 && na === nb;
  }

  function hintOr(state, fallback, headline) {
    var h = state.hint ? String(state.hint) : '';
    if (!h) { return fallback; }
    if (headline && sameWords(h, headline)) { return fallback; }
    return h;
  }

  function menuList(ctx, state, x, y, items, index, scale, lineH) {
    if (!items || !items.length) { return; }
    scale = scale || 2;
    lineH = lineH || 18;
    for (var i = 0; i < items.length; i++) {
      var sel = (i === (index | 0));
      var label = items[i];
      if (label && typeof label === 'object') { label = label.label || label.name || ''; }
      var yy = y + i * lineH;
      if (sel) {
        panel(ctx, x - 8, yy - 3, 250, scale * 7 + 6, rgba(UI.accent, 0.85), UI.accent2);
        txt(ctx, '\u25B6 ' + label, x, yy, '#100018', scale);
      } else {
        txt(ctx, '  ' + label, x, yy, UI.dim, scale);
      }
    }
  }

  function drawScreen(ctx, state) {
    var mode = state.mode || 'race';
    var frame = numOr(state.frame, 0);
    var i;

    if (mode === 'boot') {
      setFill(ctx, '#05030f');
      ctx.fillRect(0, 0, W, H);
      bigTxt(ctx, 'NEON DRIFT 86', W / 2, 84, UI.accent, 3, 'center');
      txt(ctx, 'SYSTEM BOOT', W / 2, 118, UI.dim, 1, 'center');
      var bw = 160, bp = (frame % 90) / 90;
      panel(ctx, W / 2 - bw / 2, 130, bw, 8, '#120c26', UI.dim);
      setFill(ctx, UI.accent2);
      ctx.fillRect(W / 2 - bw / 2 + 1, 131, ir((bw - 2) * bp), 6);
      return;
    }

    /* Title logo slots, 384x216: NEON 22-57, DRIFT 60-95, '86 100-121,
       ARCADE RACING 124-131, prompt 142-156, control hint 164-171,
       coin 180-187, best 192-199, (c) 204-211.  Nothing overlaps. */
    if (mode === 'title') {
      ctx.globalAlpha = 0.60;
      setFill(ctx, '#05030f');
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;

      var pulse = 0.55 + Math.sin(frame * 0.07) * 0.28;
      bigTxt(ctx, 'NEON', W / 2, 22, UI.accent, 5, 'center');
      bigTxt(ctx, 'DRIFT', W / 2, 60, UI.accent2, 5, 'center');
      bigTxt(ctx, "'86", W / 2, 100, UI.warn, 3, 'center');
      txt(ctx, 'ARCADE RACING', W / 2, 124, rgba(UI.white, pulse), 1, 'center');

      if (blinkOn(state, 44)) {
        bigTxt(ctx, hintOr(state, 'PRESS ENTER TO START', ''), W / 2, 142, UI.white, 2, 'center');
      }
      txt(ctx, 'ARROWS / WASD STEER   SPACE DRIFT   M MUTE', W / 2, 164, UI.dim, 1, 'center');
      if (blinkOn(state, 90)) {
        txt(ctx, 'INSERT COIN', W / 2, 180, UI.warn, 1, 'center');
      }
      if (numOr(state.best, 0) > 0) {
        txt(ctx, 'BEST ' + CORE.formatScore(state.best), W / 2, 192, UI.accent2, 1, 'center');
      }
      txt(ctx, 'C 1986 NEON DRIFT SYSTEMS', W / 2, 204, UI.dim, 1, 'center');
      return;
    }

    if (mode === 'select') {
      ctx.globalAlpha = 0.62;
      setFill(ctx, '#05030f');
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
      txt(ctx, 'SELECT STAGE', W / 2, 12, UI.accent, 3, 'center');
      panel(ctx, 12, 38, 360, 116, 'rgba(8,5,22,0.94)', UI.accent2);
      menuList(ctx, state, 44, 52, state.menuItems, state.menuIndex, 2, 32);
      var si = state.menuIndex | 0;
      var stg = CORE.STAGES[si] || CORE.STAGES[0];
      bigTxt(ctx, stg.name, W / 2, 162, UI.white, 2, 'center');
      txt(ctx, 'LAPS ' + stg.laps + '   TRAFFIC ' + stg.traffic + '   LIMIT ' + stg.timeLimit + 'S',
        W / 2, 184, UI.dim, 1, 'center');
      if (blinkOn(state, 44)) {
        txt(ctx, hintOr(state, 'ENTER TO RACE', ''), W / 2, 200, UI.warn, 1, 'center');
      }
      return;
    }

    if (mode === 'countdown') {
      var cd = numOr(state.countdown, 0);
      var n = Math.ceil(cd);
      bigTxt(ctx, 'GET READY', W / 2, 22, UI.white, 2, 'center');
      if (cd > 0 && n >= 1 && n <= 9) {
        bigTxt(ctx, String(n), W / 2, 48, (n <= 1 ? UI.good : UI.warn), 8, 'center');
      }
      return;
    }

    if (mode === 'gameover') {
      ctx.globalAlpha = 0.72;
      setFill(ctx, '#1a0208');
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
      bigTxt(ctx, 'GAME OVER', W / 2, 44, UI.danger, 5, 'center');
      txt(ctx, 'SCORE  ' + CORE.formatScore(numOr(state.score, 0)), W / 2, 104, UI.white, 2, 'center');
      txt(ctx, 'BEST   ' + CORE.formatScore(numOr(state.best, 0)), W / 2, 126, UI.accent2, 2, 'center');
      if (blinkOn(state, 44)) {
        bigTxt(ctx, hintOr(state, 'PRESS ENTER', ''), W / 2, 162, UI.warn, 2, 'center');
      }
      return;
    }

    if (mode === 'stageclear') {
      ctx.globalAlpha = 0.66;
      setFill(ctx, '#020c14');
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
      var r = state.results;
      bigTxt(ctx, 'STAGE CLEAR', W / 2, 24, UI.good, 4, 'center');
      if (r) {
        panel(ctx, 72, 64, 240, 96, 'rgba(8,5,22,0.94)', UI.accent2);
        txt(ctx, 'COURSE   ' + (r.stageName || ''), 84, 74, UI.white, 1);
        txt(ctx, 'TIME     ' + CORE.formatTime(numOr(r.totalTime, 0)), 84, 88, UI.white, 1);
        txt(ctx, 'BEST LAP ' + CORE.formatTime(numOr(r.bestLap, 0)), 84, 102, UI.accent2, 1);
        txt(ctx, 'LAPS     ' + (numOr(r.laps, 0) | 0), 84, 116, UI.white, 1);
        txt(ctx, 'SCORE    ' + CORE.formatScore(numOr(r.score, 0)), 84, 130, UI.warn, 1);
        txt(ctx, 'TOTAL    ' + CORE.formatScore(numOr(state.score, 0)), 84, 144, UI.dim, 1);
      } else {
        txt(ctx, 'SCORE ' + CORE.formatScore(numOr(state.score, 0)), W / 2, 104, UI.white, 2, 'center');
      }
      if (blinkOn(state, 44)) {
        bigTxt(ctx, hintOr(state, 'PRESS ENTER', ''), W / 2, 176, UI.warn, 2, 'center');
      }
      return;
    }

    if (mode === 'race' && state.results && state.results.finished) {
      ctx.globalAlpha = 0.66;
      setFill(ctx, '#020c14');
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
      bigTxt(ctx, 'ALL STAGES CLEAR', W / 2, 40, UI.warn, 3, 'center');
      txt(ctx, 'FINAL SCORE ' + CORE.formatScore(numOr(state.results.score, 0)), W / 2, 100, UI.white, 2, 'center');
      if (blinkOn(state, 44)) { bigTxt(ctx, 'PRESS ENTER', W / 2, 152, UI.warn, 2, 'center'); }
      return;
    }
  }

  /* ================================================================== CRT = */

  function chromaPass(ctx) {
    var src = ctx.canvas;
    if (!src || !fx0c || !fx1c) { chromaOk = false; return; }
    var g0 = fx0c, g1 = fx1c;
    /* Each staging pass isolates ONE channel into its own slot — red becomes
       (R,0,0), green (0,G,0), blue (0,0,B) — so under `lighter` the three
       draws land in three DIFFERENT channels and never sum together.  The
       in-place weight must therefore be 1, not 1/3; splitting it renders the
       entire world layer at one third brightness.
       `shift` is the fraction of a channel that is displaced; in-place and
       displaced copies always add back to 1, so the pass is luminance-exact. */
    var shift = 0.12;
    var rest = 1 - shift, moved = shift;
    var i, dy, seq = [['#ff0000', -1], ['#00ff00', 0], ['#0000ff', 1]];

    g0.globalCompositeOperation = 'source-over';
    g0.globalAlpha = 1;
    g0.clearRect(0, 0, W, H);
    g0.drawImage(src, 0, 0);

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    setFill(ctx, '#000000');
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';

    for (i = 0; i < 3; i++) {
      g1.globalCompositeOperation = 'source-over';
      g1.globalAlpha = 1;
      g1.clearRect(0, 0, W, H);
      g1.drawImage(fx0, 0, 0);
      g1.globalCompositeOperation = 'multiply';
      g1.fillStyle = seq[i][0];
      g1.fillRect(0, 0, W, H);
      g1.globalCompositeOperation = 'source-over';
      dy = seq[i][1];
      if (dy === 0) {
        ctx.globalAlpha = 1;
        ctx.drawImage(fx1, 0, 0);
      } else {
        ctx.globalAlpha = rest;
        ctx.drawImage(fx1, 0, 0);
        ctx.globalAlpha = moved;
        ctx.drawImage(fx1, 0, dy);
      }
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function tearPass(ctx, state) {
    var src = ctx.canvas;
    if (!src) { return; }
    var f = numOr(state.frame, 0) | 0;
    var tick = f % 167;
    if (tick > 5) { return; }
    var y = 16 + ((f * 37) % (H - 44));
    var h = 2 + (f % 5);
    var off = ((f % 7) - 3) * 2;
    if (off === 0) { off = 3; }
    ctx.drawImage(src, 0, y, W, h, off, y, W, h);
    setFill(ctx, 'rgba(255,255,255,0.10)');
    ctx.fillRect(0, y, W, 1);
    setFill(ctx, 'rgba(0,0,0,0.18)');
    ctx.fillRect(0, y + h, W, 1);
  }

  /* Applied to the WORLD layer only, before the HUD is drawn: bitmap text must
     never pick up a colour fringe or it stops being readable. */
  var slowRun = 0;
  function postWorld(ctx, state) {
    if (quality !== 'high') { return; }
    if (chromaOk && fx0c && fx1c) {
      /* The chroma reconstruction is the only multi-pass effect in the whole
         renderer, so it is the first thing to be sacrificed when the frame
         budget gets tight (60fps is a hard requirement). */
      var f = numOr(state.fps, 60);
      if (f < 46) { slowRun++; if (slowRun > 75) { chromaOk = false; } }
      else if (f > 52) { slowRun = 0; }
    }
    if (chromaOk && fx0c && fx1c) {
      try { chromaPass(ctx); } catch (e) { chromaOk = false; }
    }
    try { tearPass(ctx, state); } catch (e) { /* tear is cosmetic */ }
  }

  /* Applied over everything (HUD included) but only darkens pixels: vignette
     and phosphor tint.  Costs about 5% of average brightness. */
  function postScreen(ctx) {
    if (quality !== 'high') { return; }
    if (L.ok && L.crt) { ctx.drawImage(L.crt, 0, 0); }
  }

  /* ================================================================ PUBLIC */

  function init(ctx, state) {
    if (ctx) { ctxRef = ctx; }
    lastNow = 0;
    fpsSmooth = 0;
    chromaOk = true;
    slowRun = 0;
    needLayers = true;
    try {
      if (!fx0) { fx0 = CORE.makeCanvas(W, H); fx0c = fx0.getContext('2d'); }
      if (!fx1) { fx1 = CORE.makeCanvas(W, H); fx1c = fx1.getContext('2d'); }
    } catch (e) {
      fx0 = fx1 = null; fx0c = fx1c = null; chromaOk = false;
    }
    ensureLayers((state && state.theme) ? state.theme : CORE.THEMES.sunset);
  }

  function reset() {
    /* theme-keyed pre-renders (sky / ridges / sun / CRT overlay) survive a
       track change when the theme is unchanged; only per-track caches drop. */
    fpsSmooth = 0;
    lastNow = 0;
    if (buckets) { for (var i = 0; i < buckets.length; i++) { buckets[i].length = 0; } }
    _projProject = null;
  }

  function setQuality(q) {
    quality = (q === 'low') ? 'low' : 'high';
  }

  function draw(ctx, state) {
    if (!ctx) { ctx = ctxRef; }
    if (!ctx || !state) { return; }
    ctxRef = ctx;
    var theme = state.theme || CORE.THEMES.sunset;

    ensureLayers(theme);
    computeCamera(state, theme);
    ctx.imageSmoothingEnabled = false;
    ctx.__lastFill = '';

    drawBackground(ctx, state, theme);

    var mode = state.mode || 'race';
    if (cam.n > 0 && cam.baseSegment) {
      drawRoad(ctx, state);
      drawWorld(ctx, state);
      if (mode !== 'select' && mode !== 'gameover' && mode !== 'stageclear' && mode !== 'title') {
        drawPlayer(ctx, state, theme);
      }
    }
    drawCrashFx(ctx, state);

    /* world-only post: chroma + tear happen UNDER the HUD so text stays sharp */
    postWorld(ctx, state);

    if (mode === 'race' || mode === 'countdown' || mode === 'paused' || mode === 'stageclear') {
      drawHud(ctx, state, theme);
    }
    drawMessages(ctx, state);
    drawScreen(ctx, state);
    drawFlash(ctx, state);
    postScreen(ctx);
  }

  return {
    init: init,
    draw: draw,
    reset: reset,
    setQuality: setQuality
  };
})();
