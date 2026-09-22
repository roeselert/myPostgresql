import assert from 'node:assert/strict';
import test from 'node:test';

import { splitSql, stripComments, summarize } from '../src/sql-split.mjs';
import { createTestbed, knownIoWaitEvents, slowestPlans } from '../src/testbed.mjs';

test('splitSql keeps semicolons inside strings, comments and dollar quotes together', () => {
  assert.deepEqual(splitSql('SELECT 1; SELECT 2'), ['SELECT 1', 'SELECT 2']);
  assert.deepEqual(splitSql("SELECT ';'"), ["SELECT ';'"]);
  assert.deepEqual(splitSql('SELECT "a;b" FROM t'), ['SELECT "a;b" FROM t']);
  assert.deepEqual(splitSql("SELECT E'\\';'"), ["SELECT E'\\';'"]);
  assert.deepEqual(splitSql('SELECT 1; -- x; y\nSELECT 2'), ['SELECT 1', '-- x; y\nSELECT 2']);
  assert.deepEqual(splitSql('SELECT 1 /* a; /* b; */ c; */ ; SELECT 2').length, 2);
  assert.deepEqual(
    splitSql("CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql; SELECT f()").length,
    2,
  );
});

test('splitSql drops fragments that are only comments', () => {
  assert.deepEqual(splitSql('-- just a comment\n'), []);
  assert.deepEqual(splitSql('SELECT 1;\n-- trailing\n'), ['SELECT 1']);
});

test('stripComments and summarize', () => {
  assert.equal(stripComments('SELECT 1 -- note').trim(), 'SELECT 1');
  assert.equal(summarize('-- note\nSELECT   1\n  FROM t'), 'SELECT 1 FROM t');
  assert.equal(summarize('SELECT abcdef', 6), 'SELEC…');
});

test('the test bed captures plans and statistics', async (t) => {
  const testbed = await createTestbed({ loadSql: async () => 'SELECT 1 AS one; SELECT 2 AS two;' });
  t.after(() => testbed.close());

  assert.match(await testbed.version(), /PostgreSQL/);
  assert.equal(testbed.skippedSettings.length, 0, JSON.stringify(testbed.skippedSettings));
  assert.equal(testbed.settings['auto_explain.log_min_duration'], 0);
  assert.equal(testbed.settings['pg_stat_statements.track'], 'all');

  await testbed.resetStats();

  const outcome = await testbed.run('SELECT count(*) FROM generate_series(1, 1000)');
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.results[0].rows[0].count, 1000);
  assert.equal(outcome.plans.length, 1, 'auto_explain should log exactly one plan');
  assert.match(outcome.plans[0].plan, /Aggregate/);
  assert.match(outcome.plans[0].plan, /actual time=/, 'log_analyze should be on');
  assert.match(outcome.plans[0].queryText, /^SELECT count\(\*\)/);

  const failed = await testbed.run('SELECT * FROM does_not_exist');
  assert.match(failed.error.message, /does_not_exist/);

  const { outcomes } = await testbed.runFile('inline.sql');
  assert.equal(outcomes.length, 2);
  assert.equal(outcomes[1].results[0].rows[0].two, 2);

  const top = await testbed.topStatements({ limit: 20 });
  assert.ok(top.some((row) => /generate_series/.test(row.query)), 'pg_stat_statements should track the query');
  assert.ok(top.every((row) => !/pg_stat_statements/.test(row.query)), 'the report must not report on itself');

  assert.ok(slowestPlans(testbed.log.entries, 5).length > 0);
});

test('auto_explain settings can be changed at runtime', async (t) => {
  const testbed = await createTestbed({ settings: { 'auto_explain.log_min_duration': -1 } });
  t.after(() => testbed.close());

  assert.equal((await testbed.run('SELECT 1')).plans.length, 0, 'disabled auto_explain logs nothing');
  await testbed.applySettings({ 'auto_explain.log_min_duration': 0 });
  assert.equal((await testbed.run('SELECT 1')).plans.length, 1);
});

