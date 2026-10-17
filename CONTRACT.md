# NEON DRIFT '86 — FROZEN INTERFACE CONTRACT v1

Retro pseudo-3D arcade racer (Out Run / Pole Position lineage), HTML5 canvas, **zero runtime
network dependencies**: every sprite is generated procedurally at boot, every sound is
synthesised with the Web Audio API, and text uses a built-in bitmap font.

**Do not change anything in this file or in `src/core.js` without telling the Lead.**
Everything here is the seam between four independently-written modules.

---

## 0. Hard rules

| Rule | Reason |
|---|---|
| Classic `<script>` tags, **no ES modules, no `import`/`export`, no bundler** | the game must run from `file://` by double-clicking |
| Each module exposes **exactly one** global via `var NAME = (function(){...})();` | load order is fixed in `index.html` |
| No `fetch`/`XMLHttpRequest`/CDN/fonts/images from the network | must work fully offline |
| No `eval`, no `new Function` | CSP-friendliness |
| ES5-compatible syntax only (`var`, `function`) — no `let/const/arrow/template literals/class` | keeps the single-file bundle trivially safe everywhere |
| Internal render resolution is **384 x 216**; never assume canvas CSS size | pixel-art authenticity via integer upscale |
| Everything is drawn at 384x216; **never** use `ctx.scale`/`ctx.translate` for the world camera | keeps pixel snapping exact |

`'use strict';` inside each IIFE.

### Load order (fixed)
```
src/core.js  → src/road.js → src/sprites.js → src/audio.js → src/render.js → src/input.js → src/game.js
```

---

## 1. Ownership / write scopes

| Owner | Files | Notes |
|---|---|---|
| **lead** | `src/core.js`, `index.html`, `styles.css`, `tools/build.mjs`, `README.md` | contract owner |
| **engine** | `src/road.js`, `src/render.js` | track geometry + all drawing |
| **assets** | `src/sprites.js`, `src/audio.js` | procedural pixel art + chiptune |
| **gameplay** | `src/game.js`, `src/input.js` | loop, physics, state machine, scoring |
| **verifier** | `tools/**` except `tools/build.mjs` | harness, tests, screenshots |

Nobody edits a file outside their scope. If you need a change elsewhere, message the Lead.

---

## 2. `CORE` (given, `src/core.js`)

```
CORE.VERSION      : string
CORE.W, CORE.H    : 384, 216            internal resolution
CORE.TAU          : Math.PI * 2

--- math ---
CORE.clamp(v, lo, hi)
CORE.lerp(a, b, t)
CORE.easeIn(a, b, p) / easeOut / easeInOut
CORE.accelerate(v, accel, dt)          -> v + accel*dt
CORE.percentRemaining(n, total)        -> (n % total) / total
CORE.overlap(x1, w1, x2, w2, percent)  -> bool
CORE.wrapZ(z, trackLength)             -> z wrapped into [0, trackLength)
CORE.increase(start, inc, max)         -> wrapped start+inc

--- seeded rng (deterministic; ALWAYS pass an rng in) ---
CORE.rng(seed)        -> function(): float [0,1)
CORE.rnd(rng, a, b)   -> float
CORE.rndInt(rng, a, b)-> int, inclusive
CORE.pick(rng, arr)   -> element

--- misc ---
CORE.makeCanvas(w, h) -> HTMLCanvasElement (offscreen)
CORE.now()            -> ms (performance.now or Date.now)
CORE.storage.get(key, def) / CORE.storage.set(key, val)   // try/catch wrapped localStorage
CORE.formatTime(sec)  -> "1:23.45"      // m:ss.cc
CORE.formatScore(n)   -> zero-padded score string
CORE.pad(n, len)      -> string
CORE.selfTest()       -> { ok: bool, checks: [{name, ok, detail}] }

--- bitmap font (5x7, uppercase only) ---
CORE.FONT_W = 5, CORE.FONT_H = 7
CORE.textWidth(text, scale, spacing) -> px
CORE.drawText(ctx, text, x, y, opts) -> width drawn
   opts = { color:'#fff', scale:1, spacing:1, align:'left'|'center'|'right',
            shadow:false|'#000', baseline:'top'|'middle' }
   `scale` MUST be an integer >= 1. Text is upper-cased internally.

--- tunables (all of them; read, never mutate) ---
CORE.TUNING = {
  SEGMENT_LENGTH  : 200,      RUMBLE_LENGTH  : 3,
  ROAD_WIDTH      : 2000,     LANES          : 3,
  FIELD_OF_VIEW   : 100,      CAMERA_HEIGHT  : 1000,
  DRAW_DISTANCE   : 220,      FOG_DENSITY    : 5,
  MAX_SPEED       : 12000,                       // units/second at the fixed step
  ACCEL           : 2400,     BREAKING       : -12000,  DECEL : -2400,
  OFF_ROAD_DECEL  : -6000,    OFF_ROAD_LIMIT : 3000,
  CENTRIFUGAL     : 0.3,
  STEP            : 1 / 60,
  CAMERA_DEPTH    : 1 / Math.tan((100/2) * Math.PI/180),   // ~0.8391
  PLAYER_Z        : 1000 * CAMERA_DEPTH,
  SPRITE_SCALE    : 0.3 / 48,
  ROAD_WIDTH_HALF : 1000
}

--- themes ---
CORE.THEMES = { sunset:{...}, night:{...}, dawn:{...} }   // see src/core.js for fields
CORE.STAGES = [ {id, code, name, theme, laps, traffic, timeLimit}, x3 ]
```

