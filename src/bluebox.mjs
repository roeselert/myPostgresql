/**
 * Loading the Bluebox sample schema into the test bed.
 *
 * Bluebox (https://github.com/ryanbooz/bluebox, MIT, Copyright (c) Ryan Booz)
 * is a Pagila-derived DVD rental database built to keep generating data
 * through pg_cron. Two things about it do not survive the trip into PGlite,
 * and both are handled here rather than hidden:
 *
 *   * It needs PostGIS. sql/bluebox-pglite-shim.sql provides the small part
 *     of it Bluebox actually uses; tools/build-bluebox.mjs lists every edit
 *     made to the upstream dump.
 *   * It needs pg_cron. sql/bluebox-jobs.sql defines the jobs and the run
 *     log, and src/job-runner.mjs drives the schedule from the browser.
 *
 * The upstream data set is an 89 MB dump, so sql/bluebox-demo-data.sql
 * generates a catalog of the same shape instead.
 */

/** In load order. Each is loaded through the bed's `loadSql`. */
export const BLUEBOX_FILES = [
  { name: 'sql/bluebox-pglite-shim.sql', label: 'PostGIS stand-in' },
  { name: 'sql/bluebox-schema.sql', label: 'Bluebox schema' },
  { name: 'sql/bluebox-jobs.sql', label: 'job schedule and run log' },
  { name: 'sql/bluebox-demo-data.sql', label: 'demo catalog' },
];

/**
 * @param {object}   testbed                from createTestbed()
 * @param {object}   [options]
 * @param {number}   [options.historyDays]  days of rental history to generate, 0 for none
 * @param {Function} [options.onProgress]   called with `(label, detail)`
 */
export async function loadBluebox(testbed, { historyDays = 30, onProgress = () => {} } = {}) {
  // ~190 statements of DDL, each of which would log a plan. Nobody wants to
  // read the plan of a foreign key validation, so keep the load quiet and put
  // the bed's own setting back when it is done.
  const explainWas = testbed.settings['auto_explain.log_min_duration'];
  await testbed.applySettings({ 'auto_explain.log_min_duration': -1 });
  try {
    return await loadFiles(testbed, historyDays, onProgress);
  } finally {
    await testbed.applySettings({ 'auto_explain.log_min_duration': explainWas ?? -1 });
  }
}

async function loadFiles(testbed, historyDays, onProgress) {
  const loaded = [];

  for (const file of BLUEBOX_FILES) {
    onProgress('loading', file.label);
    const started = Date.now();
    const { outcomes } = await testbed.runFile(file.name, { split: true });
    const failures = outcomes.filter((outcome) => outcome.error);
    loaded.push({
      ...file,
      statements: outcomes.length,
      failures: failures.map((outcome) => ({ sql: outcome.sql, message: outcome.error.message })),
      elapsedMs: Date.now() - started,
    });
    onProgress('loaded', loaded[loaded.length - 1]);
    if (failures.length) throw new BlueboxLoadError(file, failures);
  }

  if (historyDays > 0) {
    onProgress('history', historyDays);
    const outcome = await testbed.run(
      `CALL bluebox.generate_rental_history((CURRENT_DATE - ${Number(historyDays)})::date, (CURRENT_DATE - 1)::date)`,
    );
    if (outcome.error) throw outcome.error;
  }

  const summary = await blueboxSummary(testbed.pg);
  onProgress('ready', summary);
  return { loaded, summary };
}

export class BlueboxLoadError extends Error {
  constructor(file, failures) {
    super(`${file.label} (${file.name}): ${failures.length} statement(s) failed — ${failures[0].message}`);
    this.name = 'BlueboxLoadError';
    this.file = file;
    this.failures = failures;
  }
}

/** Row counts for the tables that say whether the bed is usable. */
export async function blueboxSummary(pg) {
  const { rows } = await pg.query(`
    SELECT 'store'     AS entity, count(*) AS rows FROM bluebox.store
    UNION ALL SELECT 'film',      count(*) FROM bluebox.film
    UNION ALL SELECT 'inventory', count(*) FROM bluebox.inventory
    UNION ALL SELECT 'customer',  count(*) FROM bluebox.customer
    UNION ALL SELECT 'rental',    count(*) FROM bluebox.rental
    UNION ALL SELECT 'payment',   count(*) FROM bluebox.payment
    UNION ALL SELECT 'job',       count(*) FROM job.job
    ORDER BY 1`);
  return rows;
}

/** Whether a bed already carries the schema. */
export async function isBlueboxLoaded(pg) {
  const { rows } = await pg.query(
    "SELECT to_regclass('bluebox.rental') IS NOT NULL AS loaded",
  );
  return rows[0].loaded;
}

/** Queries worth having in the REPL history once Bluebox is there. */
export const BLUEBOX_HISTORY = [
  'SELECT * FROM job.status;',
  'SELECT * FROM job.recent_runs LIMIT 20;',
  "SELECT * FROM bluebox.get_film_availability(3) ORDER BY copies_available LIMIT 10;",
  'SELECT * FROM bluebox.get_overdue_rentals();',
  `SELECT s.store_id, count(*) AS customers_within_10km
     FROM bluebox.store s
     JOIN bluebox.customer c ON ST_DWithin(s.geog, c.geog, 10000)
    GROUP BY s.store_id ORDER BY 1;`,
];
