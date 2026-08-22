#!/usr/bin/env node
/**
 * resume-gate/validate.mjs — the resume construction gate (Part B).
 *
 * Fork-local. Registered in config/local-paths.txt so `update-system.mjs apply`
 * never writes to it.
 *
 * Everything mechanically checkable about a Nehal Swami resume is checked here
 * rather than asked of the model on every run, because reinforcement without
 * enforcement decays. The judgment half lives in modes/_custom.md.
 *
 * Usage:
 *   node resume-gate/validate.mjs --payload=<cv.json> --company=<Name> [options]
 *   node resume-gate/validate.mjs --self-test
 *
 * Options:
 *   --payload=<path>    CV JSON payload (the build-cv-html.mjs input).      required
 *   --company=<name>    Names the output Nehal-Swami-Resume-<Company>.pdf.  required
 *   --report=<NNN>      Tracker/report number. Forwarded to generate-pdf.mjs so
 *                       the data/pdf-index.tsv row is keyed, which is the only
 *                       way merge-tracker.mjs can flip that row's PDF column to
 *                       ✅. Without it the manifest row is written unkeyed and
 *                       the tracker silently keeps showing ❌ for a PDF that
 *                       exists on disk.
 *   --jd=<path>         JD token list, one per line, for the match count.
 *   --out=<dir>         Output directory (default: output).
 *   --format=<fmt>      letter | a4 (default: letter).
 *   --static-only       Run B1-B10 and stop. No browser, no PDF.
 *   --allow-reorder     Passed through to generate-pdf.mjs.
 *   --body-floor=<px>   Bullet/summary type floor (default: 11).
 *   --small-floor=<px>  Header/skills/publications floor (default: 9.5).
 *   --json              Emit the scorecard as JSON instead of a table.
 *
 * Exit codes: 0 clean (soft fails allowed), 1 hard fail, 2 bad invocation.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { spawnSync } from 'child_process';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const TEMPLATE = join(HERE, 'cv-template.nehal.html');

// ── B1. The literal heading strings an ATS parser is looking for ────────────
// Keyed by the payload.sections field that feeds each one. The awards slot
// carries PUBLICATIONS & FUNDING because the base template has no publications
// slot; the fork template moves it ahead of education.
export const REQUIRED_HEADINGS = {
  summary: 'SUMMARY',
  experience: 'EXPERIENCE',
  projects: 'SELECTED PROJECTS',
  awards: 'PUBLICATIONS & FUNDING',
  education: 'EDUCATION',
  skills: 'SKILLS',
};

// B2. Canonical top-to-bottom order, asserted against the template markup.
export const SECTION_ORDER = [
  'SUMMARY',
  'EXPERIENCE',
  'SELECTED PROJECTS',
  'PUBLICATIONS & FUNDING',
  'EDUCATION',
  'SKILLS',
];

export const BANNED_OPENERS = [
  'responsible for', 'helped', 'worked on', 'assisted',
  'spearheaded', 'leveraged', 'utilized', 'was involved in',
];

const LIMITS = {
  summaryWords: 65,
  recentRoleBullets: [4, 6],
  midRoleBulletsMax: 4,
  olderRoleBulletsMax: 2,
  totalBulletsMax: 24,
  metricDensityMin: 0.7,
  numbersPerBulletMax: 3,
  bulletWordsSoft: 30,
  bulletWordsHard: 34,
  page2FillMin: 0.6,
  renderedLinesMax: 2,
  maxPages: 2,
};

// ── pure helpers (exercised by --self-test) ─────────────────────────────────

/**
 * Count standalone numbers in a bullet. Two lookbehinds keep domain vocabulary
 * from reading as metrics: version and protocol tokens (FHIR R4, OAuth2) and
 * hyphenated names that end in a digit (GLP-1, COVID-19). Both would otherwise
 * trip B7 on bullets carrying no real numbers, and inflate B6 density.
 */
export function countNumbers(text) {
  return (String(text).match(/(?<![A-Za-z0-9])(?<![A-Za-z]-)\d[\d,]*(?:\.\d+)?/g) || []).length;
}

export function wordCount(text) {
  return String(text).trim().split(/\s+/).filter(Boolean).length;
}

export function hasMetric(text) {
  return countNumbers(text) > 0;
}

export function bannedOpener(text) {
  const t = String(text).trim().toLowerCase();
  return BANNED_OPENERS.find((verb) => t.startsWith(verb)) || null;
}

