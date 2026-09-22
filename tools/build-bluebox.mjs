#!/usr/bin/env node
/**
 * Regenerate sql/bluebox-schema.sql from the upstream Bluebox dump.
 *
 *   node tools/build-bluebox.mjs [path-to-bluebox-checkout]
 *
 * Bluebox (https://github.com/ryanbooz/bluebox, MIT) targets a PostgreSQL
 * server with PostGIS. PGlite has no PostGIS, and the dump also carries two
 * defects that make three of its routines uncallable. This script applies a
 * short, explicit list of edits -- each one below -- so the result loads and
 * runs under PGlite, and records what it changed in the generated file's
 * header. Nothing else in the dump is touched.
 *
 * Without a checkout path it clones the upstream repository into a temporary
 * directory.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const UPSTREAM = 'https://github.com/ryanbooz/bluebox';
const SOURCE_FILE = 'bluebox_schema.sql';
const OUTPUT = 'sql/bluebox-schema.sql';

/**
 * Each edit is a named, self-contained rewrite. `required` edits fail the
 * build when they do not match, so an upstream change cannot slip through as
 * a silently unpatched schema.
 */
const EDITS = [
  {
    name: 'postgis-extension',
    why: 'PGlite has no PostGIS; sql/bluebox-pglite-shim.sql stands in for it.',
    apply: (sql) =>
      sql.replace(
        /^CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public;$/m,
        '-- [pglite] CREATE EXTENSION postgis -- replaced by sql/bluebox-pglite-shim.sql',
      ),
  },
  {
    name: 'postgis-comment',
    why: 'The COMMENT would fail without the extension.',
    apply: (sql) => sql.replace(/^COMMENT ON EXTENSION postgis IS .*$/m, ''),
  },
  {
    name: 'topology-schema',
    why: 'The topology schema belongs to PostGIS and stays empty otherwise.',
    apply: (sql) =>
      sql
        .replace(/^CREATE SCHEMA topology;$/m, '-- [pglite] CREATE SCHEMA topology -- PostGIS only')
        .replace(/^COMMENT ON SCHEMA topology IS .*$/m, ''),
  },
  {
    name: 'geography-typmod',
    why: 'The shim types geography as a domain over point, and domains take no type modifier.',
    apply: (sql) => sql.split('public.geography(Point,4326)').join('public.geography'),
  },
  {
    name: 'pg_stat_statements',
    why: 'The test bed installs it at start up, before this file is loaded.',
    apply: (sql) =>
      sql
        .replace(
          /^CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA public;$/m,
          '-- [pglite] CREATE EXTENSION pg_stat_statements -- already installed by the test bed',
        )
        .replace(/^COMMENT ON EXTENSION pg_stat_statements IS .*$/m, ''),
  },
  {
    name: 'film-replacement-cost',
    why:
      'Upstream bug: get_overdue_rentals() and process_lost_inventory() still read film.replacement_cost, '
      + 'a column that was replaced by bluebox.get_replacement_cost(). Both routines error out as shipped. '
      + 'Both uses sit in a select list, so the call keeps the column name through the alias.',
    apply: (sql) =>
      sql.split('f.replacement_cost').join('bluebox.get_replacement_cost(f.film_id) AS replacement_cost'),
  },
  {
    name: 'duplicate-process-lost-rentals',
    why:
      'Upstream bug: two overloads of process_lost_rentals() are both callable with no arguments, '
      + 'so CALL bluebox.process_lost_rentals() fails as "not unique". The two-argument one is the '
      + 'older of the pair -- the procedure comment documents the three-argument version -- so it goes.',
    apply: (sql) =>
      cutComment(
        cutRoutine(
          sql,
          "CREATE PROCEDURE bluebox.process_lost_rentals(IN p_lost_after interval DEFAULT '30 days'::interval, IN p_print_debug boolean DEFAULT false)",
        ),
        'COMMENT ON PROCEDURE bluebox.process_lost_rentals(IN p_lost_after interval, IN p_print_debug boolean)',
      ),
  },
];

