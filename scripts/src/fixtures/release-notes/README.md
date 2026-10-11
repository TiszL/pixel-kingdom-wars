Test fixture for `landing/build-release-history.mjs` (M47 site lane B): a small
copy of the release lane's `release-notes/` layout. The shas are real commits,
so the bundled history can read each release's package.json version from git.
`android/27.md` waits on a production flag and must be left out of the bundle.