/** Bullet allowance by role position: recent two 4-6, roles 3-4 max 4, older max 2. */
export function bulletAllowance(index) {
  if (index < 2) return { min: LIMITS.recentRoleBullets[0], max: LIMITS.recentRoleBullets[1] };
  if (index < 4) return { min: 0, max: LIMITS.midRoleBulletsMax };
  return { min: 0, max: LIMITS.olderRoleBulletsMax };
}

/** Order of the canonical section titles as they appear in template markup. */
export function templateSectionOrder(templateHtml, titles = REQUIRED_HEADINGS) {
  const slots = [
    ['summary', '{{SECTION_SUMMARY}}'],
    ['experience', '{{SECTION_EXPERIENCE}}'],
    ['projects', '{{SECTION_PROJECTS}}'],
    ['awards', '{{SECTION_AWARDS}}'],
    ['education', '{{SECTION_EDUCATION}}'],
    ['skills', '{{SECTION_SKILLS}}'],
  ];
  return slots
    .map(([key, placeholder]) => ({ key, at: templateHtml.indexOf(placeholder) }))
    .filter((s) => s.at !== -1)
    .sort((a, b) => a.at - b.at)
    .map((s) => titles[s.key]);
}

export function jdTokenMatches(text, tokens) {
  const hay = String(text).toLowerCase();
  return tokens.filter((tok) => hay.includes(String(tok).trim().toLowerCase()));
}

// ── findings ────────────────────────────────────────────────────────────────

class Report {
  constructor() { this.hard = []; this.soft = []; }
  fail(id, msg) { this.hard.push(`${id} ${msg}`); }
  warn(id, msg) { this.soft.push(`${id} ${msg}`); }
}

/**
 * B1-B10: everything derivable from the JSON payload, before a browser starts.
 * @returns {{report: Report, stats: object}}
 */
export function staticChecks(payload, { templateHtml = '', jdTokens = [] } = {}) {
  const report = new Report();
  const sections = { ...payload.sections };
  const experience = Array.isArray(payload.experience) ? payload.experience : [];

  // B1 — heading strings
  for (const [key, expected] of Object.entries(REQUIRED_HEADINGS)) {
    if (sections[key] !== expected) {
      report.fail('B1', `sections.${key} is ${JSON.stringify(sections[key] ?? null)}, expected "${expected}"`);
    }
  }
  if (payload.competencies?.length) {
    report.fail('B1', 'payload carries competencies; CORE COMPETENCIES is deleted from this resume');
  }

  // B2 — section order in the template
  if (templateHtml) {
    const order = templateSectionOrder(templateHtml);
    if (order.join(' > ') !== SECTION_ORDER.join(' > ')) {
      report.fail('B2', `template section order is ${order.join(' > ')}, expected ${SECTION_ORDER.join(' > ')}`);
    }
  }

  // B3 — summary length
  const summaryWords = wordCount(payload.summary || '');
  if (summaryWords > LIMITS.summaryWords) {
    report.fail('B3', `summary is ${summaryWords} words, max ${LIMITS.summaryWords}`);
  }

  // B4-B9 — bullets
  const allBullets = [];
  let longestWords = 0;
  let longestBullet = '';

  experience.forEach((role, i) => {
    const bullets = Array.isArray(role.bullets) ? role.bullets : [];
    const label = role.company || role.role || `role ${i + 1}`;
    const { min, max } = bulletAllowance(i);

    if (bullets.length > max) report.fail('B4', `${label} has ${bullets.length} bullets, max ${max}`);
    if (bullets.length < min) report.fail('B4', `${label} has ${bullets.length} bullets, min ${min}`);

    bullets.forEach((raw) => {
      const text = typeof raw === 'string' ? raw : (raw?.text ?? '');
      allBullets.push(text);
      const words = wordCount(text);
      if (words > longestWords) { longestWords = words; longestBullet = text; }

      if (words > LIMITS.bulletWordsHard) {
        report.fail('B9', `${words}-word bullet exceeds ${LIMITS.bulletWordsHard}: "${text.slice(0, 60)}…"`);
      } else if (words > LIMITS.bulletWordsSoft) {
        report.warn('B9', `${words}-word bullet over the ${LIMITS.bulletWordsSoft}-word target: "${text.slice(0, 60)}…"`);
      }

      const nums = countNumbers(text);
      if (nums > LIMITS.numbersPerBulletMax) {
        report.fail('B7', `${nums} numbers in one bullet, max ${LIMITS.numbersPerBulletMax}: "${text.slice(0, 60)}…"`);
      }

      const banned = bannedOpener(text);
      if (banned) report.fail('B8', `banned opener "${banned}": "${text.slice(0, 60)}…"`);
    });
  });

  // B5 — total bullets
  if (allBullets.length > LIMITS.totalBulletsMax) {
    report.warn('B5', `${allBullets.length} bullets total, target max ${LIMITS.totalBulletsMax}`);
  }

  // B6 — metric density across EXPERIENCE
  const withMetric = allBullets.filter(hasMetric).length;
  const density = allBullets.length ? withMetric / allBullets.length : 0;
  if (allBullets.length && density < LIMITS.metricDensityMin) {
    report.fail('B6', `metric density ${(density * 100).toFixed(0)}%, min ${LIMITS.metricDensityMin * 100}%`);
  }

  // B10 — the cross-functional token
  const corpus = JSON.stringify(payload).toLowerCase();
  if (!corpus.includes('cross-functional')) {
    report.warn('B10', 'the literal string "cross-functional" does not appear');
  }

  const matched = jdTokens.length ? jdTokenMatches(JSON.stringify(payload), jdTokens) : [];

  return {
    report,
    stats: {
      summaryWords,
      totalBullets: allBullets.length,
      longestBulletWords: longestWords,
      longestBullet,
      metricDensity: density,
      jdTokensMatched: matched.length,
      jdTokensTotal: jdTokens.length,
      jdTokensMissing: jdTokens.filter((t) => !matched.includes(t)),
    },
  };
}

