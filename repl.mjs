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
 * `?bluebox=1` loads the Bluebox sample schema on start up, `&jobs=1` also
 * starts its schedule; see src/bluebox.mjs.
 */

import { createTestbed, isBookkeeping, slowestPlans } from './src/testbed.mjs';
import { BLUEBOX_HISTORY, isBlueboxLoaded, loadBluebox } from './src/bluebox.mjs';
import { createJobRunner } from './src/job-runner.mjs';
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
    bluebox: flag('bluebox', false),
    jobs: flag('jobs', false),
    historyDays: Number(params.get('history') ?? 30),
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
      if (entry.kind === 'plan') {
        // The job runner's own reads and writes are not the workload.
        if (!isBookkeeping(entry.queryText)) view.append(formatPlan(entry, { indent: '' }), 'plan');
      }
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

  const bluebox = createBlueboxControls({ view, testbed, options, replElement, statusElement });

  wireControls(controls, { view, testbed, options, runFiles, bluebox });

  view.section('start up');
  if (options.bluebox) await bluebox.load();
  else await runFiles(options.files);
  if (options.jobs) await bluebox.toggleJobs(true);
  view.section('ready — type SQL below');

  return { testbed, runFiles, view, bluebox };
}

/**
 * The Bluebox sample schema and its pg_cron stand-in. pg_cron is a background
 * worker and PGlite has none, so the schedule is a timer in this page while
 * the job definitions and every execution live in the `job` schema.
 */
function createBlueboxControls({ view, testbed, options, replElement, statusElement }) {
  let runner = null;

  const ensureRunner = () => {
    runner ??= createJobRunner(testbed, {
      onRun: (run) =>
        view.append(
          `job ${run.jobname} ${run.status} in ${run.durationMs.toFixed(1)} ms — ${run.message}`,
          run.status === 'failed' ? 'error' : 'job',
        ),
      onError: (error) => {
        view.append(`job runner stopped: ${error.message}`, 'error');
        if (statusElement) statusElement.textContent = `job runner stopped: ${error.message}`;
      },
    });
    return runner;
  };

  return {
    get runner() {
      return runner;
    },

    async load() {
      if (await isBlueboxLoaded(testbed.pg)) {
        view.section('Bluebox is already loaded');
        return false;
      }
      view.section('loading Bluebox');
      try {
        const { loaded, summary } = await loadBluebox(testbed, {
          historyDays: options.historyDays,
          onProgress: (phase, detail) => {
            if (phase === 'loaded') view.append(`${detail.label}: ${detail.statements} statements, ${detail.elapsedMs} ms`, 'sql');
            if (phase === 'history') view.append(`generating ${detail} days of rental history …`, 'sql');
          },
        });
        view.append(formatTable(summary, { maxRows: summary.length }), 'report');
        view.append(
          'pg_cron is not available in PGlite: the schedule runs in this page, '
          + 'the jobs and their run log live in the job schema. Start it with the Jobs button, '
          + 'or query job.status and job.recent_runs.',
          'sql',
        );
        replElement.history = [...BLUEBOX_HISTORY, ...(replElement.history ?? [])];
        return loaded;
      } catch (error) {
        view.append(`loading Bluebox failed: ${error.message}`, 'error');
        for (const failure of error.failures ?? []) view.append(`  ${failure.sql}\n    ${failure.message}`, 'error');
        throw error;
      }
    },

    /** @param {boolean} [start] force a direction instead of toggling */
    async toggleJobs(start) {
      if (!(await isBlueboxLoaded(testbed.pg))) {
        view.section('load Bluebox first — the jobs call its procedures');
        return false;
      }
      const jobRunner = ensureRunner();
      const shouldStart = start ?? !jobRunner.running;
      if (shouldStart) {
        jobRunner.start();
        const jobs = (await jobRunner.jobs()).filter((job) => job.active);
        view.section(`job schedule started — ${jobs.map((job) => `${job.jobname} every ${job.interval_ms / 1000}s`).join(', ')}`);
      } else {
        await jobRunner.stop();
        view.section('job schedule stopped');
      }
      return shouldStart;
    },

    async report(which) {
      const jobRunner = ensureRunner();
      if (which === 'status') {
        view.section('job.status');
        view.append(formatTable(await jobRunner.status(), { maxRows: 20, maxWidth: 40 }), 'report');
      } else {
        view.section('job.recent_runs');
        view.append(formatTable(await jobRunner.recentRuns(options.top * 2), { maxRows: options.top * 2, maxWidth: 46 }), 'report');
      }
    },
  };
}

function wireControls(controls = {}, { view, testbed, options, runFiles, bluebox }) {
  controls.blueboxButton?.addEventListener('click', () => bluebox.load().catch(() => {}));

  controls.jobsButton?.addEventListener('click', async () => {
    const started = await bluebox.toggleJobs();
    if (controls.jobsButton) controls.jobsButton.textContent = started ? 'Stop jobs' : 'Start jobs';
  });

  controls.jobStatusButton?.addEventListener('click', () => bluebox.report('status'));
  controls.jobRunsButton?.addEventListener('click', () => bluebox.report('runs'));

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
