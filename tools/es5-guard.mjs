#!/usr/bin/env node
/* ==========================================================================
 * NEON DRIFT '86 — tools/es5-guard.mjs
 *
 * CONTRACT.md §0 constrains the shipped sources to classic ES5 scripts under
 * <script src> (so the game also runs from file://), with no network access.
 *
 * A naive grep cannot check that: comments legitimately contain backticks
 * (`CORE`), sprite pixel-maps legitimately contain runs of "..." as
 * transparent pixels, and prose legitimately contains words like "class" and
 * "let".  So this guard removes comments and string literals first and only
 * then inspects what is actually executed.
 *
 *   node tools/es5-guard.mjs            # checks src/*.js and the bundle
 *   node tools/es5-guard.mjs --verbose
 *
 * Exit code 0 = clean, 1 = a violation was found.
 * ========================================================================== */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const VERBOSE = process.argv.includes('--verbose');

/* --------------------------------------------------------------------------
 * Replace every comment and string literal with spaces, preserving length and
 * newlines so reported line numbers still line up.  A backtick is *kept*: it
 * is itself a violation, so it must survive into the scanned text.
 * ------------------------------------------------------------------------ */
function blankOutLiterals(src) {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  let mode = 'code';
  let quote = '';

  const blank = (k) => {
    if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];

    if (mode === 'code') {
      if (c === '/' && d === '/') { mode = 'line'; blank(i); blank(i + 1); i += 2; continue; }
      if (c === '/' && d === '*') { mode = 'block'; blank(i); blank(i + 1); i += 2; continue; }
      if (c === "'" || c === '"') { mode = 'str'; quote = c; blank(i); i++; continue; }
      if (c === '`') { mode = 'str'; quote = '`'; i++; continue; }  // kept on purpose
      i++;
      continue;
    }

    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; i++; continue; }
      blank(i); i++; continue;
    }

    if (mode === 'block') {
      if (c === '*' && d === '/') { blank(i); blank(i + 1); mode = 'code'; i += 2; continue; }
      blank(i); i++; continue;
    }

    /* mode === 'str' */
    if (c === '\\') { blank(i); blank(i + 1); i += 2; continue; }
    if (c === quote) {
      if (quote !== '`') blank(i);      // keep the closing backtick visible
      mode = 'code'; i++; continue;
    }
    if (c === '\n' && quote !== '`') { mode = 'code'; i++; continue; }  // unterminated
    blank(i); i++;
  }

  return out.join('');
}

/* --------------------------------------------------------------------------
 * Rules.  Each runs against the literal-free text.
 * ------------------------------------------------------------------------ */
const RULES = [
  { id: 'arrow-function',  re: /=>/g,                          msg: 'arrow function' },
  { id: 'template-string', re: /`/g,                           msg: 'template literal' },
  { id: 'let',             re: /\blet\s+[A-Za-z_$]/g,          msg: 'let declaration' },
  { id: 'const',           re: /\bconst\s+[A-Za-z_$]/g,        msg: 'const declaration' },
  { id: 'class',           re: /\bclass\s+[A-Za-z_$]/g,        msg: 'class declaration' },
  { id: 'spread-rest',     re: /\.\.\./g,                      msg: 'spread / rest operator' },
  { id: 'es-module',       re: /\b(import|export)\s*[{(*A-Za-z_$]/g, msg: 'ES module syntax' },
  { id: 'for-of',          re: /\bfor\s*\(\s*(var|let|const)?\s*[A-Za-z_$][\w$]*\s+of\s/g, msg: 'for...of' },
  { id: 'default-param',   re: /function\s*[\w$]*\s*\([^)]*=[^)]*\)/g, msg: 'default parameter' },
  { id: 'fetch',           re: /\bfetch\s*\(/g,                msg: 'network: fetch()' },
  { id: 'xhr',             re: /\bXMLHttpRequest\b/g,          msg: 'network: XMLHttpRequest' },
  { id: 'importScripts',   re: /\bimportScripts\s*\(/g,       msg: 'network: importScripts()' },
  { id: 'eval',            re: /\beval\s*\(/g,                 msg: 'eval()' },
  { id: 'new-function',    re: /\bnew\s+Function\s*\(/g,       msg: 'new Function()' },
  { id: 'document-write',  re: /\bdocument\.write\s*\(/g,      msg: 'document.write()' }
];

function scan(label, text) {
  const clean = blankOutLiterals(text);
  const hits = [];

  if (/\/\/#\s*sourceMappingURL/.test(text)) {
    hits.push({ rule: 'source-map', line: 1, msg: 'sourceMappingURL comment' });
  }

  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(clean)) !== null) {
      const line = clean.slice(0, m.index).split('\n').length;
      hits.push({ rule: rule.id, line, msg: rule.msg });
      if (m.index === rule.re.lastIndex) rule.re.lastIndex++;   // zero-width safety
    }
  }
  return hits.map((h) => ({ ...h, file: label }));
}

/* ------------------------------------------------------------------------ */

const failures = [];
const checked = [];

const srcDir = join(ROOT, 'src');
for (const name of readdirSync(srcDir).filter((f) => f.endsWith('.js')).sort()) {
  const rel = `src/${name}`;
  const text = readFileSync(join(srcDir, name), 'utf8');
  checked.push(rel);
  const hits = scan(rel, text);
  if (hits.length) failures.push(...hits);
  else if (VERBOSE) console.log(`  ok   ${rel}  (${text.split('\n').length} lines)`);
}

/* The bundle must not reintroduce an external reference. */
const bundlePath = join(ROOT, 'neon-drift-86.html');
const bundle = readFileSync(bundlePath, 'utf8');
checked.push('neon-drift-86.html');

const externals = [
  ...bundle.matchAll(/<script\b[^>]*\bsrc=/gi),
  ...bundle.matchAll(/<link\b[^>]*\brel=["']?stylesheet/gi)
].length;
if (externals) {
  failures.push({ file: 'neon-drift-86.html', line: 1, rule: 'external-ref',
                  msg: `${externals} external reference(s) survived bundling` });
}

for (const mod of ['CORE', 'ROAD', 'SPRITES', 'AUDIO', 'RENDER', 'INPUT', 'GAME']) {
  if (!new RegExp(`\\bvar\\s+${mod}\\s*=`).test(bundle)) {
    failures.push({ file: 'neon-drift-86.html', line: 1, rule: 'missing-global',
                    msg: `global ${mod} is not defined in the bundle` });
  }
}

/* ------------------------------------------------------------------------ */

if (failures.length === 0) {
  console.log(`ES5 / offline guard: OK — ${checked.length} files clean`);
  console.log(`  checked: ${checked.join(', ')}`);
  process.exit(0);
}

console.log(`ES5 / offline guard: ${failures.length} violation(s)`);
for (const f of failures) {
  console.log(`  ${f.file}:${f.line}  [${f.rule}] ${f.msg}`);
  // Show the offending line from the literal-free text for context.
  try {
    const src = readFileSync(join(ROOT, f.file), 'utf8');
    const clean = blankOutLiterals(src).split('\n')[f.line - 1];
    if (clean !== undefined) console.log(`      ${clean.trim().slice(0, 120)}`);
  } catch { /* bundle line numbers are not meaningful */ }
}
process.exit(1);