---

## 3. `ROAD` (engine) — `src/road.js`

Pure geometry + track construction. **No canvas access at all.**

```js
ROAD.build(stageIndex) -> Track
```

```js
Track = {
  stageIndex : int,
  theme      : CORE.THEMES[...],     // same object identity
  name       : string,               // e.g. 'SUNSET STRIP'
  segments   : Segment[],            // length >= 1200; LAST segment must join the first
  trackLength: int,                  // segments.length * CORE.TUNING.SEGMENT_LENGTH
  checkpoints: int[],                // sorted segment indices; last one == first index (lap line)
  cars       : Car[],                // all AI cars, already seeded with z + offset + sprite
  seed       : int
}
```

```js
Segment = {
  index  : int,
  p1     : Point, p2 : Point,        // p1 = near edge, p2 = far edge
  curve  : float,                    // signed, 0 = straight
  sprites: [ { source:string, offset:float, scale:float } ],
  cars   : Car[],                    // cars currently inside this segment (maintained by gameplay)
  dark   : bool,                     // alternating ground colour, computed at build time
  looped : false,                    // set by render.js each frame
  fog    : 0,                        // set by render.js each frame
  clip   : 0,                        // set by render.js each frame
  light  : 0                         // set by render.js each frame (0..1, 1 = nearest)
}

Point = { world:{x,y,z}, camera:{x,y,z}, screen:{x,y,w,scale} }
```

```js
Car = {
  offset   : float,       // -1..1 lateral, relative to road half width
  z        : float,       // world z, kept in [0, trackLength)
  sprite   : string,      // SPRITES key
  speed    : float,       // units/second, 0 < speed < CORE.TUNING.MAX_SPEED * 0.8
  w        : int,         // world-ish collision width  (> 0)
  h        : int,         // collision height
  segIndex : int,         // maintained by gameplay: which segment it is in
  percent  : float        // 0..1 position inside that segment
}
```

Also exported (used by gameplay for collision + by render for projection):

```js
ROAD.findSegment(track, z)                  -> Segment
ROAD.project(p, cameraX, cameraY, cameraZ, cameraDepth, width, height, roadWidth)
                                            // fills p.camera.* and p.screen.*, returns p
ROAD.segmentAt(track, index)                -> Segment   // wrapped
ROAD.playerSegmentIndex(track, position)    -> int
```

`project()` must implement the standard perspective divide:
`scale = cameraDepth / (p.world.z - cameraZ)`, `screen.x = (width/2) + scale*(p.camera.x)*width/2`,
`screen.y = (height/2) - scale*(p.camera.y)*height/2`, `screen.w = scale * roadWidth * width/2`.

---

## 4. `SPRITES` (assets) — `src/sprites.js`

All art is **procedurally generated into offscreen canvases at boot**. No image files.

