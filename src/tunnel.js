// Core tunnel client.
//
//   - Establishes an SSH connection to the tunnel server (public-key auth only).
//   - Opens a local TCP listener on localhost.
//   - Proxies each local connection through an SSH `forwardOut` channel to the
//     target port on the server.
//   - Auto-reconnects with backoff if the SSH connection drops.
//   - Shuts down cleanly on demand (used by the SIGINT handler).

import net from 'node:net';
import ssh2 from 'ssh2';
import { ui } from './ui.js';

const { Client } = ssh2;

const MIN_RANDOM_PORT = 10001;
const MAX_RANDOM_PORT = 65535;

export class TunnelClient {
  /**
   * @param {object} opts
   * @param {string} opts.host          Remote server host/IP.
   * @param {number} opts.port          Remote SSH server port (default 2209).
   * @param {number} opts.targetPort    Target service port on the server.
   * @param {string} opts.identity      Private key (PEM string).
   * @param {string} [opts.identityPath] Where the key came from (for display).
   * @param {number} [opts.localPort]   Local port to bind (0/undefined => random >10000).
   * @param {string} [opts.username]    SSH username (server ignores; key decides).
   */
  constructor(opts) {
    this.host = opts.host;
    this.port = opts.port;
    this.targetPort = opts.targetPort;
    this.identity = opts.identity;
    this.identityPath = opts.identityPath || '(inline key)';
    this.localPort = opts.localPort || 0;
    this.username = opts.username || 'tunnel';

    this.conn = null;
    this.localServer = null;
    this.shuttingDown = false;
    this.established = false; // true once the first SSH session has been ready
    this.reconnecting = false;
    this.backoffMs = 1000;
    this.activeConnections = 0;
  }

  /** Pick a random port in [10001, 65535]. */
  static randomPort() {
    return MIN_RANDOM_PORT + Math.floor(Math.random() * (MAX_RANDOM_PORT - MIN_RANDOM_PORT + 1));
  }

  /**
   * Bind the local listener on the requested (or a random) port, retrying on
   * EADDRINUSE when we picked the random port ourselves.
   */
  _listen() {
    return new Promise((resolve, reject) => {
      const tryBind = (port) => {
        const server = net.createServer((socket) => this._handleLocal(socket));
        server.once('error', (err) => {
          if (err.code === 'EADDRINUSE' && !this.localPort) {
            ui.dim(`Local port ${port} is busy, trying another...`);
            tryBind(TunnelClient.randomPort());
          } else {
            reject(err);
          }
        });
        server.listen(port, '127.0.0.1', () => {
          this.localServer = server;
          server.on('error', (err) => ui.log('err', `Local listener error: ${err.message}`));
          resolve(server);
        });
      };
      tryBind(this.localPort || TunnelClient.randomPort());
    });
  }

  /** Connect the SSH session (resolves once the transport is ready). */
  _connect() {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      let settled = false;

      const cleanup = () => {
        try {
          conn.end();
        } catch {}
      };

      conn.on('ready', () => {
        this.conn = conn;
        this.established = true;
        this.backoffMs = 1000;
        if (!settled) {
          settled = true;
          resolve(conn);
        }
      });

      conn.on('error', (err) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error(`SSH connection failed: ${err.message}`));
        } else {
          ui.log('warn', `SSH error: ${err.message}`);
        }
      });

      conn.on('close', () => {
        if (this.conn !== conn) return;
        this.conn = null;
        // Only auto-reconnect if we had a working connection that dropped.
        // A failed initial connection should surface as an error, not loop forever.
        if (this.established && !this.shuttingDown) {
          ui.log('warn', 'SSH connection closed.');
          this._reconnect();
        } else {
          cleanup();
        }
      });

      // Public-key only: ignore keyboard-interactive challenges.
      conn.on('keyboard-interactive', (_methods, _lang, _submethods, next, done) => done());

      conn.connect({
        host: this.host,
        port: this.port,
        username: this.username,
        privateKey: this.identity,
        // Accept the host key (log it) — user auth to the server is key-only.
        hostVerifier: () => true,
        tryKeyboard: false,
        readyTimeout: 20000,
        keepaliveInterval: 15000,
        keepaliveCountMax: 3,
      });
    });
  }

  async _reconnect() {
    if (this.shuttingDown || this.reconnecting) return;
    this.reconnecting = true;
    const delay = this.backoffMs;
    ui.step(`Reconnecting in ${Math.round(delay / 1000)}s...`);
    await new Promise((r) => setTimeout(r, delay));
    this.backoffMs = Math.min(this.backoffMs * 2, 15000);
    try {
      await this._connect();
      this.reconnecting = false;
      ui.log('ok', 'SSH connection re-established.');
    } catch (err) {
      this.reconnecting = false;
      ui.log('warn', `Reconnect failed (${err.message}) — will retry.`);
      this._reconnect();
    }
  }

  /** Proxy a single local socket through the tunnel to the target. */
  _handleLocal(socket) {
    socket.setNoDelay(true);
    socket.on('error', (err) => ui.log('warn', `Local socket (${this.host}:${this.port} -> :${this.targetPort}): ${err.message}`)); //TODO:

    const forward = () => {
      if (!this.conn || this.conn.closed) {
        socket.destroy();
        return;
      }
      this.conn.forwardOut('127.0.0.1', 0, '127.0.0.1', this.targetPort, (err, stream) => {
        if (err) {
          ui.log('err', `forwardOut to ${this.targetPort} failed: ${err.message}`);
          socket.destroy();
          return;
        }
        socket.pipe(stream);
        stream.pipe(socket);
        const t0 = Date.now();
        socket.on('close', () => ui.log('ok', `Target socket (${this.host}:${this.port} -> :${this.targetPort}) closed after ${Date.now() - t0}ms`));
        stream.on('error', (e) => ui.log('warn', `Target stream: ${e.message}`));
      });
    };

    if (this.conn && !this.conn.closed) {
      forward();
    } else {
      // No live SSH connection yet — wait for a (re)connect, then forward.
      const timer = setInterval(() => {
        if (this.conn && !this.conn.closed) {
          clearInterval(timer);
          forward();
        } else if (socket.destroyed) {
          clearInterval(timer);
        }
      }, 100);
      // Give up after 20s if still no connection, to avoid leaking sockets.
      setTimeout(() => {
        if (!socket.destroyed) {
          clearInterval(timer);
          socket.destroy();
        }
      }, 20000).unref();
    }
  }

  /** Bring the tunnel up. Resolves once the local listener is bound. */
  async start() {
    ui.step('Connecting to server...');
    try {
      await this._connect();
    } catch (err) {
      ui.err(err.message);
      throw err;
    }
    ui.ok(`Server handshake OK (key auth, host ${this.host}:${this.port})`);

    await this._listen();
    const bound = this.localServer.address().port;
    ui.ok(`Local listener ready on 127.0.0.1:${bound} (http://127.0.0.1:${bound})`);
    ui.dim('Press Ctrl+C to stop.');
    return bound;
  }

  /** Gracefully close the local listener and the SSH connection. */
  close() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    ui.step('Shutting down...');

    if (this.localServer) {
      this.localServer.close();
    }
    if (this.conn) {
      this.conn.end();
    }
  }
}