// ── render-time checks ──────────────────────────────────────────────────────

/**
 * B12/B14/B15 run inside the page after layout. Line counting uses client rects
 * rather than height/line-height: a bullet with inline markup or a trailing link
 * reports fractional heights that round the wrong way, while rects give one box
 * per visual line and unique tops give an exact count.
 */
const PAGE_PROBE = `(${function probe(opts) {
  const uniqueTops = (el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const tops = new Set();
    for (const r of range.getClientRects()) {
      if (r.width > 0.5 && r.height > 0.5) tops.add(Math.round(r.top));
    }
    return tops.size || 1;
  };

  const bullets = [...document.querySelectorAll('li')].map((el) => ({
    text: (el.textContent || '').trim(),
    lines: uniqueTops(el),
    fontPx: parseFloat(getComputedStyle(el).fontSize),
  }));

  const summaryEl = document.querySelector('.summary-text');
  const summary = summaryEl
    ? { fontPx: parseFloat(getComputedStyle(summaryEl).fontSize) }
    : null;

  // Smallest rendered type anywhere with visible text, for the small-element floor.
  let smallest = null;
  for (const el of document.querySelectorAll('body *')) {
    const direct = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!direct) continue;
    const px = parseFloat(getComputedStyle(el).fontSize);
    if (!smallest || px < smallest.px) {
      smallest = { px, sample: (el.textContent || '').trim().slice(0, 40), cls: el.className || el.tagName };
    }
  }

  // Hidden-text detection: zero opacity, transparent, or text matching its background.
  const hidden = [];
  for (const el of document.querySelectorAll('body *')) {
    const text = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join('');
    if (!text) continue;
    const cs = getComputedStyle(el);
    if (parseFloat(cs.opacity) === 0 || cs.visibility === 'hidden' || cs.color === 'rgba(0, 0, 0, 0)') {
      hidden.push(text.slice(0, 40));
      continue;
    }
    if (cs.color === 'rgb(255, 255, 255)' && !/rgb\((?!255, 255, 255)/.test(cs.backgroundColor)) {
      hidden.push(text.slice(0, 40));
    }
  }

  const forbidden = {
    tables: document.querySelectorAll('table').length,
    // Tag-name alone is not the rule. The reason tables are banned is that a
    // tabular *layout* can scramble PDF text-extraction order, and CSS
    // display:table reproduces the layout with no <table> tag anywhere — so a
    // tag-only check reports "no tables" on a page built entirely out of them.
    // Counted separately from `tables` because the risk is lower (no row/col
    // semantics for a parser to misread) and this is a soft signal, not a fail.
    cssTables: [...document.querySelectorAll('body *')].filter((el) => {
      const d = getComputedStyle(el).display;
      return d === 'table' || d === 'table-row' || d === 'table-cell';
    }).length,
    images: document.querySelectorAll('img').length,
    multicol: [...document.querySelectorAll('body *')].filter((el) => {
      const cs = getComputedStyle(el);
      return (cs.columnCount && cs.columnCount !== 'auto') || (cs.columnWidth && cs.columnWidth !== 'auto');
    }).length,
  };

  // Bullet glyphs: the list marker must be the standard disc, and no bullet text
  // may open with a hand-rolled dash/arrow/checkmark.
  const badGlyphs = [...document.querySelectorAll('li')]
    .filter((el) => {
      const marker = getComputedStyle(el).listStyleType;
      const opens = /^[-–—>»→✓✔•*]/.test((el.textContent || '').trim());
      return (marker !== 'disc' && marker !== 'none') || opens;
    })
    .map((el) => (el.textContent || '').trim().slice(0, 40));

  const contentPx = document.body.scrollHeight;
  const pages = Math.max(1, Math.ceil(contentPx / opts.pageContentPx));
  const lastFill = (contentPx - (pages - 1) * opts.pageContentPx) / opts.pageContentPx;

  return { bullets, summary, smallest, hidden, forbidden, badGlyphs, contentPx, estPages: pages, lastPageFill: lastFill };
}})`;

