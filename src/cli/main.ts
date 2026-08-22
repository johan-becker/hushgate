#!/usr/bin/env node
/** The `hushgate` executable. Thin on purpose: the logic lives in run.ts. */
import { processCli } from './cli.js';
import { run } from './run.js';

process.exitCode = await run(processCli());
