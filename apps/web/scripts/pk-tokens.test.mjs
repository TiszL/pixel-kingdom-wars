import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { generatePkTokens } from './pk-tokens.mjs';

// Authored before the proposal generator changes. Execution is deferred to the admitted queue.
const tokens = readFileSync(new URL('../src/ui/pk/TOKENS.source.json', import.meta.url));
const aliases = readFileSync(new URL('../src/ui/pk/ALIAS-PROPOSALS.source.json', import.meta.url));
const source = JSON.parse(tokens);
const ledger = JSON.parse(aliases);
const build = (value = source, mapping = ledger) => generatePkTokens(
  Buffer.from(JSON.stringify(value)), Buffer.from(JSON.stringify(mapping)),
);
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const values = (css, name) => [...css.matchAll(new RegExp(`${escape(name)}\\s*:\\s*([^;]+);`, 'g'))].map((m) => m[1].trim());
const normal = (css, name) => values(css, name)[0];

test('pure generation is deterministic and binds the exact input bytes', () => {
  const first = generatePkTokens(tokens, aliases);
  assert.deepEqual(generatePkTokens(tokens, aliases), first);
  for (const bytes of [tokens, aliases]) {
    const hash = createHash('sha256').update(bytes).digest('hex');
    assert.ok(first.css.includes(hash));
    assert.ok(first.md.includes(hash));
  }
});

test('all 46 legacy names remain declared once with all 18 motion mirrors', () => {
  const { css, md } = build();
  assert.equal(ledger.aliases.length, 46);
  for (const { name } of ledger.aliases) assert.equal(values(css, name).length, 1, name);
  const mirrors = [
    ['press', '--pk-t-press'], ['swap', '--pk-t-swap'], ['disclose', '--pk-t-disclose'],
    ['pop', '--pk-t-pop'], ['stagger', '--pk-stagger'], ['staggerSection', '--pk-stagger-section'],
    ['sheet', '--pk-t-sheet'], ['snap', '--pk-t-snap'], ['close', '--pk-t-close'],
    ['seal', '--pk-t-seal'], ['fly', '--pk-t-fly'], ['glint', '--pk-t-glint'],
    ['beat', '--pk-beat'], ['celebrate', '--pk-t-celebrate'], ['ribbon', '--pk-t-ribbon'],
    ['toast', '--pk-t-toast'], ['riseQuick', '--pk-rise-quick'], ['staggerQuick', '--pk-stagger-quick'],
  ];
  for (const [key, name] of mirrors) {
    assert.ok(md.includes(`${key}: ${Number.parseInt(normal(css, name), 10)}`), key);
  }
});

test('Seal visual entrance and exit follow the design while the consent guard stays 450ms', () => {
  const { css, md } = build();
  assert.equal(normal(css, '--pk-t-seal'), '160ms');
  assert.equal(normal(css, '--pk-dur-seal-in'), '160ms');
  assert.equal(normal(css, '--pk-dur-seal-out'), '120ms');
  assert.deepEqual(values(css, '--pk-dur-seal-arm'), ['450ms']);
  assert.match(md, /DESIGN-SYSTEM\.md:521/);
  assert.match(md, /seal: 160/);
});

test('explicit future Seal duration keys are used without duplicate declarations', () => {
  const changed = structuredClone(source);
  changed.motion.durationMs.sealIn = 170;
  changed.motion.durationMs.sealOut = 130;
  const { css, md } = build(changed);
  assert.equal(normal(css, '--pk-t-seal'), '170ms');
  assert.deepEqual(values(css, '--pk-dur-seal-in'), ['170ms', 'var(--pk-dur-crossfade)', 'var(--pk-dur-crossfade)']);
  assert.deepEqual(values(css, '--pk-dur-seal-out'), ['130ms', 'var(--pk-dur-crossfade)', 'var(--pk-dur-crossfade)']);
  assert.ok(md.includes('motion.durationMs.sealIn'));
});

test('invalid explicit Seal timing and malformed alias inventories fail closed', () => {
  for (const value of [null, '160', -1, 0, 160.5]) {
    const changed = structuredClone(source);
    changed.motion.durationMs.sealIn = value;
    assert.throws(() => build(changed), /sealIn/);
  }
  const bad = structuredClone(ledger);
  bad.aliases[1].name = bad.aliases[0].name;
  assert.throws(() => build(source, bad), /not unique/);
});

test('five VT323 display sizes are literal kit tokens without changing canonical type sizes', () => {
  const { css, md } = build();
  for (const [name, value] of [['numeral-l', 30], ['primary', 26], ['title', 24], ['label', 22], ['caption', 20]]) {
    assert.deepEqual(values(css, `--pk-k-type-${name}`), [`${value}px`]);
  }
  assert.equal(normal(css, '--pk-type-numeral-l'), '16px');
  assert.equal(normal(css, '--pk-font-display'), '"VT323", monospace');
  assert.match(md, /90845456 F5/);
});

test('all viewport values use root attributes and only reduced motion uses a media query', () => {
  const { css, md } = build();
  for (const name of ['phone-portrait', 'phone-landscape', 'tablet-portrait', 'tablet-landscape', 'desktop']) {
    assert.ok(css.includes(`html[data-pk-vp="${name}"] {`), name);
  }
  assert.match(css, /html\[data-pk-vp-height="short"\]/);
  assert.match(css, /--pk-vp-height: short;/);
  const media = [...css.matchAll(/@media\s*([^\{]+)\{/g)].map((m) => m[1].trim());
  assert.deepEqual(media, ['(prefers-reduced-motion: reduce)']);
  assert.match(md, /classif.*dimensions/i);
});

test('both reduced-motion triggers crossfade Seal visuals without changing holds or guards', () => {
  const { css } = build();
  assert.ok(css.includes('html[data-motion="reduce"] {'));
  for (const name of ['--pk-dur-seal-in', '--pk-dur-seal-out']) {
    assert.deepEqual(values(css, name).slice(1), ['var(--pk-dur-crossfade)', 'var(--pk-dur-crossfade)']);
  }
  assert.deepEqual(values(css, '--pk-t-toast'), ['4000ms']);
  assert.deepEqual(values(css, '--pk-dur-toast-hold'), ['4000ms']);
  assert.deepEqual(values(css, '--pk-dur-tap-through-lock'), ['300ms']);
});

test('legacy materials and the single z vocabulary preserve the compatibility contract', () => {
  const { css, md } = build();
  assert.equal(normal(css, '--pk-seal'), '#F4E3BC');
  assert.equal(normal(css, '--pk-seal-primary'), '#E3AE3C');
  assert.equal(normal(css, '--pk-glass-flat'), 'rgba(29,26,36,.94)');
  assert.deepEqual(['toast', 'consent', 'celebrate'].map((n) => normal(css, `--z-${n}`)), ['3000', '3100', '3200']);
  assert.doesNotMatch(css, /--pk-z-/);
  assert.match(md, /numbers are confirmed/);
  assert.match(md, /--pk-ink-text/);
});

test('QA selectors remain exclusively in the separate development stylesheet', () => {
  const { css, qa } = build();
  assert.doesNotMatch(css, /data-pk-qa|--pk-qa-/);
  assert.match(qa, /\[data-pk-qa\]/);
  assert.match(qa, /--pk-qa-hud:/);
});
