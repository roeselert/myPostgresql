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
src/wait-events.mjs  the pg_wait_events catalog and per statement I/O waits
src/bluebox.mjs      loading the Bluebox sample schema
src/job-runner.mjs   the pg_cron stand-in that drives its jobs
src/format.mjs     tables, plans and reports as plain text
```

## What is enabled

* **`pg_stat_statements`** — preloaded by PGlite, `CREATE EXTENSION` run at
  start up, `track = all` so nested statements are counted too.
* **`auto_explain`** — `LOAD`ed into the session with `log_min_duration = 0`,
  `log_analyze`, `log_buffers`, `log_timing`, `log_triggers`, `log_wal` and
  `log_nested_statements` on, so every statement logs an analyzed plan.

* **Wait events** — `track_io_timing` and `track_wal_io_timing` on, so the
  `pg_stat_io` counters behind the IO wait events carry real times.
* **pg_trgm** — registered at start up because the Bluebox schema creates it,
  and PGlite can only register extensions when the instance is built. It costs
  nothing until something uses it.

Everything is switchable at run time (`--min-duration`, `--track`,
`?min_duration=`, `testbed.applySettings({...})`).

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
| `--waits` | measure what each statement waited on, and print a wait profile |
| `--wait-events <text>` | look wait events up in `pg_wait_events` and exit (`all` for every one) |
| `--wait-type <type>` | restrict `--wait-events` to IO, Lock, LWLock, IPC, Client, … |
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

## Wait events

Two separate things, because PGlite only supports one of them the way a real
server does.

**The catalog** works exactly as anywhere else — `pg_wait_events` (PostgreSQL
17+) knows every wait event with its description, which is what you want the
moment `pg_stat_activity.wait_event` shows you a name you do not recognise:

```bash
node batch.mjs --wait-events BufferMapping
node batch.mjs --wait-events all --wait-type Lock
```

```
┌────────┬───────────────┬────────────────────────────────────────────────────────────────────┐
│ type   │ name          │ description                                                        │
├────────┼───────────────┼────────────────────────────────────────────────────────────────────┤
│ LWLock │ BufferMapping │ Waiting to associate a data block with a buffer in the buffer pool │
└────────┴───────────────┴────────────────────────────────────────────────────────────────────┘
```

**Observing what a statement waited on** is where PGlite differs. On a real
server you sample `pg_stat_activity` from a second connection; PGlite runs a
single backend on a single thread, so nothing can look at it while it is busy
and a sample would always come back idle. What it *can* give is `pg_stat_io`,
the accumulated form of the IO wait events, diffed across a statement:

```bash
node batch.mjs --waits
```

```
[1/1] CREATE TABLE big AS SELECT g, repeat('x',200) FROM generate_series(1,120000) g   (374.1 ms)
  waits: 194.175 ms over 6 event(s), 3723 buffer hits
    IO:WalInitWrite [init] 2× 97.264 ms 32.0 MB
    IO:DataFileExtend [bulkwrite] 62× 85.766 ms 28.0 MB
    IO:WalWrite [normal] 2866× 8.774 ms 30.4 MB
    IO:DataFileWrite [bulkwrite] 1536× 2.285 ms 12.0 MB
    IO:DataFileRead [normal] 11× 0.085 ms 88.0 kB
    IO:WalInitSync [init] 2× 0.001 ms