/**
 * The dump's two session settings outlive it, because PGlite is one long
 * lived session rather than a psql run that ends.
 */
const FOOTER = `

--
-- [pglite] The dump sets search_path to '' for its own safety. Put it back,
-- or every unqualified name in the REPL afterwards fails to resolve.
--

SELECT pg_catalog.set_config('search_path', 'bluebox, public', false);

--
-- [pglite] Likewise client_min_messages: left at warning, the RAISE NOTICE
-- output of Bluebox's procedures never reaches the client, so the jobs would
-- have nothing to report.
--

SET client_min_messages = notice;
`;

async function main() {
  const checkout = process.argv[2] ?? (await cloneUpstream());
  const source = path.join(checkout, SOURCE_FILE);
  const original = await fs.readFile(source, 'utf-8');
  const revision = await gitRevision(checkout);

  let sql = original;
  const applied = [];
  for (const edit of EDITS) {
    const next = edit.apply(sql);
    if (next === sql) throw new Error(`edit "${edit.name}" matched nothing — has ${SOURCE_FILE} changed?`);
    sql = next;
    applied.push(edit);
  }

  const header = [
    '--',
    '-- Bluebox schema, prepared for PGlite.',
    '--',
    `-- Generated by tools/build-bluebox.mjs from ${UPSTREAM}`,
    `-- at ${revision}, file ${SOURCE_FILE}. Bluebox is MIT licensed,`,
    '-- Copyright (c) Ryan Booz. Do not edit this file by hand: change the',
    '-- build script and run it again.',
    '--',
    '-- Load sql/bluebox-pglite-shim.sql first; it provides the PostGIS',
    '-- stand-in this file depends on.',
    '--',
    '-- Changes against the upstream dump:',
    '--',
    ...applied.flatMap((edit) => [`--   * ${edit.name}`, ...wrap(edit.why, 68).map((line) => `--     ${line}`)]),
    '--',
    '',
    '',
  ].join('\n');

  await fs.writeFile(OUTPUT, header + sql + FOOTER, 'utf-8');
  console.log(`${OUTPUT}: ${applied.length} edits, ${sql.length} bytes, from ${revision}`);
}

/** Remove one routine definition, from its CREATE line to its closing `$$;`. */
function cutRoutine(sql, signature) {
  const start = sql.indexOf(signature);
  if (start === -1) return sql;
  const end = sql.indexOf('\n$$;', start);
  if (end === -1) return sql;
  const commentStart = sql.lastIndexOf('\n--\n', start);
  return (
    sql.slice(0, commentStart === -1 ? start : commentStart)
    + `\n\n-- [pglite] removed a duplicate overload of process_lost_rentals(); see tools/build-bluebox.mjs\n`
    + sql.slice(end + '\n$$;'.length)
  );
}

/** Remove one COMMENT ON statement, from its first line to the closing `';`. */
function cutComment(sql, prefix) {
  const start = sql.indexOf(prefix);
  if (start === -1) return sql;
  const end = sql.indexOf("\n';", start);
  if (end === -1) return sql;
  const commentStart = sql.lastIndexOf('\n--\n', start);
  return sql.slice(0, commentStart === -1 ? start : commentStart) + sql.slice(end + "\n';".length);
}

async function cloneUpstream() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bluebox-'));
  console.log(`cloning ${UPSTREAM} into ${directory}`);
  await run('git', ['clone', '--depth', '1', UPSTREAM, directory]);
  return directory;
}

async function gitRevision(checkout) {
  try {
    const { stdout } = await run('git', ['-C', checkout, 'log', '-1', '--format=%H (%cs)']);
    return stdout.trim();
  } catch {
    return 'an unknown revision';
  }
}

function wrap(text, width) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
