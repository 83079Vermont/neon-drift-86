/* Performance evidence for .verify/REPORT.md §5
 * Counts Canvas2D calls per frame and measures ms/frame at both qualities.
 * Usage: node .verify/perf-probe.mjs
 */
import { createShim, wallNow, out } from '../tools/canvas-shim.mjs';
import { loadSrc, bootGame, Driver } from '../tools/loader.mjs';

const shim = createShim();
const origCreate = shim.document.createElement.bind(shim.document);
shim.document.createElement = function (t) {
  const el = origCreate(t);
  if (String(t).toLowerCase() === 'canvas') instrument(el);
  return el;
};
const counts = {}, timers = {};
function instrument(cv) {
  if (cv._instrumented) return;
  cv._instrumented = true;
  const ctx = cv.getContext('2d');
  for (const name of ['fillRect', 'clearRect', 'drawImage', 'getImageData', 'putImageData', 'fill', 'stroke',
    'createLinearGradient', 'createRadialGradient', 'beginPath', 'moveTo', 'lineTo', 'clip', 'save', 'restore']) {
    const orig = ctx[name];
    if (typeof orig !== 'function') continue;
    ctx[name] = function (...a) {
      counts[name] = (counts[name] || 0) + 1;
      const t0 = wallNow();
      const r = orig.apply(this, a);
      timers[name] = (timers[name] || 0) + (wallNow() - t0);
      return r;
    };
  }
}

loadSrc();
/* GAME sizes its visible canvas from the viewport; pin it to 1x so the numbers
   describe the 384x216 render cost, not the integer-upscale blit. */
shim.setViewport(384, 216);
const boot = bootGame(shim, { cssW: 384, cssH: 216 });
const d = new Driver(shim, boot, {});
d.detect();
d.until((s) => s && s.mode === 'title', 300);
d.key('ArrowDown');
d.until((s) => s && s.mode === 'select', 200);
d.key('Enter');
d.until((s) => s && s.mode === 'race', 500, () => d.hold('ArrowUp'));
d.step(120);

function bench(label, quality, N) {
  if (quality) { RENDER.setQuality(quality); shim.tick(1000 / 60); }
  for (const k of Object.keys(counts)) { counts[k] = 0; timers[k] = 0; }
  shim.tick(1000 / 60);
  const t0 = wallNow();
  for (let i = 0; i < N; i++) shim.tick(1000 / 60);
  const ms = (wallNow() - t0) / N;
  const totalCalls = Object.values(counts).reduce((a, b) => a + b, 0) / N;
  out('');
  out(`=== ${label} : ${ms.toFixed(2)} ms/frame, ${Math.round(totalCalls)} canvas calls/frame ===`);
  const rows = Object.entries(timers).map(([k, v]) => [k, v / N, counts[k] / N]).sort((a, b) => b[1] - a[1]);
  for (const [k, m, n] of rows.slice(0, 8)) out('   ' + k.padEnd(22) + m.toFixed(2) + ' ms   ' + Math.round(n) + ' calls');
  const ctxTotal = Object.values(timers).reduce((a, b) => a + b, 0) / N;
  out('   ctx total ' + ctxTotal.toFixed(2) + ' ms | JS logic ' + (ms - ctxTotal).toFixed(2) + ' ms');
  return ms;
}

const hi = bench('quality high (CRT on)', 'high', 120);
const lo = bench('quality low  (CRT off)', 'low', 120);
out('');
out(`CRT pass cost: ${(hi - lo).toFixed(2)} ms/frame (${(((hi - lo) / hi) * 100).toFixed(0)}% of the high-quality frame)`);
out(`game canvas: ${shim.gameCanvas.width}x${shim.gameCanvas.height}`);
out(`10800 frames at high quality = ${(hi * 10800 / 60000).toFixed(1)} min in Node CPU rasterisation (NOT a browser frame rate)`);
