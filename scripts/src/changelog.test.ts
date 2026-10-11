/**
 * The changelog is the release record. If it silently drops a commit, the record
 * is wrong in the one direction nobody checks — you only find out when you go
 * looking for a change that was never written down.
 */
import { describe, expect, it } from 'vitest';
import {
  applyBump, bumpFor, insertRelease, OTHER, parseCommit, renderRelease,
} from './changelog';

const c = (sha: string, subject: string, body = ''): string => [sha, subject, body].join('\0');

describe('parseCommit', () => {
  it('reads type, scope and subject', () => {
    expect(parseCommit(c('abc1234', 'feat(sim): add hero defence'))).toEqual({
      type: 'feat', scope: 'sim', breaking: false, subject: 'add hero defence', sha: 'abc1234',
    });
  });

  it('reads a scopeless commit', () => {
    const p = parseCommit(c('abc1234', 'fix: stop the giant chewing walls'));
    expect(p.type).toBe('fix');
    expect(p.scope).toBeNull();
  });

  it('treats ! as breaking', () => {
    expect(parseCommit(c('abc1234', 'feat(api)!: drop the v1 raid route')).breaking).toBe(true);
  });

  it('treats a BREAKING CHANGE footer as breaking even without the !', () => {
    // The form people actually reach for once they are already writing the body.
    // Missing it would let a breaking change ship as a patch.
    const p = parseCommit(c('abc1234', 'refactor(api): rework raid orders',
      'Rework of the order payload.\n\nBREAKING CHANGE: orders now require simVersion.'));
    expect(p.breaking).toBe(true);
  });

  it('KEEPS an unconventional commit instead of dropping it', () => {
    // The whole point. A changelog that omits commits is worse than an untidy
    // one, because the omission is invisible.
    const p = parseCommit(c('abc1234', 'wip fixing the thing'));
    expect(p.type).toBe(OTHER);
    expect(p.subject).toBe('wip fixing the thing');
  });

  it('survives a subject containing colons and parentheses', () => {
    const p = parseCommit(c('abc1234', 'fix(web): handle 426 (stale client): force reload'));
    expect(p.scope).toBe('web');
    expect(p.subject).toBe('handle 426 (stale client): force reload');
  });
});

describe('bumpFor', () => {
  const p = (over: Partial<ReturnType<typeof parseCommit>>) => ({
    type: 'fix', scope: null, breaking: false, subject: 's', sha: 'a', ...over,
  });

  it('patch for fixes only', () => {
    expect(bumpFor([p({}), p({})], '1.2.3')).toBe('patch');
  });

  it('minor when anything is a feat', () => {
    expect(bumpFor([p({}), p({ type: 'feat' })], '1.2.3')).toBe('minor');
  });

  it('major for a breaking change once stable', () => {
    expect(bumpFor([p({ breaking: true })], '1.2.3')).toBe('major');
  });

  it('MINOR for a breaking change while pre-1.0', () => {
    // Semver's own rule for 0.x. Without it a devnet alpha reaches v9.0.0 before
    // anyone has played it, and the major number stops carrying information.
    expect(bumpFor([p({ breaking: true })], '0.4.2')).toBe('minor');
  });
});

describe('applyBump', () => {
  it('resets the lower components', () => {
    expect(applyBump('1.2.3', 'major')).toBe('2.0.0');
    expect(applyBump('1.2.3', 'minor')).toBe('1.3.0');
    expect(applyBump('1.2.3', 'patch')).toBe('1.2.4');
  });
});

describe('renderRelease', () => {
  const commits = [
    parseCommit(c('aaaaaaa', 'feat(sim): hero defence')),
    parseCommit(c('bbbbbbb', 'fix(web): stale client reload')),
    parseCommit(c('ccccccc', 'feat(api)!: drop v1 orders')),
    parseCommit(c('ddddddd', 'random unconventional commit')),
  ];

  it('hoists breaking changes above everything else', () => {
    const out = renderRelease('1.0.0', '2026-07-29', commits);
    expect(out.indexOf('⚠ Breaking')).toBeLessThan(out.indexOf('### Added'));
    // and the breaking one is NOT also listed under Added
    expect(out.match(/drop v1 orders/g)).toHaveLength(1);
  });

  it('includes unconventional commits under Other', () => {
    expect(renderRelease('1.0.0', '2026-07-29', commits)).toContain('random unconventional commit');
  });

  it('leads with the replay-protocol warning when the sim version moved', () => {
    // The single most operationally important line in a release: every client is
    // locked out of raiding until it updates. It has to be above the fold.
    const out = renderRelease('1.0.0', '2026-07-29', commits, { simVersion: 3, simVersionChanged: true });
    expect(out).toContain('sim v3');
    expect(out.indexOf('Replay protocol')).toBeLessThan(out.indexOf('⚠ Breaking'));
  });

  it('says so plainly when a release has no commits', () => {
    expect(renderRelease('1.0.1', '2026-07-29', [])).toContain('_No changes._');
  });
});

describe('insertRelease', () => {
  it('splices under the marker, newest first', () => {
    const existing = '# Changelog\n\n<!-- releases -->\n\n## [1.0.0] — 2026-01-01\n\nold\n';
    const out = insertRelease(existing, '## [1.1.0] — 2026-07-29\n\nnew\n');
    expect(out.indexOf('[1.1.0]')).toBeLessThan(out.indexOf('[1.0.0]'));
    expect(out).toContain('# Changelog');
  });

  it('appends when the marker is missing rather than losing the entry', () => {
    const out = insertRelease('# Changelog\n', '## [1.0.0] — 2026-07-29\n');
    expect(out).toContain('[1.0.0]');
  });
});
