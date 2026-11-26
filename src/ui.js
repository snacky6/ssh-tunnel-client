// Small, dependency-light terminal UI for the client CLI.
//
// Produces a consistent, colourised status block plus a running log. Colours are
// disabled automatically when stdout is not a TTY or NO_COLOR is set (via chalk).

import chalk from 'chalk';

const W = 46; // content width for the status card

function hr(char = '─') {
  return chalk.dim(char.repeat(W));
}

/**
 * Print the initial configuration card describing the tunnel that is about to be
 * (or has been) established.
 */
export function printCard(info) {
  const rows = [
    ['Server', info.server],
    ['Target (on server)', info.target],
    ['Local listener', info.local],
    ['Identity', info.identity],
  ];
  const labelW = Math.max(...rows.map(([k]) => k.length)) + 2;

  process.stdout.write('\n');
  process.stdout.write(`  ${chalk.bold('ssh-tunnel-client')} ${chalk.dim('v' + info.version)}\n`);
  process.stdout.write(`${hr()}\n`);
  for (const [key, value] of rows) {
    const label = chalk.dim(key.padEnd(labelW));
    process.stdout.write(`  ${label} ${value}\n`);
  }
  process.stdout.write(`${hr()}\n\n`);
}

function time() {
  return new Date().toLocaleTimeString([], { hour12: false });
}

export const ui = {
  /** A progress step. */
  step: (message) => process.stdout.write(`${chalk.cyan('●')} ${message}\n`),

  /** A note. */
  note: (message) => process.stdout.write(`${chalk.blue('→')} ${message}\n`),

  /** A successful terminal state. */
  ok: (message) => process.stdout.write(`${chalk.green('✔')} ${chalk.green(message)}\n`),

  /** A warning (non-fatal). */
  warn: (message) => process.stdout.write(`${chalk.yellow('▲')} ${message}\n`),

  /** An error. */
  err: (message) => process.stderr.write(`${chalk.red('✖')} ${chalk.red(message)}\n`),

  /** A dimmed informational line. */
  dim: (message) => process.stdout.write(chalk.dim(`${message}\n`)),

  /** A timestamped live event (per-connection traffic, reconnects, errors). */
  log: (kind, message) => {
    const style =
      kind === 'err' ? chalk.red : kind === 'warn' ? chalk.yellow : kind === 'ok' ? chalk.green : chalk.gray;
    process.stdout.write(`${chalk.dim(`${time()}`)} ${style(message)}\n`);
  },
};