```js
SPRITES.init()            -> void      // idempotent, must be called once before get()
SPRITES.get(name)         -> { canvas:HTMLCanvasElement, w:int, h:int, anchor:{x,y} } | null
SPRITES.has(name)         -> bool
SPRITES.names()           -> string[]
SPRITES.SCENERY           -> { sunset:[names], night:[names], dawn:[names] }
SPRITES.HERO              -> { straight, left, right, brake, shadow }   // sprite keys
SPRITES.OPPONENTS         -> { sunset:[names], night:[names], dawn:[names] }
```

`anchor` is the fraction of the sprite that sits **on the ground**: `{x:0.5, y:1}` means the
bottom-centre pixel is the contact point. Use `{x:0.5,y:1}` unless a sprite genuinely floats.

### Required sprite keys (exact names)

**Player car** — rear 3/4 view, nominal **48 x 27 px**:
`player_straight`, `player_left`, `player_right`, `player_brake`, `player_shadow`

**Opponent traffic** — rear view, nominal **44 x 24 px** (ride height differs per vehicle):
`car_red`, `car_blue`, `car_green`, `car_yellow`, `car_purple`, `truck_white`, `truck_blue`

**Scenery** (any size, keep width <= 96 px):
`palm`, `pine`, `cactus`, `rock`, `bush`, `boulder`, `lamp`, `arch`,
`billboard_0`, `billboard_1`, `billboard_2`, `billboard_3`

**Crash FX frames** (square-ish, nominal 32 x 32, drawn centred):
`boom_0`, `boom_1`, `boom_2`, `boom_3`

Sprites must use the **stage palettes in `CORE.THEMES`** so scenery reads correctly on all
three stages. Use hard-edged pixels only (no `shadowBlur`, no anti-aliased curves): draw with
`fillRect` on 1-px grid, or `imageSmoothingEnabled = false` when scaling a smaller sketch up.

---

## 5. `AUDIO` (assets) — `src/audio.js`

100 % Web Audio synthesis. Must never throw when the context is suspended or unavailable:
every public method is a no-op if audio is not ready.

```js
AUDIO.init()                     -> Promise|void   // create ctx; safe to call repeatedly
AUDIO.unlock()                   -> void           // call on first user gesture; resumes ctx
AUDIO.ready                      -> bool
AUDIO.playMusic(trackId)         -> void           // 'title' | 'race' | 'result'
AUDIO.stopMusic()                -> void
AUDIO.setMusicTempo(bpm)         -> void           // race music speeds up with the engine
AUDIO.sfx(name)                  -> void           // one-shot
AUDIO.setEngine(rpm01, on)       -> void           // continuous engine tone, rpm01 in 0..1
AUDIO.setSkid(on)                -> void           // continuous tyre screech
AUDIO.setMuted(m) / AUDIO.isMuted()
AUDIO.update(dt)                 -> void           // optional per-frame housekeeping
```

`sfx` names: `beep`, `go`, `checkpoint`, `crash`, `select`, `shift`, `engine_start`, `timeup`.

Chiptune instrumentation: 2 pulse channels (variable duty), 1 triangle bass, 1 noise drum.
`title` = slow moody outrun arpeggio; `race` = driving 4/4 with a bass line that must loop
seamlessly; `result` = short jingle that resolves. Master gain must stay well under clipping
(peak <= 0.35) and honour `setMuted`.

---

## 6. `RENDER` (engine) — `src/render.js`

Owns **every pixel** the player sees, including the HUD and the CRT post-process.

```js
RENDER.init(ctx, state)   -> void    // ctx is the 2D context of the 384x216 backbuffer
RENDER.draw(ctx, state)   -> void    // full frame, in this order:
                                     //   sky → parallax → road → sprites → player → HUD → CRT
RENDER.reset()            -> void    // forget cached per-track data (called on track change)
RENDER.setQuality(q)      -> void    // 'high' | 'low'  (low disables CRT + reduces draw distance)
```

The renderer **must not mutate** gameplay-owned fields. It may write only:
`segment.looped/.fog/.clip/.light`, `state.shakeX`, `state.shakeY`, `state.fps`.

Everything visual is driven by `state` (see §7) — the renderer never reads `GAME` or `INPUT`.

