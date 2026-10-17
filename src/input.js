/* ==========================================================================
 * NEON DRIFT '86  —  src/input.js
 * Keyboard + gamepad + touch collapsed into one stable, per-frame snapshot.
 * Exposes the single global `INPUT`.  Depends on nothing (not even CORE) so it
 * can be unit-tested on its own.
 *
 *   INPUT.init(el)          bind the touch surface (keyboard auto-binds on load)
 *   INPUT.update()          poll gamepad, re-merge, latch edges (GAME calls it)
 *   INPUT.state             {left,right,up,down,start,select,brake}   live booleans
 *   INPUT.axis              {steer:-1..1, throttle:0..1, brake:0..1}  live analogue
 *   INPUT.handbrake         bool   (Space / pad X / pad LB)  -- extra, not in contract
 *   INPUT.pressed(action)   edge-triggered, consumes the press
 *   INPUT.anyPressed()      "press any key" -- true when something fresh arrived;
 *                           consumes EVERY pending edge
 *   INPUT.reset()           drop all held keys, edges and axes
 *
 * Keyboard:  Left/A  Right/D  Up/W  Down/S  Space  Enter  Shift  Esc  M  F
 * Gamepad :  left stick / dpad, RT or A = gas, LT or B = brake, X or LB = drift,
 *            Start = confirm/start.  Hot-plugged pads are picked up automatically.
 * Touch   :  left half = analogue steering, right half = pedals
 *            (top = gas, bottom = brake).  Scrolling/zooming is suppressed.
 * ========================================================================== */
