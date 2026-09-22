-- A pg_cron stand-in for the browser.
--
-- Bluebox is built to keep generating data through pg_cron:
--
--   SELECT cron.schedule('complete-rentals', '*/15 * * * *',
--                        $$CALL bluebox.complete_rentals()$$);
--
-- pg_cron is a background worker, and PGlite has none -- it is a single
-- backend with no scheduler behind it. So the schedule lives in the browser
-- (src/job-runner.mjs) while the job definitions and, more importantly, every
-- execution live here, in the database, where they can be queried from the
-- REPL like any other table.
--
-- The layout follows pg_cron's own `cron.job` and `cron.job_run_details` so
-- that queries written against one read the same against the other. Two
-- things differ: `interval_ms` is what the browser timer actually uses, and
-- `pg_cron_schedule` records the cron expression it stands for, so the gap
-- between the test bed and a real server stays visible.

CREATE SCHEMA IF NOT EXISTS job;

COMMENT ON SCHEMA job IS
  'Scheduled jobs and their run log. The schedule is driven by the browser, not by pg_cron.';

CREATE TABLE IF NOT EXISTS job.job (
  jobid            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  jobname          text NOT NULL UNIQUE,
  command          text NOT NULL,
  interval_ms      integer NOT NULL CHECK (interval_ms >= 250),
  pg_cron_schedule text,
  active           boolean NOT NULL DEFAULT true,
  description      text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS job.run_details (
  runid          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  jobid          bigint REFERENCES job.job ON DELETE SET NULL,
  jobname        text NOT NULL,
  command        text NOT NULL,
  status         text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  return_message text,
  start_time     timestamptz NOT NULL DEFAULT now(),
  end_time       timestamptz,
  duration_ms    numeric(12,3)
);

CREATE INDEX IF NOT EXISTS run_details_jobname_start_idx
  ON job.run_details (jobname, start_time DESC);

CREATE INDEX IF NOT EXISTS run_details_failed_idx
  ON job.run_details (start_time DESC) WHERE status = 'failed';

-- --------------------------------------------------------------- the API

/* Add or update a job. Mirrors cron.schedule(), with the browser's interval. */
CREATE OR REPLACE FUNCTION job.schedule(
  p_jobname          text,
  p_command          text,
  p_interval_ms      integer,
  p_pg_cron_schedule text DEFAULT NULL,
  p_description      text DEFAULT NULL
) RETURNS bigint
LANGUAGE sql
AS $$
  INSERT INTO job.job (jobname, command, interval_ms, pg_cron_schedule, description)
  VALUES (p_jobname, p_command, p_interval_ms, p_pg_cron_schedule, p_description)
  ON CONFLICT (jobname) DO UPDATE
    SET command          = excluded.command,
        interval_ms      = excluded.interval_ms,
        pg_cron_schedule = excluded.pg_cron_schedule,
        description      = excluded.description,
        active           = true
  RETURNING jobid;
$$;

/* Remove a job. Its run history is kept, with jobid set to NULL. */
CREATE OR REPLACE FUNCTION job.unschedule(p_jobname text) RETURNS boolean
LANGUAGE sql
AS $$
  WITH gone AS (DELETE FROM job.job WHERE jobname = p_jobname RETURNING 1)
  SELECT count(*) > 0 FROM gone;
$$;

CREATE OR REPLACE FUNCTION job.set_active(p_jobname text, p_active boolean) RETURNS boolean
LANGUAGE sql
AS $$
  WITH changed AS (UPDATE job.job SET active = p_active WHERE jobname = p_jobname RETURNING 1)
  SELECT count(*) > 0 FROM changed;
$$;

/* One row per job with how it has been going. */
CREATE OR REPLACE VIEW job.status AS
SELECT j.jobname,
       j.active,
       j.interval_ms,
       j.pg_cron_schedule,
       count(r.runid) FILTER (WHERE r.status = 'succeeded') AS succeeded,
       count(r.runid) FILTER (WHERE r.status = 'failed')    AS failed,
       count(r.runid) FILTER (WHERE r.status = 'running')   AS running,
       round(avg(r.duration_ms), 1)                         AS avg_ms,
       round(max(r.duration_ms), 1)                         AS max_ms,
       max(r.start_time)                                    AS last_run,
       (array_agg(r.return_message ORDER BY r.start_time DESC)
          FILTER (WHERE r.status = 'failed'))[1]            AS last_error
FROM job.job j
LEFT JOIN job.run_details r ON r.jobname = j.jobname
GROUP BY j.jobname, j.active, j.interval_ms, j.pg_cron_schedule
ORDER BY j.jobname;

CREATE OR REPLACE VIEW job.recent_runs AS
SELECT runid, jobname, status, round(duration_ms, 1) AS duration_ms,
       start_time, return_message
FROM job.run_details
ORDER BY start_time DESC, runid DESC;

-- ------------------------------------------------------- the default jobs

-- The intervals are seconds rather than the minutes and hours a real server
-- would use, so that a test bed session actually shows something happening.
-- `pg_cron_schedule` carries what Bluebox's own documentation suggests.

-- The demo catalog has 900 customers where the real Bluebox data set has
-- tens of thousands, and generate_rentals() scales its output by the customer
-- count. The percentages are raised to match, so a tick produces a visible
-- handful of rentals rather than the one it would otherwise round down to.
SELECT job.schedule(
  'generate-rentals',
  $$CALL bluebox.generate_rentals(now() - interval '1 hour', now(),
                                  p_min_cust_pct => 15.0, p_max_cust_pct => 30.0,
                                  p_print_debug => true)$$,
  15000,
  '*/5 * * * *',
  'Rent films to customers near a store'
);

SELECT job.schedule(
  'complete-rentals',
  $$CALL bluebox.complete_rentals(p_min_rental_age => interval '1 minute',
                                  p_completion_pct => 25.0, p_print_debug => true)$$,
  30000,
  '*/15 * * * *',
  'Return a share of the open rentals and charge for them'
);

SELECT job.schedule(
  'insert-payments',
  $$CALL bluebox.insert_payments(CURRENT_DATE)$$,
  60000,
  '0 * * * *',
  'Create the payment rows for rentals closed today'
);

-- Off by default: writing off a rental that generate_rentals() created in
-- the same session crashes the PGlite backend with "ERRORDATA_STACK_SIZE
-- exceeded", which takes the whole REPL down with it. Reproducible without
-- the test bed; see README.md. A p_lost_after long enough to only catch the
-- seeded history (30 days, the upstream default) does not hit it.
SELECT job.schedule(
  'process-lost-rentals',
  $$CALL bluebox.process_lost_rentals(p_lost_after => interval '30 days',
                                      p_print_debug => true)$$,
  120000,
  '0 3 * * *',
  'Write off rentals that were never returned (see README: crashes PGlite on freshly generated rentals)'
);
SELECT job.set_active('process-lost-rentals', false);

SELECT job.schedule(
  'update-customer-activity',
  $$CALL bluebox.update_customer_activity()$$,
  120000,
  '30 3 * * *',
  'Refresh the activebool flag and the status log'
);

-- Heavier, and it rewrites inventory across stores: off until asked for.
SELECT job.schedule(
  'nightly-maintenance',
  $$CALL bluebox.nightly_maintenance()$$,
  300000,
  '0 4 * * *',
  'process_lost_inventory + update_customer_activity in one go'
);
SELECT job.set_active('nightly-maintenance', false);
