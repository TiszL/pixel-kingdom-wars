import { lstat, mkdir, readFile, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Both clients exclude each other through this directory. Never remove a lock
 * that was replaced, or a directory with another transaction's recovery files. */
export async function acquireReleaseLock(directory, owner, writeOwner = writeFile, moveLock = rename) {
  await mkdir(directory, { mode: 0o700 });
  const created = await lstat(directory);
  const ownerPath = path.join(directory, 'owner.json');
  const sameDirectory = async () => {
    const current = await lstat(directory);
    return current.isDirectory() && current.dev === created.dev && current.ino === created.ino;
  };
  async function removeOwnedDirectory(requireOwner) {
    if (!(await sameDirectory())) throw new Error('Shared release lock directory changed; retained for recovery');
    const quarantine = `${directory}.cleanup-${randomUUID()}`;
    // Claim the actual directory entry before deciding which inode to delete.
    // Rechecking then recursively deleting by its old name can delete a replacement.
    await moveLock(directory, quarantine);
    try {
      const claimed = await lstat(quarantine);
      if (claimed.dev !== created.dev || claimed.ino !== created.ino || !claimed.isDirectory()) throw new Error(`Concurrent lock replacement retained at ${quarantine}; recover before releasing`);
      if (requireOwner) {
        const current = JSON.parse(await readFile(path.join(quarantine, 'owner.json'), 'utf8'));
        if (current.transactionId !== owner.transactionId) throw new Error(`Changed lock ownership retained at ${quarantine}`);
      }
      const names = await readdir(quarantine);
      if (names.some((name) => name !== 'owner.json')) throw new Error(`Unexpected recovery files retained at ${quarantine}`);
      if (names.includes('owner.json')) await unlink(path.join(quarantine, 'owner.json'));
      // Nonrecursive removal preserves any concurrently added recovery file.
      await rmdir(quarantine);
    } catch (error) {
      // A failed claim must not make either client believe recovery is complete.
      // Restore a blocking directory only when no newer client owns the name.
      try {
        await mkdir(directory, { mode: 0o700 });
        await writeFile(path.join(directory, 'native-recovery-required.json'), JSON.stringify({ quarantine, transactionId: owner.transactionId }), { flag: 'wx', mode: 0o600 });
      } catch (blockError) { if (blockError.code !== 'EEXIST') throw new AggregateError([error, blockError], `Recovery lock could not be restored; inspect ${quarantine}`); }
      throw error;
    }
  }
  try { await writeOwner(ownerPath, JSON.stringify(owner), { mode: 0o600, flag: 'wx' }); }
  catch (error) {
    await removeOwnedDirectory(false);
    throw error;
  }
  return async () => {
    if (!(await sameDirectory())) throw new Error('Shared release lock directory changed; retained for recovery');
    const current = JSON.parse(await readFile(ownerPath, 'utf8'));
    if (current.transactionId !== owner.transactionId) throw new Error('Shared release lock ownership changed; retained for recovery');
    await removeOwnedDirectory(true);
  };
}
