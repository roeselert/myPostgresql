#!/usr/bin/env node
/**
 * Batch test bed.
 *
 * Runs one or more SQL files against a PGlite instance that has
 * `pg_stat_statements` and `auto_explain` enabled, prints the result of every
 * statement together with its analyzed plan, and finishes with a
 * `pg_stat_statements` report.
 *
 *   node batch.mjs                      # runs user.sql
 *   node batch.mjs train.sql user.sql   # runs both, in order
 *   node batch.mjs --sql "SELECT 1" --no-plans
 *   node batch.mjs --waits                   # what each statement waited on
 *   node batch.mjs --wait-events lock        # look wait events up in the catalog
 *   node batch.mjs --help
 *
 * The REPL bed in index.html drives the same core from src/testbed.mjs.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { createTestbed, realConsole, slowestPlans } from './src/testbed.mjs';
import {
  formatOutcome,
  formatStatements,
  formatTable,
  formatWaitEvents,
  formatWaitProfile,
  heading,
} from './src/format.mjs';

const USAGE = `Usage: node batch.mjs [options] [file.sql ...]

  --file <path>          SQL file to run on start up (repeatable)
  --sql <statement>      ad hoc statement to run after the files (repeatable)
  --no-split             send each file as one batch instead of statement by statement
  --stop-on-error        abort a file after the first failing statement
  --no-plans             do not print the auto_explain plans
  --waits                measure the I/O waits of every statement and report a profile
  --wait-events <text>   look wait events up in pg_wait_events and exit ("all" for every one)
  --wait-type <type>     restrict --wait-events to a type: IO, Lock, LWLock, IPC, Client, …
  --min-duration <ms>    auto_explain.log_min_duration (default 0, -1 disables)
  --no-analyze           turn auto_explain.log_analyze off (plan only, no execution stats)
  --format <fmt>         auto_explain.log_format: text | json | yaml | xml
  --track <mode>         pg_stat_statements.track: all | top | none
  --top <n>              statements in the final report (default 10)
  --order <col>          report order: total | mean | max | calls | rows
  --rows <n>             result rows printed per statement (default 20)
  --data-dir <path>      keep the cluster on disk instead of in memory
  --out <path>           write everything printed to this file as well
  --quiet                only print the final report
  --help                 show this text
`;

const DEFAULT_FILES = ['user.sql'];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.waitEvents !== undefined && !options.explicitTop) options.top = 40;
  if (options.help) {
    realConsole.log(USAGE);
    return;
  }

  const sink = createSink(options.out, options.quiet);
  const files = options.files.length ? options.files : filesFromEnv() ?? DEFAULT_FILES;

  const testbed = await createTestbed({
    dataDir: options.dataDir,
    measureWaits: options.waits,
    loadSql: (name) => fs.readFile(path.resolve(process.cwd(), name), 'utf-8'),
    settings: {
      'auto_explain.log_min_duration': options.minDuration,
      'auto_explain.log_analyze': options.analyze ? 'on' : 'off',
      'auto_explain.log_format': options.format,
      'pg_stat_statements.track': options.track,
    },
    onProgress: (phase, detail) => {
      if (phase === 'sql-file') sink.write(heading(`SQL file: ${detail}`));
    },
  });

  if (options.waitEvents !== undefined) {
    await reportWaitEvents(testbed, options, sink);
    await testbed.close();
    await sink.flush();
    return;
  }

  sink.write(heading('PGlite test bed'));
  sink.write(`  ${await testbed.version()}`);
  sink.write(`  auto_explain:        ${describe(testbed.settings, 'auto_explain.')}`);
  sink.write(`  pg_stat_statements:  ${describe(testbed.settings, 'pg_stat_statements.')}`);
  for (const skipped of testbed.skippedSettings) {
    sink.write(`  ! could not set ${skipped.name}: ${skipped.message}`);
  }

  // Statistics from loading the extensions themselves are noise.
  await testbed.resetStats();

  let failures = 0;
  const runOutcome = (outcome, index, total) => {
    if (outcome.error) failures += 1;
    sink.write(
      formatOutcome(outcome, {
        index,
        total,
        maxRows: options.rows,
        showPlans: options.plans,
        showWaits: options.waits,
      }),
    );
    sink.write('');
  };

  for (const file of files) {
    try {
      await testbed.runFile(file, {
        split: options.split,
        stopOnError: options.stopOnError,
        onStatement: runOutcome,
      });
    } catch (error) {
      failures += 1;
      sink.write(`  ERROR reading ${file}: ${error.message}`);
    }
  }

  if (options.statements.length) {
    sink.write(heading('Ad hoc statements'));
    for (const [index, statement] of options.statements.entries()) {
      runOutcome(await testbed.run(statement), index + 1, options.statements.length);
    }
  }

  // Snapshot before the report queries add plans of their own.
  const plansSoFar = testbed.log.entries.slice();

  sink.write(heading(`pg_stat_statements — top ${options.top} by ${options.order}`), { always: true });
  const top = await testbed.topStatements({ limit: options.top, orderBy: options.order });
  sink.write(formatStatements(top), { always: true });

  sink.write(heading(`Slowest ${options.top} single executions (auto_explain)`), { always: true });
  sink.write(formatTable(slowestPlans(plansSoFar, options.top), { maxRows: options.top }), { always: true });

  if (options.waits) {
    sink.write(heading('Wait profile (pg_stat_io, described by pg_wait_events)'), { always: true });
    sink.write(formatWaitProfile(await testbed.waitProfile()), { always: true });
  }

  await testbed.close();
  await sink.flush();

  if (failures) {
    realConsole.error(`\n${failures} statement(s) failed.`);
    process.exitCode = 1;
  }
}

/** `--wait-events`: the catalog, not a workload. */
async function reportWaitEvents(testbed, options, sink) {
  const search = /^(all|\*)$/i.test(options.waitEvents) ? undefined : options.waitEvents;
  sink.write(heading('pg_wait_events'), { always: true });
  sink.write(
    formatTable(await testbed.waitEventTypes(), { maxRows: 20, fields: ['type', 'events'] }),
    { always: true },
  );
  const rows = await testbed.waitEvents({ search, type: options.waitType, limit: options.top });
  sink.write(
    heading(
      [
        `${rows.length} match(es)`,
        search ? `for "${search}"` : '',
        options.waitType ? `of type ${options.waitType}` : '',
      ]
        .filter(Boolean)
        .join(' '),
    ),
    { always: true },
  );
  sink.write(formatWaitEvents(rows), { always: true });
}