var INPUT = (function () {
  'use strict';

  /* ------------------------------------------------------------- helpers -- */
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  function on(el, type, fn, opts) {
    if (!el || !el.addEventListener) { return; }
    try { el.addEventListener(type, fn, opts); }
    catch (e) { try { el.addEventListener(type, fn, false); } catch (e2) { /* ignore */ } }
  }
  function off(el, type, fn, opts) {
    if (!el || !el.removeEventListener) { return; }
    try { el.removeEventListener(type, fn, opts); }
    catch (e) { try { el.removeEventListener(type, fn, false); } catch (e2) { /* ignore */ } }
  }

  /* ------------------------------------------------------------- actions -- */
  /* `brake` is the pedal (Down/S, pad LT, touch pad).  `down` is the raw key.
     `handbrake` is Space / pad X and drives drifting.                        */
  var ACTIONS = ['left', 'right', 'up', 'down', 'brake', 'handbrake',
                 'start', 'select', 'pause', 'mute', 'fps'];

  var kbHeld = {};      /* keyboard only                                        */
  var gpHeld = {};      /* gamepad buttons only                                 */
  var edge = {};        /* latched presses waiting to be consumed               */
  var prev = {};        /* last merged value, for edge detection                */
  var anyEdge = false;  /* unmapped key / any pad button / touchstart           */

  var gpSteer = 0, gpThrottle = 0, gpBrake = 0;
  var gpAnyDown = false, gpAnyPrev = false, gpStartPrev = false;
  var touchSteer = 0, touchThrottle = 0, touchBrake = 0;

  var handbrakeOn = false;

  var stateObj = { left: false, right: false, up: false, down: false,
                   start: false, select: false, brake: false };
  var axisObj = { steer: 0, throttle: 0, brake: 0 };

  var touchMap = {}, touching = false, padIndex = -1, padSeen = false;
  var target = null, keyboardBound = false, inited = false;

  var i;
  for (i = 0; i < ACTIONS.length; i++) {
    kbHeld[ACTIONS[i]] = false;
    gpHeld[ACTIONS[i]] = false;
    edge[ACTIONS[i]] = false;
    prev[ACTIONS[i]] = false;
  }

  /* ------------------------------------------------------------ keyboard -- */
  var KEYMAP = {
    arrowleft: ['left'], a: ['left'],
    arrowright: ['right'], d: ['right'],
    arrowup: ['up'], w: ['up'],
    arrowdown: ['down', 'brake'], s: ['down', 'brake'],
    ' ': ['handbrake'], space: ['handbrake'], spacebar: ['handbrake'],
    enter: ['start'], return: ['start'],
    escape: ['pause'], esc: ['pause'], p: ['pause'],
    shift: ['select'], tab: ['select'],
    m: ['mute'], f: ['fps']
  };

  var KEYCODES = {
    37: ['left'], 65: ['left'],
    39: ['right'], 68: ['right'],
    38: ['up'], 87: ['up'],
    40: ['down', 'brake'], 83: ['down', 'brake'],
    32: ['handbrake'],
    13: ['start'],
    27: ['pause'],
    16: ['select'],
    77: ['mute'], 70: ['fps']
  };

  /* keys that must NOT double as "press any key to continue" */
  var QUIET = { mute: true, fps: true, pause: true };

  function actionsFor(e) {
    var k = e.key, code = e.code, acts = null;
    if (code === 'Space') { return KEYMAP[' ']; }
    if (typeof k === 'string' && k.length) {
      acts = KEYMAP[k.toLowerCase()] || null;
    }
    if (!acts && typeof e.keyCode === 'number') {
      acts = KEYCODES[e.keyCode] || null;
    }
    return acts;
  }

  function onKeyDown(e) {
    var acts = actionsFor(e), i, a, quiet = false;
    if (!acts) {
      if (!e.repeat) { anyEdge = true; }
      return;
    }
    for (i = 0; i < acts.length; i++) {
      a = acts[i];
      if (e.repeat) { continue; }                  /* held keys never re-fire */
      if (!kbHeld[a]) { edge[a] = true; }          /* latch the edge          */
      if (QUIET[a]) { quiet = true; }
    }
    for (i = 0; i < acts.length; i++) { kbHeld[acts[i]] = true; }
    if (!quiet && !e.repeat) { anyEdge = true; }
    if (!e.ctrlKey && !e.altKey && !e.metaKey && e.preventDefault) {
      try { e.preventDefault(); } catch (e2) { /* ignore */ }
    }
  }

  function onKeyUp(e) {
    var acts = actionsFor(e), i;
    if (!acts) { return; }
    for (i = 0; i < acts.length; i++) { kbHeld[acts[i]] = false; }
    sync();
  }

  function bindKeyboard() {
    if (keyboardBound) { return; }
    var doc = (typeof document !== 'undefined') ? document : null;
    var win = (typeof window !== 'undefined') ? window : null;
    if (doc) { on(doc, 'keydown', onKeyDown); on(doc, 'keyup', onKeyUp); }
    if (win) {
      on(win, 'keydown', onKeyDown);
      on(win, 'keyup', onKeyUp);
      on(win, 'blur', reset);
      on(win, 'gamepadconnected', function () { padIndex = -1; padSeen = false; });
      on(win, 'gamepaddisconnected', function () { padIndex = -1; padSeen = false; });
    }
    if (doc) {
      on(doc, 'visibilitychange', function () {
        var hidden = doc.hidden || doc.webkitHidden;
        if (hidden) { reset(); }
      });
    }
    keyboardBound = true;
  }

  /* ------------------------------------------------------------- merging -- */
  function merged(action) {
    if (action === 'left') { return axisObj.steer < -0.12; }
    if (action === 'right') { return axisObj.steer > 0.12; }
    if (action === 'up') { return axisObj.throttle > 0.10; }
    if (action === 'brake') { return axisObj.brake > 0.10; }
    if (action === 'down') { return !!(kbHeld.down || gpHeld.down); }
    if (action === 'handbrake') { return handbrakeOn; }
    if (action === 'start') { return !!(kbHeld.start || gpHeld.start); }
    if (action === 'select') { return !!(kbHeld.select || gpHeld.select); }
    return !!kbHeld[action];
  }

  function sync() {
    var steer = gpSteer + touchSteer;
    if (kbHeld.left) { steer -= 1; }
    if (kbHeld.right) { steer += 1; }
    steer = clamp(steer, -1, 1);

    var throttle = Math.max(gpThrottle, touchThrottle, kbHeld.up ? 1 : 0, gpHeld.up ? 1 : 0);
    var brake = Math.max(gpBrake, touchBrake, kbHeld.brake ? 1 : 0,
                         gpHeld.brake ? 1 : 0, gpHeld.down ? 1 : 0);

    axisObj.steer = steer;
    axisObj.throttle = throttle;
    axisObj.brake = brake;
    handbrakeOn = !!(kbHeld.handbrake || gpHeld.handbrake);

    stateObj.left = steer < -0.12;
    stateObj.right = steer > 0.12;
    stateObj.up = throttle > 0.10;
    stateObj.down = !!(kbHeld.down || gpHeld.down);
    stateObj.brake = brake > 0.10;
    stateObj.start = !!(kbHeld.start || gpHeld.start);
    stateObj.select = !!(kbHeld.select || gpHeld.select);

    var i, a, cur;
    for (i = 0; i < ACTIONS.length; i++) {
      a = ACTIONS[i];
      cur = merged(a);
      if (cur && !prev[a]) { edge[a] = true; }
      prev[a] = cur;
    }
  }

  /* ------------------------------------------------------------ gamepads -- */
  function buttonDown(pad, idx) {
    var b = pad.buttons && pad.buttons[idx];
    if (!b) { return false; }
    if (typeof b === 'number') { return b > 0.5; }
    return !!(b.pressed || (typeof b.value === 'number' && b.value > 0.5));
  }
  function buttonValue(pad, idx) {
    var b = pad.buttons && pad.buttons[idx];
    if (!b) { return 0; }
    if (typeof b === 'number') { return b; }
    if (typeof b.value === 'number') { return b.value; }
    return b.pressed ? 1 : 0;
  }
  function axisValue(pad, idx) {
    var a = pad.axes && pad.axes[idx];
    return (typeof a === 'number' && isFinite(a)) ? a : 0;
  }

  function pollGamepad() {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) { return; }
    var pads;
    try { pads = navigator.getGamepads(); } catch (e) { return; }
    if (!pads) { return; }

    var pad = null, i;
    if (padIndex >= 0 && pads[padIndex] && pads[padIndex].connected !== false) {
      pad = pads[padIndex];
    } else {
      for (i = 0; i < pads.length; i++) {
        if (pads[i] && pads[i].connected !== false) { pad = pads[i]; padIndex = i; break; }
      }
    }
    if (!pad) {
      if (padSeen) {                                   /* unplugged mid-race */
        padSeen = false; padIndex = -1;
        gpSteer = gpThrottle = gpBrake = 0;
        for (i = 0; i < ACTIONS.length; i++) { gpHeld[ACTIONS[i]] = false; }
      }
      return;
    }
    padSeen = true;

    /* --- analogue sources: sticks first, dpad as a digital fallback --- */
    var dz = 0.14, s = axisValue(pad, 0);
    if (Math.abs(s) < dz) { s = 0; }
    if (buttonDown(pad, 14)) { s = -1; }
    else if (buttonDown(pad, 15)) { s = 1; }
    gpSteer = clamp(s, -1, 1);

    var rt = Math.max(buttonValue(pad, 7), axisValue(pad, 5), buttonDown(pad, 0) ? 0.85 : 0);
    var lt = Math.max(buttonValue(pad, 6), axisValue(pad, 2), buttonDown(pad, 1) ? 0.9 : 0);
    gpThrottle = clamp(rt, 0, 1);
    gpBrake = clamp(lt, 0, 1);

    /* --- digital buttons --- */
    var btns = {
      left: buttonDown(pad, 14) || gpSteer < -0.5,
      right: buttonDown(pad, 15) || gpSteer > 0.5,
      up: gpThrottle > 0.10 || buttonDown(pad, 12),
      down: buttonDown(pad, 13) || gpBrake > 0.10,
      brake: gpBrake > 0.10 || buttonDown(pad, 13),
      handbrake: buttonDown(pad, 2) || buttonDown(pad, 4),
      start: buttonDown(pad, 9) || buttonDown(pad, 3),
      select: buttonDown(pad, 8)
    };
    var k;
    for (k in btns) {
      if (!has(btns, k)) { continue; }
      if (btns[k] && !gpHeld[k]) { edge[k] = true; }
      gpHeld[k] = btns[k];
    }

    /* any fresh pad button counts as "press any key" */
    var anyDown = false;
    if (pad.buttons) {
      for (i = 0; i < pad.buttons.length; i++) {
        if (buttonDown(pad, i)) { anyDown = true; break; }
      }
    }
    if (anyDown && !gpAnyPrev) { anyEdge = true; }
    gpAnyDown = anyDown;
    gpAnyPrev = anyDown;
    if (buttonDown(pad, 9) && !gpStartPrev) { edge.start = true; }
    gpStartPrev = buttonDown(pad, 9);

    sync();
  }

  /* --------------------------------------------------------------- touch -- */
  function rectOf() {
    if (target && target.getBoundingClientRect) {
      try {
        var r = target.getBoundingClientRect();
        if (r && r.width > 0 && r.height > 0) { return r; }
      } catch (e) { /* ignore */ }
    }
    var w = (typeof window !== 'undefined' && window.innerWidth) ? window.innerWidth : 384;
    var h = (typeof window !== 'undefined' && window.innerHeight) ? window.innerHeight : 216;
    return { left: 0, top: 0, width: w, height: h };
  }

  function readTouches(e) {
    var map = {}, i, t, gone;
    /* `touches` is the authoritative live list.  When a synthetic or older
       event omits it we fall back to removing what `changedTouches` says has
       ended, so a lifted finger can never stay stuck on the wheel.          */
    var list = e.touches;
    if (list !== undefined && list !== null) {
      for (i = 0; i < list.length; i++) {
        t = list[i];
        map['t' + t.identifier] = { x: t.clientX, y: t.clientY };
      }
      return map;
    }
    for (var k in touchMap) {
      if (has(touchMap, k)) { map[k] = touchMap[k]; }
    }
    gone = e.changedTouches;
    if (gone) {
      for (i = 0; i < gone.length; i++) { delete map['t' + gone[i].identifier]; }
    }
    return map;
  }

  function computeTouch() {
    var r = rectOf();
    var w = (r && r.width) ? r.width : 384;
    var h = (r && r.height) ? r.height : 216;
    var steer = 0, thr = 0, brk = 0, k, t, lx, ly, s, any = false;

    for (k in touchMap) {
      if (!has(touchMap, k)) { continue; }
      any = true;
      t = touchMap[k];
      lx = t.x - r.left;
      ly = t.y - r.top;
      if (lx < w * 0.5) {
        /* left half: analogue wheel. far left = full lock left, centre = neutral */
        s = clamp((lx - w * 0.25) / (w * 0.25), -1, 1);
        if (Math.abs(s) > Math.abs(steer)) { steer = s; }
      } else if (ly < h * 0.55) {
        thr = 1;
      } else {
        brk = 1;
      }
    }
    touchSteer = steer;
    touchThrottle = thr;
    touchBrake = brk;
    touching = any;
    sync();
  }

  function onTouchStart(e) {
    if (e.preventDefault) { try { e.preventDefault(); } catch (e2) { /* ignore */ } }
    touchMap = readTouches(e);
    anyEdge = true;
    computeTouch();
  }
  function onTouchMove(e) {
    if (e.preventDefault) { try { e.preventDefault(); } catch (e2) { /* ignore */ } }
    touchMap = readTouches(e);
    computeTouch();
  }
  function onTouchEnd(e) {
    if (e.preventDefault) { try { e.preventDefault(); } catch (e2) { /* ignore */ } }
    touchMap = readTouches(e);
    computeTouch();
  }

  function bindTouch(el) {
    if (target && target !== el) {
      off(target, 'touchstart', onTouchStart);
      off(target, 'touchmove', onTouchMove);
      off(target, 'touchend', onTouchEnd);
      off(target, 'touchcancel', onTouchEnd);
    }
    target = el;
    if (!target) { return; }
    var opts = false;
    try { opts = { passive: false }; } catch (e) { opts = false; }
    on(target, 'touchstart', onTouchStart, opts);
    on(target, 'touchmove', onTouchMove, opts);
    on(target, 'touchend', onTouchEnd, opts);
    on(target, 'touchcancel', onTouchEnd, opts);
    if (target.style) {
      try {
        target.style.touchAction = 'none';
        target.style.webkitTouchCallout = 'none';
        target.style.webkitUserSelect = 'none';
        target.style.userSelect = 'none';
      } catch (e3) { /* ignore */ }
    }
  }

  /* ---------------------------------------------------------------- api --- */
  function init(el) {
    bindKeyboard();
    bindTouch(el || target || null);
    inited = true;
    sync();
  }

  function update() {
    pollGamepad();
    sync();
  }

  function pressed(action) {
    sync();
    if (edge[action]) { edge[action] = false; return true; }
    return false;
  }

  function anyPressed() {
    sync();
    var found = anyEdge, i;
    anyEdge = false;
    for (i = 0; i < ACTIONS.length; i++) {
      if (edge[ACTIONS[i]]) { edge[ACTIONS[i]] = false; found = true; }
    }
    return found;
  }

  function reset() {
    var i;
    for (i = 0; i < ACTIONS.length; i++) {
      kbHeld[ACTIONS[i]] = false;
      gpHeld[ACTIONS[i]] = false;
      edge[ACTIONS[i]] = false;
      prev[ACTIONS[i]] = false;
    }
    gpSteer = gpThrottle = gpBrake = 0;
    touchSteer = touchThrottle = touchBrake = 0;
    touchMap = {};
    touching = false;
    anyEdge = false;
    gpAnyDown = gpAnyPrev = gpStartPrev = false;
    sync();
  }

  /* --------------------------------------------------------------- export -- */
  var api = {
    init: init,
    update: update,
    pressed: pressed,
    anyPressed: anyPressed,
    reset: reset
  };

  Object.defineProperty(api, 'state', {
    get: function () { sync(); return stateObj; },
    enumerable: true
  });
  Object.defineProperty(api, 'axis', {
    get: function () { sync(); return axisObj; },
    enumerable: true
  });
  Object.defineProperty(api, 'handbrake', {
    get: function () { sync(); return handbrakeOn; },
    enumerable: true
  });
  Object.defineProperty(api, 'touching', {
    get: function () { return touching; },
    enumerable: true
  });
  Object.defineProperty(api, 'padConnected', {
    get: function () { return padSeen; },
    enumerable: true
  });
  Object.defineProperty(api, 'inited', {
    get: function () { return inited; },
    enumerable: true
  });

  /* keyboard works even if nobody ever calls init() */
  bindKeyboard();

  return api;
})();
