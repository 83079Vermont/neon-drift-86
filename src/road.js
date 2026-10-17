/* ==========================================================================
 * NEON DRIFT '86  —  src/road.js
 * Track geometry: segment construction, perspective projection and the
 * initial placement of AI traffic.
 *
 * NO canvas / document / DOM access anywhere in this file (it must load and
 * run under node).  Depends on: CORE.  Exposes the single global `ROAD`.
 *
 * Load order: core.js -> road.js -> sprites.js -> audio.js -> render.js
 * ========================================================================== */
var ROAD = (function () {
  'use strict';

  var T = CORE.TUNING;
  var SEG_LEN = T.SEGMENT_LENGTH;        /* 200  */
  var RUMBLE_LEN = T.RUMBLE_LENGTH;      /* 3    */
  var ROAD_WIDTH = T.ROAD_WIDTH;         /* 2000 */

  /* curve is a per-segment steering accumulator (see the classic out-run model):
     `dx += curve` each segment, `x += dx` each segment. */
  var CURVE = { NONE: 0, EASY: 1.7, MEDIUM: 3.1, HARD: 4.5, HAIRPIN: 6.2, MAX: 7.5 };

  /* slope is expressed as a fraction of the horizontal run, so hill height
     scales with section length and never becomes a wall. */
  var SLOPE = { NONE: 0, LOW: 0.15, MEDIUM: 0.28, HIGH: 0.42, STEEP: 0.56 };

  var MIN_SEGMENTS = 1200;       /* contract floor  */
  var TARGET_SEGMENTS = 1320;    /* the fun part    */
  var OPENING_STRAIGHT = 46;     /* start / finish straight */
  var CLOSING_STRAIGHT = 40;
  var CHECKPOINT_GATES = 4;      /* gates per lap, one of them the lap line */

  var CAR_KINDS = [
    { sprite: 'car_red', w: 1080, h: 620, lo: 0.46, hi: 0.74 },
    { sprite: 'car_blue', w: 1080, h: 620, lo: 0.46, hi: 0.74 },
    { sprite: 'car_green', w: 1080, h: 620, lo: 0.46, hi: 0.74 },
    { sprite: 'car_yellow', w: 1080, h: 620, lo: 0.46, hi: 0.74 },
    { sprite: 'car_purple', w: 1080, h: 620, lo: 0.46, hi: 0.74 },
    { sprite: 'truck_white', w: 1520, h: 980, lo: 0.27, hi: 0.48 },
    { sprite: 'truck_blue', w: 1520, h: 980, lo: 0.27, hi: 0.48 }
  ];

  /* ======================================================== small helpers == */

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function newPoint(x, y, z) {
    return {
      world: { x: x, y: y, z: z },
      camera: { x: 0, y: 0, z: 0 },
      screen: { x: 0, y: 0, w: 0, scale: 0 }
    };
  }

  function newSegment(index, curve, y1, y2) {
    return {
      index: index,
      p1: newPoint(0, y1, index * SEG_LEN),
      p2: newPoint(0, y2, (index + 1) * SEG_LEN),
      curve: curve,
      sprites: [],
      cars: [],
      /* alternating ground colour; flips every RUMBLE_LENGTH segments */
      dark: (Math.floor(index / RUMBLE_LEN) % 2) === 1,
      looped: false,
      fog: 0,
      clip: 0,
      light: 0
    };
  }

  function lastY(track) {
    var segs = track.segments;
    return segs.length === 0 ? 0 : segs[segs.length - 1].p2.world.y;
  }

  function pushSegment(track, curve, y2) {
    var segs = track.segments;
    var y1 = segs.length === 0 ? 0 : segs[segs.length - 1].p2.world.y;
    segs.push(newSegment(segs.length, curve, y1, y2));
  }

  /* ---------------------------------------------------------- road pieces -- */

  /* enter/hold/leave are segment counts; `curve` is the held curve value and
     `slope` the held gradient (world-y delta / world-z delta). */
  function addRoad(track, enter, hold, leave, curve, slope) {
    var startY = lastY(track);
    var total = enter + hold + leave;
    if (total <= 0) { return; }
    var endY = startY + (slope || 0) * total * SEG_LEN;
    var n;

    for (n = 0; n < enter; n++) {
      pushSegment(track, CORE.easeIn(0, curve, n / enter), CORE.easeInOut(startY, endY, n / total));
    }
    for (n = 0; n < hold; n++) {
      pushSegment(track, curve, CORE.easeInOut(startY, endY, (enter + n) / total));
    }
    for (n = 0; n < leave; n++) {
      pushSegment(track, CORE.easeInOut(curve, 0, n / leave), CORE.easeInOut(startY, endY, (enter + hold + n) / total));
    }
  }

  function addStraight(track, len) { addRoad(track, 0, len, 0, 0, 0); }

  /* A run of alternating crests and dips; the 4-step pattern nets to zero so
     a bumpy stretch always returns to the height it started at. */
  function addBumps(track, len, amount) {
    var pattern = [1, -2, 1, 0];
    var n, y = lastY(track);
    len = len - (len % 4);
    for (n = 0; n < len; n++) {
      y = y + pattern[n % 4] * amount;
      pushSegment(track, 0, y);
    }
  }

  /* ---------------------------------------------------------- the recipe --- */

  function chooseSlope(track, hilly, rng) {
    var y = lastY(track);
    var bias = clamp(-y / 14000, -1, 1);        /* pull back toward sea level */
    var mag = 0.08 + rng() * 0.34;
    var s = (rng() < 0.5 ? -1 : 1) * mag;
    if (bias > 0.25 && s > 0) { s = -s; }
    if (bias < -0.25 && s < 0) { s = -s; }
    return s * hilly;
  }

  function buildMoves(track, stage, rng) {
    var curvy = stage.curviness || 1;
    var hilly = stage.hilliness || 1;
    var dir = rng() < 0.5 ? 1 : -1;
    var pattern = [
      'straight', 'curve', 'hill', 'scurve', 'straight', 'crest',
      'hairpin', 'dip', 'curve', 'bumps', 'straight', 'hill',
      'scurve', 'curve', 'hairpin', 'crest', 'bumps', 'dip'
    ];
    var pi = 0, kind, mag, len, c;

    addStraight(track, OPENING_STRAIGHT);

    while (track.segments.length < TARGET_SEGMENTS) {
      kind = pattern[pi % pattern.length];
      pi++;
      /* a long breather after every hairpin */
      mag = CURVE.EASY + rng() * (CURVE.HARD - CURVE.EASY);
      c = clamp(mag * curvy, 0, CURVE.MAX) * dir;

      if (kind === 'straight') {
        len = 26 + Math.floor(rng() * 38);
        addRoad(track, 6, len, 6, 0, chooseSlope(track, hilly, rng) * 0.4);
      } else if (kind === 'curve') {
        len = 34 + Math.floor(rng() * 34);
        addRoad(track, Math.round(len * 0.28), Math.round(len * 0.44), Math.round(len * 0.28),
          c, chooseSlope(track, hilly, rng) * 0.35);
        dir = -dir;
      } else if (kind === 'scurve') {
        len = 22 + Math.floor(rng() * 16);
        c = clamp(CURVE.MEDIUM * curvy, 0, CURVE.MAX) * dir;
        addRoad(track, Math.round(len * 0.3), Math.round(len * 0.4), Math.round(len * 0.3), c, 0);
        c = -c * 0.85;
        addRoad(track, Math.round(len * 0.3), Math.round(len * 0.4), Math.round(len * 0.3), c, 0);
        dir = -dir;
      } else if (kind === 'hairpin') {
        len = 40 + Math.floor(rng() * 22);
        c = clamp(CURVE.HAIRPIN * curvy, 0, CURVE.MAX) * dir;
        addRoad(track, 10, len, 14, c, chooseSlope(track, hilly, rng) * 0.25);
        dir = -dir;
      } else if (kind === 'hill') {
        len = 44 + Math.floor(rng() * 40);
        addRoad(track, Math.round(len * 0.32), Math.round(len * 0.36), Math.round(len * 0.32),
          0, chooseSlope(track, hilly, rng));
      } else if (kind === 'crest') {
        var up = 30 + Math.floor(rng() * 22);
        var down = 30 + Math.floor(rng() * 22);
        addRoad(track, 10, up, 8, 0, Math.abs(chooseSlope(track, hilly, rng)) * 1.15);
        addRoad(track, 8, down, 10, 0, -Math.abs(chooseSlope(track, hilly, rng)) * 1.15);
      } else if (kind === 'dip') {
        var dn = 26 + Math.floor(rng() * 20);
        var upn = 26 + Math.floor(rng() * 20);
        addRoad(track, 10, dn, 8, 0, -Math.abs(chooseSlope(track, hilly, rng)) * 1.1);
        addRoad(track, 8, upn, 10, 0, Math.abs(chooseSlope(track, hilly, rng)) * 1.1);
      } else if (kind === 'bumps') {
        len = 22 + Math.floor(rng() * 26);
        addStraight(track, 4);
        addBumps(track, len, (34 + rng() * 62) * hilly);
        addStraight(track, 4);
      }
    }
  }

  /* The eased y ramps never quite reach their target (the last step is at
     (total-1)/total), so a few world units of drift accumulate over the lap.
     Spread a linear correction over the final straight to land on exactly 0,
     otherwise the seam between the last and first segment would snap. */
  function snapToZero(track) {
    var segs = track.segments;
    var n = segs.length;
    if (n < 2) { return; }
    var resid = segs[n - 1].p2.world.y;
    if (!(Math.abs(resid) > 1e-9)) {
      segs[n - 1].p2.world.y = 0;
      return;
    }
    var k = Math.min(n - 1, CLOSING_STRAIGHT);
    var start = n - k;
    var i, f;
    for (i = start; i < n; i++) {
      f = (i - start + 1) / k;
      segs[i].p2.world.y = segs[i].p2.world.y - resid * f;
      if (i > start) { segs[i].p1.world.y = segs[i - 1].p2.world.y; }
    }
    segs[n - 1].p2.world.y = 0;
  }

  /* Bring the track back to y = 0 and curve = 0 so the last segment joins the
     first one exactly (otherwise crossing the lap line snaps the world). */
  function closeTrack(track) {
    var y = lastY(track);
    var n, len, slope;
    if (Math.abs(y) > 0.5) {
      len = clamp(Math.round(Math.abs(y) / (SEG_LEN * 0.34)), 34, 220);
      slope = -y / (len * SEG_LEN);
      addRoad(track, Math.round(len * 0.3), Math.round(len * 0.4), Math.round(len * 0.3), 0, slope);
    }
    /* guarantee both ends of the seam are dead flat and dead straight */
    addStraight(track, CLOSING_STRAIGHT);
    for (n = 0; n < CLOSING_STRAIGHT; n++) {
      track.segments[track.segments.length - 1 - n].curve = 0;
    }
    /* the opening straight is flat/straight by construction; assert it so the
       seam is provably clean whichever way the recipe evolved */
    for (n = 0; n < 8; n++) {
      track.segments[n].curve = 0;
      track.segments[n].p1.world.y = 0;
      track.segments[n].p2.world.y = 0;
    }
    snapToZero(track);
  }

  /* ------------------------------------------------------------- scenery --- */

  function sceneryNames(theme) {
    var cand = null, ok, i;
    if (typeof SPRITES !== 'undefined' && SPRITES && SPRITES.SCENERY) {
      cand = SPRITES.SCENERY[theme.key];
    }
    if (cand && cand.length) {
      if (typeof SPRITES.has === 'function') {
        ok = [];
        try {
          for (i = 0; i < cand.length; i++) {
            if (SPRITES.has(cand[i])) { ok.push(cand[i]); }
          }
        } catch (e) { ok = []; }
        if (ok.length >= 2) { return ok; }
      }
      return cand;
    }
    if (theme.scenery && theme.scenery.length) { return theme.scenery; }
    return ['palm', 'bush', 'rock', 'lamp'];
  }

  /* Sprites sitting further from the road are drawn smaller, so a verge of
     palms reads as depth instead of a wall of identical trees. */
  function vergeScale(rng, offset) {
    var s = 0.9 + rng() * 0.75;
    s = s * (1.42 - 0.20 * Math.abs(offset));
    return clamp(s, 0.55, 2.0);
  }

  function addScenery(track, theme, rng) {
    var names = sceneryNames(theme);
    var segs = track.segments;
    var n = segs.length;
    var i = 8, gap, off, side, name, seg, big;

    while (i < n) {
      i += CORE.rndInt(rng, 3, 9);
      if (i >= n) { break; }
      seg = segs[i];
      side = rng() < 0.5 ? -1 : 1;
      off = side * CORE.rnd(rng, 1.25, 3.0);
      name = CORE.pick(rng, names);
      seg.sprites.push({ source: name, offset: off, scale: vergeScale(rng, off) });

      if (rng() < 0.34) {
        off = -side * CORE.rnd(rng, 1.4, 2.9);
        name = CORE.pick(rng, names);
        seg.sprites.push({ source: name, offset: off, scale: vergeScale(rng, off) });
      }
    }

    /* landmarks: billboards and arches, evenly spaced but never in the
       opening straight (they would block the start line). */
    big = 0;
    for (i = 120; i < n - 20; i += 96) {
      seg = segs[i + Math.floor(rng() * 24)];
      if (!seg) { continue; }
      big++;
      if (big % 3 === 0 && theme.scenery && theme.scenery.length) {
        seg.sprites.push({ source: 'arch', offset: 0, scale: 2.4 });
      } else {
        off = (rng() < 0.5 ? -1 : 1) * CORE.rnd(rng, 1.6, 2.2);
        seg.sprites.push({
          source: 'billboard_' + CORE.rndInt(rng, 0, 3),
          offset: off,
          scale: 1.35 + rng() * 0.5
        });
      }
    }
  }

  /* ---------------------------------------------------------------- cars --- */

  function buildCars(track, stage, rng) {
    var count = Math.max(0, stage.traffic | 0);
    var cars = [];
    var i, kind, car, z, span, off;
    var trackLength = track.trackLength;
    /* keep the start grid clear so the player is not immediately hit */
    var head = OPENING_STRAIGHT * SEG_LEN * 2;
    span = Math.max(SEG_LEN * 40, trackLength - head - SEG_LEN * 40);

    for (i = 0; i < count; i++) {
      kind = CAR_KINDS[CORE.rndInt(rng, 0, CAR_KINDS.length - 1)];
      z = head + (i / Math.max(1, count)) * span + CORE.rnd(rng, -SEG_LEN * 3, SEG_LEN * 3);
      z = CORE.wrapZ(z, trackLength);
      off = CORE.rnd(rng, -0.82, 0.82);
      car = {
        offset: off,
        z: z,
        sprite: kind.sprite,
        speed: CORE.rnd(rng, kind.lo, kind.hi) * T.MAX_SPEED,
        w: kind.w,
        h: kind.h,
        segIndex: Math.floor(z / SEG_LEN) % track.segments.length,
        percent: (z % SEG_LEN) / SEG_LEN
      };
      cars.push(car);
      track.segments[car.segIndex].cars.push(car);
    }
    return cars;
  }

  /* -------------------------------------------------------------- build ---- */

  function build(stageIndex) {
    var idx = clamp(stageIndex | 0, 0, CORE.STAGES.length - 1);
    var stage = CORE.STAGES[idx];
    var theme = CORE.THEMES[stage.theme] || CORE.THEMES.sunset;
    var rng = CORE.rng(stage.seed);

    var track = {
      stageIndex: idx,
      theme: theme,
      name: stage.name,
      segments: [],
      trackLength: 0,
      checkpoints: [],
      cars: [],
      seed: stage.seed,
      lanes: T.LANES,
      roadWidth: ROAD_WIDTH,
      segmentLength: SEG_LEN,
      lapCount: stage.laps
    };

    buildMoves(track, stage, rng);
    closeTrack(track);

    var n = track.segments.length;
    track.trackLength = n * SEG_LEN;

    /* checkpoints: first entry is the start/finish line (segment 0) and the
       LAST entry repeats it, so the array closes the lap — crossing the final
       gate returns you to the line.  The interior entries are strictly
       ascending segment indices.  `state.nextCheckpoint` indexes THIS array. */
    var g, gates = [];
    for (g = 0; g < CHECKPOINT_GATES; g++) {
      gates.push(Math.floor(n * g / CHECKPOINT_GATES));
    }
    gates[0] = 0;
    gates.push(gates[0]);
    track.checkpoints = gates;

    addScenery(track, theme, rng);
    track.cars = buildCars(track, stage, rng);

    return track;
  }

  /* ---------------------------------------------------------- projection --- */

  function project(p, cameraX, cameraY, cameraZ, cameraDepth, width, height, roadWidth) {
    var w = p.world;
    var wx = w.x || 0, wy = w.y || 0, wz = w.z || 0;
    var cz = wz - cameraZ;
    var scale = cameraDepth / cz;

    p.camera.x = wx - cameraX;
    p.camera.y = wy - cameraY;
    p.camera.z = cz;

    p.screen.scale = scale;
    p.screen.x = Math.round((width / 2) + (scale * p.camera.x * width / 2));
    p.screen.y = Math.round((height / 2) - (scale * p.camera.y * height / 2));
    p.screen.w = Math.round(scale * roadWidth * width / 2);
    return p;
  }

  /* ------------------------------------------------------------- lookups --- */

  function segmentAt(track, index) {
    var segs = track.segments;
    var n = segs.length;
    if (n === 0) { return null; }
    var i = index % n;
    if (i < 0) { i += n; }
    return segs[i];
  }

  function findSegment(track, z) {
    var segs = track.segments;
    var n = segs.length;
    if (n === 0) { return null; }
    var len = track.trackLength || (n * SEG_LEN);
    var i = Math.floor(CORE.wrapZ(z, len) / SEG_LEN);
    if (!(i >= 0)) { i = 0; }
    if (i >= n) { i = n - 1; }
    return segs[i];
  }

  function playerSegmentIndex(track, position) {
    var seg = findSegment(track, position + T.PLAYER_Z);
    return seg ? seg.index : 0;
  }

  /* --------------------------------------------------------------- misc ---- */

  /* Fraction of a lap completed, 0..1 (handy for the HUD). */
  function lapProgress(track, position) {
    if (!track || !track.trackLength) { return 0; }
    return CORE.wrapZ(position, track.trackLength) / track.trackLength;
  }

  function selfTest() {
    var checks = [], t, i, ok;
    function ck(name, good, detail) { checks.push({ name: name, ok: !!good, detail: detail || '' }); }

    for (i = 0; i < CORE.STAGES.length; i++) {
      t = build(i);
      ck('segments[' + i + ']>=1200', t.segments.length >= MIN_SEGMENTS, String(t.segments.length));
      ck('seam-y[' + i + ']', Math.abs(t.segments[t.segments.length - 1].p2.world.y - t.segments[0].p1.world.y) < 1e-6);
      ck('seam-curve[' + i + ']', t.segments[t.segments.length - 1].curve === 0 && t.segments[0].curve === 0);
      ck('trackLength[' + i + ']', t.trackLength === t.segments.length * SEG_LEN);
      var cps = t.checkpoints;
      var last = cps.length - 1;
      ok = cps.length >= 2 && cps[0] === 0 && cps[last] === cps[0];
      for (var c = 1; c < last; c++) {
        if (!(cps[c] > cps[c - 1])) { ok = false; }
        if (cps[c] >= t.segments.length) { ok = false; }
      }
      ck('checkpoints[' + i + ']', ok, t.checkpoints.join(','));
      ck('cars[' + i + ']', t.cars.length === CORE.STAGES[i].traffic, String(t.cars.length));
    }

    var p = { world: { x: 0, y: 0, z: 2000 }, camera: {}, screen: {} };
    project(p, 0, 0, 0, T.CAMERA_DEPTH, CORE.W, CORE.H, ROAD_WIDTH);
    var far = { world: { x: 0, y: 0, z: 20000 }, camera: {}, screen: {} };
    project(far, 0, 0, 0, T.CAMERA_DEPTH, CORE.W, CORE.H, ROAD_WIDTH);
    ck('project.scale-near-bigger', p.screen.scale > far.screen.scale,
      p.screen.scale.toFixed(6) + ' > ' + far.screen.scale.toFixed(6));
    ck('project.w-near-bigger', p.screen.w > far.screen.w, p.screen.w + ' > ' + far.screen.w);
    ck('project.centre', far.screen.x === CORE.W / 2 && far.screen.y === CORE.H / 2);

    ok = true;
    for (i = 0; i < checks.length; i++) { if (!checks[i].ok) { ok = false; } }
    return { ok: ok, checks: checks };
  }

  return {
    CURVE: CURVE,
    SLOPE: SLOPE,
    MIN_SEGMENTS: MIN_SEGMENTS,

    build: build,
    project: project,
    findSegment: findSegment,
    segmentAt: segmentAt,
    playerSegmentIndex: playerSegmentIndex,
    lapProgress: lapProgress,

    selfTest: selfTest
  };
})();