Look requirements (arcade 1986, not a modern 2D game):
- hard pixel edges, no blur, no anti-aliasing, no gradients on gameplay elements
- parallax sky: banded gradient + big slitted sun + two mountain layers, scrolling with `state.skyOffset`/`hillOffset`
- road: 3 lanes, alternating rumble strips, lane dashes that scroll, exponential fog to the theme's `fog` colour
- sprites drawn far→near with painter's algorithm; clip sprites against the road horizon
- road-side geometry must scale by `segment.p1.screen.scale`
- **CRT pass** (in `high`): 1-in-N scanlines, 2-px edge vignette, subtle vertical chroma shift, occasional
  horizontal tear line. Keep it cheap: pre-render static overlays once, never per-frame gradients over 384x216.
- HUD (see §7.1) drawn in the bitmap font, chunky, with a hard shadow.

---

## 7. `GAME` + `INPUT` (gameplay)

```js
INPUT.init(targetEl) -> void
INPUT.state          -> { left, right, up, down, start, select, brake }   // booleans, live
INPUT.pressed(action)-> bool    // edge-triggered, consumes the press
INPUT.anyPressed()   -> bool
INPUT.axis           -> { steer:-1..1, throttle:0..1, brake:0..1 }        // analogue sources
INPUT.reset()        -> void
```
Keyboard: `←/A` left, `→/D` right, `↑/W` accelerate, `↓/S` brake, `Space` handbrake/drift,
`Enter` start/confirm, `Esc` pause, `M` mute, `F` fps. Touch + gamepad must also work
(gamepad polled each frame inside `INPUT.state`'s getter or an `INPUT.update()` hook —
`INPUT.update()` is called by `GAME` every frame).

```js
GAME.boot(canvas)  -> void   // canvas is the visible element (CSS-sized); GAME owns the
                             // 384x216 backbuffer + integer upscale + letterbox
GAME.update(dt)    -> void
GAME.render()      -> void
GAME.state         -> State
```

`GAME` owns: the fixed-timestep accumulator (`CORE.TUNING.STEP`), the rAF loop, all physics,
collisions, checkpoint/lap logic, scoring, mode transitions, `localStorage` bests, and the
`Escape`-pause. On every track change it calls `RENDER.reset()`.

### 7.1 `State` — the frozen frame contract

`CORE.createState()` produces this. **`GAME` writes it, `RENDER` reads it.**

```
timing   : now, dt, frame, fps
flow     : mode, modeTime, prevMode
           mode ∈ 'boot'|'title'|'select'|'countdown'|'race'|'paused'|'stageclear'|'gameover'
player   : position, speed, playerX, playerY, steer, throttle, brake,
           gear, rpm (0..1), shiftTimer
stage    : stage, stageIndex, lap, laps, trackLength, track, segments, cars,
           checkpoint, checkpoints, nextCheckpoint, timeLeft,
           lapTime, lastLapTime, bestLapTime, totalTime, score, combo, best
camera   : cameraHeight, cameraDepth, playerZ, skyOffset, hillOffset, treeOffset
fx       : shake, flash, hitTimer, offRoad, skid, crash (bool), crashTimer
ui       : menuIndex, menuItems, countdown, paused, muted, quality, showFps, hint
messages : [{ text, color, scale, x, y, ttl, ttl0 }]
theme    : object from CORE.THEMES (must equal track.theme)
results  : null | { stageName, totalTime, bestLap, score, finished, laps }
debug    : errors[]
```

`state.segments` and `state.cars` are the arrays from `state.track` (same references) so the
renderer can walk them without touching `ROAD`.

### 7.2 Gameplay rules (fixed, so the renderer can lay out the HUD)

- 3 stages, each 2 laps, each with a checkpoint timer. Crossing a checkpoint adds time.
- Running the timer to 0 → `gameover`. Finishing the last lap of stage 3 → `stageclear` → results.
- Off-road (|playerX| > 1): heavy deceleration + screen shake + skid sfx; hitting traffic: speed
  penalty, shake, `crash` flash, brief invulnerability.
- Drift: holding handbrake while steering above 60 % speed increases steering authority and
  produces skid marks (`state.skid`).
- Gear/rpm are cosmetic-but-plausible: 5 gears, `rpm` sawtooths 0→1 inside each gear.
- Best lap and best score persist through `CORE.storage` under `neondrift86.*`.

