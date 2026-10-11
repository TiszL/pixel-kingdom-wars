#!/usr/bin/env node
/** Local processes and synthetic state only. Never installs an APK or contacts a deployment service. */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { createServer as httpsServer, request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { createReadStream, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile, realpath, stat, chmod, rename } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { createConnection } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPack } from './pack.mjs';
import { PORTS, PROJECT, localHost, localOrigin, contentRequest, runtimeEnvironment, inside,
  nightDevnetEnvironment, NIGHT_DEVNET_REQUEST_URL_FILE } from './local-dev-policy.mjs';
import { writeInitialProfile } from './local-dev-profile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const state = path.join(root, '.reports/local-dev');
const args = process.argv.slice(2);
const mode = args[0];
const value = (key, fallback) => { const index = args.indexOf(key); return index < 0 ? fallback : args[index + 1]; };
const run = (command, commandArgs, options = {}) => {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})${result.stderr ? `: ${result.stderr.toString().slice(-2000)}` : ''}`);
};
const readConfig = async () => {
  const config = JSON.parse(await readFile(path.join(state, 'config.json'), 'utf8'));
  runtimeEnvironment(config);
  config.source = await realpath(config.source); config.pack = await realpath(config.pack);
  if (!(await stat(path.join(config.source, 'apps/api/src/app.ts'))).isFile()) throw new Error('Canonical API source is missing');
  return config;
};
const compose = (config, command) => run('docker', ['compose', '--project-name', PROJECT,
  '--env-file', path.join(state, 'docker.env'), '-f', path.join(config.source, 'infra/native-local.compose.yml'), ...command]);
const sourceArgs = (action, entry = '../../scripts/native-local-api.mjs') => ['--filter', '@shardkeep/api', 'exec', 'tsx', entry, action, '--state', state];
const sourceRun = (config, action) => run('pnpm', sourceArgs(action), { cwd: config.source, env: runtimeEnvironment(config) });
// Opt-in devnet TEST lane for `serve` only. Unset: the ordinary lane, unchanged.
const nightEnvFile = process.env.PKW_NIGHT_DEVNET_ENV_FILE;
const serveEntry = nightEnvFile ? '../../scripts/night-devnet-local-api.mjs' : '../../scripts/native-local-api.mjs';
const serveEnvironment = (config) => (nightEnvFile
  ? nightDevnetEnvironment(runtimeEnvironment(config), readFileSync(nightEnvFile, 'utf8'),
    readFileSync(path.join(state, NIGHT_DEVNET_REQUEST_URL_FILE), 'utf8'))
  : runtimeEnvironment(config));
const portOpen = (host, port) => new Promise((resolve, reject) => {
  const socket = createConnection({ host, port });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', (error) => { if (error.code === 'ECONNREFUSED') resolve(false); else reject(error); });
  socket.setTimeout(1500, () => socket.destroy(new Error('Cannot confirm that the previous local server has stopped')));
});

if (mode === 'prepare') {
  const host = localHost(value('--host', '127.0.0.1'));
  if (host !== 'localhost' && host !== '127.0.0.1' && !Object.values(networkInterfaces()).flat().some((entry) => entry?.address === host)) {
    throw new Error('The selected LAN address does not belong to this Mac');
  }
  const origin = `https://${host}:${PORTS.https}`;
  const source = await realpath(value('--source', new URL('../../', import.meta.url).pathname));
  const lock = JSON.parse(await readFile(path.join(root, 'client-pack.lock.json'), 'utf8'));
  const pack = await realpath(value('--pack', path.join(root, lock.sourcePack)));
  await verifyPack(pack);
  await mkdir(state, { recursive: true, mode: 0o700 });
  let existing;
  let configPresent = true;
  try { await stat(path.join(state, 'config.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; configPresent = false; }
  // Missing source/pack references are configuration errors, never permission
  // to generate different credentials against a retained PostgreSQL volume.
  if (configPresent) existing = await readConfig();
  let reconfigure = false;
  if (existing) {
    if (existing.origin !== origin || existing.source !== source || existing.pack !== pack) {
      if (!args.includes('--reconfigure')) throw new Error('Stop the local server, then use prepare --reconfigure to change host/source/pack while preserving DB credentials and CA.');
      if (await portOpen('127.0.0.1', PORTS.api) || await portOpen(new URL(existing.origin).hostname, PORTS.https)) {
        throw new Error('Stop the existing local serve process before reconfiguration');
      }
      reconfigure = true;
    }
  } else {
    const password = randomBytes(24).toString('hex');
    await writeInitialProfile(state, { schemaVersion: 1, source, pack, origin,
      databaseUrl: `postgresql://pkw_native:${password}@127.0.0.1:${PORTS.postgres}/pkw_native_local`,
      jwtSecret: randomBytes(32).toString('hex'), twofaKey: randomBytes(32).toString('base64'),
    }, `PKW_NATIVE_DB_PASSWORD=${password}\n`);
  }
  let leafExists = false;
  try { await stat(path.join(state, 'server.pem')); leafExists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!leafExists || (reconfigure && existing.origin !== origin)) {
    const certificateEnvironment = { PATH: process.env.PATH, HOME: process.env.HOME };
    const options = { cwd: state, env: certificateEnvironment, stdio: ['ignore', 'ignore', 'pipe'] };
    let caExists = false;
    try { await stat(path.join(state, 'ca.pem')); caExists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!caExists) run('openssl', ['req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-sha256', '-days', '30',
      '-subj', '/CN=PKW isolated local test CA', '-keyout', 'ca.key', '-out', 'ca.pem',
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'], options);
    run('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${host}`,
      '-keyout', 'server.key', '-out', 'server.csr'], options);
    await writeFile(path.join(state, 'server.ext'), `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${host === 'localhost' ? 'DNS' : 'IP'}:${host}\n`, { mode: 0o600 });
    run('openssl', ['x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial',
      '-out', 'server.pem', '-days', '30', '-sha256', '-extfile', 'server.ext'], options);
  }
  if (reconfigure) {
    const temporary = path.join(state, 'config.next.json');
    await writeFile(temporary, JSON.stringify({ ...existing, origin, source, pack }, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, path.join(state, 'config.json'));
  }
  await chmod(path.join(state, 'ca.key'), 0o600); await chmod(path.join(state, 'server.key'), 0o600);
  console.log(`Prepared isolated local profile: ${origin}\nDebug build properties: -PnativeLocalOrigin=${origin} -PnativeLocalCa=.reports/local-dev/ca.pem\nOwner installs the APK. No device or deployment action was performed.`);
} else if (mode === 'up') {
  const config = await readConfig();
  compose(config, ['up', '-d', '--wait']);
  sourceRun(config, 'initialize');
} else if (mode === 'down') {
  compose(await readConfig(), ['down']); // Preserve the named synthetic-data volume.
} else if (mode === 'seed') {
  sourceRun(await readConfig(), 'seed');
} else if (mode === 'serve') {
  const config = await readConfig();
  const manifest = await verifyPack(config.pack);
  const allowed = new Set(['manifest.json', ...manifest.files.map((file) => file.path)]);
  const tls = { key: await readFile(path.join(state, 'server.key')), cert: await readFile(path.join(state, 'server.pem')) };
  const api = spawn('pnpm', sourceArgs('serve', serveEntry), { cwd: config.source, env: serveEnvironment(config), stdio: 'inherit', detached: true });
  const types = { '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.ogg': 'audio/ogg',
    '.mp3': 'audio/mpeg', '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' };
  let server;
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true; server?.close(); server?.closeAllConnections();
    // Stop this launcher's whole pnpm/tsx process group, never unrelated API processes.
    if (api.pid) try { process.kill(-api.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  process.once('SIGINT', close); process.once('SIGTERM', close);
  api.once('error', (error) => { console.error(error.message); close(); process.exitCode = 1; });
  api.once('exit', (code) => { if (!closing) { console.error(`Isolated API exited (${code})`); process.exitCode = code || 1; close(); } });
  const sendFile = async (res, directory, relative) => {
    const filename = inside(directory, await realpath(path.join(directory, relative)));
    const info = await stat(filename);
    if (!info.isFile()) throw new Error('Not a file');
    res.writeHead(200, { 'content-type': types[path.extname(filename)] ?? 'application/octet-stream',
      'content-length': info.size, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    const stream = createReadStream(filename); stream.on('error', () => res.destroy()); stream.pipe(res);
  };
  server = httpsServer(tls, async (req, res) => {
    const url = req.url ?? '/';
    try {
      if (url === '/api' || url.startsWith('/api/')) {
        const headers = { ...req.headers, host: new URL(config.origin).host, 'x-forwarded-proto': 'https',
          'x-forwarded-for': req.socket.remoteAddress };
        delete headers['forwarded']; delete headers['x-forwarded-host'];
        const upstream = httpRequest({ host: '127.0.0.1', port: PORTS.api, path: url.slice(4) || '/', method: req.method, headers }, (response) => {
          res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
        });
        upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Local API unavailable'); });
        req.on('aborted', () => upstream.destroy()); res.on('close', () => upstream.destroy()); req.pipe(upstream);
      } else if (url.startsWith('/native/releases/')) {
        // M45 §3 shape only, immutable like production; files are staged by the operator.
        const name = /^\/native\/releases\/([0-9]{1,6}-[0-9a-f]{64}\.apk)$/.exec(url)?.[1];
        if (!name || (req.method !== 'GET' && req.method !== 'HEAD')) { res.writeHead(404); res.end(); return; }
        const directory = path.join(state, 'releases');
        const filename = inside(directory, await realpath(path.join(directory, name)));
        const info = await stat(filename);
        res.writeHead(200, { 'content-type': 'application/vnd.android.package-archive', 'content-length': info.size,
          'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' });
        const stream = createReadStream(filename); stream.on('error', () => res.destroy()); stream.pipe(res);
      } else if (url.startsWith('/native-content/')) {
        const relative = contentRequest(url, allowed);
        if (!relative || (req.method !== 'GET' && req.method !== 'HEAD')) { res.writeHead(404); res.end(); return; }
        await sendFile(res, config.pack, relative);
      } else {
        // Optional prebuilt current web client: same local API, no modification or publication.
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
        const pathname = decodeURIComponent(url.split('?')[0]);
        if (pathname.includes('..') || pathname.includes('\\')) throw new Error('Invalid path');
        const directory = path.join(config.source, 'apps/web/dist');
        try { await sendFile(res, directory, pathname === '/' ? 'index.html' : pathname.slice(1)); }
        catch { res.writeHead(404); res.end('Build the canonical web client locally to compare its routes.'); }
      }
    } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
  });
  server.once('error', (error) => { console.error(error.message); close(); process.exitCode = 1; });
  if (!closing) server.listen(PORTS.https, localOrigin(config.origin).hostname === 'localhost' ? '127.0.0.1' : localOrigin(config.origin).hostname,
    () => console.log(`Isolated HTTPS server: ${config.origin}\nCtrl-C stops API and proxy; local Docker data remains until down. Owner installs APK; no deployment occurs.`));
} else if (mode === 'check') {
  const config = await readConfig();
  const ca = await readFile(path.join(state, 'ca.pem'));
  const get = (relative, headers) => new Promise((resolve, reject) => {
    const request = httpsRequest(new URL(relative, config.origin), { ca, headers }, (response) => {
      const chunks = []; response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks), headers: response.headers }));
    }); request.on('error', reject); request.setTimeout(20_000, () => request.destroy(new Error('Local check timed out'))); request.end();
  });
  const capabilities = await get('/api/native/capabilities');
  if (capabilities.status !== 200 || JSON.parse(capabilities.body).contentManifestUrl !== `${config.origin}/native-content/manifest.json`) throw new Error('Native capabilities do not advertise the local manifest');
  const published = await get('/native-content/manifest.json');
  const actual = await readFile(path.join(config.pack, 'manifest.json'));
  if (published.status !== 200 || !published.body.equals(actual)) throw new Error('Published manifest differs from verified pack');
  const { files } = JSON.parse(actual);
  const selected = files.find((file) => file.tier === 'core');
  const content = await get(`/native-content/${selected.path}`);
  if (content.status !== 200 || createHash('sha256').update(content.body).digest('hex') !== selected.sha256) throw new Error('Local content integrity failed');
  if ((await get('/api/me')).status !== 401) throw new Error('Unauthenticated local account route did not reject access');
  if ((await get('/native-content/server.key')).status !== 404) throw new Error('Private files must not be served');
  const [session] = JSON.parse(await readFile(path.join(state, 'synthetic-sessions.json'), 'utf8'));
  const authenticated = { cookie: session.cookie, 'x-sim-version': String(JSON.parse(actual).simVersion) };
  const me = await get('/api/me', authenticated);
  if (me.status !== 200 || JSON.parse(me.body).wallet !== session.wallet) throw new Error('Existing web account endpoint failed over local HTTPS');
  if ((await get('/api/base', authenticated)).status !== 200) throw new Error('Existing web base endpoint failed over local HTTPS');
  console.log('Local HTTPS, exact manifest/content hash, canonical authentication/base routes and private-file exclusion passed.');
} else {
  throw new Error('Usage: node tools/local-dev.mjs prepare [--source PATH] [--pack PATH] [--host PRIVATE_IPV4] [--reconfigure] | up | serve | seed | check | down');
}
