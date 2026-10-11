/**
 * Turning `git log` into a changelog nobody has to hand-maintain.
 *
 * Split from the CLI (release.ts) so the interesting part — parsing a commit
 * subject, deciding what a release is called, grouping the notes — is pure and
 * testable. The CLI does the git and filesystem work, which is not.
 *
 * Convention is Conventional Commits, because it is the one every tool already
 * understands and it is what this repo drifted into on its own:
 *
 *     type(scope)!: subject
 *
 * `type` decides the section AND the version bump. `!` (or a `BREAKING CHANGE:`
 * footer) forces a major. Anything that does not parse is not dropped — it lands
 * under "Other", because a changelog that silently omits commits is worse than an
 * untidy one. You find out at review time, not after someone goes looking for a
 * change that was never written down.
 */

export type BumpKind = 'major' | 'minor' | 'patch';

export interface ParsedCommit {
  type: string;
  scope: string | null;
  breaking: boolean;
  subject: string;
  sha: string;
}

/** Section heading per type, in the order they should appear. Types absent here
 *  are still recorded — see OTHER. */
export const SECTIONS: ReadonlyArray<readonly [type: string, heading: string]> = [
  ['feat', 'Added'],
  ['fix', 'Fixed'],
  ['perf', 'Performance'],
  ['refactor', 'Changed'],
  ['docs', 'Documentation'],
  ['test', 'Tests'],
  ['build', 'Build'],
  ['ci', 'CI'],
  ['chore', 'Chores'],
];
export const OTHER = 'Other';

const HEADER = /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?<bang>!)?:\s*(?<subject>.+)$/;

/**
 * Parse one commit. `raw` is "<sha>\x00<subject>\x00<body>" — NUL-separated
 * because subjects and bodies contain every other separator you might reach for.
 */
export function parseCommit(raw: string): ParsedCommit {
  const [sha = '', subject = '', body = ''] = raw.split('\0');
  const m = HEADER.exec(subject.trim());
  // A `BREAKING CHANGE:` footer counts even without the `!`, per the spec — and
  // it is the form people actually reach for when they realise mid-write.
  const footerBreaking = /^BREAKING[ -]CHANGE:/m.test(body);
  if (!m?.groups) {
    return { type: OTHER, scope: null, breaking: footerBreaking, subject: subject.trim(), sha };
  }
  const g = m.groups;
  return {
    type: g['type']!,
    scope: g['scope'] ?? null,
    breaking: g['bang'] === '!' || footerBreaking,
    subject: g['subject']!.trim(),
    sha,
  };
}

/**
 * What kind of release this set of commits is.
 *
 * Pre-1.0 deliberately does NOT get the "breaking means major" treatment: while
 * the version is 0.x a breaking change bumps the MINOR, which is the semver
 * convention for unstable packages and stops an alpha from sprinting to v7.0.0
 * before anyone has played it.
 */
export function bumpFor(commits: readonly ParsedCommit[], currentVersion: string): BumpKind {
  const preRelease = currentVersion.startsWith('0.');
  if (commits.some((c) => c.breaking)) return preRelease ? 'minor' : 'major';
  if (commits.some((c) => c.type === 'feat')) return 'minor';
  return 'patch';
}

export function applyBump(version: string, kind: BumpKind): string {
  const [maj = 0, min = 0, pat = 0] = version.split('.').map((n) => Number.parseInt(n, 10));
  if (kind === 'major') return `${maj + 1}.0.0`;
  if (kind === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

/**
 * Render one release section in Keep a Changelog shape.
 *
 * Breaking changes are hoisted into their own block at the top rather than left
 * inline under "Added". If someone skims one thing before deploying, it has to be
 * the list of things that will break.
 */
export function renderRelease(
  version: string,
  date: string,
  commits: readonly ParsedCommit[],
  opts: { simVersion?: number; simVersionChanged?: boolean } = {},
): string {
  const lines: string[] = [`## [${version}] — ${date}`, ''];

  if (opts.simVersionChanged && opts.simVersion !== undefined) {
    // The single most operationally important fact about a release, so it goes
    // first and says what it MEANS, not just that a number moved: every client
    // must update before it can raid.
    lines.push(
      `> **Replay protocol → sim v${opts.simVersion}.** Battle simulation changed.`,
      '> Clients below this are refused at raid creation (426) and must update.',
      '> Completed replays remain stable because they render archived event logs.',
      '',
    );
  }

  const breaking = commits.filter((c) => c.breaking);
  if (breaking.length > 0) {
    lines.push('### ⚠ Breaking', '');
    for (const c of breaking) lines.push(bullet(c));
    lines.push('');
  }

  for (const [type, heading] of SECTIONS) {
    const of = commits.filter((c) => c.type === type && !c.breaking);
    if (of.length === 0) continue;
    lines.push(`### ${heading}`, '');
    for (const c of of) lines.push(bullet(c));
    lines.push('');
  }

  const known = new Set(SECTIONS.map(([t]) => t));
  const other = commits.filter((c) => !known.has(c.type) && !c.breaking);
  if (other.length > 0) {
    lines.push(`### ${OTHER}`, '');
    for (const c of other) lines.push(bullet(c));
    lines.push('');
  }

  if (commits.length === 0) lines.push('_No changes._', '');
  return lines.join('\n');
}

function bullet(c: ParsedCommit): string {
  const scope = c.scope ? `**${c.scope}:** ` : '';
  return `- ${scope}${c.subject} (\`${c.sha.slice(0, 7)}\`)`;
}

/** Splice a rendered release in under the header of an existing CHANGELOG. */
export function insertRelease(existing: string, rendered: string): string {
  const marker = '<!-- releases -->';
  const at = existing.indexOf(marker);
  if (at === -1) return `${existing.trimEnd()}\n\n${rendered}`;
  const cut = at + marker.length;
  return `${existing.slice(0, cut)}\n\n${rendered}${existing.slice(cut)}`;
}
