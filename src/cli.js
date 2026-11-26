// Command-line interface for the ssh-tunnel client.
//
//   ssh-tunnel [OPTIONS] SERVER_IP TARGET_PORT

import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TunnelClient } from './tunnel.js';
import { printCard, ui } from './ui.js';

const PKG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const PKG = JSON.parse(readFileSync(PKG_PATH, 'utf8'));

// Where to look for a private key when -i/--identity is not provided.
const DEFAULT_KEY_LOCATIONS = [
  path.join(process.cwd(), 'private_key.pem'),
  path.join(process.cwd(), 'id_tunnel'),
  path.join(process.cwd(), 'keys', 'id_tunnel'),
  path.join(os.homedir(), '.ssh', 'id_ed25519'),
  path.join(os.homedir(), '.ssh', 'id_rsa'),
];

function resolveIdentity(flagPath) {
  if (flagPath) {
    const p = path.resolve(flagPath);
    if (!existsSync(p)) {
      throw new Error(`identity file not found: ${p}`);
    }
    return { pem: readFileSync(p, 'utf8'), path: p };
  }
  for (const candidate of DEFAULT_KEY_LOCATIONS) {
    if (existsSync(candidate)) {
      return { pem: readFileSync(candidate, 'utf8'), path: candidate };
    }
  }
  throw new Error(
    'No private key found. Provide one with -i/--identity, or place a key at one of: ' +
      DEFAULT_KEY_LOCATIONS.map((p) => path.relative(process.cwd(), p) || p).join(', '),
  );
}

function toPort(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`${name} must be a port between 1 and 65535 (got "${value}")`);
  }
  return n;
}

export async function run(argv) {
  const program = new Command();

  program
    .name('ssh-tunnel')
    .description('Forward a port through an SSH tunnel to reach a service on a distant machine.')
    .argument('SERVER_IP', 'IP address or hostname of the remote SSH tunnel server')
    .argument('TARGET_PORT', 'port of the service to reach on the remote server')
    .option('-i, --identity <path>', 'path to the private key file')
    .option('-p, --port <number>', 'SSH server listening port', '2209')
    .option('-l, --local-port <number>', 'local port to bind (default: random > 10000)')
    .version(`ssh-tunnel-client v${PKG.version}`, '-v, --version', 'print client version information')
    .showHelpAfterError('(use --help for details)');

  program.parse(argv);

  const opts = program.opts();
  const [serverIp, targetPortArg] = program.args;

  // Validate up front so the user gets a clean error, not a stack trace.
  const port = toPort(opts.port, '--port');
  const targetPort = toPort(targetPortArg, 'TARGET_PORT');
  let localPort = 0;
  if (opts.localPort !== undefined) localPort = toPort(opts.localPort, '--local-port');

  let identity;
  try {
    identity = resolveIdentity(opts.identity);
  } catch (err) {
    ui.err(err.message);
    process.exitCode = 1;
    return;
  }

  const info = {
    version: PKG.version,
    server: `${serverIp}:${port}`,
    target: `127.0.0.1:${targetPort}`,
    local: localPort ? `127.0.0.1:${localPort}` : '127.0.0.1:<random>',
    identity: identity.path,
  };
  printCard(info);

  let username = 'tunnel';
  try {
    username = os.userInfo().username || 'tunnel';
  } catch {
    // os.userInfo() can throw on some systems; the server ignores the username anyway.
  }

  const client = new TunnelClient({
    host: serverIp,
    port,
    targetPort,
    identity: identity.pem,
    identityPath: identity.path,
    localPort,
    username,
  });

  // Graceful Ctrl+C handling.
  const onSignal = (signal) => {
    process.stdout.write('\n');
    ui.step(`Received ${signal}, closing...`);
    client.close();
    // Close the event loop; exit cleanly once drained.
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  // Zero-crash safety nets for the client too.
  process.on('uncaughtException', (err) => ui.log('err', `Uncaught exception: ${err.message}`));
  process.on('unhandledRejection', (reason) =>
    ui.log('err', `Unhandled rejection: ${reason && reason.message ? reason.message : reason}`),
  );

  try {
    const bound = await client.start();
    info.local = `127.0.0.1:${bound}`;
    process.stdout.write('\n');
    ui.log('ok', `Tunnel up: 127.0.0.1:${bound} (client) -> ${serverIp}:${port} -> 127.0.0.1:${targetPort} (server)`);
  } catch (err) {
    if (!err.message.startsWith('SSH connection failed')) {
      ui.err(err.message);
    }
    process.exitCode = 1;
    return;
  }

  await new Promise(() => {});
}
