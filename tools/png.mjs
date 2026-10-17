/* ==========================================================================
 * NEON DRIFT '86 — tools/png.mjs
 * Zero-dependency PNG writer (node:zlib only) + image statistics helpers.
 *
 * The verification harness renders the real game into an RGBA buffer and must
 * hand a human a file they can actually open, so this module is deliberately
 * boring: 8-bit RGBA, non-interlaced, adaptive per-row filtering.
 *
 * Owner: verifier.  Nobody else edits this file.
 * ========================================================================== */
import zlib from 'node:zlib';

/* ------------------------------------------------------------------ crc32 */
var CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  var t = new Int32Array(256), n, k, c;
  for (n = 0; n < 256; n++) {
    c = n;
    for (k = 0; k < 8; k++) { c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); }
    t[n] = c;
  }
  CRC_TABLE = t;
  return t;
}

export function crc32(buf) {
  var t = crcTable(), c = 0xFFFFFFFF, i;
  for (i = 0; i < buf.length; i++) { c = t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* ----------------------------------------------------------------- chunks */
function chunk(type, data) {
  var out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, 'ascii');
  data.copy(out, 8);
  var crcInput = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  out.writeUInt32BE(crc32(crcInput), data.length + 8);
  return out;
}

function paeth(a, b, c) {
  var p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Encode an RGBA pixel buffer as a PNG.
 * @param {number} width
 * @param {number} height
 * @param {Uint8ClampedArray|Uint8Array|Buffer} rgba  width*height*4 bytes
 * @param {{level?:number, filter?:'adaptive'|'none'}} [opts]
 * @returns {Buffer}
 */
export function encodePNG(width, height, rgba, opts) {
  opts = opts || {};
  var level = opts.level === undefined ? 9 : opts.level;
  var mode = opts.filter || 'adaptive';
  var w = width | 0, h = height | 0;
  if (w <= 0 || h <= 0) throw new Error('encodePNG: bad size ' + width + 'x' + height);
  var need = w * h * 4;
  if (rgba.length < need) {
    throw new Error('encodePNG: buffer too small (' + rgba.length + ' < ' + need + ')');
  }

  var stride = w * 4;
  var raw = Buffer.alloc((stride + 1) * h);
  var prev = Buffer.alloc(stride);
  var sub = Buffer.alloc(stride);
  var up = Buffer.alloc(stride);
  var avg = Buffer.alloc(stride);
  var pae = Buffer.alloc(stride);
  var y, i, x, sum, best, bestSum, filt;

  for (y = 0; y < h; y++) {
    var rowOff = y * stride;
    sum = 0;
    for (i = 0; i < stride; i++) {
      var cur = rgba[rowOff + i];
      var left = i >= 4 ? rgba[rowOff + i - 4] : 0;
      var upv = prev[i];
      var ul = i >= 4 ? prev[i - 4] : 0;
      sub[i] = (cur - left) & 0xFF;
      up[i] = (cur - upv) & 0xFF;
      avg[i] = (cur - ((left + upv) >> 1)) & 0xFF;
      pae[i] = (cur - paeth(left, upv, ul)) & 0xFF;
      sum += Math.abs((cur << 24) >> 24);      /* signed magnitude of raw byte */
    }

    if (mode === 'none') {
      filt = 0; best = null;
    } else {
      /* adaptive: try all five filters, keep the one with the smallest
         sum of |signed byte| (the classic minimum-sum-of-absolute-
         differences heuristic). */
      best = 0; bestSum = sum; filt = 0;
      var cands = [sub, up, avg, pae];
      for (var ci = 0; ci < 4; ci++) {
        var s = 0, arr = cands[ci];
        for (i = 0; i < stride; i++) { s += Math.abs((arr[i] << 24) >> 24); }
        if (s < bestSum) { bestSum = s; best = arr; filt = ci + 1; }
      }
    }

    raw[y * (stride + 1)] = filt;
    if (filt === 0) {
      for (i = 0; i < stride; i++) { raw[y * (stride + 1) + 1 + i] = rgba[rowOff + i]; }
    } else {
      best.copy(raw, y * (stride + 1) + 1);
    }
    for (i = 0; i < stride; i++) { prev[i] = rgba[rowOff + i]; }
  }

  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;      /* bit depth       */
  ihdr[9] = 6;      /* colour type RGBA */
  ihdr[10] = 0;     /* compression      */
  ihdr[11] = 0;     /* filter           */
  ihdr[12] = 0;     /* interlace        */

  var idat = zlib.deflateSync(raw, { level: level });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* --------------------------------------------------------- image analysis */
function packRGBA(r, g, b, a) {
  return ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
}

/**
 * Cheap, deterministic description of a frame. Used to prove a PNG is not a
 * flat fill and that different stages really do look different.
 */
export function imageStats(rgba, w, h, opts) {
  opts = opts || {};
  var cap = opts.distinctCap || 4096;
  var counts = new Map();
  var capped = false;
  var sr = 0, sg = 0, sb = 0, sa = 0, n = w * h, i;
  var transparent = 0;
  var minL = 255, maxL = 0;

  for (i = 0; i < n; i++) {
    var o = i * 4;
    var r = rgba[o], g = rgba[o + 1], b = rgba[o + 2], a = rgba[o + 3];
    sr += r; sg += g; sb += b; sa += a;
    if (a < 8) transparent++;
    var key = packRGBA(r, g, b, a);
    var c = counts.get(key);
    if (c === undefined) {
      if (counts.size < cap) { counts.set(key, 1); }
      else { capped = true; }
    } else {
      counts.set(key, c + 1);
    }
    var lum = (r * 299 + g * 587 + b * 114) / 1000;
    if (lum < minL) minL = lum;
    if (lum > maxL) maxL = lum;
  }

  var domKey = 0, domCount = 0;
  counts.forEach(function (v, k) { if (v > domCount) { domCount = v; domKey = k; } });
  var dom = [(domKey >>> 24) & 255, (domKey >>> 16) & 255, (domKey >>> 8) & 255, domKey & 255];

  /* horizontal detail: how many neighbouring pixels differ (proves texture) */
  var edges = 0;
  for (var y = 0; y < h; y++) {
    var ro = y * w * 4;
    for (var x = 1; x < w; x++) {
      var p = ro + x * 4, q = p - 4;
      if (rgba[p] !== rgba[q] || rgba[p + 1] !== rgba[q + 1] || rgba[p + 2] !== rgba[q + 2]) edges++;
    }
  }

  var mean = [sr / n, sg / n, sb / n, sa / n];
  return {
    w: w, h: h,
    distinct: counts.size,
    distinctCapped: capped,
    dominant: dom,
    dominantFrac: domCount / n,
    mean: mean,
    transparentFrac: transparent / n,
    edgeFrac: edges / (n - h),
    lumaMin: minL, lumaMax: maxL,
    lumaRange: maxL - minL
  };
}

/** A frame counts as "really drawn" when it has texture and is not a flat fill. */
export function isBlank(stats) {
  return stats.distinct <= 2 || stats.dominantFrac > 0.995 || stats.edgeFrac < 0.0005;
}

/** Fraction of pixels that differ between two same-size RGBA buffers. */
export function diffStats(a, b, w, h) {
  var n = w * h, diff = 0, sum = 0, i;
  for (i = 0; i < n; i++) {
    var o = i * 4;
    var d = Math.abs(a[o] - b[o]) + Math.abs(a[o + 1] - b[o + 1]) + Math.abs(a[o + 2] - b[o + 2]);
    if (d > 0) { diff++; sum += d; }
  }
  return { changedFrac: diff / n, meanDelta: sum / n };
}

/** Mean RGB distance between two frames (theme separation check). */
export function meanColorDistance(s1, s2) {
  var a = s1.mean, b = s2.mean, d = 0, i;
  for (i = 0; i < 3; i++) { d += (a[i] - b[i]) * (a[i] - b[i]); }
  return Math.sqrt(d);
}

export function parsePNG(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504E47) throw new Error('not a PNG');
  var pos = 8, out = { width: 0, height: 0, chunks: [] };
  while (pos + 8 <= buf.length) {
    var len = buf.readUInt32BE(pos);
    var type = buf.toString('ascii', pos + 4, pos + 8);
    out.chunks.push(type);
    if (type === 'IHDR') {
      out.width = buf.readUInt32BE(pos + 8);
      out.height = buf.readUInt32BE(pos + 12);
      out.bitDepth = buf[pos + 16];
      out.colorType = buf[pos + 17];
    }
    pos += 12 + len;
  }
  return out;
}
