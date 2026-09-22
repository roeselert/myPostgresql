import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { blueboxSummary, isBlueboxLoaded, loadBluebox } from '../src/bluebox.mjs';
import { createJobRunner } from '../src/job-runner.mjs';
import { createTestbed } from '../src/testbed.mjs';
import { ioWaitEvent } from '../src/wait-events.mjs';

const loadSql = (name) => fs.readFile(path.resolve(process.cwd(), name), 'utf-8');

/** One bed for the whole file: loading Bluebox takes about a second. */
async function blueboxBed() {
  const testbed = await createTestbed({
    loadSql,
    // The schema load is the subject here, not its plans.
    settings: { 'auto_explain.log_min_duration': -1 },
  });
  await loadBluebox(testbed, { historyDays: 30 });
  return testbed;
}

test('the Bluebox schema loads and its procedures run', async (t) => {
  const testbed = await blueboxBed();
  t.after(() => testbed.close());

  assert.equal(await isBlueboxLoaded(testbed.pg), true);

  const summary = Object.fromEntries(
    (await blueboxSummary(testbed.pg)).map((row) => [row.entity, Number(row.rows)]),
  );
  assert.equal(summary.store, 5);
  assert.equal(summary.film, 240);
  assert.equal(summary.customer, 900);
  assert.ok(summary.inventory > 500);
  assert.ok(summary.rental > 100, 'generate_rental_history should have produced rentals');
  assert.ok(summary.payment > 100);

  // The PostGIS stand-in: same call sites, metres, roughly the right answer.
  const { rows } = await testbed.pg.query(
    'SELECT round(ST_Distance(a.geog, b.geog)::numeric) AS metres, ST_DWithin(a.geog, b.geog, 25000) AS near'
    + ' FROM bluebox.store a, bluebox.store b WHERE a.store_id = 1 AND b.store_id = 2',
  );
  assert.ok(Number(rows[0].metres) > 5000 && Number(rows[0].metres) < 10000, `got ${rows[0].metres} m`);
  assert.equal(rows[0].near, true);

  // The routines the jobs depend on, plus the two the build step repairs.
  for (const sql of [
    "CALL bluebox.generate_rentals(now() - interval '1 hour', now())",
    'CALL bluebox.complete_rentals()',
    'CALL bluebox.insert_payments(CURRENT_DATE)',
    'CALL bluebox.update_customer_activity()',
    'CALL bluebox.process_lost_rentals()',
    'CALL bluebox.process_lost_inventory()',
    'CALL bluebox.nightly_maintenance()',
    'SELECT count(*) FROM bluebox.get_overdue_rentals()',
    'SELECT count(*) FROM bluebox.get_film_availability(2)',
  ]) {
    const outcome = await testbed.run(sql);
    assert.equal(outcome.error, undefined, `${sql} -> ${outcome.error?.message}`);
  }
});

test('the schema survives a reload and the search_path stays usable', async (t) => {
  const testbed = await createTestbed({ loadSql, settings: { 'auto_explain.log_min_duration': -1 } });
  t.after(() => testbed.close());

  assert.equal(await isBlueboxLoaded(testbed.pg), false);
  await loadBluebox(testbed, { historyDays: 0 });

  // The dump sets search_path to '' and client_min_messages to warning;
  // both have to be back, or the REPL session is unusable afterwards.
  const { rows } = await testbed.pg.query('SHOW search_path');
  assert.match(rows[0].search_path, /bluebox/);
  const notices = await testbed.pg.query('SHOW client_min_messages');
  assert.equal(notices.rows[0].client_min_messages, 'notice');

  const outcome = await testbed.run('SELECT count(*) FROM store');
  assert.equal(outcome.error, undefined, 'unqualified names must resolve');
});

