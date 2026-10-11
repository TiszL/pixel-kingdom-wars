import { open, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';

/** Publish config last: a retained docker.env must never acquire a new password. */
export async function writeInitialProfile(directory, config, dockerEnvironment) {
  const created = [];
  try {
    for (const [name, bytes] of [['docker.env', dockerEnvironment], ['config.json', JSON.stringify(config, null, 2) + '\n']]) {
      const filename = path.join(directory, name);
      const file = await open(filename, 'wx', 0o600);
      try {
        created.push({ filename, identity: await file.stat() });
        await file.writeFile(bytes); await file.sync();
      } finally { await file.close(); }
    }
  } catch (error) {
    // Ordinary failures remove only files created by this attempt. Abrupt death
    // leaves an exclusive-write blocker for inspection, never password rotation.
    for (const { filename, identity } of created.reverse()) {
      const actual = await lstat(filename).catch((failure) => { if (failure.code !== 'ENOENT') throw failure; });
      if (actual?.ino === identity.ino && actual.dev === identity.dev) await unlink(filename);
    }
    throw error;
  }
}