```

Half of those 374 ms went into creating and extending files — which is the
kind of thing neither the plan nor `pg_stat_statements` tells you. At the end
comes the profile over the whole run, each row described by `pg_wait_events`:

```
┌───────────────────┬───────────┬───────┬──────────┬─────────┬─────────────────────────────────────────────┐
│ wait_event        │ context   │ count │ total_ms │ bytes   │ description                                 │
├───────────────────┼───────────┼───────┼──────────┼─────────┼─────────────────────────────────────────────┤
│ IO:WalInitWrite   │ init      │ 2     │ 97.264   │ 32.0 MB │ Waiting for a write while initializing a n… │
│ IO:DataFileExtend │ bulkwrite │ 62    │ 85.766   │ 28.0 MB │ Waiting for a relation data file to be ext… │
│ IO:WalWrite       │ normal    │ 2866  │ 8.774    │ 30.4 MB │ Waiting for a write to a WAL file           │
└───────────────────┴───────────┴───────┴──────────┴─────────┴─────────────────────────────────────────────┘
```

Two limits are worth knowing, both inherited from PostgreSQL rather than from
the bed:

* **Only IO waits show up.** `Lock`, `LWLock`, `IPC` and `Client` events need
  more than one backend to happen at all, so they stay empty here. The catalog
  still describes them, which is the point of having it.
* **Inside `BEGIN … COMMIT` the waits land on the `COMMIT`.** A backend flushes
  its statistics when a transaction ends, so per statement attribution is not
  available inside a block — the bed prints `waits: deferred` there instead of
  a misleading zero. (Between statements it forces the flush with
  `pg_stat_force_next_flush()`, which is why `--waits` costs four extra
  queries per statement.)

For a single statement, `auto_explain`'s own `Buffers` and `I/O Timings` lines
carry the same information and cost nothing extra.

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
`top`, `waits`, `bluebox`, `jobs`, `history`. Statements typed into the REPL
run through the same capture, so their plans land in the panel on the right;
*Top statements*, *Slowest plans*, *Wait events* and *Wait profile* render the
same reports the batch bed prints. With `?waits=1` the start up files report
what they waited on, and `?bluebox=1&jobs=1` starts with the Bluebox schema
and its schedule running — see [Bluebox](#bluebox).

The browser clamps timer resolution unless the page is cross-origin isolated,
so `actual time` in the REPL is coarse (multiples of ~0.1 ms). Use the batch
bed when the numbers matter.

## Bluebox

*Load Bluebox schema* puts [Bluebox](https://github.com/ryanbooz/bluebox) — a
Pagila-derived DVD rental database, MIT, Copyright (c) Ryan Booz — into the
bed, so there is a schema worth analyzing rather than five rows of test data.
`?bluebox=1` does it on start up, `&jobs=1` also starts the schedule. It takes
about a second and gives you 25 tables, 13 procedures, 15 functions, a catalog
of 240 films across 5 stores, 900 customers and a month of rental history.

Three things about Bluebox do not survive the trip into PGlite. None of them
is papered over.

### PostGIS

Bluebox needs PostGIS, which PGlite does not have. It uses very little of it:
a `geography(Point,4326)` column on customer, store and zip_code_info,
`ST_DWithin()` to find customers near a store, and one GiST index.
`sql/bluebox-pglite-shim.sql` provides exactly that much — `geography` as a
domain over the built-in `point` type, and `ST_DWithin()` / `ST_Distance()` as
haversine on a sphere, in metres, under the same names — so every call site in
Bluebox resolves to the shim untouched. Distances are within ~0.5% of PostGIS,
far inside the 25 km radius Bluebox uses.

### pg_cron

Bluebox keeps generating data through pg_cron:

```sql
SELECT cron.schedule('complete-rentals', '*/15 * * * *',
                     $$CALL bluebox.complete_rentals()$$);