const PAGE_HEIGHT_IN = { letter: 11, a4: 11.69 };

async function renderChecks(htmlPath, { format, marginIn, bodyFloor, smallFloor }) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    ({ chromium } = await import('@playwright/test'));
  }

  const pageContentPx = (PAGE_HEIGHT_IN[format] - marginIn * 2) * 96;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.emulateMedia({ media: 'print' });
    await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle' });
    const probe = await page.evaluate(`${PAGE_PROBE}(${JSON.stringify({ pageContentPx })})`);

    const report = new Report();

    // B12 — the gate the base pipeline has no equivalent for.
    const overlong = probe.bullets.filter((b) => b.lines > LIMITS.renderedLinesMax);
    for (const b of overlong) {
      report.fail('B12', `bullet renders on ${b.lines} lines: "${b.text.slice(0, 60)}…"`);
    }

    // B14 — scoped type floors.
    for (const b of probe.bullets) {
      if (b.fontPx < bodyFloor) {
        report.fail('B14', `bullet renders at ${b.fontPx}px, floor ${bodyFloor}px`);
        break;
      }
    }
    if (probe.summary && probe.summary.fontPx < bodyFloor) {
      report.fail('B14', `summary renders at ${probe.summary.fontPx}px, floor ${bodyFloor}px`);
    }
    if (probe.smallest && probe.smallest.px < smallFloor) {
      report.fail('B14', `"${probe.smallest.sample}" renders at ${probe.smallest.px}px, floor ${smallFloor}px`);
    }

    // B15 — static format assertions.
    if (probe.forbidden.tables) report.fail('B15', `${probe.forbidden.tables} <table> element(s) in the DOM`);
    if (probe.forbidden.cssTables) {
      report.warn('B15', `${probe.forbidden.cssTables} element(s) using CSS display:table* (no <table> tag, but a tabular layout — currently the awards/publications and certifications rows)`);
    }
    if (probe.forbidden.images) report.fail('B15', `${probe.forbidden.images} <img> element(s) in the DOM`);
    if (probe.forbidden.multicol) report.fail('B15', `${probe.forbidden.multicol} multi-column element(s)`);
    for (const g of probe.badGlyphs) report.fail('B15', `non-standard bullet glyph: "${g}"`);
    for (const h of probe.hidden) report.fail('B15', `hidden or invisible text: "${h}"`);

    const longestLines = probe.bullets.reduce((m, b) => Math.max(m, b.lines), 0);
    return { report, probe, longestLines };
  } finally {
    await browser.close();
  }
}

// ── orchestration ───────────────────────────────────────────────────────────

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf-8', cwd: ROOT, ...opts });
}

