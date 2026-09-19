/**
 * The PGlite test bed shared by the batch runner (`batch.mjs`) and the
 * browser REPL (`repl.mjs`).
 *
 * It gives both beds the same database: `pg_stat_statements` installed and
 * tracking everything, `auto_explain` loaded and logging analyzed plans, and
 * the server log captured so those plans can be shown next to the statement
 * that produced them.
 *
 * The module must stay free of environment specific imports -- reading SQL
 * files is left to the caller, which passes a `loadSql` function.
 */

import { PGlite } from '@electric-sql/pglite';
import { auto_explain } from '@electric-sql/pglite/contrib/auto_explain';
import { pg_stat_statements } from '@electric-sql/pglite/contrib/pg_stat_statements';

import { PgLog, plansOf, realConsole } from './pg-log.mjs';
import { splitSql, stripComments, summarize } from './sql-split.mjs';
import {
  currentActivity,
  describeWaits,
  ioDelta,
  ioSnapshot,
  waitEventCatalog,
  waitEventTypes,
  waitProfile,
} from './wait-events.mjs';

export { plansOf, realConsole, splitSql, summarize };
export { knownIoWaitEvents, ioWaitEvent } from './wait-events.mjs';

/**
 * Server settings applied after startup. `auto_explain` is session loaded
 * (`LOAD`) rather than preloaded: PGlite fails to boot with `auto_explain` in
 * shared_preload_libraries, and since PGlite serves a single backend the
 * session load covers everything that runs against the instance.
 *
 * `log_min_messages = warning` removes the DEBUG1 chatter that PGlite's
 * `debug` option switches on, without losing the plans -- LOG outranks
 * WARNING in `log_min_messages`.
 */
export const DEFAULT_SETTINGS = {
  'auto_explain.log_min_duration': 0,
  'auto_explain.log_analyze': 'on',
  'auto_explain.log_buffers': 'on',
  'auto_explain.log_timing': 'on',
  'auto_explain.log_triggers': 'on',
  'auto_explain.log_wal': 'on',
  'auto_explain.log_verbose': 'off',
  'auto_explain.log_settings': 'off',
  'auto_explain.log_nested_statements': 'on',
  'auto_explain.log_format': 'text',
  'auto_explain.sample_rate': 1,
  'pg_stat_statements.track': 'all',
  'pg_stat_statements.track_utility': 'on',
  'track_io_timing': 'on',
  'track_wal_io_timing': 'on',
  'log_min_messages': 'warning',
};

const WRAPPED_METHODS = ['query', 'exec', 'sql', 'transaction', 'describeQuery'];

/**
 * @param {object} [options]
 * @param {string}   [options.dataDir]   persist the cluster, e.g. `./pgdata`; omit for memory
 * @param {object}   [options.settings]  overrides merged over DEFAULT_SETTINGS
 * @param {object}   [options.extensions] extra PGlite extensions
 * @param {Function} [options.loadSql]   `(name) => Promise<string>`, used by `runFile`
 * @param {Function} [options.onEntry]   called with every captured server log entry
 * @param {Function} [options.onProgress] called with `(phase, detail)` during startup
 * @param {boolean}  [options.measureWaits] measure the I/O waits of every statement
 */