```

pg_cron is a background worker, and PGlite has none. So the **schedule** lives
in the browser (`src/job-runner.mjs`) while the **jobs and every execution**
live in the database, in a `job` schema laid out like pg_cron's own:

```sql
SELECT * FROM job.status;       -- per job: runs, failures, avg/max ms, last error
SELECT * FROM job.recent_runs;  -- every execution, newest first
SELECT * FROM job.job;          -- what is scheduled, and the cron expression it stands for
```

Each run is written to `job.run_details` as `running`, then updated to
`succeeded` or `failed` with its duration and what the procedure reported —
Bluebox's own `RAISE NOTICE` output, so the log says *"Created 10 rentals"*
rather than *"ok"*. `job.job.interval_ms` is what the browser timer uses;
`pg_cron_schedule` records the cron expression it stands for, so the gap to a
real server stays visible. Intervals are seconds rather than minutes, because
a test bed session should show something happening.

Because PGlite is a single connection, jobs run one at a time and a job blocks
statements typed into the REPL while it runs. The default jobs are all a few
milliseconds.

### Two jobs are off by default

`nightly-maintenance` is heavy and rewrites inventory across stores.

`process-lost-rentals` is off for a harder reason: **writing off a rental that
`generate_rentals()` created in the same session crashes the PGlite backend**
with `ERRORDATA_STACK_SIZE exceeded`, which takes the whole page down with it.
It reproduces in a plain PGlite with no test bed code involved — `CALL
bluebox.generate_rentals(...)` followed by `CALL
bluebox.process_lost_rentals(p_lost_after => interval '10 minutes')` is enough.
A `p_lost_after` long enough to only catch the seeded history (30 days, the
upstream default) does not hit it, which is how the job is configured, and the
job runner stops the schedule on a PANIC or FATAL rather than piling up
failures against a dead backend.

### The data, and what the build script changes

The real Bluebox data set is an 89 MB dump of TMDB films and Geofaker
addresses. `sql/bluebox-demo-data.sql` generates a catalog of the same shape
instead — synthetic titles, random points around five New York stores — small
enough to build in a second and large enough for Bluebox's own procedures to
work against. The rental percentages in the jobs are raised to match, since
`generate_rentals()` scales its output by the customer count and 900 customers
is far fewer than the real set.

`sql/bluebox-schema.sql` is generated, not written:

```bash
npm run build:bluebox              # clones upstream
node tools/build-bluebox.mjs ../bluebox   # or use a checkout
```

The script applies seven named edits and records them in the generated file's
header, and it fails if one of them stops matching, so an upstream change
cannot slip through as a silently unpatched schema. Five are PGlite
compatibility. Two are upstream defects that make three routines uncallable as
shipped:

* `get_overdue_rentals()` and `process_lost_inventory()` still read
  `film.replacement_cost`, a column that was replaced by the
  `bluebox.get_replacement_cost()` function.
* Two overloads of `process_lost_rentals()` are both callable with no
  arguments, so `CALL bluebox.process_lost_rentals()` fails as *"not unique"*.

The dump also leaves `search_path` empty and `client_min_messages` at
`warning`. In psql those die with the session; in PGlite, which is one long
lived session, they would make the REPL unusable and silence every procedure's
output, so the generated file puts both back.

## Using the bed from your own script

```js
import { createTestbed } from './src/testbed.mjs';
import fs from 'node:fs/promises';

const testbed = await createTestbed({ loadSql: (name) => fs.readFile(name, 'utf-8') });
await testbed.runFile('train.sql');

const { plans, results } = await testbed.run('SELECT * FROM journey_view');
console.log(plans[0].durationMs, plans[0].plan);
console.log(await testbed.topStatements({ limit: 5, orderBy: 'mean' }));

// the Bluebox sample schema and its jobs
import { loadBluebox } from './src/bluebox.mjs';
import { createJobRunner } from './src/job-runner.mjs';

await loadBluebox(testbed, { historyDays: 30 });
const runner = createJobRunner(testbed, { onRun: (run) => console.log(run.jobname, run.message) });
runner.start();                       // or: await runner.runOnce('generate-rentals')

// wait events
console.log(await testbed.waitEvents({ search: 'DataFile' }));
const { io } = await testbed.run('VACUUM FULL journey', { waits: true });
console.log(io.waits, io.totalMs);
console.log(await testbed.waitProfile());

await testbed.close();
```

## Tests

```bash
npm test
```

Covers the statement splitter and, against a real PGlite instance:
`auto_explain` producing analyzed plans, `pg_stat_statements` recording the
statements, settings changing at run time, and the wait event measurement —
including a check that every wait event name the `pg_stat_io` mapping produces
really exists in `pg_wait_events`.

`test/bluebox.test.mjs` loads the whole Bluebox schema and calls every
procedure the jobs depend on, checks the PostGIS stand-in against a known
distance, and drives the scheduler: that a due job fires and an inactive one
does not, that every execution lands in `job.run_details` with the procedure's
own output, that a failing job is recorded as failed, and that stopping the
runner leaves nothing hanging in `running`.

## SQL files in this repo

* `user.sql` — a `users` table with 20 rows and two example queries.
* `train.sql` — trains, stations and journeys with a joining view, foreign keys
  and indexes; the more interesting plans come from this one.
* `sql/bluebox-*.sql` — the Bluebox sample database; see
  [Bluebox](#bluebox). `bluebox-schema.sql` is generated by
  `tools/build-bluebox.mjs`, the other three are written by hand.