function describe(settings, prefix) {
  return Object.entries(settings)
    .filter(([name]) => name.startsWith(prefix))
    .map(([name, value]) => `${name.slice(prefix.length)}=${value}`)
    .join(' ');
}

/** Prints to stdout and, with --out, collects the same text for a file. */
function createSink(outPath, quiet) {
  const buffer = [];
  return {
    write(text, { always = false } = {}) {
      const line = String(text);
      if (outPath) buffer.push(line);
      if (!quiet || always) realConsole.log(line);
    },
    async flush() {
      if (!outPath) return;
      await fs.writeFile(outPath, `${buffer.join('\n')}\n`, 'utf-8');
      realConsole.log(`\nOutput written to ${outPath}`);
    },
  };
}

function filesFromEnv() {
  const fromEnv = process.env.SQL_FILES?.trim();
  return fromEnv ? fromEnv.split(/[,\s]+/).filter(Boolean) : undefined;
}

function parseArgs(argv) {
  const options = {
    files: [],
    statements: [],
    split: true,
    stopOnError: false,
    plans: true,
    waits: false,
    waitEvents: undefined,
    waitType: undefined,
    analyze: true,
    minDuration: 0,
    format: 'text',
    track: 'all',
    top: 10,
    order: 'total',
    rows: 20,
    dataDir: undefined,
    out: undefined,
    quiet: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };

    switch (arg) {
      case '--help': case '-h': options.help = true; break;
      case '--file': case '-f': options.files.push(next()); break;
      case '--sql': options.statements.push(next()); break;
      case '--no-split': options.split = false; break;
      case '--stop-on-error': options.stopOnError = true; break;
      case '--no-plans': options.plans = false; break;
      case '--waits': options.waits = true; break;
      case '--wait-events': options.waitEvents = next(); break;
      case '--wait-type': options.waitType = next(); break;
      case '--no-analyze': options.analyze = false; break;
      case '--min-duration': options.minDuration = Number(next()); break;
      case '--format': options.format = next(); break;
      case '--track': options.track = next(); break;
      case '--top': options.top = Number(next()); options.explicitTop = true; break;
      case '--order': options.order = next(); break;
      case '--rows': options.rows = Number(next()); break;
      case '--data-dir': options.dataDir = next(); break;
      case '--out': options.out = next(); break;
      case '--quiet': options.quiet = true; break;
      default:
        if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}\n\n${USAGE}`);
        options.files.push(arg);
    }
  }
  return options;
}

main().catch((error) => {
  realConsole.error(error.stack ?? error.message);
  process.exitCode = 1;
});
