// Minimal, high-signal lint config: enforce React's Rules of Hooks in the web
// app. A hooks-order violation in RaidUI (2026-07-19) black-screened the whole
// app, and the repo had no linter to catch it. Scoped deliberately to just the
// rules-of-hooks rule for now (not the full recommended sets) to stay noise-free
// in a previously un-linted codebase; broaden later if desired.
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config({
  files: ['src/**/*.{ts,tsx}'],
  // This config enables only rules-of-hooks, so don't flag existing
  // `eslint-disable react-hooks/exhaustive-deps` comments as "unused".
  linterOptions: { reportUnusedDisableDirectives: false },
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
  plugins: { 'react-hooks': reactHooks },
  rules: { 'react-hooks/rules-of-hooks': 'error' },
});