---

## 8. AMENDMENTS (agreed during implementation — these override the sections above)

**A1 — `Track.checkpoints` is closed.** §3 stands as written: the array's **last element equals
its first** (the start/finish line). `GAME` additionally tolerates the un-closed shape.

**A2 — `state.nextCheckpoint` is an ARRAY INDEX into `state.checkpoints`**, *not* a segment
number (`RENDER` reads `state.checkpoints[state.nextCheckpoint]`).
`state.checkpoint` is the **segment index** of the most recently passed checkpoint.

**A3 — stage start time is computed, not `stage.timeLimit`.** `GAME` uses
`clamp(trackLength * laps / (0.55 * MAX_SPEED) * 0.48, 20, stage.timeLimit)`, so a fast track
gets a tight clock instead of a meaningless 100 s. `stage.timeLimit` remains the upper bound.
All feel constants live in a single `FEEL` block at the top of `src/game.js`.

**A4 — scanlines are CSS, not canvas.** The CRT aperture grille lives in `styles.css`
(`.glass::after`) so it is 1 px at *output* resolution instead of being integer-multiplied into
3-5 px stripes. `RENDER`'s `high` quality keeps only: subtle vignette, very light chroma
(<= 1 px, alpha <= 0.12, never on HUD text) and an occasional tear line.
Acceptance: enabling the post-process must change frame mean luminance by **<= 15 %**.

**A5 — `GAME.boot()` sets an inline `width`/`height` style on the visible canvas** (the integer
upscale), so `styles.css` must never set a competing size on `#screen`. It currently does not.

**A6 — persistence keys**: `neondrift86.bestScore`, `neondrift86.bestLap{0,1,2}`,
`neondrift86.muted`, `neondrift86.quality`.

**A7 — extra public members are allowed** as long as the contracted ones keep their exact
names and semantics (`INPUT.handbrake/touching/padConnected`, `GAME.stop/layout/pushMessage`).

**A8 — `ROAD.project()` rounds `screen.x/y/w` to whole pixels** (`scale` and `camera.*` stay
exact). This is deliberate for a pixel-art renderer and supersedes the literal formula in §3.
`scale` must still be the exact perspective divide so sprite sizing stays smooth.

**A9 — score resets per stage by design.** `GAME.startStage()` zeroes `state.score`; `state.best`
is the persistent cross-session value. A `gameover` frame showing `SCORE 0000000` next to a
non-zero `BEST` is correct, not a bug.

**A10 — the CRT chroma pass must be luminance-neutral.** Reconstructing the frame from
per-channel copies requires **`base = 1`**, not `1/3`: the three `multiply`+`lighter` iterations
each land back in their *own* channel, so `(1/3)(R,0,0) + (1/3)(0,G,0) + (1/3)(0,0,B)` is
`(R,G,B)/3`, i.e. a 67 % luminance loss — not a reconstruction. With `base = 1` and
`shift ≈ 0.12` the pass is exactly luminance-neutral and leaves only a ~1 px colour fringe.
Guard: `render.crt-stays-subtle` must keep >= 60 % of pre-CRT mean luminance (target ~100 %).

**A11 — `GAME.layout()` must measure available space, never the canvas itself.**
Reading `canvas.getBoundingClientRect()` to derive the integer upscale factor is
self-referential: the canvas starts at 384x216, so `k` locks to 1 forever.
Use `chromeH = document.body.clientHeight - canvas.parentElement.getBoundingClientRect().height`
and `k = floor(min((vw - 48) / W, (vh - chromeH - 28) / H))`.
Because chrome height does not depend on canvas size, one pass converges from any start state.

---

## 9. Definition of done

1. `index.html` opened from `file://` shows the title screen; `Enter` starts a race.
2. 60 fps at 384x216 with the CRT pass on, on integrated graphics.
3. No console errors or warnings during 3 minutes of play across all 3 stages.
4. All 3 stages render distinct themes; checkpoints, laps, timer, gameover and results all work.
5. Keyboard, touch and gamepad all drive the car; `M` mutes; `Esc` pauses.
6. `tools/build.mjs` inlines everything into a single self-contained `neon-drift-86.html`.
