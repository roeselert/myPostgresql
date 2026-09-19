import assert from 'node:assert/strict';
import test from 'node:test';

import { splitSql, stripComments, summarize } from '../src/sql-split.mjs';
import { createTestbed, slowestPlans } from '../src/testbed.mjs';

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
