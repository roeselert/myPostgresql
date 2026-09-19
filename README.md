# PostgreSQL test beds

Two test beds around [PGlite](https://pglite.dev) (PostgreSQL 18 compiled to
WASM) for trying out the diagnostics from [`CheatSheet.md`](CheatSheet.md)
without installing a server:

| bed | entry point | what it is for |
| --- | --- | --- |
| batch | `batch.mjs` (Node) | run SQL files start to finish, print every plan, end with a `pg_stat_statements` report |
| REPL  | `index.html` (browser) | same database, interactive, plans appear next to the statements you type |

Both drive the same core in [`src/`](src) — the extensions, the settings, the
log capture, the statement splitter and the output formatting are shared; only
the two shells differ (CLI flags and `fs` vs. query string and `fetch`).

```
src/testbed.mjs    the bed: PGlite + extensions + settings + run/report helpers
src/pg-log.mjs     captures the server log out of PGlite, parses auto_explain plans
src/sql-split.mjs  splits a SQL script into single statements
src/format.mjs     tables, plans and reports as plain text
```

## What is enabled

* **`pg_stat_statements`** — preloaded by PGlite, `CREATE EXTENSION` run at
  start up, `track = all` so nested statements are counted too.
* **`auto_explain`** — `LOAD`ed into the session with `log_min_duration = 0`,
  `log_analyze`, `log_buffers`, `log_timing`, `log_triggers`, `log_wal` and
  `log_nested_statements` on, so every statement logs an analyzed plan.

Both are switchable at run time (`--min-duration`, `--track`, `?min_duration=`,
`testbed.applySettings({...})`).

Two things are worth knowing about how this works inside PGlite:

* `auto_explain` is session loaded rather than put into
  `shared_preload_libraries` — PGlite fails to boot with it preloaded, and as
  PGlite serves a single backend the session load covers everything.
* PGlite only forwards the backend's stderr to the console while its `debug`
  option is on, and that option also turns on DEBUG1 logging. The bed therefore
  starts with `debug: 1` and then sets `log_min_messages = 'warning'`: `LOG`
  outranks `WARNING` in `log_min_messages`, so the plans survive while the
  debug chatter does not.

## Batch bed

```bash
npm install
npm start                          # runs user.sql
node batch.mjs train.sql user.sql  # runs both, in order
node batch.mjs --sql "SELECT 1" --top 20 --order mean
SQL_FILES="train.sql user.sql" node batch.mjs
```

Each statement is reported with its result rows and its plan, followed by the
`pg_stat_statements` report and the slowest single executions:

```
[4/5] SELECT id, username, email FROM users ORDER BY id LIMIT 3   (1.6 ms)
  ┌────┬──────────┬───────────────────┐
  │ id │ username │ email             │
  ├────┼──────────┼───────────────────┤
  │ 1  │ user1    │ user1@example.com │
  └────┴──────────┴───────────────────┘
  plan (0.153 ms):
  Limit  (cost=0.14..2.24 rows=3 width=869) (actual time=0.085..0.092 rows=3.00 loops=1)
    Buffers: shared hit=2
    ->  Index Scan using users_pkey on users  (cost=0.14..49.19 rows=70 width=869) …
```

Options — `node batch.mjs --help`:

| flag | meaning |
| --- | --- |
| `--file <path>` | SQL file to run on start up (repeatable; bare arguments work too) |
| `--sql <statement>` | ad hoc statement after the files (repeatable) |
| `--no-split` | send each file as one batch instead of statement by statement |
| `--stop-on-error` | abort a file after the first failing statement |
| `--no-plans` | do not print the plans |
| `--min-duration <ms>` | `auto_explain.log_min_duration`, `-1` disables |
| `--no-analyze` | plan only, no execution statistics |
| `--format <fmt>` | `auto_explain.log_format`: text, json, yaml, xml |
| `--track <mode>` | `pg_stat_statements.track`: all, top, none |
| `--top <n>` / `--order <col>` | size and order of the report (`total`, `mean`, `max`, `calls`, `rows`) |
| `--rows <n>` | result rows printed per statement |
| `--data-dir <path>` | keep the cluster on disk instead of in memory |
| `--out <path>` | also write everything to a file |
| `--quiet` | only print the final report |

Files can also come from the `SQL_FILES` environment variable (space or comma
separated), which is what the *Run Batch Test Bed* workflow uses.

## REPL bed

```bash
npm run repl     # serves the repo on http://localhost:8080
```

Then open `http://localhost:8080/index.html`. The page needs to be served over
HTTP — `file://` does not work with modules and WASM.

Start up files come from the query string, everything else is a button:

```
index.html?file=user.sql
index.html?file=train.sql&file=user.sql
index.html?files=train.sql,user.sql
index.html?file=https://example.org/schema.sql
```

Further parameters: `min_duration`, `analyze`, `format`, `track`, `split`,
`top`. Statements typed into the REPL run through the same capture, so their
plans land in the panel on the right; *Top statements* and *Slowest plans*
render the same reports the batch bed prints.

The browser clamps timer resolution unless the page is cross-origin isolated,
so `actual time` in the REPL is coarse (multiples of ~0.1 ms). Use the batch
bed when the numbers matter.

## Using the bed from your own script

```js
import { createTestbed } from './src/testbed.mjs';
import fs from 'node:fs/promises';

const testbed = await createTestbed({ loadSql: (name) => fs.readFile(name, 'utf-8') });
await testbed.runFile('train.sql');

const { plans, results } = await testbed.run('SELECT * FROM journey_view');
console.log(plans[0].durationMs, plans[0].plan);
console.log(await testbed.topStatements({ limit: 5, orderBy: 'mean' }));

await testbed.close();
```

## Tests

```bash
npm test
```

Covers the statement splitter and, against a real PGlite instance, that
`auto_explain` produces analyzed plans, that `pg_stat_statements` records the
statements, and that the settings can be changed at run time.

## SQL files in this repo

* `user.sql` — a `users` table with 20 rows and two example queries.
* `train.sql` — trains, stations and journeys with a joining view, foreign keys
  and indexes; the more interesting plans come from this one.