test('jobs run on a schedule and every execution is logged', async (t) => {
  const testbed = await blueboxBed();
  t.after(() => testbed.close());

  const seen = [];
  const runner = createJobRunner(testbed, { tickMs: 100, onRun: (run) => seen.push(run) });

  const jobs = await runner.jobs();
  assert.ok(jobs.length >= 5);
  assert.ok(jobs.every((job) => job.interval_ms >= 250));
  // The two that can take the backend down or rewrite everything stay off.
  const inactive = jobs.filter((job) => !job.active).map((job) => job.jobname).sort();
  assert.deepEqual(inactive, ['nightly-maintenance', 'process-lost-rentals']);

  const run = await runner.runOnce('generate-rentals');
  assert.equal(run.status, 'succeeded', run.message);
  assert.ok(run.durationMs > 0);
  assert.match(run.message, /Created \d+ rentals/, 'the procedure notices should be the log message');

  const { rows } = await testbed.pg.query(
    "SELECT jobname, status, duration_ms, return_message FROM job.run_details WHERE runid = $1",
    [run.runid],
  );
  assert.equal(rows[0].jobname, 'generate-rentals');
  assert.equal(rows[0].status, 'succeeded');
  assert.ok(Number(rows[0].duration_ms) > 0);
  assert.equal(rows[0].return_message, run.message);

  // A due job fires on a tick, an inactive one never does.
  await testbed.pg.query("UPDATE job.job SET interval_ms = 250 WHERE jobname = 'insert-payments'");
  runner.start();
  await new Promise((resolve) => setTimeout(resolve, 900));
  await runner.stop();

  assert.equal(runner.running, false);
  assert.ok(seen.some((r) => r.jobname === 'insert-payments'), 'the scheduled job should have run');
  assert.ok(!seen.some((r) => r.jobname === 'nightly-maintenance'), 'an inactive job must not run');

  const open = await testbed.pg.query("SELECT count(*)::int AS c FROM job.run_details WHERE status = 'running'");
  assert.equal(open.rows[0].c, 0, 'stop() must not leave runs hanging');

  const status = await runner.status();
  const generate = status.find((row) => row.jobname === 'generate-rentals');
  assert.ok(Number(generate.succeeded) >= 1);
  assert.equal(Number(generate.failed), 0);
});

test('a failing job is logged as failed without stopping the schedule', async (t) => {
  const testbed = await blueboxBed();
  t.after(() => testbed.close());

  const runner = createJobRunner(testbed);
  await testbed.pg.query(
    "SELECT job.schedule('broken', 'SELECT * FROM nothing_here', 1000, NULL, 'always fails')",
  );

  const run = await runner.runOnce('broken');
  assert.equal(run.status, 'failed');
  assert.match(run.message, /nothing_here/);

  const { rows } = await testbed.pg.query(
    "SELECT status, return_message FROM job.run_details WHERE jobname = 'broken'",
  );
  assert.equal(rows[0].status, 'failed');
  assert.match(rows[0].return_message, /nothing_here/);

  const [status] = (await runner.status()).filter((row) => row.jobname === 'broken');
  assert.equal(Number(status.failed), 1);
  assert.match(status.last_error, /nothing_here/);
});

test('job.schedule and job.unschedule behave like cron.schedule', async (t) => {
  const testbed = await blueboxBed();
  t.after(() => testbed.close());

  await testbed.pg.query("SELECT job.schedule('temp', 'SELECT 1', 5000, '* * * * *', 'a test')");
  await testbed.pg.query("SELECT job.schedule('temp', 'SELECT 2', 9000, '*/2 * * * *', 'changed')");
  const { rows } = await testbed.pg.query("SELECT command, interval_ms FROM job.job WHERE jobname = 'temp'");
  assert.equal(rows.length, 1, 'scheduling the same name twice updates it');
  assert.equal(rows[0].command, 'SELECT 2');
  assert.equal(Number(rows[0].interval_ms), 9000);

  const runner = createJobRunner(testbed);
  await runner.runOnce('temp');

  const gone = await testbed.pg.query("SELECT job.unschedule('temp') AS gone");
  assert.equal(gone.rows[0].gone, true);
  const kept = await testbed.pg.query("SELECT count(*)::int AS c FROM job.run_details WHERE jobname = 'temp'");
  assert.equal(kept.rows[0].c, 1, 'the run history outlives the job');
});

test('the io wait event mapping covers the objects Bluebox writes', () => {
  assert.equal(ioWaitEvent('relation', 'bulkwrite', 'extend'), 'DataFileExtend');
  assert.equal(ioWaitEvent('wal', 'normal', 'write'), 'WalWrite');
  assert.equal(ioWaitEvent('wal', 'init', 'write'), 'WalInitWrite');
  assert.equal(ioWaitEvent('relation', 'normal', 'nonsense'), undefined);
});
