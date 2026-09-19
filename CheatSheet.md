# PostgreSQL Performance Cheat Sheet

*Slow Query Diagnostics · EXPLAIN ANALYZE · Parameter Tuning*

-----

## Table of Contents

1. [pg_stat_statements — Historical Query Stats](#1-pg_stat_statements--historical-query-stats)
1. [auto_explain — Automatic Plan Logging](#2-auto_explain--automatic-plan-logging)
1. [Reading EXPLAIN ANALYZE Output](#3-reading-explain-analyze-output)
1. [Wait Events — What Queries Are Waiting For](#4-wait-events--what-queries-are-waiting-for)
1. [Parameter Tuning — 4–8 GB RAM, SSD](#5-parameter-tuning--48-gb-ram-ssd)
1. [Quick Reference Card](#6-quick-reference-card)
1. [Small VM Baseline — 1 CPU / 1 GB RAM](#7-small-vm-baseline--1-cpu--1-gb-ram)

-----

## 1  pg_stat_statements — Historical Query Stats

### 1.1  Enable (`postgresql.conf` — needs RESTART)

```ini
shared_preload_libraries = 'pg_stat_statements'
pg_stat_statements.max   = 10000   # queries tracked (default 5000)
pg_stat_statements.track = all     # top | all (includes nested calls)
```

> ⚠️ Requires a full PostgreSQL **RESTART** — reload is not enough.

### 1.2  Install extension per database

```sql
-- Run once per database you want to monitor
CREATE EXTENSION pg_stat_statements;

-- Tip: install in 'postgres' DB to see ALL databases on the instance
\c postgres
CREATE EXTENSION pg_stat_statements;
```

### 1.3  Key diagnostic queries

**Top 10 by TOTAL time** — highest overall impact, start here

```sql
SELECT round(total_exec_time::numeric, 2)                          AS total_ms,
       calls,
       round(mean_exec_time::numeric, 2)                           AS mean_ms,
       round(stddev_exec_time::numeric, 2)                         AS stddev_ms,
       round((total_exec_time/sum(total_exec_time) OVER())*100, 1) AS pct,
       left(query, 80)                                             AS query
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 10;
```

**Top 10 by MEAN time** — catches rare but painful queries

```sql
SELECT round(mean_exec_time::numeric, 2)   AS mean_ms,
       round(stddev_exec_time::numeric, 2)  AS stddev_ms,
       calls,
       left(query, 80)                      AS query
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 10;
```

**High stddev** — inconsistent queries, often a caching or locking issue

```sql
SELECT round(mean_exec_time::numeric, 2)   AS mean_ms,
       round(stddev_exec_time::numeric, 2)  AS stddev_ms,
       calls,
       left(query, 80)                      AS query
FROM pg_stat_statements
WHERE calls > 20
ORDER BY stddev_exec_time DESC
LIMIT 10;
```

**Reset stats between experiments**

```sql
SELECT pg_stat_statements_reset();
SELECT pg_stat_reset();                    -- table/index stats
SELECT pg_stat_reset_shared('bgwriter');   -- bgwriter stats
```

-----

## 2  auto_explain — Automatic Plan Logging

### 2.1  Enable (`postgresql.conf` — needs RESTART)

```ini
shared_preload_libraries = 'pg_stat_statements, auto_explain'

auto_explain.log_min_duration      = 1000  # ms threshold; 0 = log all queries
auto_explain.log_analyze           = true  # actual rows + timing
auto_explain.log_buffers           = true  # cache hits vs disk reads
auto_explain.log_timing            = true  # per-node timing
auto_explain.log_format            = text  # text | json | xml
auto_explain.log_nested_statements = true  # queries inside functions
```

> ⚠️ `log_analyze = true` runs queries for real to measure actuals.
> Fine on a lab VM — use cautiously in production.

### 2.2  Tune threshold on the fly (no restart needed)

```sql
ALTER SYSTEM SET auto_explain.log_min_duration = 500;
SELECT pg_reload_conf();

-- Or per-session only (no preload required)
LOAD 'auto_explain';
SET auto_explain.log_min_duration = 0;
SET auto_explain.log_analyze = true;
```

### 2.3  Watch plans live alongside pgbench

```bash
# Terminal 1
pgbench -c 4 -j 2 -T 60 -P 5 pgbench_test

# Terminal 2
tail -f /var/log/postgresql/postgresql-*.log | grep -A 30 'duration'
```

-----

## 3  Reading EXPLAIN ANALYZE Output

### 3.1  Run it

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM pgbench_accounts WHERE aid = 42;
```

### 3.2  Anatomy of a plan node

```
Index Scan using pgbench_accounts_pkey on pgbench_accounts
  (cost=0.29..8.07  rows=1    width=97)      -- PLANNER estimate
  (actual time=1.2..1.2  rows=1  loops=1)    -- ACTUAL result
  Index Cond: (aid = 42)
  Buffers: shared hit=4  read=1              -- cache vs disk reads
```

|Field                   |Meaning                                              |
|------------------------|-----------------------------------------------------|
|`cost=start..total`     |Planner estimate (arbitrary units, not ms)           |
|`actual time=start..end`|Real milliseconds on disk                            |
|`rows=N`                |Planner’s estimated row count                        |
|`loops=N`               |Node ran N times — actual rows shown are **per loop**|


> 💡 **Total node cost = actual time × loops.**
> A node with `loops=1000` and `time=2ms` costs **2 seconds** total.

### 3.3  The three red flags

|Red Flag                   |Example                               |Action                                                      |
|---------------------------|--------------------------------------|------------------------------------------------------------|
|**Rows mismatch**          |`rows=1` estimate, `rows=50000` actual|Run `ANALYZE` on the table                                  |
|**Seq Scan on large table**|Full scan, no index used              |Missing index — or check why planner ignores an existing one|
|**Buffers: read= high**    |`hit=0, read=500`                     |Cold cache or I/O bound — check `shared_buffers`            |

### 3.4  Node types quick reference

|Node             |When you see it                                                |
|-----------------|---------------------------------------------------------------|
|`Index Scan`     |Uses index + fetches heap rows (good for selective queries)    |
|`Index Only Scan`|Uses index only, no heap fetch (best — needs recent VACUUM)    |
|`Seq Scan`       |Reads entire table (fine for small tables or full-scan queries)|
|`Hash Join`      |Builds hash of inner set (good for large unsorted joins)       |
|`Nested Loop`    |Per outer row, probes inner (fast when inner side is indexed)  |
|`Sort`           |In-memory or on-disk sort (**Disk = `work_mem` too low**)      |
|`Hash`           |Build hash from subplan (**batches > 1 = spilling to disk**)   |

### 3.5  Spotting work_mem pressure

```
Sort Method: external merge  Disk: 42MB   -- work_mem too low, spilling to disk
Sort Method: quicksort  Memory: 128kB     -- in memory, good

Hash Batches: 8  (original 1)             -- hash spilled to disk
Hash Batches: 1                           -- fit in memory, good
```

-----

## 4  Wait Events — What Queries Are Waiting For

`pg_stat_statements` says *which* statement is slow, `EXPLAIN ANALYZE` says
*where* in the plan the time goes — wait events say *what the backend was
blocked on* while it was not running.

### 4.1  What is running right now, and what is it waiting for

```sql
SELECT pid,
       now() - query_start                  AS running_for,
       state,
       wait_event_type || ':' || wait_event AS waiting_on,
       left(query, 60)                      AS query
FROM pg_stat_activity
WHERE state <> 'idle'
  AND pid <> pg_backend_pid()
ORDER BY query_start;
```

`waiting_on` NULL means the backend is on CPU. Everything else names the
wait — `Lock:transactionid`, `LWLock:BufferMapping`, `IO:DataFileRead`, …

### 4.2  Look the name up

```sql
-- what does this event mean?
SELECT type, name, description FROM pg_wait_events WHERE name = 'DataFileExtend';

-- everything of one kind
SELECT name, description FROM pg_wait_events WHERE type = 'Lock' ORDER BY name;
```

`pg_wait_events` needs PostgreSQL 17 or newer; on older versions the same list
is in the *Wait Events* appendix of the manual.

### 4.3  Sample it — one snapshot proves nothing

A wait event is an instant, not a duration. Sample in a loop and count:

```sql
-- poor man's sampler: run from a second session, e.g. every 10 ms via watch
CREATE UNLOGGED TABLE wait_samples AS
SELECT now() AS ts, wait_event_type, wait_event, state
FROM pg_stat_activity WHERE false;

INSERT INTO wait_samples
SELECT now(), wait_event_type, wait_event, state
FROM pg_stat_activity
WHERE state <> 'idle' AND pid <> pg_backend_pid();
```

```sql
-- the profile: where the time went
SELECT coalesce(wait_event_type || ':' || wait_event, 'CPU') AS waiting_on,
       count(*)                                              AS samples,
       round(100.0 * count(*) / sum(count(*)) OVER (), 1)    AS pct
FROM wait_samples
GROUP BY 1
ORDER BY samples DESC;
```

The extension `pg_wait_sampling` does exactly this in the background, without
the polling loop, and is worth installing on a busy server.

### 4.4  The accumulated view: pg_stat_io

The IO wait events also exist as counters. This needs `track_io_timing = on`
(and `track_wal_io_timing = on` for the WAL rows), and unlike sampling it is
exact:

```sql
SELECT backend_type, object, context,
       reads, round(read_time::numeric, 1)   AS read_ms,
       writes, round(write_time::numeric, 1) AS write_ms,
       extends, round(extend_time::numeric, 1) AS extend_ms,
       hits, evictions
FROM pg_stat_io
WHERE reads > 0 OR writes > 0 OR extends > 0
ORDER BY read_time + write_time + extend_time DESC;
```

The mapping back to wait event names: `relation` reads/writes/extends are
`DataFileRead` / `DataFileWrite` / `DataFileExtend`, `temp relation` is
`BuffileRead` / `BuffileWrite`, `wal` is `WalRead` / `WalWrite` / `WalSync`.

A backend only pushes these counters to shared memory about once a second, so
for a single statement call `SELECT pg_stat_force_next_flush();` first — and
note that inside an explicit `BEGIN … COMMIT` block the flush happens at the
`COMMIT`, so the whole block's I/O is attributed there.

### 4.5  What each type usually means

| type | typical cause | first thing to look at |
| --- | --- | --- |
| `Lock` | a real row/table lock conflict | the blocking query, `log_lock_waits`, long transactions |
| `LWLock` | internal contention | `BufferMapping`/`WALWrite` → too small `shared_buffers`, too much WAL |
| `IO` | reading or writing files | cache hit ratio, `shared_buffers`, the storage itself |
| `IPC` | waiting for another process | parallel workers, replication |
| `Client` | waiting for the application | *not* a database problem — the client is slow to read |
| `Timeout` | a deliberate sleep | `vacuum_cost_delay`, `pg_sleep` |
| `BufferPin` | another backend pins the buffer | rare; usually long-running scans |

`Client:ClientRead` dominating a profile means the backend is idle waiting for
the next statement — exclude `state = 'idle'` before you read anything into it.

-----

## 5  Parameter Tuning — 4–8 GB RAM, SSD

### 5.1  Storage cost parameters

The planner uses the ratio of `random_page_cost` / `seq_page_cost` to choose between index and sequential scans.
The default `4.0` was designed for spinning disks — too high for SSD, causes the planner to skip useful indexes.

|Parameter                 |Default|Recommendation                                         |
|--------------------------|-------|-------------------------------------------------------|
|`random_page_cost`        |4.0    |`1.5` (SSD) / `1.1` (NVMe or data fits in RAM)         |
|`seq_page_cost`           |1.0    |Leave at 1.0 — tune `random_page_cost` relative to this|
|`effective_io_concurrency`|1      |`200` (SSD) / `1` (spinning disk)                      |

```sql
ALTER SYSTEM SET random_page_cost         = 1.5;
ALTER SYSTEM SET effective_io_concurrency = 200;
SELECT pg_reload_conf();   -- no restart needed
```

### 5.2  Memory parameters

|Parameter             |Default|Recommendation                                 |
|----------------------|-------|-----------------------------------------------|
|`shared_buffers`      |128MB  |`1GB` — 25% of total RAM (**RESTART required**)|
|`work_mem`            |4MB    |`32MB` — per sort/hash op (see warning)        |
|`maintenance_work_mem`|64MB   |`256MB` — for VACUUM, ANALYZE, CREATE INDEX    |
|`effective_cache_size`|4GB    |`3GB` — planner hint only, not allocated       |


> ⚠️ `work_mem` is allocated **per sort/hash operation** and a single query can use multiple.
> `work_mem × ops × connections` can exceed RAM quickly. Start conservatively in production.

```sql
ALTER SYSTEM SET shared_buffers       = '1GB';    -- RESTART required
ALTER SYSTEM SET work_mem             = '32MB';
ALTER SYSTEM SET maintenance_work_mem = '256MB';
ALTER SYSTEM SET effective_cache_size = '3GB';
SELECT pg_reload_conf();
```

### 5.3  Statistics

|Parameter                  |Default|Recommendation                          |
|---------------------------|-------|----------------------------------------|
|`default_statistics_target`|100    |`200` — better estimates, slower ANALYZE|

```sql
ALTER SYSTEM SET default_statistics_target = 200;
SELECT pg_reload_conf();

-- Or per-column for a specific problem column:
ALTER TABLE pgbench_accounts ALTER COLUMN bid SET STATISTICS 500;
ANALYZE pgbench_accounts;
```

> 💡 Rows mismatch in EXPLAIN ANALYZE (planner estimated 1, got 50000) usually means stale or insufficient statistics.
> Run `ANALYZE` first, then increase `default_statistics_target` if the mismatch persists.

### 5.4  Checkpoint & WAL

|Parameter                     |Default|Recommendation                                               |
|------------------------------|-------|-------------------------------------------------------------|
|`max_wal_size`                |1GB    |`2GB` — fewer checkpoints during write-heavy pgbench         |
|`wal_buffers`                 |auto   |`64MB` — more WAL buffering for bursts (**RESTART required**)|
|`checkpoint_completion_target`|0.9    |`0.9` — already good, leave it                               |

```sql
ALTER SYSTEM SET max_wal_size                 = '2GB';
ALTER SYSTEM SET wal_buffers                  = '64MB';  -- RESTART required
ALTER SYSTEM SET checkpoint_completion_target = 0.9;
SELECT pg_reload_conf();

-- Detect checkpoint pressure:
SELECT checkpoints_timed, checkpoints_req FROM pg_stat_bgwriter;
-- checkpoints_req >> checkpoints_timed  =  you are checkpoint-bound
```

### 5.5  Parallelism

|Parameter                        |Default|Recommendation                             |
|---------------------------------|-------|-------------------------------------------|
|`max_parallel_workers_per_gather`|2      |`4` — for multi-core VM, analytical queries|
|`max_parallel_workers`           |8      |Match number of CPU cores                  |

```sql
ALTER SYSTEM SET max_parallel_workers_per_gather = 4;
ALTER SYSTEM SET max_parallel_workers            = 4;
SELECT pg_reload_conf();
```

### 5.6  Full baseline — 4–8 GB RAM, SSD

```sql
ALTER SYSTEM SET shared_buffers                  = '1GB';
ALTER SYSTEM SET work_mem                        = '32MB';
ALTER SYSTEM SET maintenance_work_mem            = '256MB';
ALTER SYSTEM SET effective_cache_size            = '3GB';
ALTER SYSTEM SET random_page_cost                = '1.5';
ALTER SYSTEM SET effective_io_concurrency        = '200';
ALTER SYSTEM SET default_statistics_target       = '200';
ALTER SYSTEM SET max_wal_size                    = '2GB';
ALTER SYSTEM SET checkpoint_completion_target    = '0.9';
ALTER SYSTEM SET max_parallel_workers_per_gather = '4';

SELECT pg_reload_conf();
-- Then restart PostgreSQL for shared_buffers and wal_buffers to take effect
```

> 💡 Change **ONE parameter at a time**. Reset `pg_stat_statements` between pgbench runs and record TPS before and after.
> That discipline is what separates careful tuning from guesswork.

-----

## 6  Quick Reference Card

### Restart vs Reload

|Parameter                      |Requires                           |
|-------------------------------|-----------------------------------|
|`shared_buffers`               |**RESTART**                        |
|`wal_buffers`                  |**RESTART**                        |
|`shared_preload_libraries`     |**RESTART**                        |
|`max_connections`              |**RESTART**                        |
|`max_worker_processes`         |**RESTART**                        |
|`work_mem`                     |RELOAD — `SELECT pg_reload_conf();`|
|`maintenance_work_mem`         |RELOAD                             |
|`effective_cache_size`         |RELOAD                             |
|`random_page_cost`             |RELOAD                             |
|`effective_io_concurrency`     |RELOAD                             |
|`default_statistics_target`    |RELOAD                             |
|`max_wal_size`                 |RELOAD                             |
|`auto_explain.log_min_duration`|RELOAD                             |
|`log_min_duration_statement`   |RELOAD                             |

```sql
-- Check any parameter's reload requirement:
SELECT name, context FROM pg_settings WHERE name = 'shared_buffers';
-- context: postmaster = restart | sighup = reload | user = session
```

### Essential commands

|Task                        |Command                                                                                   |
|----------------------------|------------------------------------------------------------------------------------------|
|View changed settings       |`SELECT name, setting, boot_val FROM pg_settings WHERE setting != boot_val ORDER BY name;`|
|Reload config               |`SELECT pg_reload_conf();`                                                                |
|Reset query stats           |`SELECT pg_stat_statements_reset();`                                                      |
|Check bgwriter / checkpoints|`SELECT * FROM pg_stat_bgwriter;`                                                         |
|Live query activity         |`SELECT pid, state, left(query,50) FROM pg_stat_activity WHERE state != 'idle';`          |
|Check extensions            |`\dx`                                                                                     |
|Log file location           |`SHOW log_directory;`                                                                     |

-----

## 7  Small VM Baseline — 1 CPU / 1 GB RAM

### 7.1  Memory budget

With only 1 GB total, work backwards from what the OS needs before allocating anything to PostgreSQL.

|Item                         |Amount     |Notes                                |
|-----------------------------|-----------|-------------------------------------|
|Total RAM                    |1024 MB    |                                     |
|OS + system processes        |~200 MB    |kernel, systemd, sshd, etc.          |
|Available for PG             |~820 MB    |rough ceiling for all PG memory      |
|**`shared_buffers`**         |**200 MB** |25% rule still applies               |
|**`max_connections` × ~5 MB**|**~100 MB**|20 connections × ~5 MB each          |
|**`work_mem` headroom**      |**~60 MB** |4 MB × ~15 concurrent ops            |
|OS page cache                |remainder  |PostgreSQL benefits from OS cache too|
|**`effective_cache_size`**   |**600 MB** |shared_buffers + estimated OS cache  |


> 🔴 `max_connections` defaults to **100**. At ~5 MB per connection that is 500 MB —
> more than half your RAM before a single query runs.
> **Always set `max_connections` low on constrained VMs.**

### 7.2  What changes vs a larger VM

|Parameter                        |4–8 GB VM|1 GB VM   |Reason                             |
|---------------------------------|---------|----------|-----------------------------------|
|`shared_buffers`                 |1 GB     |**200 MB**|25% of 1 GB                        |
|`work_mem`                       |32 MB    |**4 MB**  |RAM is scarce; keep it small       |
|`maintenance_work_mem`           |256 MB   |**64 MB** |No headroom for large ops          |
|`effective_cache_size`           |3 GB     |**600 MB**|Reflects actual available RAM      |
|`max_wal_size`                   |2 GB     |**512 MB**|Cannot afford large WAL buildup    |
|`wal_buffers`                    |64 MB    |**8 MB**  |Proportional to shared_buffers     |
|`default_statistics_target`      |200      |**100**   |Higher stats uses more memory      |
|`max_parallel_workers_per_gather`|4        |**0**     |1 CPU: parallelism is pure overhead|
|`max_parallel_workers`           |4        |**1**     |No benefit on a single CPU         |
|`max_connections`                |100      |**20**    |Each idle connection uses ~5 MB    |
|`effective_io_concurrency`       |200      |200       |Still SSD — unchanged              |
|`random_page_cost`               |1.5      |1.5       |Still SSD — unchanged              |
|`checkpoint_completion_target`   |0.9      |0.9       |Already optimal — unchanged        |

### 7.3  Full baseline — paste and apply

```sql
-- Memory
ALTER SYSTEM SET shared_buffers                  = '200MB';  -- RESTART
ALTER SYSTEM SET work_mem                        = '4MB';
ALTER SYSTEM SET maintenance_work_mem            = '64MB';
ALTER SYSTEM SET effective_cache_size            = '600MB';

-- Storage (still SSD)
ALTER SYSTEM SET random_page_cost                = '1.5';
ALTER SYSTEM SET effective_io_concurrency        = '200';

-- Statistics — back to default (ANALYZE is cheaper on small RAM)
ALTER SYSTEM SET default_statistics_target       = '100';

-- WAL & checkpoints
ALTER SYSTEM SET max_wal_size                    = '512MB';
ALTER SYSTEM SET wal_buffers                     = '8MB';   -- RESTART
ALTER SYSTEM SET checkpoint_completion_target    = '0.9';

-- Parallelism — disable (single CPU)
ALTER SYSTEM SET max_parallel_workers_per_gather = '0';
ALTER SYSTEM SET max_parallel_workers            = '1';
ALTER SYSTEM SET max_worker_processes            = '2';     -- RESTART

-- Connections — prevent memory exhaustion
ALTER SYSTEM SET max_connections                 = '20';    -- RESTART

SELECT pg_reload_conf();
-- Restart PostgreSQL to apply: shared_buffers, wal_buffers,
-- max_worker_processes, max_connections
```

### 7.4  Connection pooling with PgBouncer

If you ever need more than 20 concurrent connections, add PgBouncer in front rather
than raising `max_connections`. PgBouncer multiplexes many client connections onto a
small pool of real server connections, keeping PostgreSQL’s memory footprint stable.

```bash
# Install
apt install pgbouncer
```

```ini
# Minimal /etc/pgbouncer/pgbouncer.ini

[databases]
pgbench_test = host=127.0.0.1 port=5432 dbname=pgbench_test

[pgbouncer]
listen_port       = 6432
listen_addr       = 127.0.0.1
auth_type         = md5
pool_mode         = transaction    # best throughput
max_client_conn   = 100            # clients see up to 100 connections
default_pool_size = 10             # only 10 real PG server connections
```

-----

*Lab / dev use only — validate all settings for production*
