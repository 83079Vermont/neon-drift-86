/* ==========================================================================
 * NEON DRIFT '86  —  src/game.js
 * Main loop, physics, collisions, checkpoints/laps, scoring and mode flow.
 * Exposes the single global `GAME` (depends on CORE; calls ROAD / SPRITES /
 * AUDIO / RENDER only if they exist, and always exactly as the contract says).
 *
 *   GAME.boot(canvas)  384x216 backbuffer + integer upscale + rAF loop start
 *   GAME.update(dt)    advance by dt seconds (fixed step inside) - hand-drivable
 *   GAME.render()      draw one frame into the backbuffer and blit it
 *   GAME.state         the frozen frame contract (CONTRACT.md 7.1)
 *   GAME.stop()        cancel the rAF loop (tools / tests)
 * ========================================================================== */
var GAME = (function () {
  'use strict';

  /* ========================================================== constants === */
  var T = CORE.TUNING;
  var W = CORE.W, H = CORE.H;
  var SEG = T.SEGMENT_LENGTH;
  var UI = CORE.UI;

  /* Feel knobs.  Everything the player notices about the handling lives here. */
  var FEEL = {
    /* --- steering --- */
    STEER_RATE_LOW: 9.0,      /* stick-to-wheel rate at a standstill (per sec)   */
    STEER_RATE_HIGH: 5.2,     /* ...and at top speed: heavy, weighty steering    */
    STEER_RETURN: 11.0,       /* self-centring when you let go (out of a corner) */
    STEER_DRIFT_RATE: 1.55,   /* multiplier while the handbrake is down          */
    LATERAL_RATE: 3.10,       /* road-widths / second at full lock & top speed   */
    LATERAL_FLOOR: 0.30,      /* how much of that you keep at walking pace       */
    CENTRIFUGAL: 0.185,       /* pull towards the outside of the curve           */
    DRIFT_CENTRIFUGAL: 1.25,  /* tail slides wider when drifting                  */
    CURVE_CLAMP: 7,           /* units of road curvature we are willing to trust */
    OFFROAD_GRIP: 0.55,       /* steering authority multiplier in the dirt       */
    SLIDE_GRIP: 0.86,         /* <1 = the car keeps sliding after you straighten */

    /* --- power --- */
    ACCEL_TAPER: 0.62,        /* how much acceleration fades near top speed      */
    ACCEL_PUNCH: 1.45,        /* extra grunt below 30% speed = launch feel       */
    PUNCH_RANGE: 0.30,
    REVERSE_MAX: 900,
    BRAKE_SKID_SPEED: 0.62,   /* braking above this % of top speed leaves marks  */

    /* --- gearbox --- */
    GEAR_TOP: [0.16, 0.34, 0.55, 0.78, 1.0],
    SHIFT_TIME: 0.26,
    SHIFT_CUT: 0.14,          /* torque cut right after a shift                  */
    SHIFT_CUT_GAIN: 0.20,

    /* --- drift --- */
    DRIFT_MIN_SPEED: 0.60,    /* contract: above 60% speed                        */
    DRIFT_MIN_STEER: 0.22,
    DRIFT_HOLD: 0.22,         /* keeps the drift alive between stick crossings   */
    DRIFT_DECEL: -1500,       /* the price of sliding: scrubbed speed            */

    /* --- collisions --- */
    PLAYER_W: 0.30,           /* in road-half-width units (48px * SPRITE_SCALE)  */
    HIT_PUSH: 0.26,
    PLAYER_X_LIMIT: 1.35,     /* hard wall: never further than this off centre   */
    CRASH_FX_TIME: 0.45,

    /* --- scoring --- */
    SCORE_PER_UNIT: 0.01,
    CHECKPOINT_SCORE: 1200,
    LAP_SCORE: 5000,
    COMBO_MAX: 8,

    /* --- timing model --- */
    PACE: 0.55,               /* reference average speed, as a fraction of max */
    INITIAL_SLACK: 0.48,      /* starting clock, as a fraction of the reference run */
    CP_SLACK: 0.50,           /* per-checkpoint refill, same fraction          */
    CP_FLAT: 1,
    CP_MIN: 3
  };

  /* ============================================================= module === */
  var state = CORE.createState();

  var canvas = null, vctx = null, back = null, bctx = null;
  var rafId = 0, running = false, lastT = 0, acc = 0, clock = 0;
  var fpsFrames = 0, fpsTime = 0;
  var windowBound = false, booted = false;

  var track = null, segments = [], cars = [], carBase = [];
  var cpCursor = 0, cpBonusArr = [];
  var input = null;

  var shakeAmt = 0, flashAmt = 0, hitTimer = 0, crashTimer = 0;
  var driftTimer = 0, hurryTimer = 0, lastBeepSec = -1;
  var musicTempo = -1, engineOn = false, engineRpm = -1;
  var menuActions = [];
  var pausedFrom = 'race';
  var quality = 'high', muted = false;
  var errorCount = 0;

  /* ============================================================ helpers === */
  function clamp(v, lo, hi) { return CORE.clamp(v, lo, hi); }
  function num(v, def) { return (typeof v === 'number' && isFinite(v)) ? v : def; }
  function safeArray(a) { return (a && a.length !== undefined) ? a : []; }

  function pushError(what) {
    errorCount++;
    if (state.errors.length > 12) { state.errors.shift(); }
    state.errors.push(String(what));
    if (errorCount <= 3 && typeof console !== 'undefined' && console.error) {
      console.error('[NEON DRIFT] ' + what);
    }
  }

  function sfx(name) {
    if (typeof AUDIO !== 'undefined' && AUDIO && AUDIO.sfx) {
      try { AUDIO.sfx(name); } catch (e) { /* audio must never break the game */ }
    }
  }
  function music(id) {
    if (typeof AUDIO !== 'undefined' && AUDIO && AUDIO.playMusic) {
      try { AUDIO.playMusic(id); } catch (e) { /* ignore */ }
    }
  }
  function setEngine(rpm, on) {
    if (typeof AUDIO === 'undefined' || !AUDIO || !AUDIO.setEngine) { return; }
    if (on === engineOn && Math.abs(rpm - engineRpm) < 0.01) { return; }
    try { AUDIO.setEngine(rpm, on); } catch (e) { /* ignore */ }
    engineOn = on;
    engineRpm = rpm;
  }

  /* ------------------------------------------------------------- messages -- */
  /* {text,color,scale,x,y,ttl,ttl0} — x is the CENTRE of the line.            */
  function pushMsg(text, color, scale, ttl, y) {
    scale = scale || 2;
    ttl = ttl || 1.2;
    var m = {
      text: String(text), color: color || UI.white, scale: scale,
      x: Math.round(W / 2),
      y: Math.round(y === undefined ? (H * 0.30) : y),
      ttl: ttl, ttl0: ttl
    };
    if (state.messages.length > 5) { state.messages.shift(); }
    state.messages.push(m);
    return m;
  }

  function updateMessages(h) {
    var i, m;
    for (i = state.messages.length - 1; i >= 0; i--) {
      m = state.messages[i];
      m.ttl -= h;
      if (!(m.ttl > 0)) { state.messages.splice(i, 1); }
    }
  }

  function flash(v) { if (v > flashAmt) { flashAmt = v; } }
  function shake(v) { if (v > shakeAmt) { shakeAmt = v; } }

  /* ============================================================== boot ==== */
  function boot(cv) {
    if (cv) { canvas = cv; }
    if (!canvas && typeof document !== 'undefined' && document.getElementById) {
      canvas = document.getElementById('game') ||
               document.getElementById('canvas') ||
               document.getElementById('screen');
    }

    back = null;
    try { back = CORE.makeCanvas(W, H); } catch (e) { pushError('backbuffer: ' + e.message); }
    bctx = (back && back.getContext) ? back.getContext('2d') : null;
    if (canvas && canvas.getContext) {
      try { vctx = canvas.getContext('2d'); } catch (e2) { vctx = null; }
    }

    /* siblings: every one of them is optional */
    if (typeof SPRITES !== 'undefined' && SPRITES && SPRITES.init) {
      try { SPRITES.init(); } catch (e3) { pushError('SPRITES.init: ' + e3.message); }
    }
    if (bctx && typeof RENDER !== 'undefined' && RENDER && RENDER.init) {
      try { RENDER.init(bctx, state); } catch (e4) { pushError('RENDER.init: ' + e4.message); }
    }
    if (typeof RENDER !== 'undefined' && RENDER && RENDER.setQuality) {
      try { RENDER.setQuality(quality); } catch (e5) { /* ignore */ }
    }
    if (typeof INPUT !== 'undefined' && INPUT && INPUT.init) {
      try { INPUT.init(canvas); } catch (e6) { /* ignore */ }
    }
    if (typeof AUDIO !== 'undefined' && AUDIO && AUDIO.init) {
      try { AUDIO.init(); } catch (e7) { /* ignore */ }
    }

    /* persisted preferences / bests */
    quality = String(CORE.storage.get('quality', 'high')) === 'low' ? 'low' : 'high';
    muted = !!CORE.storage.get('muted', false);
    state.quality = quality;
    state.muted = muted;
    if (typeof AUDIO !== 'undefined' && AUDIO && AUDIO.setMuted) {
      try { AUDIO.setMuted(muted); } catch (e8) { /* ignore */ }
    }
    state.best = num(CORE.storage.get('bestScore', 0), 0);

    layout();
    bindWindow();

    if (!booted) {
      booted = true;
      state.menuItems = [];
      state.mode = 'boot';
      state.modeTime = 0;
      state.hint = '';
    }
    startLoop();
  }

  function bindWindow() {
    if (windowBound) { return; }
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('resize', function () { layout(); });
      windowBound = true;
    }
  }

  function winW() {
    if (typeof window !== 'undefined' && window.innerWidth) { return window.innerWidth; }
    return W * 3;
  }
  function winH() {
    if (typeof window !== 'undefined' && window.innerHeight) { return window.innerHeight; }
    return H * 3;
  }

  /* Integer upscale + letterbox; the page background does the letterboxing.
   *
   * NEVER derive the scale from the canvas's own box: the canvas size is the
   * thing we are about to set, so measuring it is self-referential -- on a page
   * whose canvas has no CSS size it reports the authored 384x216, k comes out 1
   * and the game stays locked at 1x forever.
   *
   * Instead: take the largest scale the viewport could possibly hold, apply it,
   * and step down until the real box around the canvas actually fits on screen.
   * That needs no knowledge of the page structure, absorbs header/footer/padding
   * however the CSS is written, and is stable across resizes.                 */
  function applyScale(k) {
    canvas.width = W * k;
    canvas.height = H * k;
    if (canvas.style) {
      canvas.style.width = (W * k) + 'px';
      canvas.style.height = (H * k) + 'px';
      if ('imageRendering' in canvas.style) { canvas.style.imageRendering = 'pixelated'; }
    }
    if (vctx) {
      vctx.imageSmoothingEnabled = false;
      if ('mozImageSmoothingEnabled' in vctx) { vctx.mozImageSmoothingEnabled = false; }
      if ('webkitImageSmoothingEnabled' in vctx) { vctx.webkitImageSmoothingEnabled = false; }
    }
  }

  /* Does the box that holds the canvas fit on screen?
     Only the canvas's own frame is constrained: the elements around it are the
     cabinet's decoration (marquee, control legend, footnote) and the page clips
     them by design (html,body overflow:hidden), so letting them overflow buys a
     whole extra scale step instead of shrinking the game to protect a caption.
     The canvas itself is therefore never clipped.                            */
  function frameFits(vw, vh) {
    var el = canvas.parentElement;
    if (!el || !el.getBoundingClientRect) { return true; }
    var r;
    try { r = el.getBoundingClientRect(); } catch (e) { return true; }
    if (!r || typeof r.top !== 'number' || typeof r.bottom !== 'number') { return true; }
    var tol = 0.5;
    if (r.bottom > vh + tol || r.top < -tol) { return false; }
    if (typeof r.right === 'number' && r.right > vw + tol) { return false; }
    if (typeof r.left === 'number' && r.left < -tol) { return false; }
    return true;
  }

  /* 1x is the integer floor, so a viewport narrower than the frame cannot show
     the whole screen at any integer scale.  Rather than let the page clip the
     HUD (speedo on one side, timer on the other), shrink the CSS display box
     proportionally and leave the 384x216 backing store untouched: slightly soft
     on a phone, but the entire screen stays visible.  Only ever used when the
     integer path has already bottomed out at 1x and still does not fit.      */
  function setCssSize(cssW) {
    if (!canvas.style) { return; }
    canvas.style.width = cssW + 'px';
    canvas.style.height = (cssW * H / W) + 'px';
  }

  function fitCssToViewport(vw, vh) {
    var lo = 1, hi = W, best = W, mid, guard = 0;
    setCssSize(hi);
    if (frameFits(vw, vh)) { setCssSize(W); return; }     /* no shrink needed */
    best = 1;
    while (lo <= hi && guard++ < 14) {
      mid = (lo + hi) / 2;
      setCssSize(mid);
      if (frameFits(vw, vh)) { best = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    setCssSize(best);
  }

  function layout() {
    if (!canvas) { return; }
    var vw = winW(), vh = winH();

    var kMax = Math.floor(Math.min(vw / W, vh / H));
    if (!isFinite(kMax) || kMax < 1) { kMax = 1; }
    if (kMax > 12) { kMax = 12; }

    var k = kMax, guard = 0;
    applyScale(k);
    while (k > 1 && guard++ < 12 && !frameFits(vw, vh)) {
      k--;
      applyScale(k);
    }
    applyScale(k);                       /* keep exactly the size we settled on */

    /* integer scaling bottomed out and it still does not fit: go fractional in
       CSS only -- the backbuffer stays 384x216, so nothing about the game
       changes, the pixels are just displayed a little smaller.               */
    if (k === 1 && !frameFits(vw, vh)) { fitCssToViewport(vw, vh); }
  }

  function startLoop() {
    if (running) { return; }
    if (typeof requestAnimationFrame !== 'function') { running = false; return; }
    running = true;
    lastT = CORE.now();
    rafId = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    if (rafId && typeof cancelAnimationFrame === 'function') {
      try { cancelAnimationFrame(rafId); } catch (e) { /* ignore */ }
    }
    rafId = 0;
  }

  function frame(t) {
    if (!running) { return; }
    rafId = requestAnimationFrame(frame);
    var now = (typeof t === 'number' && isFinite(t)) ? t : CORE.now();
    var dt = (now - lastT) / 1000;
    lastT = now;
    update(dt);
    render();
  }

  /* ============================================================ present === */
  function fallbackFill() {
    if (!bctx) { return; }
    bctx.fillStyle = '#0b0420';
    bctx.fillRect(0, 0, W, H);
    if (CORE.drawText) {
      CORE.drawText(bctx, 'NO RENDERER', W / 2, H / 2 - 4,
        { color: UI.warn, scale: 1, align: 'center', shadow: '#000' });
    }
  }

  function present() {
    if (!vctx || !back || !canvas) { return; }
    try {
      vctx.imageSmoothingEnabled = false;
      vctx.fillStyle = '#000000';
      vctx.fillRect(0, 0, canvas.width, canvas.height);
      vctx.drawImage(back, 0, 0, back.width || W, back.height || H,
                     0, 0, canvas.width, canvas.height);
    } catch (e) { /* a broken visible context must not kill the loop */ }
  }

  function render() {
    if (!bctx) { return; }
    if (typeof RENDER !== 'undefined' && RENDER && RENDER.draw) {
      try { RENDER.draw(bctx, state); }
      catch (e) { pushError('RENDER.draw: ' + e.message); fallbackFill(); }
    } else {
      fallbackFill();
    }
    present();
  }

  /* ============================================================= input ==== */
  function snapshotInput() {
    var o = {
      left: false, right: false, up: false, down: false,
      start: false, select: false, brake: false,
      steer: 0, throttle: 0, brakeAxis: 0, handbrake: false
    };
    var s = null, ax = null;
    if (typeof INPUT !== 'undefined' && INPUT) {
      s = INPUT.state || null;
      ax = INPUT.axis || null;
      if (typeof INPUT.handbrake !== 'undefined') { o.handbrake = !!INPUT.handbrake; }
    }
    if (s) {
      o.left = !!s.left; o.right = !!s.right; o.up = !!s.up;
      o.down = !!s.down; o.start = !!s.start; o.select = !!s.select;
      o.brake = !!s.brake;
      o.steer = (s.right ? 1 : 0) - (s.left ? 1 : 0);
      o.throttle = s.up ? 1 : 0;
      o.brakeAxis = s.brake ? 1 : 0;
    }
    if (ax) {
      if (typeof ax.steer === 'number' && isFinite(ax.steer)) { o.steer = clamp(ax.steer, -1, 1); }
      if (typeof ax.throttle === 'number' && isFinite(ax.throttle)) { o.throttle = clamp(ax.throttle, 0, 1); }
      if (typeof ax.brake === 'number' && isFinite(ax.brake)) { o.brakeAxis = clamp(ax.brake, 0, 1); }
    }
    return o;
  }

  /* Edge queries. A mock INPUT that only exposes `state` still drives menus. */
  var mockPrev = {};
  function pressed(name) {
    if (typeof INPUT === 'undefined' || !INPUT) { return false; }
    if (typeof INPUT.pressed === 'function') { return !!INPUT.pressed(name); }
    var s = INPUT.state;
    if (!s || typeof s[name] === 'undefined') { return false; }
    var cur = !!s[name], was = !!mockPrev[name];
    mockPrev[name] = cur;
    return cur && !was;
  }
  function anyPressed() {
    if (typeof INPUT === 'undefined' || !INPUT) { return false; }
    if (typeof INPUT.anyPressed === 'function') { return !!INPUT.anyPressed(); }
    return false;
  }

  /* ============================================================== flow ==== */
  function setMode(m) {
    if (state.mode === m) { return; }
    state.prevMode = state.mode;
    state.mode = m;
    state.modeTime = 0;
    onEnterMode(m);
  }

  function refreshTitleMenu() {
    state.menuItems = [
      'START RACE',
      'SELECT STAGE',
      'QUALITY: ' + (quality === 'high' ? 'HIGH' : 'LOW'),
      'SOUND: ' + (muted ? 'OFF' : 'ON')
    ];
    menuActions = ['start', 'select', 'quality', 'sound'];
    if (state.menuIndex >= state.menuItems.length) { state.menuIndex = 0; }
  }

  function onEnterMode(m) {
    if (m === 'boot') { state.hint = ''; state.menuItems = []; }
    else if (m === 'title') {
      refreshTitleMenu();
      state.hint = 'ENTER TO START';
      music('title');
    } else if (m === 'select') {
      state.menuItems = [CORE.STAGES[0].name, CORE.STAGES[1].name, CORE.STAGES[2].name];
      menuActions = ['stage', 'stage', 'stage'];
      state.menuIndex = state.stageIndex;
      state.hint = 'CHOOSE STAGE - ENTER TO RACE - ESC BACK';
      music('title');
    } else if (m === 'countdown') {
      state.menuItems = [];
      state.hint = '';
    } else if (m === 'race') {
      state.menuItems = [];
      state.hint = 'ARROWS STEER - SPACE DRIFT - ESC PAUSE - M MUTE';
      music('race');
      musicTempo = -1;
    } else if (m === 'paused') {
      state.menuItems = ['RESUME', 'RESTART STAGE', 'QUIT TO TITLE'];
      menuActions = ['resume', 'restart', 'quit'];
      state.menuIndex = 0;
      /* render.js already draws its own modal PAUSED banner, and it also draws
         state.hint on this screen -- leave hint empty or "PAUSED" shows twice. */
      state.hint = '';
    } else if (m === 'stageclear') {
      state.menuItems = [];
      state.hint = 'ENTER TO CONTINUE';
      music('result');
    } else if (m === 'gameover') {
      state.menuItems = [];
      state.hint = 'ENTER TO CONTINUE';
      music('result');
    }
  }

  function toggleQuality() {
    quality = (quality === 'high') ? 'low' : 'high';
    state.quality = quality;
    CORE.storage.set('quality', quality);
    if (typeof RENDER !== 'undefined' && RENDER && RENDER.setQuality) {
      try { RENDER.setQuality(quality); } catch (e) { /* ignore */ }
    }
    refreshTitleMenu();
    pushMsg('QUALITY: ' + (quality === 'high' ? 'HIGH' : 'LOW'), UI.accent2, 1, 1.0, 40);
  }

  function toggleMute() {
    muted = !muted;
    state.muted = muted;
    CORE.storage.set('muted', muted);
    if (typeof AUDIO !== 'undefined' && AUDIO && AUDIO.setMuted) {
      try { AUDIO.setMuted(muted); } catch (e) { /* ignore */ }
    }
    refreshTitleMenu();
    pushMsg('SOUND: ' + (muted ? 'OFF' : 'ON'), UI.accent2, 1, 1.0, 40);
  }

  function activateMenu() {
    var a = menuActions[state.menuIndex] || '';
    if (a === 'start') { startStage(state.stageIndex); }
    else if (a === 'select') { sfx('select'); setMode('select'); }
    else if (a === 'quality') { toggleQuality(); }
    else if (a === 'sound') { toggleMute(); }
    else if (a === 'resume') { resumeRace(); }
    else if (a === 'restart') { sfx('select'); startStage(state.stageIndex); }
    else if (a === 'quit') { toTitle(); }
    else if (a === 'stage') { startStage(state.menuIndex); }
  }

  function toTitle() {
    /* back at the title, START RACE means a fresh run from stage 1 */
    state.stageIndex = 0;
    state.stage = 0;
    state.menuIndex = 0;
    setMode('title');
  }

  function pauseRace() {
    if (state.mode !== 'race' && state.mode !== 'countdown') { return; }
    pausedFrom = state.mode;
    state.paused = true;
    setMode('paused');
    sfx('select');
    setEngine(0, false);
    setSkid(false);
  }

  function resumeRace() {
    state.paused = false;
    state.menuIndex = 0;
    setMode(pausedFrom === 'countdown' ? 'countdown' : 'race');
    sfx('select');
  }

  function setSkid(on) {
    if (typeof AUDIO !== 'undefined' && AUDIO && AUDIO.setSkid) {
      try { AUDIO.setSkid(!!on); } catch (e) { /* ignore */ }
    }
  }

  /* ============================================================ track ===== */
  function buildTrack(idx) {
    var st = CORE.STAGES[idx] || CORE.STAGES[0];
    var t = null;
    if (typeof ROAD !== 'undefined' && ROAD && ROAD.build) {
      try { t = ROAD.build(idx); }
      catch (e) { pushError('ROAD.build(' + idx + '): ' + e.message); t = null; }
    }
    if (!t) { t = fallbackTrack(idx); }

    track = t;
    segments = safeArray(t.segments);
    cars = safeArray(t.cars);
    state.track = t;
    state.segments = segments;
    state.cars = cars;
    state.trackLength = num(t.trackLength, segments.length * SEG);
    if (!(state.trackLength > 0)) { state.trackLength = Math.max(1, segments.length * SEG); }
    state.theme = t.theme || CORE.THEMES[st.theme] || CORE.THEMES.sunset;
    state.stageIndex = idx;
    state.stage = idx;
    state.laps = Math.max(1, num(st.laps, 2));
    state.cameraHeight = T.CAMERA_HEIGHT;
    state.cameraDepth = T.CAMERA_DEPTH;
    state.playerZ = T.PLAYER_Z;

    /* Contract 3: "sorted segment indices, last one == first index (lap line)".
       road.js may hand us the plain sorted list instead, so normalise a private
       copy: the duplicate lap line is what makes the first lap a FULL lap.   */
    var cps = t.checkpoints, cpi;
    if (!cps || !cps.length) { cps = [0]; }
    if (cps[cps.length - 1] !== cps[0] || cps.length < 2) {
      var fixed = [];
      for (cpi = 0; cpi < cps.length; cpi++) { fixed.push(cps[cpi]); }
      fixed.push(cps[0]);
      cps = fixed;
    }
    state.checkpoints = cps;

    /* keep every car's segment bookkeeping sane before the first frame */
    if (segments.length) {
      var i, c;
      for (i = 0; i < cars.length; i++) {
        c = cars[i];
        if (!c || typeof c !== 'object') { continue; }
        c.z = num(c.z, 0);
        c.offset = clamp(num(c.offset, 0), -1, 1);
        c.speed = clamp(num(c.speed, 3000), 0, T.MAX_SPEED * 0.8);
        c.w = num(c.w, 44);
        c.h = num(c.h, 24);
        c.percent = CORE.percentRemaining(c.z, SEG);
        c.segIndex = segmentIndexOf(c.z);
      }
    }

    if (typeof RENDER !== 'undefined' && RENDER && RENDER.reset) {
      try { RENDER.reset(); } catch (e2) { pushError('RENDER.reset: ' + e2.message); }
    }
  }

  /* Minimal straight-ish road so the game still runs if road.js is absent. */
  function fallbackTrack(idx) {
    var st = CORE.STAGES[idx] || CORE.STAGES[0];
    var theme = CORE.THEMES[st.theme] || CORE.THEMES.sunset;
    var n = 1200, segs = [], i, k, curve;
    for (i = 0; i < n; i++) {
      curve = 0;
      if (i > 150 && i < 260) { curve = 2.4; }
      else if (i > 320 && i < 380) { curve = -1.8; }
      else if (i > 500 && i < 620) { curve = 1.4; }
      else if (i > 700 && i < 780) { curve = -3.0; }
      else if (i > 900 && i < 1000) { curve = 2.0; }
      k = (Math.floor(i / T.RUMBLE_LENGTH) % 2) === 0;
      segs.push({
        index: i,
        p1: { world: { x: 0, y: 0, z: i * SEG }, camera: { x: 0, y: 0, z: 0 }, screen: { x: 0, y: 0, w: 0, scale: 0 } },
        p2: { world: { x: 0, y: 0, z: (i + 1) * SEG }, camera: { x: 0, y: 0, z: 0 }, screen: { x: 0, y: 0, w: 0, scale: 0 } },
        curve: curve, sprites: [], cars: [], dark: k,
        looped: false, fog: 0, clip: 0, light: 0
      });
    }
    return {
      stageIndex: idx, theme: theme, name: st.name,
      segments: segs, trackLength: n * SEG,
      checkpoints: [0, 300, 600, 900, 0],
      cars: [], seed: st.seed
    };
  }

  function segmentIndexOf(z) {
    var n = segments.length;
    if (!n) { return 0; }
    var i = Math.floor(num(z, 0) / SEG) % n;
    if (i < 0) { i += n; }
    return i;
  }

  function segAt(z) {
    if (!segments.length) { return null; }
    if (typeof ROAD !== 'undefined' && ROAD && ROAD.findSegment) {
      try {
        var s = ROAD.findSegment(track, z);
        if (s) { return s; }
      } catch (e) { /* fall through to the local lookup */ }
    }
    return segments[segmentIndexOf(z)];
  }

  /* ============================================================== setup === */
  function resetRun() {
    var st = CORE.STAGES[state.stageIndex] || CORE.STAGES[0];
    var L = state.trackLength;
    var cps = state.checkpoints, n = cps.length, i;

    state.position = 0;
    state.speed = 0;
    state.playerX = 0;
    state.playerY = 0;
    state.steer = 0;
    state.throttle = 0;
    state.brake = 0;
    state.gear = 1;
    state.rpm = 0;
    state.shiftTimer = 0;

    state.lap = 1;
    state.checkpoint = cps[0];              /* segment index of the last one crossed */
    cpCursor = (n > 1) ? 1 : 0;
    state.nextCheckpoint = cpCursor;        /* INDEX into state.checkpoints          */

    state.lapTime = 0;
    state.lastLapTime = 0;
    state.totalTime = 0;
    state.bestLapTime = num(CORE.storage.get('bestLap' + state.stageIndex, 0), 0);
    state.score = 0;
    state.combo = 1;
    state.results = null;

    state.skyOffset = 0;
    state.hillOffset = 0;
    state.treeOffset = 0;

    state.shake = 0; state.shakeX = 0; state.shakeY = 0; state.flash = 0;
    state.crash = false; state.crashTimer = 0; state.crashFrame = 0;
    shakeAmt = 0; flashAmt = 0; hitTimer = 0; crashTimer = 0;
    driftTimer = 0; hurryTimer = 0; lastBeepSec = -1;
    state.hitTimer = 0; state.offRoad = false; state.skid = false;
    state.messages.length = 0;

    /* ---- time model: self-balancing against the real track length ----
       ideal run = trackLength * laps / (PACE * MAX_SPEED) seconds.
       The starting clock is a fraction of that and every checkpoint refills
       a fraction of the ideal time of the stretch leading up to it, so the
       race stays tense whatever road.js decides to build.                 */
    var pace = Math.max(600, FEEL.PACE * T.MAX_SPEED);
    var required = (L * state.laps) / pace;
    state.timeLeft = clamp(required * FEEL.INITIAL_SLACK, 20, num(st.timeLimit, 100));

    cpBonusArr = [];
    for (i = 0; i < n; i++) {
      var a = cps[(i - 1 + n) % n], b = cps[i];
      var dist = ((b - a) * SEG + L) % L;
      if (!(dist > 0)) { dist = L / Math.max(1, n - 1); }
      cpBonusArr[i] = clamp(Math.round(FEEL.CP_SLACK * (dist / pace) + FEEL.CP_FLAT),
                            FEEL.CP_MIN, T.CHECKPOINT_BONUS);
    }

    carBase = [];
    for (i = 0; i < cars.length; i++) {
      carBase[i] = clamp(num(cars[i] && cars[i].offset, 0), -0.95, 0.95);
    }
    clearCarSegments();
  }

  function startStage(idx) {
    state.stageIndex = clamp(idx | 0, 0, CORE.STAGES.length - 1);
    state.paused = false;
    buildTrack(state.stageIndex);
    resetRun();
    setMode('countdown');
    state.countdown = 3;
    sfx('beep');
    lastBeepSec = 3;
  }

  function finishStage() {
    var last = state.stageIndex >= CORE.STAGES.length - 1;
    var timeBonus = Math.floor(Math.max(0, state.timeLeft)) * 100;
    state.score += timeBonus;
    state.results = {
      stageName: track ? track.name : (CORE.STAGES[state.stageIndex].name),
      totalTime: state.totalTime,
      bestLap: state.bestLapTime,
      score: state.score,
      finished: last,
      laps: state.laps
    };
    saveBestScore();
    setMode('stageclear');
    pushMsg('STAGE CLEAR', UI.good, 2, 3.0, 46);
    if (timeBonus > 0) { pushMsg('TIME BONUS ' + timeBonus, UI.warn, 1, 3.0, 60); }
  }

  function timeUp() {
    state.results = {
      stageName: track ? track.name : (CORE.STAGES[state.stageIndex].name),
      totalTime: state.totalTime,
      bestLap: state.bestLapTime,
      score: state.score,
      finished: false,
      laps: Math.max(1, state.lap)
    };
    saveBestScore();
    state.speed = 0;
    setMode('gameover');
    sfx('timeup');
    setEngine(0, false);
    setSkid(false);
  }

  function saveBestScore() {
    if (state.score > state.best) {
      state.best = state.score;
      CORE.storage.set('bestScore', state.best);
    }
  }

  /* ============================================================= update === */
  function update(dt) {
    if (typeof dt !== 'number' || !isFinite(dt) || dt <= 0) { dt = T.STEP; }
    if (dt > 0.25) { dt = 0.25; }
    state.dt = dt;

    if (typeof INPUT !== 'undefined' && INPUT && INPUT.update) {
      try { INPUT.update(); } catch (e) { /* ignore */ }
    }
    input = snapshotInput();

    fpsFrames++;
    fpsTime += dt;
    if (fpsTime >= 0.5) {
      state.fps = Math.max(1, Math.round(fpsFrames / fpsTime));
      fpsFrames = 0;
      fpsTime = 0;
    }

    acc += dt;
    var steps = 0;
    while (acc >= T.STEP) {
      acc -= T.STEP;
      step(T.STEP);
      steps++;
      if (steps >= 8) { acc = 0; break; }
    }
    if (steps === 0) { /* sub-step frame: nothing simulated, keeps the sim honest */ }

    state.now = Math.round(clock * 1000);
  }

  function step(h) {
    clock += h;
    state.frame++;
    state.modeTime += h;

    updateMessages(h);
    handleGlobalKeys();

    var m = state.mode;
    if (m === 'boot') { stepBoot(h); }
    else if (m === 'title') { stepTitle(h); }
    else if (m === 'select') { stepSelect(h); }
    else if (m === 'countdown') { stepCountdown(h); }
    else if (m === 'race') { stepRace(h); }
    else if (m === 'paused') { stepPaused(h); }
    else if (m === 'stageclear') { stepStageClear(h); }
    else if (m === 'gameover') { stepGameOver(h); }
    else { stepTitle(h); }

    updateFx(h);
    updateAudio(h);

    /* One input edge drives at most one step, no matter how many steps this
       update ran: removes the "held Enter skips two screens" class of bug.  */
    anyPressed();
  }

  function updateFx(h) {
    /* shake + flash decay; sources raise them every frame they are active */
    shakeAmt -= shakeAmt * 6 * h;
    if (shakeAmt < 0.002) { shakeAmt = 0; }
    flashAmt -= flashAmt * 4.5 * h + 0.02 * h;
    if (flashAmt < 0) { flashAmt = 0; }

    if (hitTimer > 0) { hitTimer = Math.max(0, hitTimer - h); }
    if (crashTimer > 0) {
      crashTimer = Math.max(0, crashTimer - h);
      state.crashFrame = clamp(Math.floor((1 - crashTimer / FEEL.CRASH_FX_TIME) * 4), 0, 3);
      if (crashTimer <= 0) { state.crash = false; state.crashFrame = 0; }
    }
    if (driftTimer > 0) { driftTimer = Math.max(0, driftTimer - h); }

    state.shake = clamp(shakeAmt, 0, 1);
    state.flash = clamp(flashAmt, 0, 1);
    state.hitTimer = hitTimer;
    state.crashTimer = crashTimer;
  }

  function updateAudio(h) {
    if (typeof AUDIO === 'undefined' || !AUDIO) { return; }
    var racing = (state.mode === 'race' || state.mode === 'countdown');
    setEngine(racing ? clamp(state.rpm, 0, 1) : 0, racing);
    if (AUDIO.update) { try { AUDIO.update(h); } catch (e) { /* ignore */ } }
    if (racing && AUDIO.setMusicTempo) {
      var bpm = 116 + Math.round(clamp(state.speed / T.MAX_SPEED, 0, 1) * 54);
      if (bpm !== musicTempo) {
        musicTempo = bpm;
        try { AUDIO.setMusicTempo(bpm); } catch (e2) { /* ignore */ }
      }
    }
  }

  /* ============================================================== modes === */
  /* keys that mean the same thing in every mode */
  function handleGlobalKeys() {
    if (pressed('mute')) { toggleMute(); }
    if (pressed('fps')) { state.showFps = !state.showFps; }
  }

  function stepBoot(h) {
    if (state.modeTime > 0.55) { toTitle(); }
  }

  function stepTitle(h) {
    var n = state.menuItems.length || 1;
    /* A navigation press must only ever move the cursor.  The same keydown also
       raises INPUT's "any key" latch, so "press any key to continue" has to be
       suppressed for the frame that consumed a navigation edge -- otherwise a
       single Down moves to the next item and confirms it in the same frame.  */
    var navigated = false;
    if (pressed('up')) { state.menuIndex = (state.menuIndex + n - 1) % n; sfx('select'); navigated = true; }
    if (pressed('down')) { state.menuIndex = (state.menuIndex + 1) % n; sfx('select'); navigated = true; }
    if (pressed('left') || pressed('right')) {
      navigated = true;
      var a = menuActions[state.menuIndex];
      if (a === 'quality') { toggleQuality(); }
      else if (a === 'sound') { toggleMute(); }
    }
    if (pressed('start')) { activateMenu(); return; }
    if (!navigated && anyPressed()) { activateMenu(); }
  }

  function stepSelect(h) {
    var n = state.menuItems.length || 1;
    if (pressed('up')) { state.menuIndex = (state.menuIndex + n - 1) % n; sfx('select'); }
    if (pressed('down')) { state.menuIndex = (state.menuIndex + 1) % n; sfx('select'); }
    state.stageIndex = clamp(state.menuIndex, 0, CORE.STAGES.length - 1);
    if (pressed('start')) { startStage(state.stageIndex); return; }
    if (pressed('pause') || pressed('select')) { sfx('select'); toTitle(); return; }
  }

  function stepCountdown(h) {
    if (pressed('pause')) { pauseRace(); return; }
    if (state.countdown > 0) {
      state.countdown = Math.max(0, state.countdown - h);
      var sec = Math.ceil(state.countdown);
      if (sec !== lastBeepSec) {
        lastBeepSec = sec;
        if (sec > 0) { sfx('beep'); }
        else { sfx('go'); flash(0.25); pushMsg('GO!', UI.good, 3, 0.8, 52); }
      }
    } else {
      stepRacePhysics(h);                        /* rolling start after GO */
      if (state.modeTime > 3.0 + 0.62) { setMode('race'); }
    }
  }

  function stepPaused(h) {
    var n = state.menuItems.length || 1;
    if (pressed('up')) { state.menuIndex = (state.menuIndex + n - 1) % n; sfx('select'); }
    if (pressed('down')) { state.menuIndex = (state.menuIndex + 1) % n; sfx('select'); }
    if (pressed('start')) { activateMenu(); return; }
    if (pressed('pause')) { resumeRace(); return; }
  }

  function stepStageClear(h) {
    if (state.modeTime > 5.5 || pressed('start') || anyPressed()) {
      if (state.results && state.results.finished) {
        setMode('gameover');
        return;
      }
      startStage(clamp(state.stageIndex + 1, 0, CORE.STAGES.length - 1));
    }
  }

  function stepGameOver(h) {
    if (state.modeTime > 0.8 && (pressed('start') || anyPressed())) {
      state.menuIndex = 0;
      toTitle();
    }
  }

  /* ============================================================ physics === */
  function carWidth(c) {
    var w = num(c && c.w, 44);
    if (w <= 0) { w = 44; }
    if (w > 2) { w = w * T.SPRITE_SCALE; }        /* sprite pixels -> road units */
    return clamp(w, 0.12, 0.60);
  }

  function clearCarSegments() {
    var i, s;
    for (i = 0; i < segments.length; i++) {
      s = segments[i];
      if (s && s.cars && s.cars.length) { s.cars.length = 0; }
    }
  }

  function updateTraffic(h) {
    if (!segments.length) { return; }
    var L = state.trackLength, i, c, idx, seg;
    /* self-heal if anything ever swaps the car list under us */
    if (carBase.length !== cars.length) {
      carBase = [];
      for (i = 0; i < cars.length; i++) {
        carBase[i] = clamp(num(cars[i] && cars[i].offset, 0), -0.95, 0.95);
      }
    }
    clearCarSegments();
    for (i = 0; i < cars.length; i++) {
      c = cars[i];
      if (!c || typeof c !== 'object') { continue; }
      if (!(c.speed > 0)) { c.speed = 3000; }
      c.z = CORE.increase(num(c.z, 0), c.speed * h, L);
      c.percent = CORE.percentRemaining(c.z, SEG);
      idx = segmentIndexOf(c.z);
      c.segIndex = idx;
      /* a little life: some of the traffic wanders gently inside its lane  */
      if (carBase.length > i && (i % 3) !== 2) {
        c.offset = clamp(carBase[i] + Math.sin(clock * 0.55 + i * 1.7) * 0.09, -0.92, 0.92);
      } else {
        c.offset = clamp(num(c.offset, 0), -0.92, 0.92);
      }
      seg = segments[idx];
      if (seg && seg.cars && seg.cars.length !== undefined) { seg.cars.push(c); }
    }
  }

  function checkCollisions() {
    if (hitTimer > 0 || !segments.length) { return; }
    var seg = segAt(state.position + T.PLAYER_Z);
    if (!seg || !seg.cars || !seg.cars.length) { return; }
    var i, c;
    for (i = 0; i < seg.cars.length; i++) {
      c = seg.cars[i];
      if (!c) { continue; }
      if (state.speed > num(c.speed, 0) &&
          CORE.overlap(state.playerX, FEEL.PLAYER_W, num(c.offset, 0), carWidth(c), 0.8)) {
        collide(c);
        return;
      }
    }
  }

  function collide(c) {
    var carSpeed = num(c.speed, 0);
    var floorSpeed = Math.max(carSpeed * 0.9, state.speed * (1 - T.COLLISION_SPEED_LOSS));
    if (state.speed > floorSpeed) { state.speed = Math.max(0, floorSpeed); }

    var dir = (state.playerX >= num(c.offset, 0)) ? 1 : -1;
    state.playerX = clamp(state.playerX + dir * FEEL.HIT_PUSH,
                          -FEEL.PLAYER_X_LIMIT, FEEL.PLAYER_X_LIMIT);

    hitTimer = T.HIT_INVULN;
    crashTimer = FEEL.CRASH_FX_TIME;
    state.crash = true;
    state.crashTimer = crashTimer;
    state.crashFrame = 0;
    state.crashX = Math.round(W / 2 + state.playerX * 18);
    state.crashY = Math.round(H - 46);
    state.combo = 1;
    shake(0.95);
    flash(0.5);
    sfx('crash');
    pushMsg('CRASH!', UI.danger, 2, 0.9, 44);
  }

  function checkCrossings(prevZ, z) {
    var cps = state.checkpoints, n = cps.length, i;
    if (!n || !state.trackLength) { return; }
    for (i = 0; i < n; i++) {
      if (crossedZ(prevZ, z, cps[i] * SEG)) {
        if (i === cpCursor) { onCheckpoint(i); }
        else if (i > cpCursor && n > 1) { onCheckpoint(i); }
      }
    }
  }

  function crossedZ(fromZ, toZ, atZ) {
    var L = state.trackLength;
    var a = fromZ % L; if (a < 0) { a += L; }
    var b = toZ % L; if (b < 0) { b += L; }
    var p = atZ % L; if (p < 0) { p += L; }
    if (b >= a) { return p > a && p <= b; }
    return p > a || p <= b;
  }

  function onCheckpoint(i) {
    var cps = state.checkpoints, n = cps.length;
    var bonus = num(cpBonusArr[i], FEEL.CP_MIN);

    state.checkpoint = cps[i];
    state.timeLeft += bonus;
    state.combo = Math.min(FEEL.COMBO_MAX, state.combo + 1);
    state.score += FEEL.CHECKPOINT_SCORE * state.combo;
    sfx('checkpoint');
    flash(0.3);

    if (i === n - 1) {
      completeLap(bonus);
      cpCursor = (n > 1) ? 1 : 0;
    } else {
      pushMsg('CHECKPOINT  +' + bonus, UI.accent2, 1, 1.5, 40);
      cpCursor = (i + 1) % n;
      if (cpCursor === 0) { cpCursor = (n > 1) ? 1 : 0; }
    }
    state.nextCheckpoint = cpCursor % n;
  }

  function completeLap(bonus) {
    state.lastLapTime = state.lapTime;
    if (!(state.bestLapTime > 0) || state.lapTime < state.bestLapTime) {
      state.bestLapTime = state.lapTime;
      CORE.storage.set('bestLap' + state.stageIndex, state.bestLapTime);
      pushMsg('BEST LAP  ' + CORE.formatTime(state.bestLapTime), UI.good, 1, 2.0, 54);
    } else {
      pushMsg('LAP  ' + CORE.formatTime(state.lapTime), UI.white, 1, 1.6, 54);
    }
    state.lapTime = 0;
    state.score += FEEL.LAP_SCORE * state.combo;

    if (state.lap >= state.laps) {
      finishStage();
    } else {
      state.lap++;
      state.timeLeft += 2;
      pushMsg('LAP ' + state.lap + '/' + state.laps + '  +' + bonus, UI.accent, 2, 2.0, 34);
      sfx('checkpoint');
      flash(0.35);
    }
  }

  function stepRace(h) {
    if (pressed('pause')) { pauseRace(); return; }
    stepRacePhysics(h);
    if (state.mode !== 'race') { return; }       /* the run may have just ended */
    state.lapTime += h;
    state.totalTime += h;
    state.timeLeft -= h;

    if (state.timeLeft <= 10 && state.timeLeft > 0) {
      var sec = Math.ceil(state.timeLeft);
      if (sec !== lastBeepSec) {
        lastBeepSec = sec;
        sfx('beep');
        flash(0.16);
        shake(0.22);
      }
      hurryTimer -= h;
      if (hurryTimer <= 0) {
        hurryTimer = sec <= 5 ? 0.42 : 0.8;
        pushMsg(sec <= 5 ? 'HURRY UP!' : 'TIME ' + sec,
                sec <= 5 ? UI.danger : UI.warn, sec <= 5 ? 2 : 1, 0.7, 34);
      }
    }

    if (state.timeLeft <= 0) {
      state.timeLeft = 0;
      timeUp();
    }
  }

  function stepRacePhysics(h) {
    var maxSpeed = T.MAX_SPEED;
    var sp = clamp(state.speed / maxSpeed, -1, 1);
    var spAbs = Math.abs(sp);

    var steerIn = input ? input.steer : 0;
    var throttle = input ? input.throttle : 0;
    var brakeIn = input ? input.brakeAxis : 0;
    var hand = input ? !!input.handbrake : false;

    /* ---------------------------------------------------------- drift --- */
    if (hand && spAbs > FEEL.DRIFT_MIN_SPEED && Math.abs(steerIn) > FEEL.DRIFT_MIN_STEER) {
      driftTimer = FEEL.DRIFT_HOLD;
    } else if (driftTimer > 0) {
      driftTimer = Math.max(0, driftTimer - h);
    }
    var drifting = driftTimer > 0 && spAbs > FEEL.DRIFT_MIN_SPEED * 0.75;

    var offDepth = clamp((Math.abs(state.playerX) - 1) / 0.35, 0, 1);
    var grip = 1 - offDepth * (1 - FEEL.OFFROAD_GRIP);

    /* ------------------------------------------------------- steering --- */
    var target = clamp(steerIn, -1, 1);
    var rate = CORE.lerp(FEEL.STEER_RATE_LOW, FEEL.STEER_RATE_HIGH, clamp(spAbs, 0, 1));
    if (target === 0) { rate = FEEL.STEER_RETURN; }
    if (drifting) { rate *= FEEL.STEER_DRIFT_RATE; }
    var d = target - state.steer;
    var lim = rate * h;
    if (d > lim) { d = lim; } else if (d < -lim) { d = -lim; }
    state.steer = clamp(state.steer + d, -1, 1);

    /* ------------------------------------------------------- lateral ---- */
    var lateral = FEEL.LATERAL_RATE * (FEEL.LATERAL_FLOOR + (1 - FEEL.LATERAL_FLOOR) * spAbs);
    var auth = grip;
    if (drifting) { auth *= T.DRIFT_STEER_BONUS; }

    state.playerX += state.steer * lateral * auth * h;

    /* centrifugal force: the faster you go the harder the corner throws you */
    var seg = segAt(state.position + T.PLAYER_Z);
    var curve = seg ? clamp(num(seg.curve, 0), -FEEL.CURVE_CLAMP, FEEL.CURVE_CLAMP) : 0;
    var pull = lateral * Math.pow(spAbs, 1.25) * curve * FEEL.CENTRIFUGAL;
    if (drifting) { pull *= FEEL.DRIFT_CENTRIFUGAL; }
    if (sp < 0) { pull = -pull; }
    state.playerX -= pull * h;

    /* sliding: straightening the wheel does not instantly stop the slide */
    state.playerX *= 1 - (1 - FEEL.SLIDE_GRIP) * Math.min(1, spAbs) * 6 * h;

    /* --------------------------------------------------------- speed ---- */
    var braking = brakeIn > 0.35;
    if (braking) {
      if (state.speed > 0) {
        state.speed = Math.max(0, CORE.accelerate(state.speed, T.BREAKING, h));
      } else if (state.speed > -FEEL.REVERSE_MAX) {
        /* held brake at a standstill = gentle reverse, for unsticking */
        state.speed = Math.max(-FEEL.REVERSE_MAX, CORE.accelerate(state.speed, T.BREAKING * 0.12, h));
      }
    } else if (throttle > 0.05) {
      var punch = 1 + (FEEL.ACCEL_PUNCH - 1) * (1 - clamp(spAbs / FEEL.PUNCH_RANGE, 0, 1));
      var accel = T.ACCEL * (1 - FEEL.ACCEL_TAPER * Math.pow(clamp(spAbs, 0, 1), 1.7)) * punch;
      if (state.shiftTimer > FEEL.SHIFT_TIME - FEEL.SHIFT_CUT) { accel *= FEEL.SHIFT_CUT_GAIN; }
      state.speed = CORE.accelerate(state.speed, accel * throttle, h);
    } else {
      /* coasting never rolls the car backwards */
      state.speed = Math.max(0, CORE.accelerate(state.speed, T.DECEL, h));
    }

    if (drifting) { state.speed = CORE.accelerate(state.speed, FEEL.DRIFT_DECEL, h); }

    /* ------------------------------------------------------- off road --- */
    var offRoad = Math.abs(state.playerX) > 1;
    if (offRoad) {
      /* scrubs down to a crawl on the shoulder, slower the deeper you go */
      var floorSpeed = T.OFF_ROAD_LIMIT * (1 - offDepth * 0.45);
      if (state.speed > floorSpeed) {
        var scrub = T.OFF_ROAD_DECEL * (1 + offDepth * 0.7);
        state.speed = Math.max(floorSpeed, state.speed + scrub * h);
      }
      if (state.speed > 400) {
        shake(0.16 + 0.42 * clamp(state.speed / maxSpeed, 0, 1));
      }
    }
    state.offRoad = offRoad;

    state.speed = clamp(num(state.speed, 0), -FEEL.REVERSE_MAX, maxSpeed);
    state.playerX = clamp(num(state.playerX, 0), -FEEL.PLAYER_X_LIMIT, FEEL.PLAYER_X_LIMIT);

    /* -------------------------------------------------------- advance --- */
    var prevZ = state.position;
    state.position = CORE.increase(state.position, state.speed * h, state.trackLength);

    var pseg = segAt(state.position + T.PLAYER_Z);
    if (pseg && pseg.p1 && pseg.p1.world) {
      var pct = CORE.percentRemaining(state.position + T.PLAYER_Z, SEG);
      var y1 = num(pseg.p1.world.y, 0);
      var y2 = (pseg.p2 && pseg.p2.world) ? num(pseg.p2.world.y, y1) : y1;
      state.playerY = CORE.lerp(y1, y2, pct);
    }

    /* parallax offsets, wrapped into [0,1) like the reference racer */
    if (pseg) {
      var traveled = (state.position - prevZ) / SEG;
      var cv = clamp(num(pseg.curve, 0), -FEEL.CURVE_CLAMP, FEEL.CURVE_CLAMP);
      state.skyOffset = CORE.increase(state.skyOffset, 0.0012 * cv * traveled, 1);
      state.hillOffset = CORE.increase(state.hillOffset, 0.0026 * cv * traveled, 1);
      state.treeOffset = CORE.increase(state.treeOffset, 0.0042 * cv * traveled, 1);
    }

    /* -------------------------------------------------------- traffic --- */
    updateTraffic(h);
    checkCollisions();
    if (state.speed >= 0) { checkCrossings(prevZ, state.position); }

    /* ---------------------------------------------------- gear + rpm ---- */
    updateGearbox(h, throttle);

    /* ------------------------------------------------------------- fx --- */
    var skid = drifting || (offRoad && state.speed > 1500) ||
               (braking && spAbs > FEEL.BRAKE_SKID_SPEED);
    state.skid = skid;
    setSkid(skid);
    if (skid && !offRoad) { shake(0.12 + 0.2 * spAbs); }

    state.throttle = input ? input.throttle : 0;
    state.brake = input ? input.brakeAxis : 0;

    state.score += Math.max(0, state.speed) * h * FEEL.SCORE_PER_UNIT * state.combo;
    if (!isFinite(state.score)) { state.score = 0; }
  }

  function updateGearbox(h, throttle) {
    var spAbs = clamp(state.speed / T.MAX_SPEED, 0, 1);
    var g = 0, tops = FEEL.GEAR_TOP;
    while (g < tops.length - 1 && spAbs > tops[g]) { g++; }
    var lo = (g === 0) ? 0 : tops[g - 1];
    var hi = tops[g];
    var frac = clamp((spAbs - lo) / Math.max(0.0001, hi - lo), 0, 1);
    var gear = g + 1;

    if (state.shiftTimer <= 0 && gear !== state.gear) {
      state.gear = gear;
      state.shiftTimer = FEEL.SHIFT_TIME;
      sfx('shift');
    }
    state.shiftTimer = Math.max(0, state.shiftTimer - h);

    var targetRpm = 0.13 + 0.87 * frac;
    if (throttle > 0.05 || state.speed < 0) {
      state.rpm = targetRpm;
    } else {
      state.rpm = CORE.lerp(state.rpm, 0.10, Math.min(1, h * 6));
    }
    state.rpm = clamp(num(state.rpm, 0), 0, 1);
  }

  /* ============================================================= export === */
  var api = {
    boot: boot,
    update: update,
    render: render,
    stop: stop,
    layout: layout,
    pushMessage: pushMsg
  };

  Object.defineProperty(api, 'state', {
    get: function () { return state; },
    enumerable: true
  });
  Object.defineProperty(api, 'track', {
    get: function () { return track; },
    enumerable: true
  });
  Object.defineProperty(api, 'running', {
    get: function () { return running; },
    enumerable: true
  });

  return api;
})();