function parseArgs(argv) {
  const out = {
    payload: '', company: '', report: '', jd: '', outDir: 'output', format: 'letter',
    staticOnly: false, allowReorder: false, json: false,
    // Tracks --font-size in cv-template.nehal.html. A default below what the
    // template actually renders is a floor that can never fail.
    bodyFloor: 12.5, smallFloor: 9.5,
  };
  for (const a of argv) {
    if (a.startsWith('--payload=')) out.payload = a.slice(10);
    else if (a.startsWith('--company=')) out.company = a.slice(10);
    else if (a.startsWith('--report=')) out.report = a.slice(9).trim();
    else if (a.startsWith('--jd=')) out.jd = a.slice(5);
    else if (a.startsWith('--out=')) out.outDir = a.slice(6);
    else if (a.startsWith('--format=')) out.format = a.slice(9);
    else if (a.startsWith('--body-floor=')) out.bodyFloor = Number(a.slice(13));
    else if (a.startsWith('--small-floor=')) out.smallFloor = Number(a.slice(14));
    else if (a === '--static-only') out.staticOnly = true;
    else if (a === '--allow-reorder') out.allowReorder = true;
    else if (a === '--json') out.json = true;
  }
  return out;
}

function scorecard(s, hard, soft, outputPath) {
  const rows = [
    ['pages', s.pages ?? '—'],
    ['page 2 fill', s.page2Fill == null ? '—' : `${(s.page2Fill * 100).toFixed(0)}%`],
    ['total bullets', s.totalBullets],
    ['longest bullet (words)', s.longestBulletWords],
    ['longest bullet (rendered lines)', s.longestLines ?? '—'],
    ['metric density', `${(s.metricDensity * 100).toFixed(0)}%`],
    ['summary words', s.summaryWords],
    ['JD tokens matched', s.jdTokensTotal ? `${s.jdTokensMatched}/${s.jdTokensTotal}` : '—'],
    ['hard fails', hard.length],
    ['soft fails', soft.length],
    ['output', outputPath || '—'],
  ];
  const w = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `  ${k.padEnd(w)}  ${v}`).join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) return selfTest();

  const opt = parseArgs(args);
  if (!opt.payload || !opt.company) {
    console.error('Usage: node resume-gate/validate.mjs --payload=<cv.json> --company=<Name> [--jd=<tokens>] [--static-only]');
    process.exit(2);
  }
  if (!existsSync(opt.payload)) {
    console.error(`Payload not found: ${opt.payload}`);
    process.exit(2);
  }

  const payload = JSON.parse(readFileSync(opt.payload, 'utf-8'));
  const templateHtml = readFileSync(TEMPLATE, 'utf-8');
  const jdTokens = opt.jd && existsSync(opt.jd)
    ? readFileSync(opt.jd, 'utf-8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    : [];

  const { report, stats } = staticChecks(payload, { templateHtml, jdTokens });
  const hard = [...report.hard];
  const soft = [...report.soft];
  // Surfaced rather than silent: an unkeyed manifest row leaves the tracker
  // showing ❌ next to a PDF that exists, which reads as "not built yet".
  if (!opt.staticOnly && !opt.report) {
    soft.push('B13 no --report=NNN given; data/pdf-index.tsv row will be unkeyed and merge-tracker.mjs cannot set the PDF flag');
  }
  let outputPath = '';

  if (!opt.staticOnly && hard.length === 0) {
    const slug = opt.company.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    mkdirSync(resolve(ROOT, opt.outDir), { recursive: true });
    // Intermediate HTML stays inside the project: generate-pdf.mjs refuses any
    // input path that escapes the project directory, so a tmpdir build fails.
    const htmlPath = resolve(ROOT, opt.outDir, `resume-gate-${slug}.html`);
    const pdfPath = resolve(ROOT, opt.outDir, `Nehal-Swami-Resume-${slug}.pdf`);

    // build-cv-html.mjs takes the template as a third positional, not a flag.
    const build = run('node', ['build-cv-html.mjs', resolve(opt.payload), htmlPath, TEMPLATE]);
    if (build.status !== 0) {
      hard.push(`BUILD build-cv-html.mjs failed: ${(build.stderr || build.stdout || '').trim().split('\n').slice(-3).join(' ')}`);
    } else {
      // Strip HTML comments from the built output before anything reads it.
      // The template header documents its own divergences and cites measured
      // page-fill percentages; those survive the build into the output HTML,
      // where verify-cv-facts reads them as resume metrics with no digest
      // backing and B11 hard-fails on the template's own changelog. Comments
      // never render, so nothing visual changes — but they do travel with the
      // file, and an HTML resume should not ship internal notes to a recruiter.
      const built = readFileSync(htmlPath, 'utf-8');
      const stripped = built.replace(/<!--[\s\S]*?-->/g, '');
      if (stripped !== built) writeFileSync(htmlPath, stripped);

      // B11 — facts, against cv.md + article-digest.md.
      const { verifyFacts } = await import(resolve(ROOT, 'verify-cv-facts.mjs'));
      const facts = verifyFacts(readFileSync(htmlPath, 'utf-8'), { cwd: ROOT });
      for (const m of facts.invented) hard.push(`B11 metric absent from the digest: ${m}`);
      for (const f of facts.unsupportedFacts) hard.push(`B11 ${f.kind} absent from the digest: ${f.value}`);
      for (const p of facts.forbidden) hard.push(`B11 forbidden phrase: ${p}`);
      for (const w of facts.warnings) soft.push(`B11 warn phrase: ${w}`);

      const marginIn = 0.6;
      const rc = await renderChecks(htmlPath, {
        format: opt.format, marginIn, bodyFloor: opt.bodyFloor, smallFloor: opt.smallFloor,
      });
      hard.push(...rc.report.hard);
      soft.push(...rc.report.soft);
      stats.longestLines = rc.longestLines;
      stats.page2Fill = rc.probe.estPages >= 2 ? rc.probe.lastPageFill : 0;

      if (hard.length === 0) {
        // B13 — strict page budget. A third page throws instead of warning.
        const pdfArgs = ['generate-pdf.mjs', htmlPath, pdfPath, `--format=${opt.format}`,
          `--max-pages=${LIMITS.maxPages}`, '--strict-pages'];
        // Keys the data/pdf-index.tsv row so merge-tracker.mjs can sync the ✅.
        if (opt.report) pdfArgs.push(`--report=${opt.report}`);
        if (opt.allowReorder) pdfArgs.push('--allow-reorder');
        const pdf = run('node', pdfArgs);
        const printed = `${pdf.stdout || ''}${pdf.stderr || ''}`;
        const m = printed.match(/Pages:\s*(\d+)/) || printed.match(/CV is (\d+) pages/);
        stats.pages = m ? Number(m[1]) : undefined;
        if (pdf.status !== 0) {
          hard.push(`B13 ${printed.trim().split('\n').filter(Boolean).slice(-2).join(' ')}`);
        } else {
          outputPath = pdfPath;
          if (stats.pages !== LIMITS.maxPages) {
            soft.push(`B13 rendered ${stats.pages} page(s); the target is exactly ${LIMITS.maxPages}`);
          }
          if (stats.page2Fill != null && stats.page2Fill < LIMITS.page2FillMin && stats.pages >= 2) {
            soft.push(`B13 page 2 is ${(stats.page2Fill * 100).toFixed(0)}% full, min ${LIMITS.page2FillMin * 100}%`);
          }
        }
      }
    }
  }

  if (opt.json) {
    console.log(JSON.stringify({ hard, soft, stats, outputPath, verdict: hard.length ? 'block' : 'pass' }, null, 2));
  } else {
    console.log('\nResume gate\n');
    console.log(scorecard(stats, hard, soft, outputPath));
    if (hard.length) {
      console.log('\nHARD FAILS — not rendered:');
      for (const h of hard) console.log(`  ✗ ${h}`);
    }
    if (soft.length) {
      console.log('\nSoft:');
      for (const s of soft) console.log(`  ! ${s}`);
    }
    if (stats.jdTokensMissing?.length) {
      console.log(`\nJD tokens absent: ${stats.jdTokensMissing.join(', ')}`);
    }
    console.log('');
  }
  process.exit(hard.length ? 1 : 0);
}

