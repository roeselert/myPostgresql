/**
 * The browser side of the pg_cron stand-in.
 *
 * pg_cron runs its schedule in a background worker. PGlite has none: it is a
 * single backend with nothing behind it, so the clock has to live outside the
 * database. This runner keeps that clock — and writes every execution back
 * into `job.run_details`, so the log is queryable from the REPL rather than
 * only visible in a panel.
 *
 * Three things follow from PGlite being a single connection:
 *
 *   * Jobs run one at a time, in due order. A second tick that arrives while
 *     one is still running does nothing.
 *   * A job blocks statements typed into the REPL for as long as it runs, and
 *     the other way round. That is a property of the database, not of this
 *     runner, and it is why the default jobs are all short.
 *   * A job that is mid-flight when the runner stops is marked as such rather
 *     than left hanging in `running`.
 *
 * See sql/bluebox-jobs.sql for the tables this reads and writes.
 */

const DEFAULT_TICK_MS = 1000;

/**
 * @param {object}   testbed              from createTestbed()
 * @param {object}   [options]
 * @param {number}   [options.tickMs]     how often to look for due jobs
 * @param {Function} [options.onRun]      called with each finished run
 * @param {Function} [options.onError]    called when the tick itself fails
 */
export function createJobRunner(testbed, { tickMs = DEFAULT_TICK_MS, onRun, onError } = {}) {
  const dueAt = new Map();
  let timer = null;
  let ticking = false;
  let current = null;

  /** The jobs as the database has them. */
  async function jobs() {
    const { rows } = await testbed.pg.query(
      'SELECT jobid, jobname, command, interval_ms, active, description FROM job.job ORDER BY jobname',
    );
    return rows;
  }

  async function tick() {
    if (ticking) return; // the previous tick is still working through its jobs
    ticking = true;
    try {
      const now = Date.now();
      for (const job of await jobs()) {
        if (!job.active) {
          dueAt.delete(job.jobname);
          continue;
        }
        // A job just switched on waits a full interval before its first run,
        // so switching one on does not immediately fire it.
        if (!dueAt.has(job.jobname)) {
          dueAt.set(job.jobname, now + job.interval_ms);
          continue;
        }
        if (dueAt.get(job.jobname) > now) continue;
        dueAt.set(job.jobname, now + job.interval_ms);
        await runJob(job);
      }
    } catch (error) {
      if (onError) onError(error);
    } finally {
      ticking = false;
    }
  }

  /** Execute one job, logging start and outcome to job.run_details. */
  async function runJob(job) {
    const { rows } = await testbed.pg.query(
      `INSERT INTO job.run_details (jobid, jobname, command, status)
       VALUES ($1, $2, $3, 'running') RETURNING runid`,
      [job.jobid, job.jobname, job.command],
    );
    const runid = rows[0].runid;
    current = { runid, jobname: job.jobname };

    const outcome = await testbed.run(job.command);
    const status = outcome.error ? 'failed' : 'succeeded';
    const fatal = isFatal(outcome.error);
    const message = outcome.error
      ? outcome.error.message
      : noticesOf(outcome.entries) ?? summarizeResults(outcome.results);

    // A fatal error leaves the backend dead, so this write is a best effort.
    try {
      await testbed.pg.query(
        `UPDATE job.run_details
            SET status = $2, return_message = $3, end_time = now(), duration_ms = $4
          WHERE runid = $1`,
        [runid, status, message, Number(outcome.elapsedMs.toFixed(3))],
      );
    } catch (error) {
      if (!fatal) throw error;
    }

    current = null;
    const run = {
      runid,
      jobname: job.jobname,
      command: job.command,
      status,
      message,
      durationMs: outcome.elapsedMs,
      plans: outcome.plans,
      io: outcome.io,
    };
    if (onRun) onRun(run);
    // Nothing works after the backend dies; keeping the schedule going would
    // only pile up failures.
    if (fatal) {
      stopTimer();
      if (onError) onError(new Error(`${job.jobname} killed the backend (${message}); the schedule is stopped`));
    }
    return run;
  }

  function stopTimer() {
    if (!timer) return false;
    clearInterval(timer);
    timer = null;
    return true;
  }

  return {
    get running() {
      return timer !== null;
    },

    /** Current job, while one is executing. */
    get current() {
      return current;
    },

    start() {
      if (timer) return false;
      dueAt.clear();
      timer = setInterval(() => void tick(), tickMs);
      return true;
    },

    async stop() {
      if (!stopTimer()) return false;
      // Anything still marked running belongs to a run this stop interrupted.
      await testbed.pg.query(
        `UPDATE job.run_details
            SET status = 'failed', return_message = 'interrupted: the runner was stopped',
                end_time = now(),
                duration_ms = extract(epoch FROM now() - start_time) * 1000
          WHERE status = 'running'`,
      );
      return true;
    },

    /** Run one job now, regardless of its schedule or its active flag. */
    async runOnce(jobname) {
      const { rows } = await testbed.pg.query(
        'SELECT jobid, jobname, command, interval_ms FROM job.job WHERE jobname = $1',
        [jobname],
      );
      if (!rows.length) throw new Error(`no job named ${jobname}`);
      dueAt.set(jobname, Date.now() + rows[0].interval_ms);
      return runJob(rows[0]);
    },

    /** One tick, for tests and for a manual nudge. */
    tick,

    jobs,

    async status() {
      const { rows } = await testbed.pg.query('SELECT * FROM job.status');
      return rows;
    },

    async recentRuns(limit = 20) {
      const { rows } = await testbed.pg.query(
        'SELECT * FROM job.recent_runs LIMIT $1',
        [limit],
      );
      return rows;
    },
  };
}

/** PANIC and FATAL take the backend with them; there is no carrying on. */
function isFatal(error) {
  return Boolean(error) && (error.severity === 'PANIC' || error.severity === 'FATAL');
}

/** Bluebox's procedures report what they did through RAISE NOTICE. */
function noticesOf(entries = []) {
  const notices = entries
    .filter((entry) => entry.level === 'NOTICE')
    .map((entry) => entry.message.trim())
    .filter(Boolean);
  return notices.length ? notices.join(' | ') : undefined;
}

/** What a CALL gives back: nothing useful, so report what it touched. */
function summarizeResults(results) {
  const affected = results.reduce((sum, result) => sum + (result?.affectedRows ?? 0), 0);
  const rows = results.reduce((sum, result) => sum + (result?.rows?.length ?? 0), 0);
  if (affected) return `${affected} row(s) affected`;
  if (rows) return `${rows} row(s) returned`;
  return 'ok';
}
