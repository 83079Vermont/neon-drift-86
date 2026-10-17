/* ==========================================================================
 * NEON DRIFT '86 — tools/run-all.mjs
 *
 * One command that runs the whole verification stack and prints a verdict:
 *   1. tools/contract-test.mjs   — CONTRACT.md assertions + soak + determinism
 *   2. tools/render-frames.mjs   — scripted playthrough, PNG per key beat
 *
 * Usage (Node 24 is not on PATH in this session):
 *   & "C:\Users\wanji\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" tools\run-all.mjs
 *
 * Flags:
 *   --allow-missing      missing src modules => INCOMPLETE (exit 3) instead of FAIL
 *   --full-soak          10800 rendered frames (≈3 min of play, ~5 min wall clock)
 *   --soak-frames=N      override the update-only soak length (default 10800)
 *   --skip-frames        contract tests only
 *   --skip-tests         frame export only
 *
 * Exit codes: 0 = PASS / PASS WITH ISSUES, 1 = FAIL, 3 = INCOMPLETE
 *
 * Owner: verifier.
 * ========================================================================== */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { out, wallNow } from './canvas-shim.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const NODE = process.execPath;

function parseArgs(argv) {
  const a = {};
  for (const s of argv) {
    if (s.startsWith('--')) { const [k, v] = s.slice(2).split('='); a[k] = v === undefined ? true : v; }
  }
  return a;
}

function runStep(title, script, args) {
  out('');
  out('##################################################################');
  out('# ' + title);
  out('##################################################################');
  const t0 = wallNow();
  const res = spawnSync(NODE, [path.join(HERE, script), ...args], {
    cwd: ROOT, stdio: 'inherit', env: process.env
  });
  const ms = wallNow() - t0;
  const code = res.status === null ? 1 : res.status;
  out('');
  out('>>> ' + script + ' finished with exit code ' + code + ' in ' + (ms / 1000).toFixed(1) + ' s');
  return { code, ms, signal: res.signal, error: res.error ? String(res.error.message) : null };
}

export function main(argv) {
  const args = parseArgs(argv || []);
  const started = wallNow();
  out('');
  out('==============================================================');
  out('  NEON DRIFT \'86  —  FULL VERIFICATION RUN');
  out('  node ' + process.version + '   ' + new Date().toISOString());
  out('==============================================================');

  const testArgs = [];
  if (args['allow-missing']) testArgs.push('--allow-missing');
  if (args['soak-frames']) testArgs.push('--soak-frames=' + args['soak-frames']);
  if (args['full-soak']) testArgs.push('--soak-frames=10800', '--render-soak=360');
  const frameArgs = [];
  if (args['real-race']) frameArgs.push('--real-race');

  const steps = [];
  if (!args['skip-tests']) steps.push(['1/2  contract tests (assertions, soak, determinism)', 'contract-test.mjs', testArgs]);
  if (!args['skip-frames']) steps.push(['2/2  frame export (scripted playthrough -> PNG)', 'render-frames.mjs', frameArgs]);

  const results = [];
  for (const [title, script, extra] of steps) {
    results.push({ title, script, ...runStep(title, script, extra) });
  }

  /* ------------------------------------------------------------ summary */
  const manifestPath = path.join(ROOT, '.verify', 'frames', 'manifest.json');
  const testPath = path.join(ROOT, '.verify', 'contract-test.json');
  let manifest = null, tests = null;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (e) { }
  try { tests = JSON.parse(fs.readFileSync(testPath, 'utf8')); } catch (e) { }

  out('');
  out('==============================================================');
  out('  VERDICT');
  out('==============================================================');
  for (const r of results) out('  ' + r.script.padEnd(22) + ' exit ' + r.code + '   ' + (r.ms / 1000).toFixed(1) + ' s');
  if (tests) {
    out('  contract tests        ' + tests.counts.PASS + ' pass / ' + tests.counts.FAIL + ' fail / ' +
      tests.counts.WARN + ' warn / ' + tests.counts.SKIP + ' skip');
    for (const r of tests.results.filter(x => x.status === 'FAIL').slice(0, 12)) {
      out('    FAIL ' + r.group + '.' + r.name + ' — ' + r.detail.slice(0, 160));
    }
    for (const r of tests.results.filter(x => x.status === 'WARN').slice(0, 8)) {
      out('    WARN ' + r.group + '.' + r.name + ' — ' + r.detail.slice(0, 160));
    }
    for (const r of tests.results.filter(x => x.status === 'SKIP').slice(0, 8)) {
      out('    SKIP ' + r.group + '.' + r.name + ' — ' + r.detail.slice(0, 120));
    }
  } else out('  contract tests        (no .verify/contract-test.json)');
  if (manifest) {
    const real = manifest.frames.filter(f => f.kind !== 'diagnostic');
    const blank = manifest.frames.filter(f => f.blank);
    out('  frames                ' + real.length + ' gameplay / ' +
      (manifest.frames.length - real.length) + ' diagnostic, ' + blank.length + ' blank');
    if (manifest.stale) out('    ** frames are STALE: ' + manifest.staleReason);
    if (manifest.srcHashes) out('  src revision          ' + (manifest.srcHashes.__combined || '?'));
    if (manifest.missingFrames && manifest.missingFrames.length) {
      out('    missing frames: ' + [...new Set(manifest.missingFrames)].join(', '));
    }
    for (const f of manifest.frames.filter(x => x.note && /UNVERIFIED|FAILED|NOT REACHED|no collision|NO collision/i.test(x.note))) {
      out('    note ' + f.name + ': ' + f.note.slice(0, 170));
    }
  } else out('  frames                (no .verify/frames/manifest.json)');

  const codes = results.map(r => r.code);
  let verdict, code;
  if (codes.includes(1)) { verdict = 'FAIL'; code = 1; }
  else if (codes.includes(3)) { verdict = 'INCOMPLETE'; code = 3; }
  else if (tests && tests.counts.WARN > 0) { verdict = 'PASS WITH ISSUES'; code = 0; }
  else if (manifest && manifest.violations && manifest.violations.length) { verdict = 'PASS WITH ISSUES'; code = 0; }
  else { verdict = 'PASS'; code = 0; }

  /* a stale frame set is never a PASS */
  if (manifest && manifest.stale && verdict === 'PASS') { verdict = 'INCOMPLETE'; code = 3; }

  out('');
  out('  artefacts: .verify/frames/*.png  .verify/frames/manifest.json  .verify/contract-test.json');
  out('  total wall clock: ' + ((wallNow() - started) / 1000).toFixed(1) + ' s');
  out('');
  out('  RESULT: ' + verdict + '   (exit ' + code + ')');
  out('==============================================================');
  return code;
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/run-all.mjs');
if (isMain) {
  process.exit(main(process.argv.slice(2)));
}
