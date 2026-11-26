#!/usr/bin/env node
// ssh-tunnel client entry point.
import { run } from './src/cli.js';

run(process.argv).catch((err) => {
  process.stderr.write(`Fatal: ${err.stack || err.message}\n`);
  process.exitCode = 1;
});