export async function createTestbed(options = {}) {
  const {
    dataDir,
    settings = {},
    extensions = {},
    loadSql,
    onEntry,
    onProgress = () => {},
    measureWaits = false,
  } = options;

  const log = new PgLog({ onEntry }).install();
  const effective = { ...DEFAULT_SETTINGS, ...settings };

  onProgress('starting', 'booting PGlite');
  const { result: pg } = await log.capture(async () => {
    const instance = new PGlite({
      dataDir,
      // Required: PGlite only forwards the backend's stderr -- and with it the
      // auto_explain plans -- to the console while debug is enabled.
      debug: 1,
      extensions: { auto_explain, pg_stat_statements, ...extensions },
    });
    await instance.waitReady;
    return instance;
  });

  wrapMethods(pg, log);

  onProgress('extensions', 'auto_explain + pg_stat_statements');
  await pg.exec("LOAD 'auto_explain';");
  await pg.exec('CREATE EXTENSION IF NOT EXISTS pg_stat_statements;');

  const applied = {};
  const skipped = [];
  for (const [name, value] of Object.entries(effective)) {
    if (value === undefined || value === null) continue;
    try {
      await pg.exec(`SET ${name} = ${quoteGuc(value)};`);
      applied[name] = value;
    } catch (error) {
      skipped.push({ name, value, message: error.message });
    }
  }
  onProgress('settings', applied);

  // Reading pg_stat_io touches catalogs; warm them once so the measurement
  // itself does not report I/O waits of its own.
  await ioSnapshot(pg);
  await ioSnapshot(pg);

  let waitsEnabled = Boolean(measureWaits);
  let inTransactionBlock = false;
  const recordedWaits = [];

  const testbed = {
    pg,
    log,
    settings: applied,
    skippedSettings: skipped,

    /** Version banner of the embedded server. */
    async version() {
      const { rows } = await pg.query('SELECT version() AS version');
      return rows[0].version;
    },

    /**
     * Run one statement and return its result plus the plans it produced.
     *
     * @param {string} sql
     * @param {object} [options]
     * @param {unknown[]} [options.params] run it as a prepared query
     * @param {boolean}   [options.waits]  measure the I/O waits it caused
     */
    async run(sql, { params, waits = waitsEnabled } = {}) {
      // Taken before the statement so the snapshot query's own I/O, which
      // lands after it, cannot leak into the measured window.
      const before = waits ? await ioSnapshot(pg) : undefined;
      const started = now();
      let outcome;
      try {
        const { result, entries } = await log.capture(() =>
          params ? pg.query(sql, params) : pg.exec(sql),
        );
        const results = Array.isArray(result) ? result : [result];
        outcome = { sql, results, entries, plans: plansOf(entries), elapsedMs: now() - started };
      } catch (error) {
        const entries = error.pgLogEntries ?? [];
        outcome = { sql, results: [], entries, plans: plansOf(entries), elapsedMs: now() - started, error };
      }
      const wasInBlock = inTransactionBlock;
      inTransactionBlock = nextTransactionState(sql, inTransactionBlock);

      if (before) {
        outcome.io = ioDelta(before, await ioSnapshot(pg));
        // A backend flushes its statistics when a transaction ends, so inside
        // an explicit block everything shows up on the COMMIT instead.
        outcome.io.deferred = wasInBlock && inTransactionBlock;
        outcome.waits = outcome.io.waits;
        recordedWaits.push(...outcome.waits);
      }
      return outcome;
    },

    /** Query `pg_wait_events`: every wait event the server knows, described. */
    waitEvents: (options) => waitEventCatalog(pg, options),

    /** How many wait events the server knows, per type. */
    waitEventTypes: () => waitEventTypes(pg),

    /** `pg_stat_activity` as this backend sees itself. */
    activity: () => currentActivity(pg),

    /** Turn the per statement wait measurement on or off for later runs. */
    measureWaits(enabled = true) {
      waitsEnabled = enabled;
      return waitsEnabled;
    },

    /** Everything measured so far, aggregated by wait event and described. */
    waitProfile: () => describeWaits(pg, waitProfile(recordedWaits)),

    /** The raw wait rows recorded so far. */
    get recordedWaits() {
      return recordedWaits;
    },

    /**
     * Run a SQL script. `split` (default true) executes it statement by
     * statement so each plan and each `pg_stat_statements` row can be tied to
     * a single statement; without it the script goes over in one `exec`.
     */
    async runScript(sql, { split = true, stopOnError = false, onStatement } = {}) {
      const statements = split ? splitSql(sql) : [sql.trim()].filter(Boolean);
      const outcomes = [];
      for (const statement of statements) {
        const outcome = await testbed.run(statement);
        outcomes.push(outcome);
        if (onStatement) onStatement(outcome, outcomes.length, statements.length);
        if (outcome.error && stopOnError) break;
      }
      return outcomes;
    },

    /** Load a SQL file through the bed's `loadSql` and run it. */
    async runFile(name, scriptOptions) {
      if (!loadSql) throw new Error('createTestbed() was called without a loadSql function');
      onProgress('sql-file', name);
      const sql = await loadSql(name);
      return { name, outcomes: await testbed.runScript(sql, scriptOptions) };
    },

    /** Load the SQL files a bed was started with, in order. */
    async runFiles(names, scriptOptions) {
      const loaded = [];
      for (const name of names) {
        loaded.push(await testbed.runFile(name, scriptOptions));
      }
      return loaded;
    },

    /** Top entries from pg_stat_statements. */
    async topStatements({ limit = 10, orderBy = 'total_exec_time', includeUtility = true } = {}) {
      const column = STAT_ORDERS[orderBy] ?? STAT_ORDERS.total_exec_time;
      const { rows } = await pg.query(
        `SELECT calls,
                round(total_exec_time::numeric, 3)  AS total_ms,
                round(mean_exec_time::numeric, 3)   AS mean_ms,
                round(max_exec_time::numeric, 3)    AS max_ms,
                round(stddev_exec_time::numeric, 3) AS stddev_ms,
                rows,
                shared_blks_hit  AS blks_hit,
                shared_blks_read AS blks_read,
                CASE WHEN toplevel THEN 'top' ELSE 'nested' END AS level,
                query
           FROM pg_stat_statements
          WHERE queryid IS NOT NULL
            AND query NOT ILIKE ALL (ARRAY['%pg_stat_statements%', '%pg_stat_io%', '%pg_stat_force_next_flush%'])
            AND ($1 OR query !~* '^[[:space:]]*(set|show|load|begin|commit|rollback)[[:>:]]')
          ORDER BY ${column} DESC NULLS LAST
          LIMIT $2`,
        [includeUtility, limit],
      );
      return rows;
    },

    /** Forget every statistic collected so far. */
    async resetStats() {
      await pg.query('SELECT pg_stat_statements_reset()');
      log.clear();
      recordedWaits.length = 0;
    },

    /** Change auto_explain / pg_stat_statements settings at runtime. */
    async applySettings(next) {
      for (const [name, value] of Object.entries(next)) {
        await pg.exec(`SET ${name} = ${quoteGuc(value)};`);
        testbed.settings[name] = value;
      }
      return testbed.settings;
    },

    async close() {
      await log.capture(() => pg.close());
      log.uninstall();
    },
  };

  return testbed;
}

