/**
 * REPL test bed.
 *
 * Wires the shared test bed from src/testbed.mjs to the `<pglite-repl>` web
 * component: same extensions, same settings, same SQL file loading as
 * batch.mjs, but interactive. Every statement typed into the REPL goes
 * through the log capture as well, so its auto_explain plan shows up in the
 * panel next to it.
 *
 * Start up SQL files come from the query string:
 *   index.html?file=user.sql
 *   index.html?file=train.sql&file=user.sql
 *   index.html?files=train.sql,user.sql
 *   index.html?file=https://example.org/schema.sql
 *
 * Other recognised parameters: min_duration, analyze, format, track, split,
 * top, waits — they map onto the same settings the batch bed exposes as flags.
 */

import { createTestbed, slowestPlans } from './src/testbed.mjs';
import {
  formatOutcome,
  formatPlan,
  formatStatements,
  formatTable,
  formatWaitEvents,
  formatWaitProfile,
} from './src/format.mjs';

const DEFAULT_FILES = ['user.sql'];

/** Everything else the backend logs is start up chatter. */
const REPORTED_LEVELS = new Set(['NOTICE', 'WARNING', 'ERROR', 'FATAL', 'PANIC']);

export function readOptions(search = window.location.search) {
  const params = new URLSearchParams(search);
  const files = [
    ...params.getAll('file'),
    ...params.getAll('sql'),
    ...params.getAll('files').flatMap((value) => value.split(',')),
  ]
    .map((value) => value.trim())
    .filter(Boolean);

  const flag = (name, fallback) => {
    const value = params.get(name);
    if (value === null) return fallback;
    return !/^(0|off|false|no)$/i.test(value);
  };

  return {
    files: files.length ? files : DEFAULT_FILES,
    minDuration: Number(params.get('min_duration') ?? 0),
    analyze: flag('analyze', true),
    format: params.get('format') ?? 'text',
    track: params.get('track') ?? 'all',
    split: flag('split', true),
    waits: flag('waits', false),
    top: Number(params.get('top') ?? 10),
  };
}

export async function start({ replElement, logElement, statusElement, controls, options = readOptions() }) {
  const view = createLogView(logElement);

  view.status(statusElement, 'booting PGlite …');
  const testbed = await createTestbed({
    loadSql: fetchSql,
    measureWaits: options.waits,
    settings: {
      'auto_explain.log_min_duration': options.minDuration,
      'auto_explain.log_analyze': options.analyze ? 'on' : 'off',
      'auto_explain.log_format': options.format,
      'pg_stat_statements.track': options.track,
    },
    onEntry: (entry) => {
      // Plans from statements typed into the REPL land here.
      if (entry.kind === 'plan') view.append(formatPlan(entry, { indent: '' }), 'plan');
      else if (REPORTED_LEVELS.has(entry.level)) view.append(entry.text, 'notice');
    },
    onProgress: (phase, detail) => {
      if (phase === 'sql-file') view.section(`SQL file: ${detail}`);
    },
  });

  view.status(
    statusElement,
    `${shortVersion(await testbed.version())} · auto_explain on · pg_stat_statements on` +
      (options.waits ? ' · waits measured' : ''),
  );
  await testbed.resetStats();
  view.clear(); // the bed's own start up queries are not worth reporting

  // The REPL shares the instance, so its queries are captured the same way.
  replElement.pg = testbed.pg;
  replElement.history = [
    'SELECT * FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 10;',
    'EXPLAIN (ANALYZE, BUFFERS) SELECT 1;',
  ];

  const runFiles = async (files) => {
    for (const file of files) {
      try {
        await testbed.runFile(file, {
          split: options.split,
          onStatement: (outcome, index, total) =>
            view.append(
              formatOutcome(outcome, { index, total, showPlans: false, showWaits: options.waits }),
              outcome.error ? 'error' : 'sql',
            ),
        });
      } catch (error) {
        view.append(`could not load ${file}: ${error.message}`, 'error');
      }
    }
  };

  wireControls(controls, {
    view,
    testbed,
    options,
    runFiles,
  });

  view.section('start up');
  await runFiles(options.files);
  view.section('ready — type SQL below');

  return { testbed, runFiles, view };
}

function wireControls(controls = {}, { view, testbed, options, runFiles }) {
  controls.loadForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = controls.loadInput?.value.trim();
    if (value) await runFiles(value.split(',').map((name) => name.trim()).filter(Boolean));
  });

  controls.topButton?.addEventListener('click', async () => {
    const rows = await testbed.topStatements({ limit: options.top });
    view.section(`pg_stat_statements — top ${options.top} by total_exec_time`);
    view.append(formatStatements(rows), 'report');
  });

  controls.slowestButton?.addEventListener('click', () => {
    const plans = slowestPlans(testbed.log.entries, options.top);
    view.section(`slowest ${options.top} single executions (auto_explain)`);
    view.append(formatTable(plans, { maxRows: options.top }), 'report');
  });

  controls.waitForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const search = controls.waitInput?.value.trim();
    const rows = await testbed.waitEvents({ search: search || undefined, limit: 40 });
    view.section(search ? `pg_wait_events matching "${search}"` : 'pg_wait_events');
    view.append(formatWaitEvents(rows, { maxWidth: 60 }), 'report');
  });

  controls.waitProfileButton?.addEventListener('click', async () => {
    view.section('wait profile (pg_stat_io, described by pg_wait_events)');
    view.append(formatWaitProfile(await testbed.waitProfile(), { maxWidth: 44 }), 'report');
  });

  controls.resetButton?.addEventListener('click', async () => {
    await testbed.resetStats();
    view.clear();
    view.section('statistics and captured plans reset');
  });

  controls.clearButton?.addEventListener('click', () => view.clear());
}

/** SQL files are fetched relative to the page unless an absolute URL is given. */
async function fetchSql(name) {
  const url = new URL(name, window.location.href.split('?')[0]).href;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.text();
}

function createLogView(element) {
  return {
    append(text, kind = 'plain') {
      if (!element || !text) return;
      const block = document.createElement('pre');
      block.className = `entry entry--${kind}`;
      block.textContent = text;
      element.append(block);
      element.scrollTop = element.scrollHeight;
    },
    section(title) {
      if (!element) return;
      const block = document.createElement('div');
      block.className = 'entry entry--section';
      block.textContent = title;
      element.append(block);
      element.scrollTop = element.scrollHeight;
    },
    clear() {
      if (element) element.replaceChildren();
    },
    status(target, text) {
      if (target) target.textContent = text;
    },
  };
}

function shortVersion(banner) {
  return banner.match(/PostgreSQL [\d.]+ \(PGlite [\d.]+\)/)?.[0] ?? banner.slice(0, 40);
}