// ── self-test ───────────────────────────────────────────────────────────────

function selfTest() {
  let passed = 0, failed = 0;
  const ok = (cond, label) => { if (cond) { passed++; } else { failed++; console.error(`  ✗ ${label}`); } };

  ok(countNumbers('Scaled from 7 sites to 40 in 10 months, training 50+ staff') === 4, 'counts four numbers');
  ok(countNumbers('Shipped SMART on FHIR R4 with OAuth2 auth') === 0, 'version tokens are not numbers');
  ok(countNumbers('Patients discontinuing GLP-1 therapy after COVID-19') === 0, 'hyphenated names ending in a digit are not numbers');
  ok(countNumbers('Scaled a 7-site trial to 40 centers') === 2, 'a leading hyphenated number still counts');
  ok(countNumbers('Won $2.4M+ across AHRQ and PCORI') === 1, '$2.4M is one number');
  ok(countNumbers('1,850,000 data points') === 1, 'thousands separators are one number');

  ok(wordCount('  a b   c ') === 3, 'word count ignores padding');
  ok(hasMetric('89% caregiver adoption'), 'percent counts as a metric');
  ok(!hasMetric('Owned the roadmap'), 'no numerals means no metric');

  ok(bannedOpener('Responsible for the roadmap') === 'responsible for', 'catches a banned opener');
  ok(bannedOpener('Spearheaded delivery') === 'spearheaded', 'catches spearheaded');
  ok(bannedOpener('Owned the roadmap') === null, 'approved opener passes');

  ok(bulletAllowance(0).max === 6 && bulletAllowance(0).min === 4, 'recent role allows 4-6');
  ok(bulletAllowance(2).max === 4, 'third role caps at 4');
  ok(bulletAllowance(5).max === 2, 'older role caps at 2');

  const tpl = '{{SECTION_SUMMARY}}{{SECTION_EXPERIENCE}}{{SECTION_PROJECTS}}{{SECTION_AWARDS}}{{SECTION_EDUCATION}}{{SECTION_SKILLS}}';
  ok(templateSectionOrder(tpl).join('|') === SECTION_ORDER.join('|'), 'template order matches the canonical order');
  const swapped = '{{SECTION_SUMMARY}}{{SECTION_EXPERIENCE}}{{SECTION_EDUCATION}}{{SECTION_AWARDS}}{{SECTION_PROJECTS}}{{SECTION_SKILLS}}';
  ok(templateSectionOrder(swapped).join('|') !== SECTION_ORDER.join('|'), 'a reordered template is detected');

  const good = {
    sections: { ...REQUIRED_HEADINGS },
    summary: 'Product leader with cross-functional scope.',
    experience: [
      { company: 'A', bullets: ['Owned 1 platform for 40 centers and 3 teams', 'Shipped 2 integrations', 'Scaled to 40 sites', 'Drove 89% adoption'] },
      { company: 'B', bullets: ['Ran 200 sessions', 'Defined 1 metric', 'Cut 3 features', 'Won $2M'] },
    ],
  };
  ok(staticChecks(good, {}).report.hard.length === 0, 'a clean payload has no hard fails');

  const badHeading = { ...good, sections: { ...REQUIRED_HEADINGS, projects: 'Projects' } };
  ok(staticChecks(badHeading, {}).report.hard.some((h) => h.startsWith('B1')), 'a renamed heading hard-fails');

  const longSummary = { ...good, summary: 'word '.repeat(70) };
  ok(staticChecks(longSummary, {}).report.hard.some((h) => h.startsWith('B3')), 'a 70-word summary hard-fails');

  const tooMany = { ...good, experience: [{ company: 'A', bullets: Array(7).fill('Owned 1 thing') }, good.experience[1]] };
  ok(staticChecks(tooMany, {}).report.hard.some((h) => h.startsWith('B4')), 'seven bullets on a role hard-fails');

  const fourNumbers = { ...good, experience: [{ company: 'A', bullets: ['Scaled 7 to 40 sites in 10 months with 50 staff', 'Owned 1 thing', 'Shipped 2 things', 'Drove 3 things'] }, good.experience[1]] };
  ok(staticChecks(fourNumbers, {}).report.hard.some((h) => h.startsWith('B7')), 'four numbers in a bullet hard-fails');

  const thin = { ...good, experience: [{ company: 'A', bullets: ['Owned the roadmap', 'Shipped the thing', 'Drove the work', 'Ran the team'] }, good.experience[1]] };
  ok(staticChecks(thin, {}).report.hard.some((h) => h.startsWith('B6')), 'low metric density hard-fails');

  const withComp = { ...good, competencies: ['Product'] };
  ok(staticChecks(withComp, {}).report.hard.some((h) => h.startsWith('B1')), 'core competencies hard-fails');

  const noXfn = { ...good, summary: 'Product leader.' };
  ok(staticChecks(noXfn, {}).report.soft.some((s) => s.startsWith('B10')), 'missing cross-functional soft-fails');

  ok(jdTokenMatches('We do value-based care', ['value-based care', 'FHIR']).length === 1, 'JD token match counts hits');

  console.log(`resume-gate self-test: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`resume-gate crashed: ${err.stack || err.message}`);
    process.exit(1);
  });
}