test('every mapped IO wait event exists in pg_wait_events', async (t) => {
  const testbed = await createTestbed();
  t.after(() => testbed.close());

  const names = knownIoWaitEvents();
  assert.ok(names.length >= 10);
  const { rows } = await testbed.pg.query('SELECT name FROM pg_wait_events WHERE name = ANY($1)', [names]);
  const found = new Set(rows.map((row) => row.name));
  assert.deepEqual(names.filter((name) => !found.has(name)), [], 'mapping must not invent wait event names');
});

test('the wait event catalog can be searched', async (t) => {
  const testbed = await createTestbed();
  t.after(() => testbed.close());

  const [match] = await testbed.waitEvents({ search: 'BufferMapping' });
  assert.equal(match.type, 'LWLock');
  assert.match(match.description, /buffer pool/);

  const locks = await testbed.waitEvents({ type: 'Lock', limit: 100 });
  assert.ok(locks.length > 5);
  assert.ok(locks.every((row) => row.type === 'Lock'));

  const types = await testbed.waitEventTypes();
  assert.ok(types.some((row) => row.type === 'IO' && row.events > 0));
});

test('IO waits are measured per statement', async (t) => {
  const testbed = await createTestbed({ measureWaits: true, settings: { 'auto_explain.log_min_duration': -1 } });
  t.after(() => testbed.close());

  assert.deepEqual((await testbed.run('SELECT 1')).io.waits, [], 'a trivial statement must not pick up noise');

  const built = await testbed.run(
    "CREATE TABLE wide AS SELECT g AS id, repeat('x', 200) AS pad FROM generate_series(1, 60000) g",
  );
  assert.ok(built.io.waits.length > 0, 'writing 60k rows has to wait on I/O somewhere');
  assert.ok(built.io.waits.some((wait) => wait.waitEvent === 'DataFileExtend'));
  assert.ok(built.io.totalMs > 0);
  assert.ok(built.io.waits.every((wait) => wait.type === 'IO' && wait.count > 0));

  const profile = await testbed.waitProfile();
  assert.ok(profile.length > 0);
  assert.ok(profile.every((row) => row.description.length > 0), 'every wait needs its catalog description');
  assert.ok(profile[0].timeMs >= profile[profile.length - 1].timeMs, 'sorted by time');
});

test('waits inside a transaction block are reported as deferred', async (t) => {
  const testbed = await createTestbed({ measureWaits: true, settings: { 'auto_explain.log_min_duration': -1 } });
  t.after(() => testbed.close());

  await testbed.run('BEGIN');
  const inside = await testbed.run('CREATE TABLE t AS SELECT g FROM generate_series(1, 40000) g');
  assert.equal(inside.io.deferred, true);
  assert.deepEqual(inside.io.waits, []);

  const commit = await testbed.run('COMMIT');
  assert.equal(commit.io.deferred, false);
  assert.ok(commit.io.waits.length > 0, 'the block flushes its I/O on COMMIT');
});

test('pg_stat_activity is reachable', async (t) => {
  const testbed = await createTestbed();
  t.after(() => testbed.close());

  const [self] = await testbed.activity();
  assert.equal(self.state, 'active');
  assert.match(self.query, /pg_stat_activity/);
});

test('auto_explain can be switched off and back on to its threshold', async (t) => {
  const testbed = await createTestbed({ settings: { 'auto_explain.log_min_duration': 25 } });
  t.after(() => testbed.close());

  assert.equal(testbed.settings['auto_explain.log_min_duration'], 25);
  assert.equal((await testbed.run('SELECT 1')).plans.length, 0, '1 ms is under the 25 ms threshold');

  await testbed.applySettings({ 'auto_explain.log_min_duration': -1 });
  assert.equal((await testbed.run('SELECT pg_sleep(0.05)')).plans.length, 0, 'switched off logs nothing');

  await testbed.applySettings({ 'auto_explain.log_min_duration': 25 });
  assert.equal(testbed.settings['auto_explain.log_min_duration'], 25);
  assert.equal((await testbed.run('SELECT pg_sleep(0.05)')).plans.length, 1, 'the threshold came back');
});
