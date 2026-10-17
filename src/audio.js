/* ==========================================================================
 * NEON DRIFT '86  —  src/audio.js
 * 100% Web Audio synthesis.  No sample files, no network, no fonts.
 *
 *   channels   : 2 pulse voices (variable duty) + triangle bass + noise drum
 *   music      : 'title' slow outrun arpeggio, 'race' driving 4/4 (seamless
 *                loop), 'result' short resolving jingle
 *   continuous : engine (detuned saw+square through a tracking lowpass, with
 *                an intake noise layer and firing-order amplitude wobble) and
 *                tyre screech
 *
 * Hard rule: every public method is a safe no-op when Web Audio is missing,
 * the context is suspended, or init() was never called.  Nothing here throws.
 *
 * Exposes the single global 'AUDIO'.
 * ========================================================================== */
var AUDIO = (function () {
  'use strict';

  /* ------------------------------------------------------------ gain budget
     Worst case: 2 pulse voices + bass + a drum peak, all under musicBus, plus
     engine and one sfx.  Everything is trimmed so the signal at the
     destination stays below 0.35 peak.                                        */
  var MASTER_GAIN = 0.28;
  var MUSIC_GAIN = 0.55;
  var SFX_GAIN = 0.90;
  var ENGINE_GAIN = 0.70;
  var SKID_GAIN = 0.55;

  var ctx = null;
  var master = null, musicBus = null, sfxBus = null, engBus = null;
  var ready = false;
  var muted = false;
  var noiseBuf = null;
  var waveCache = {};

  var song = null, songId = '', step = 0, nextTime = 0, playing = false;
  var tempoBpm = 0;                 /* 0 = use the song's own tempo */
  var pendingTrack = null;
  var timer = null;

  var engine = null, skid = null;
  var engineOn = false, engineRpm = 0;

  /* ====================================================================== *
   *  tiny guarded wrappers — every Web Audio call goes through one of these
   * ====================================================================== */

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }

  function paramAt(param, method, v, t) {
    try { if (param && typeof param[method] === 'function') { param[method](v, t); } } catch (e) { }
  }
  function setAt(param, v, t) { paramAt(param, 'setValueAtTime', v, t); }
  function linAt(param, v, t) { paramAt(param, 'linearRampToValueAtTime', v, t); }
  function expAt(param, v, t) { paramAt(param, 'exponentialRampToValueAtTime', v < 0.0001 ? 0.0001 : v, t); }
  function cancel(param) { try { if (param && param.cancelScheduledValues) { param.cancelScheduledValues(nowT()); } } catch (e) { } }

  function nowT() { try { return ctx ? ctx.currentTime : 0; } catch (e) { return 0; } }

  function node(create) {
    try { return ctx ? create() : null; } catch (e) { return null; }
  }
  function connect(a, b) {
    try { if (a && b && a.connect) { a.connect(b); } } catch (e) { }
  }
  function startAt(src, t) {
    try { if (src && src.start) { src.start(t); } } catch (e) { }
  }
  function stopAt(src, t) {
    try { if (src && src.stop) { src.stop(t); } } catch (e) { }
  }

  /* ====================================================================== *
   *  note helpers
   * ====================================================================== */

  var SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

  function noteMidi(name) {
    var s = String(name), i = 0, n, acc = 0, oct;
    var c = s.charAt(0).toUpperCase();
    if (!(c in SEMI)) { return -1; }
    n = SEMI[c];
    i = 1;
    if (s.charAt(i) === '#') { acc = 1; i++; }
    else if (s.charAt(i) === 'b') { acc = -1; i++; }
    oct = parseInt(s.slice(i), 10);
    if (!isFinite(oct)) { return -1; }
    return (oct + 1) * 12 + n + acc;
  }

  function midiFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  function noteFreq(name) {
    var m = noteMidi(name);
    return m < 0 ? 0 : midiFreq(m);
  }
  function transpose(name, semi) {
    var m = noteMidi(name);
    if (m < 0) { return name; }
    m += semi;
    var names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    return names[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
  }

  /* ====================================================================== *
   *  voices
   * ====================================================================== */

  function pulseWave(duty) {
    if (!ctx || typeof ctx.createPeriodicWave !== 'function') { return null; }
    var key = 'd' + duty;
    if (waveCache[key]) { return waveCache[key]; }
    var n = 32, real, imag, i, w = null;
    try {
      real = new Float32Array(n);
      imag = new Float32Array(n);
      for (i = 1; i < n; i++) {
        /* Fourier series of a rectangular pulse of the given duty cycle */
        imag[i] = (2 / (i * Math.PI)) * Math.sin(i * Math.PI * duty);
      }
      w = ctx.createPeriodicWave(real, imag);
    } catch (e) { w = null; }
    if (w) { waveCache[key] = w; }
    return w;
  }

  /* one shot tone: opts = {t, freq, dur, gain, type|duty, attack, slideTo,
     detune, dest, vibrato} */
  function tone(opts) {
    if (!ctx) { return; }
    var dest = opts.dest || sfxBus;
    if (!dest) { return; }
    var t = num(opts.t, nowT());
    var dur = Math.max(0.02, num(opts.dur, 0.12));
    var freq = Math.max(8, num(opts.freq, 440));
    var osc = node(function () { return ctx.createOscillator(); });
    if (!osc) { return; }
    var w = opts.duty !== undefined ? pulseWave(opts.duty) : null;
    try {
      if (w && osc.setPeriodicWave) { osc.setPeriodicWave(w); }
      else if (opts.type) { osc.type = opts.type; }
      else { osc.type = 'square'; }
    } catch (e) { }
    setAt(osc.frequency, freq, t);
    if (opts.slideTo) { expAt(osc.frequency, opts.slideTo, t + dur); }
    if (opts.detune) { try { osc.detune.value = opts.detune; } catch (e2) { } }

    var g = node(function () { return ctx.createGain(); });
    if (!g) { return; }
    var peak = num(opts.gain, 0.18);
    var atk = num(opts.attack, 0.006);
    setAt(g.gain, 0.0001, t);
    linAt(g.gain, peak, t + atk);
    expAt(g.gain, 0.0001, t + dur);
    connect(osc, g);
    connect(g, dest);
    startAt(osc, t);
    stopAt(osc, t + dur + 0.03);
  }

  function noiseHit(opts) {
    if (!ctx) { return; }
    var dest = opts.dest || sfxBus;
    var buf = noiseBuffer();
    if (!buf || !dest) { return; }
    var t = num(opts.t, nowT());
    var dur = Math.max(0.02, num(opts.dur, 0.1));
    var src = node(function () { return ctx.createBufferSource(); });
    if (!src) { return; }
    try { src.buffer = buf; src.loop = true; } catch (e) { return; }
    var f = node(function () { return ctx.createBiquadFilter(); });
    var g = node(function () { return ctx.createGain(); });
    if (!f || !g) { return; }
    try {
      f.type = opts.filter || 'highpass';
      f.frequency.setValueAtTime(Math.max(20, num(opts.freq, 5000)), t);
      if (f.Q) { f.Q.value = num(opts.q, 1); }
    } catch (e2) { }
    if (opts.sweepTo) { expAt(f.frequency, opts.sweepTo, t + dur); }
    var peak = num(opts.gain, 0.2);
    setAt(g.gain, 0.0001, t);
    linAt(g.gain, peak, t + num(opts.attack, 0.003));
    expAt(g.gain, 0.0001, t + dur);
    connect(src, f); connect(f, g); connect(g, dest);
    startAt(src, t);
    stopAt(src, t + dur + 0.03);
  }

  function noiseBuffer() {
    if (noiseBuf !== null) { return noiseBuf; }
    if (!ctx) { return null; }
    noiseBuf = null;
    try {
      var len = Math.floor(ctx.sampleRate * 1.1);
      var buf = ctx.createBuffer(1, len, ctx.sampleRate);
      var d = buf.getChannelData(0);
      var s = 0x1f2e3d4c;                       /* deterministic white noise */
      for (var i = 0; i < len; i++) {
        s ^= s << 13; s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5; s >>>= 0;
        d[i] = (s / 2147483648) - 1;
      }
      noiseBuf = buf;
    } catch (e) { noiseBuf = null; }
    return noiseBuf;
  }

  /* ---- drums ----------------------------------------------------------- */
  function drum(kind, t, gain, dest) {
    dest = dest || musicBus;
    var g = gain === undefined ? 1 : gain;
    if (kind === 'K') {
      tone({ t: t, freq: 132, slideTo: 42, dur: 0.16, gain: 0.34 * g, type: 'triangle', dest: dest });
      noiseHit({ t: t, dur: 0.03, gain: 0.10 * g, filter: 'lowpass', freq: 900, dest: dest });
    } else if (kind === 'S') {
      noiseHit({ t: t, dur: 0.16, gain: 0.20 * g, filter: 'bandpass', freq: 1900, q: 0.8, dest: dest });
      tone({ t: t, freq: 210, slideTo: 150, dur: 0.09, gain: 0.12 * g, type: 'triangle', dest: dest });
    } else if (kind === 'H') {
      noiseHit({ t: t, dur: 0.035, gain: 0.11 * g, filter: 'highpass', freq: 7200, dest: dest });
    } else if (kind === 'O') {
      noiseHit({ t: t, dur: 0.13, gain: 0.10 * g, filter: 'highpass', freq: 6400, dest: dest });
    } else if (kind === 'C') {
      noiseHit({ t: t, dur: 0.5, gain: 0.16 * g, filter: 'highpass', freq: 4200, sweepTo: 2600, dest: dest });
    }
  }

  /* ====================================================================== *
   *  songs — chords drive the bass/arp, the hooks are written out
   * ====================================================================== */

  var CHORDS = {
    Am: ['A3', 'C4', 'E4'], F: ['F3', 'A3', 'C4'], C: ['C4', 'E4', 'G4'],
    G: ['G3', 'B3', 'D4'], Em: ['E3', 'G3', 'B3'], Dm: ['D3', 'F3', 'A3'],
    E: ['E3', 'G#3', 'B3'], Am7: ['A3', 'C4', 'G4']
  };

  function chord(name) {
    var a = CHORDS[name] || CHORDS.Am;
    return [a[0], a[1], a[2], transpose(a[0], 12), transpose(a[1], 12)];
  }

  /* 16th-note grid, one array of 16 tokens per bar.  '.' = silence. */
  var RACE_LEAD = [
    'A4 . . E5 . . D5 . C5 . . E5 . . . .',
    'A4 . . E5 . . G5 . F5 . . E5 . . . .',
    'F4 . . C5 . . B4 . A4 . . C5 . . . .',
    'G4 . . D5 . . F5 . E5 . . . . . A4 .'
  ];
  var RACE_HARM = [
    '. . E4 . . . E4 . . . E4 . . . E4 .',
    '. . E4 . . . E4 . . . E4 . . . E4 .',
    '. . A3 . . . A3 . . . A3 . . . A3 .',
    '. . B3 . . . B3 . . . B3 . . . B3 .'
  ];
  var RACE_DRUM = 'K.H.S.H.K.HHS.HH';
  var RACE_DRUM_FILL = 'K.H.S.H.K.H.S.HH';

  var TITLE_DRUM = 'K...H...S...H...';
  var RESULT_LEAD = [
    'C5 . . . E5 . . . G5 . . . . . . .',
    'A4 . . . C5 . . . F5 . . . . . . .',
    'B4 . . . D5 . . . G5 . . . . . . .',
    'C5 . . . . . . . . . . . . . . .'
  ];

  var SONGS = {
    title: { bpm: 92, bars: 4, loop: true, prog: ['Am', 'F', 'C', 'G'], kind: 'title' },
    race: { bpm: 152, bars: 4, loop: true, prog: ['Am', 'Am', 'F', 'G'], kind: 'race' },
    result: { bpm: 116, bars: 4, loop: false, prog: ['C', 'F', 'G', 'C'], kind: 'result' }
  };

  /* ---- per-song step renderers (t = absolute AudioContext time) --------- */
  function renderTitle(t, bar, s, ch) {
    var i;
    /* arpeggio on eighths — the moody outrun figure */
    if (s % 2 === 0) {
      var seq = [0, 1, 2, 3, 2, 1, 4, 2];
      var pick = seq[(s / 2) % 8];
      tone({
        t: t, freq: noteFreq(ch[pick]), dur: 0.20, gain: 0.13,
        duty: 0.5, dest: musicBus
      });
      /* echo an octave up, quieter */
      tone({
        t: t + 0.055, freq: noteFreq(ch[pick]) * 2, dur: 0.13, gain: 0.045,
        duty: 0.125, dest: musicBus
      });
    }
    /* pad on the off-beats */
    if (s === 4 || s === 12) {
      for (i = 0; i < 2; i++) {
        tone({
          t: t, freq: noteFreq(ch[1 + i]), dur: 0.72, gain: 0.055,
          duty: 0.125, attack: 0.08, dest: musicBus
        });
      }
    }
    /* triangle bass: root on 1 and 3 */
    if (s === 0 || s === 8) {
      tone({ t: t, freq: noteFreq(ch[0]) / 2, dur: 0.85, gain: 0.26, type: 'triangle', dest: musicBus });
    }
    drum(TITLE_DRUM.charAt(s), t, 0.75);
  }

  function renderRace(t, bar, s, ch) {
    var lead = RACE_LEAD[bar].split(' ')[s];
    var harm = RACE_HARM[bar].split(' ')[s];
    var i;
    /* lead hook, 25% pulse */
    if (lead && lead !== '.') {
      tone({ t: t, freq: noteFreq(lead), dur: 0.16, gain: 0.15, duty: 0.25, dest: musicBus });
    }
    /* off-beat harmony stabs, thin 12.5% pulse */
    if (harm && harm !== '.') {
      tone({ t: t, freq: noteFreq(harm), dur: 0.10, gain: 0.075, duty: 0.125, dest: musicBus });
    }
    /* driving eighth bass: root, root, octave, root */
    if (s % 2 === 0) {
      var fig = [0, 0, 12, 0, 0, 0, 12, 7][(s / 2) % 8];
      tone({
        t: t, freq: noteFreq(ch[0]) / 2 * Math.pow(2, fig / 12),
        dur: 0.14, gain: 0.24, type: 'triangle', dest: musicBus
      });
    }
    /* chord stabs on the "and" of 2 and 4 */
    if (s === 6 || s === 14) {
      for (i = 0; i < 3; i++) {
        tone({ t: t, freq: noteFreq(ch[i]), dur: 0.09, gain: 0.05, duty: 0.125, dest: musicBus });
      }
    }
    drum((bar === 3 ? RACE_DRUM_FILL : RACE_DRUM).charAt(s), t, 0.9);
  }

  function renderResult(t, bar, s, ch) {
    var lead = RESULT_LEAD[bar].split(' ')[s];
    var i;
    if (lead && lead !== '.') {
      tone({ t: t, freq: noteFreq(lead), dur: 0.30, gain: 0.16, duty: 0.5, dest: musicBus });
    }
    if (s === 0) {
      for (i = 0; i < 3; i++) {
        tone({ t: t, freq: noteFreq(ch[i]), dur: 1.5, gain: 0.055, duty: 0.125, attack: 0.05, dest: musicBus });
      }
      tone({ t: t, freq: noteFreq(ch[0]) / 2, dur: 1.5, gain: 0.22, type: 'triangle', dest: musicBus });
    }
    if (s === 0) { drum('K', t, 0.8); }
    if (s === 8) { drum('S', t, 0.7); }
    if (s === 4 || s === 12) { drum('H', t, 0.7); }
    if (bar === 0 && s === 0) { drum('C', t, 0.5); }
    /* final chord rings out */
    if (bar === 3 && s === 0) {
      tone({ t: t + 0.0, freq: noteFreq('C5'), dur: 1.9, gain: 0.13, duty: 0.25, dest: musicBus });
      tone({ t: t + 0.0, freq: noteFreq('E5'), dur: 1.9, gain: 0.10, duty: 0.25, dest: musicBus });
      tone({ t: t + 0.0, freq: noteFreq('G5'), dur: 1.9, gain: 0.09, duty: 0.25, dest: musicBus });
    }
  }

  function stepDur() {
    var bpm = tempoBpm > 0 ? tempoBpm : (song ? song.bpm : 120);
    bpm = clamp(bpm, 40, 300);
    return 60 / bpm / 4;                     /* one sixteenth note */
  }

  /* ====================================================================== *
   *  the scheduler
   * ====================================================================== */

  function pump() {
    if (!ready || !playing || !song || !ctx || muted) { return; }
    try {
      var look = 0.22;
      var now = ctx.currentTime;
      if (nextTime < now) { nextTime = now + 0.03; }   /* resync after a stall */
      var guard = 0;
      while (nextTime < now + look && guard++ < 64) {
        var total = song.bars * 16;
        if (step >= total) {
          if (!song.loop) { playing = false; break; }
          step = 0;
        }
        var bar = Math.floor(step / 16);
        var s = step % 16;
        var ch = chord(song.prog[bar % song.prog.length]);
        if (song.kind === 'race') { renderRace(nextTime, bar, s, ch); }
        else if (song.kind === 'title') { renderTitle(nextTime, bar, s, ch); }
        else { renderResult(nextTime, bar, s, ch); }
        nextTime += stepDur();
        step++;
      }
    } catch (e) { /* never let the sequencer take the frame down */ }
  }

  /* ====================================================================== *
   *  continuous voices
   * ====================================================================== */

  function buildEngine() {
    if (!ctx) { return; }
    engine = {};
    engine.out = node(function () { return ctx.createGain(); });
    engine.gain = node(function () { return ctx.createGain(); });
    engine.filter = node(function () { return ctx.createBiquadFilter(); });
    engine.osc1 = node(function () { return ctx.createOscillator(); });
    engine.osc2 = node(function () { return ctx.createOscillator(); });
    engine.sub = node(function () { return ctx.createOscillator(); });
    engine.lfo = node(function () { return ctx.createOscillator(); });
    engine.lfoGain = node(function () { return ctx.createGain(); });
    engine.noise = node(function () { return ctx.createBufferSource(); });
    engine.noiseFilter = node(function () { return ctx.createBiquadFilter(); });
    engine.noiseGain = node(function () { return ctx.createGain(); });
    if (!engine.out || !engine.gain || !engine.osc1 || !engine.osc2) { engine = null; return; }
    try {
      engine.gain.gain.value = 0.0001;
      engine.filter.type = 'lowpass';
      engine.filter.frequency.value = 420;
      engine.filter.Q.value = 5;
      engine.osc1.type = 'sawtooth';
      engine.osc2.type = 'square';
      engine.sub.type = 'triangle';
      engine.osc1.frequency.value = 34;
      engine.osc2.frequency.value = 34;
      engine.osc2.detune.value = 16;
      engine.sub.frequency.value = 17;
      engine.lfo.type = 'sine';
      engine.lfo.frequency.value = 17;
      engine.lfoGain.gain.value = 0.10;
      engine.noiseFilter.type = 'bandpass';
      engine.noiseFilter.frequency.value = 1100;
      if (engine.noiseFilter.Q) { engine.noiseFilter.Q.value = 0.7; }
      engine.noiseGain.gain.value = 0.0001;
      if (engine.noise) { engine.noise.buffer = noiseBuffer(); engine.noise.loop = true; }
    } catch (e) { }
    connect(engine.osc1, engine.filter);
    connect(engine.osc2, engine.filter);
    connect(engine.sub, engine.filter);
    connect(engine.filter, engine.gain);
    connect(engine.gain, engine.out);
    connect(engine.out, engBus);
    connect(engine.lfo, engine.lfoGain);
    connect(engine.lfoGain, engine.gain.gain);
    if (engine.noise && engine.noiseFilter && engine.noiseGain) {
      connect(engine.noise, engine.noiseFilter);
      connect(engine.noiseFilter, engine.noiseGain);
      connect(engine.noiseGain, engine.out);
      startAt(engine.noise, 0);
    }
    startAt(engine.osc1, 0);
    startAt(engine.osc2, 0);
    startAt(engine.sub, 0);
    startAt(engine.lfo, 0);
  }

  function buildSkid() {
    if (!ctx) { return; }
    skid = {};
    skid.src = node(function () { return ctx.createBufferSource(); });
    skid.filter = node(function () { return ctx.createBiquadFilter(); });
    skid.hp = node(function () { return ctx.createBiquadFilter(); });
    skid.gain = node(function () { return ctx.createGain(); });
    skid.lfo = node(function () { return ctx.createOscillator(); });
    skid.lfoGain = node(function () { return ctx.createGain(); });
    if (!skid.src || !skid.filter || !skid.gain) { skid = null; return; }
    try {
      skid.src.buffer = noiseBuffer();
      skid.src.loop = true;
      skid.filter.type = 'bandpass';
      skid.filter.frequency.value = 2400;
      if (skid.filter.Q) { skid.filter.Q.value = 3.2; }
      skid.hp.type = 'highpass';
      skid.hp.frequency.value = 900;
      skid.gain.gain.value = 0.0001;
      skid.lfo.type = 'sine';
      skid.lfo.frequency.value = 7.5;
      skid.lfoGain.gain.value = 0.012;
    } catch (e) { }
    connect(skid.src, skid.filter);
    connect(skid.filter, skid.hp);
    connect(skid.hp, skid.gain);
    connect(skid.gain, sfxBus);
    connect(skid.lfo, skid.lfoGain);
    connect(skid.lfoGain, skid.gain.gain);
    startAt(skid.src, 0);
    startAt(skid.lfo, 0);
  }

  function buildGraph() {
    master = node(function () { return ctx.createGain(); });
    musicBus = node(function () { return ctx.createGain(); });
    sfxBus = node(function () { return ctx.createGain(); });
    engBus = node(function () { return ctx.createGain(); });
    if (!master || !musicBus || !sfxBus || !engBus) { return false; }
    try {
      master.gain.value = muted ? 0.0001 : MASTER_GAIN;
      musicBus.gain.value = MUSIC_GAIN;
      sfxBus.gain.value = SFX_GAIN;
      engBus.gain.value = ENGINE_GAIN;
    } catch (e) { }
    connect(musicBus, master);
    connect(sfxBus, master);
    connect(engBus, master);
    connect(master, ctx.destination);
    buildEngine();
    buildSkid();
    return true;
  }

  function resumeCtx() {
    if (!ctx) { return; }
    try {
      if (ctx.state === 'suspended' && ctx.resume) {
        var p = ctx.resume();
        if (p && p.then) { p.then(function () { }, function () { }); }
      }
    } catch (e) { }
  }

  /* ====================================================================== *
   *  public API
   * ====================================================================== */

  function done() {
    var p = null;
    try {
      if (typeof Promise !== 'undefined') { p = Promise.resolve(ready); }
    } catch (e) { p = null; }
    return p;
  }

  function init() {
    try {
      if (!ctx) {
        var AC = null;
        try { if (typeof AudioContext !== 'undefined' && AudioContext) { AC = AudioContext; } } catch (e1) { }
        if (!AC) { try { if (typeof webkitAudioContext !== 'undefined' && webkitAudioContext) { AC = webkitAudioContext; } } catch (e2) { } }
        if (!AC) {
          try {
            if (typeof window !== 'undefined' && window) {
              AC = window.AudioContext || window.webkitAudioContext || null;
            }
          } catch (e3) { }
        }
        if (!AC) { ready = false; return done(); }
        ctx = new AC();
        if (!buildGraph()) { ctx = null; ready = false; return done(); }
      }
      ready = true;
      resumeCtx();
      if (!timer && typeof setInterval === 'function') {
        try {
          timer = setInterval(function () { pump(); }, 55);
        } catch (e4) { timer = null; }
      }
      if (pendingTrack) { playMusic(pendingTrack); }
    } catch (e) {
      ctx = null; ready = false;
    }
    return done();
  }

  function unlock() {
    try {
      if (!ctx) { init(); }
      resumeCtx();
      if (ready && pendingTrack) { playMusic(pendingTrack); }
      pump();
    } catch (e) { }
  }

  function playMusic(trackId) {
    try {
      if (!trackId) { stopMusic(); return; }
      pendingTrack = trackId;
      if (!ready || !ctx || !SONGS[trackId]) { return; }
      if (songId === trackId && playing) { return; }
      playing = false;
      song = null; songId = ''; step = 0;
      /* clear anything already queued on the music bus */
      cancel(musicBus && musicBus.gain);
      setAt(musicBus.gain, 0.0001, nowT());
      song = SONGS[trackId];
      songId = trackId;
      step = 0;
      nextTime = nowT() + 0.08;
      playing = true;
      linAt(musicBus.gain, MUSIC_GAIN, nowT() + 0.10);
      pump();
    } catch (e) { }
  }

  function stopMusic() {
    try {
      pendingTrack = null;
      playing = false;
      song = null;
      songId = '';
      if (!ready || !musicBus) { return; }
      cancel(musicBus.gain);
      setAt(musicBus.gain, Math.max(0.0001, musicBus.gain.value), nowT());
      linAt(musicBus.gain, 0.0001, nowT() + 0.09);
    } catch (e) { }
  }

  function setMusicTempo(bpm) {
    try {
      var v = num(bpm, 0);
      tempoBpm = v > 0 ? clamp(v, 40, 300) : 0;
      /* keep the lookahead short so a tempo jump is heard promptly */
      if (ready && playing && ctx && nextTime > ctx.currentTime + 0.25) {
        nextTime = ctx.currentTime + 0.12;
      }
    } catch (e) { }
  }

  /* ---- one-shot effects ------------------------------------------------ */
  function sfx(name) {
    if (!ready || !ctx) { return; }
    try {
      var t = nowT() + 0.005;
      if (name === 'beep') {
        tone({ t: t, freq: 880, dur: 0.07, gain: 0.20, duty: 0.25 });
      } else if (name === 'go') {
        tone({ t: t, freq: 523, dur: 0.11, gain: 0.20, duty: 0.5 });
        tone({ t: t + 0.12, freq: 1046, dur: 0.42, gain: 0.22, duty: 0.25 });
        tone({ t: t + 0.02, freq: 261, dur: 0.5, gain: 0.14, type: 'triangle' });
      } else if (name === 'checkpoint') {
        var arp = [784, 988, 1319, 1568], i;
        for (i = 0; i < arp.length; i++) {
          tone({ t: t + i * 0.055, freq: arp[i], dur: 0.13, gain: 0.17, duty: 0.25 });
        }
      } else if (name === 'crash') {
        noiseHit({ t: t, dur: 0.42, gain: 0.30, filter: 'lowpass', freq: 3200, sweepTo: 380 });
        noiseHit({ t: t, dur: 0.22, gain: 0.16, filter: 'bandpass', freq: 1700, q: 0.9 });
        tone({ t: t, freq: 190, slideTo: 48, dur: 0.34, gain: 0.22, type: 'triangle' });
      } else if (name === 'select') {
        tone({ t: t, freq: 1320, slideTo: 1760, dur: 0.05, gain: 0.16, duty: 0.125 });
      } else if (name === 'shift') {
        noiseHit({ t: t, dur: 0.05, gain: 0.13, filter: 'bandpass', freq: 2600, q: 2 });
        tone({ t: t, freq: 260, slideTo: 180, dur: 0.06, gain: 0.10, type: 'triangle' });
      } else if (name === 'engine_start') {
        /* starter motor: a low buzzy crank, then it catches and revs */
        var k;
        for (k = 0; k < 7; k++) {
          tone({
            t: t + k * 0.085, freq: 62 + (k % 2) * 9, dur: 0.08,
            gain: 0.14, type: 'sawtooth'
          });
        }
        noiseHit({ t: t, dur: 0.62, gain: 0.08, filter: 'bandpass', freq: 900, q: 0.6 });
        tone({ t: t + 0.62, freq: 55, slideTo: 150, dur: 0.75, gain: 0.20, type: 'sawtooth' });
        tone({ t: t + 0.62, freq: 27, slideTo: 74, dur: 0.8, gain: 0.16, type: 'triangle' });
      } else if (name === 'timeup') {
        var warn = [988, 880, 740, 587], j;
        for (j = 0; j < warn.length; j++) {
          tone({ t: t + j * 0.20, freq: warn[j], dur: 0.19, gain: 0.20, duty: 0.5 });
          tone({ t: t + j * 0.20, freq: warn[j] / 2, dur: 0.19, gain: 0.12, type: 'triangle' });
        }
        tone({ t: t + 0.8, freq: 147, dur: 0.9, gain: 0.18, type: 'sawtooth' });
      }
    } catch (e) { }
  }

  /* ---- continuous engine ---------------------------------------------- */
  function setEngine(rpm01, on) {
    try {
      var rpm = clamp(num(rpm01, 0), 0, 1);
      var want = !!on;
      if (engineRpm === rpm && engineOn === want) { return; }
      engineRpm = rpm;
      engineOn = want;
      if (!ready || !engine || !ctx) { return; }
      var t = nowT();
      var f = 26 + rpm * 78;                    /* firing frequency, Hz */
      var target = want ? (0.16 + rpm * 0.20) : 0.0001;
      if (engine.osc1) { expAt(engine.osc1.frequency, f, t + 0.08); }
      if (engine.osc2) { expAt(engine.osc2.frequency, f * 1.005, t + 0.08); }
      if (engine.sub) { expAt(engine.sub.frequency, f * 0.5, t + 0.08); }
      if (engine.lfo) { expAt(engine.lfo.frequency, f * 0.5, t + 0.08); }
      if (engine.filter) { expAt(engine.filter.frequency, 340 + rpm * 2400, t + 0.10); }
      if (engine.noiseFilter) { expAt(engine.noiseFilter.frequency, 700 + rpm * 2100, t + 0.10); }
      if (engine.gain) {
        cancel(engine.gain.gain);
        setAt(engine.gain.gain, Math.max(0.0001, engine.gain.gain.value), t);
        linAt(engine.gain.gain, target, t + (want ? 0.10 : 0.18));
      }
      if (engine.noiseGain) {
        cancel(engine.noiseGain.gain);
        setAt(engine.noiseGain.gain, Math.max(0.0001, engine.noiseGain.gain.value), t);
        linAt(engine.noiseGain.gain, want ? (0.03 + rpm * 0.09) : 0.0001, t + 0.12);
      }
    } catch (e) { }
  }

  function setSkid(on) {
    try {
      var want = !!on;
      if (!ready || !skid || !ctx) { return; }
      var t = nowT();
      var g = want ? 0.06 : 0.0001;
      cancel(skid.gain.gain);
      setAt(skid.gain.gain, Math.max(0.0001, skid.gain.gain.value), t);
      linAt(skid.gain.gain, g, t + (want ? 0.05 : 0.12));
    } catch (e) { }
  }

  function setMuted(m) {
    try {
      muted = !!m;
      if (master && ctx) {
        var t = nowT();
        cancel(master.gain);
        setAt(master.gain, Math.max(0.0001, master.gain.value), t);
        linAt(master.gain, muted ? 0.0001 : MASTER_GAIN, t + 0.06);
      }
      if (!muted) { pump(); }
    } catch (e) { }
  }

  function isMuted() { return muted; }

  /* Per-frame housekeeping: keeps the sequencer fed even when the browser
     throttles timers (the game loop calls this 60 times a second).  The audio
     graph smooths its own ramps, so dt is only used as a liveness hint. */
  function update(dt) {
    try {
      pump();
      if (typeof dt === 'number' && dt > 0.5) { resumeCtx(); }
    } catch (e) { }
  }

  var API = {
    init: init,
    unlock: unlock,
    playMusic: playMusic,
    stopMusic: stopMusic,
    setMusicTempo: setMusicTempo,
    sfx: sfx,
    setEngine: setEngine,
    setSkid: setSkid,
    setMuted: setMuted,
    isMuted: isMuted,
    update: update,
    ready: false
  };

  /* expose ready as a live boolean without ever throwing on an engine that
     cannot redefine properties */
  try {
    Object.defineProperty(API, 'ready', {
      get: function () { return ready; },
      enumerable: true,
      configurable: true
    });
  } catch (e) { API.ready = false; }

  return API;
})();
