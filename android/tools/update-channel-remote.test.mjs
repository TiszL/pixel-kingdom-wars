import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_REMOTE_EXEC, parseShowRows, remoteCommand, runRemote, runRemotePublish } from './update-channel.mjs';

function fakeSpawn({ exitCode = 0, stdout = '' } = {}) {
  const calls = [];
  const spawnImpl = (file, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    const call = { file, args, options, stdin: '' };
    calls.push(call);
    child.stdin.on('data', (chunk) => { call.stdin += chunk; });
    child.stdin.on('finish', () => { child.stdout.end(stdout); child.stdout.on('end', () => child.emit('close', exitCode)); child.stdout.resume(); });
    return child;
  };
  return { calls, spawnImpl };
}

// The operator CLI runs inside the API container (WORKDIR /app/apps/api) exactly like db:migrate;
// a drifted prefix publishes against the wrong env file or container.
test('the default remote command is the production compose exec of the operator CLI', () => {
  assert.equal(DEFAULT_REMOTE_EXEC, 'cd ~/shardkeep && docker compose --env-file infra/.env.prod -f infra/docker-compose.prod.yml exec -T api');
  const command = remoteCommand({ remote: 'deploy@host' });
  assert.equal(command.command, `${DEFAULT_REMOTE_EXEC} node --import tsx src/native/updateChannelCli.ts publish --manifest -`);
  assert.deepEqual([command.file, ...command.args], ['ssh', 'deploy@host', command.command]);
  assert.equal(command.text, `ssh deploy@host '${command.command}'`);
  assert.equal(remoteCommand({}).text, `ssh <user@host> '${command.command}'`);
  assert.equal(remoteCommand({ remote: 'h', remoteExec: 'docker exec -i api', args: ['show'] }).command, 'docker exec -i api node --import tsx src/native/updateChannelCli.ts show');
});

// ssh parses a leading '-' as an option (e.g. -oProxyCommand); a quote breaks the printed command.
test('refuses a remote that ssh would parse as an option and a quoted exec prefix', () => {
  for (const remote of ['-oProxyCommand=touch', 'deploy@host;rm', 'a b']) assert.throws(() => remoteCommand({ remote }), /Invalid --remote/);
  assert.throws(() => remoteCommand({ remote: 'h', remoteExec: "sh -c 'x'" }), /single quotes/);
});

// The manifest must reach the CLI on stdin byte-for-byte, and no local secret env may travel with ssh.
test('remote publish pipes the manifest to ssh and strips secret-like env', async () => {
  const fake = fakeSpawn({ stdout: '{"versionCode":26}\n' });
  const manifest = { versionCode: 26, channel: 'tester' };
  process.env.PKW_TEST_R2_SECRET = 'never-forward';
  try {
    assert.equal(await runRemotePublish({ manifest, remote: 'deploy@host', spawnImpl: fake.spawnImpl }), '{"versionCode":26}\n');
  } finally { delete process.env.PKW_TEST_R2_SECRET; }
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].file, 'ssh');
  assert.deepEqual(fake.calls[0].args, ['deploy@host', remoteCommand({ remote: 'deploy@host' }).command]);
  assert.equal(fake.calls[0].stdin, JSON.stringify(manifest) + '\n');
  assert.equal(fake.calls[0].options.env.PKW_TEST_R2_SECRET, undefined);
});

// A CLI refusal (non-zero exit) must stop the release, never be reported as published.
test('a non-zero remote exit refuses', async () => {
  const fake = fakeSpawn({ exitCode: 2 });
  await assert.rejects(runRemotePublish({ manifest: {}, remote: 'deploy@host', spawnImpl: fake.spawnImpl }), /exited with 2/);
  await assert.rejects(async () => runRemote({ args: ['show'], spawnImpl: fake.spawnImpl }), /Missing --remote/);
});

// Remote show feeds the code/signer refusals; unparseable output must not be read as "no rows".
// The fixture is built exactly like the backend toOffer() (apps/api/src/native/updateChannel.ts), which
// `show` prints as a bare array keyed latestVersionCode. An invented { versionCode } shape once passed
// here while every real --remote publish after the first row was refused; the two lanes must not drift.
test('remote show parses the backend NativeUpdateOffer array strictly', () => {
  const offer = { latestVersionCode: 26, versionName: '0.5.9', sourceCommit: 'd'.repeat(40),
    apkPath: `/native/releases/26-${'c'.repeat(64)}.apk`, apkUrl: `https://play.pixelkingdomwars.com/native/releases/26-${'c'.repeat(64)}.apk`,
    sha256: 'c'.repeat(64), sizeBytes: 225576834, signerSha256: 'a'.repeat(64), publishedAt: '2026-09-25T10:00:00.000Z',
    storeStatus: 'pending', channel: 'tester', mandatory: false, notesUrl: null };
  const text = JSON.stringify([offer], null, 2);
  assert.deepEqual(parseShowRows(text), [{ versionCode: 26, sha256: 'c'.repeat(64), signerSha256: 'a'.repeat(64), channel: 'tester' }]);
  assert.deepEqual(parseShowRows('[]'), []);
  const { latestVersionCode, ...legacy } = offer;
  for (const bad of ['not json', '{}', JSON.stringify({ rows: [] }), JSON.stringify([{ ...legacy, versionCode: latestVersionCode }]),
    JSON.stringify([{ ...offer, channel: 'beta' }]), JSON.stringify([{ ...offer, sha256: 'x' }])]) {
    assert.throws(() => parseShowRows(bad), /channel rows/);
  }
});

// The manual path (no --remote) prints a command the operator pastes into a shell. The canonical
// native checkout path may contain spaces, so an unquoted `< path` would redirect from a
// nonexistent file and append the rest of the path to the remote command. Proven by a real /bin/sh.
test('the printed manual command quotes the manifest path for the shell', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pkw android native it's-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = path.join(root, 'x.channel.json');
  await writeFile(manifest, '{"versionCode":26}\n');
  const { text } = remoteCommand({ stdinFile: manifest });
  const redirect = text.slice(text.lastIndexOf("' < ") + 2);
  assert.ok(text.startsWith(`ssh <user@host> '${DEFAULT_REMOTE_EXEC} node --import tsx src/native/updateChannelCli.ts publish --manifest -' < `));
  assert.equal(execFileSync('/bin/sh', ['-c', `cat ${redirect}`], { encoding: 'utf8' }), '{"versionCode":26}\n');
});