/** Queries the bed runs to report on itself, which no report should list. */
const BOOKKEEPING = /pg_stat_statements|pg_stat_io|pg_stat_force_next_flush|pg_wait_events|pg_stat_activity/i;

/**
 * The plans auto_explain logged, most expensive first. The bed's own
 * bookkeeping queries are dropped.
 */
export function slowestPlans(entries, limit = 10) {
  return entries
    .filter((entry) => entry.kind === 'plan' && !BOOKKEEPING.test(entry.queryText ?? ''))
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, limit)
    .map((entry) => ({ ms: entry.durationMs, query: summarize(entry.queryText ?? '', 80) }));
}

const BLOCK_START = /^\s*(begin|start\s+transaction)\b/i;
const BLOCK_END = /^\s*(commit|end|rollback|abort)\b/i;

/** Track BEGIN/COMMIT so waits can say when they are deferred to the COMMIT. */
function nextTransactionState(sql, open) {
  const statement = stripComments(sql);
  if (BLOCK_START.test(statement)) return true;
  if (BLOCK_END.test(statement)) return false;
  return open;
}

const STAT_ORDERS = {
  total_exec_time: 'total_exec_time',
  total: 'total_exec_time',
  mean_exec_time: 'mean_exec_time',
  mean: 'mean_exec_time',
  max_exec_time: 'max_exec_time',
  max: 'max_exec_time',
  calls: 'calls',
  rows: 'rows',
};

/**
 * Route every database call through the log capture, so plans triggered by
 * code we do not own -- the REPL component, for instance -- are collected too.
 */
function wrapMethods(pg, log) {
  for (const name of WRAPPED_METHODS) {
    const original = pg[name];
    if (typeof original !== 'function') continue;
    pg[name] = (...args) => log.capture(() => original.apply(pg, args)).then((r) => r.result);
  }
}

function quoteGuc(value) {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  const text = String(value);
  if (/^-?\d+(\.\d+)?$/.test(text)) return text;
  if (/^(on|off|true|false)$/i.test(text)) return text.toLowerCase();
  return `'${text.replace(/'/g, "''")}'`;
}

const now = () =>
  typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
