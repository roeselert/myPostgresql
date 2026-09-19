/**
 * Wait events.
 *
 * Two different things are useful here, and PGlite only supports one of them
 * the way a real server does:
 *
 * 1. The catalog. `pg_wait_events` (PostgreSQL 17+) lists every wait event the
 *    server knows about with its description. Looking a name up there is the
 *    first step whenever `pg_stat_activity.wait_event` shows something on a
 *    real server, and it works in PGlite exactly as it does anywhere else.
 *
 * 2. Observing what a statement waited on. On a real server you sample
 *    `pg_stat_activity` from a second connection. PGlite runs a single backend
 *    on a single thread, so nothing can look at it while it is busy -- a
 *    sample would always come back idle. What PGlite *can* tell us is
 *    `pg_stat_io`: the number of I/O operations and the time spent in them,
 *    per object and context. Those counters are the accumulated form of the
 *    IO wait events, so the delta across a statement says which I/O waits it
 *    hit and for how long. It needs `track_io_timing` (the bed sets it).
 *
 * What this cannot show are the waits that need contention to happen at all:
 * Lock, LWLock, IPC and Client events stay empty in a single backend.
 */

/**
 * `pg_stat_io` rows to the IO wait event the operation blocks in. Every name
 * is checked against `pg_wait_events` by the test suite.
 */
const IO_WAIT_EVENTS = {
  relation: {
    read: 'DataFileRead',
    write: 'DataFileWrite',
    extend: 'DataFileExtend',
    writeback: 'DataFileFlush',
    fsync: 'DataFileSync',
  },
  'temp relation': {
    read: 'BuffileRead',
    write: 'BuffileWrite',
    extend: 'BuffileWrite',
  },
  wal: {
    read: 'WalRead',
    write: 'WalWrite',
    fsync: 'WalSync',
  },
};

/** `wal` in the `init` context uses its own pair of wait events. */
const WAL_INIT_WAIT_EVENTS = { write: 'WalInitWrite', fsync: 'WalInitSync' };

/** The counter triplets pg_stat_io keeps per operation. */
const OPERATIONS = [
  { operation: 'read', count: 'reads', bytes: 'read_bytes', time: 'read_time' },
  { operation: 'write', count: 'writes', bytes: 'write_bytes', time: 'write_time' },
  { operation: 'extend', count: 'extends', bytes: 'extend_bytes', time: 'extend_time' },
  { operation: 'writeback', count: 'writebacks', bytes: null, time: 'writeback_time' },
  { operation: 'fsync', count: 'fsyncs', bytes: null, time: 'fsync_time' },
];

const BUFFER_COUNTERS = ['hits', 'evictions', 'reuses'];

export function ioWaitEvent(object, context, operation) {
  if (object === 'wal' && context === 'init') {
    return WAL_INIT_WAIT_EVENTS[operation] ?? IO_WAIT_EVENTS.wal?.[operation];
  }
  return IO_WAIT_EVENTS[object]?.[operation];
}

/** Every wait event name this module can produce, for validation. */
export function knownIoWaitEvents() {
  const names = Object.values(IO_WAIT_EVENTS).flatMap((byOperation) => Object.values(byOperation));
  return [...new Set([...names, ...Object.values(WAL_INIT_WAIT_EVENTS)])].sort();
}

/**
 * Query `pg_wait_events`.
 *
 * @param {object} pg        a PGlite instance
 * @param {object} [options]
 * @param {string} [options.search] matched against name and description
 * @param {string} [options.type]   Lock, LWLock, IO, IPC, Client, Timeout, …
 * @param {number} [options.limit]
 */
export async function waitEventCatalog(pg, { search, type, limit = 50 } = {}) {
  const { rows } = await pg.query(
    `SELECT type, name, description
       FROM pg_wait_events
      WHERE ($1::text IS NULL OR name ILIKE '%' || $1 || '%' OR description ILIKE '%' || $1 || '%')
        AND ($2::text IS NULL OR type ILIKE $2)
      ORDER BY (name ILIKE COALESCE($1, '') ) DESC, type, name
      LIMIT $3`,
    [search ?? null, type ?? null, limit],
  );
  return rows;
}

/** How many events of each type the server knows. */
export async function waitEventTypes(pg) {
  const { rows } = await pg.query(
    'SELECT type, count(*)::int AS events FROM pg_wait_events GROUP BY type ORDER BY events DESC',
  );
  return rows;
}

/**
 * A snapshot of the I/O counters, to be diffed with `ioDelta`.
 *
 * A backend keeps its I/O statistics locally and only pushes them to shared
 * memory every `PGSTAT_MIN_INTERVAL` (1s) or so, which is far too coarse for
 * a single statement. `pg_stat_force_next_flush()` lifts that rate limit for
 * the next flush, which then happens when this statement's transaction ends,
 * so the following read sees everything up to here.
 */
export async function ioSnapshot(pg) {
  await pg.query('SELECT pg_stat_force_next_flush()');
  const columns = [
    ...OPERATIONS.flatMap((op) => [op.count, op.bytes, op.time].filter(Boolean)),
    ...BUFFER_COUNTERS,
  ];
  const { rows } = await pg.query(
    `SELECT backend_type, object, context, ${columns.join(', ')} FROM pg_stat_io`,
  );
  return rows;
}

const keyOf = (row) => `${row.backend_type}\u0000${row.object}\u0000${row.context}`;
const num = (value) => Number(value ?? 0);

/**
 * The I/O -- and with it the IO waits -- that happened between two snapshots.
 *
 * @returns {{waits: object[], hits: number, evictions: number, reuses: number, totalMs: number}}
 */
export function ioDelta(before, after) {
  const previous = new Map(before.map((row) => [keyOf(row), row]));
  const waits = [];
  const buffers = { hits: 0, evictions: 0, reuses: 0 };

  for (const row of after) {
    const old = previous.get(keyOf(row)) ?? {};
    for (const counter of BUFFER_COUNTERS) buffers[counter] += num(row[counter]) - num(old[counter]);

    for (const op of OPERATIONS) {
      const count = num(row[op.count]) - num(old[op.count]);
      if (count <= 0) continue;
      waits.push({
        waitEvent: ioWaitEvent(row.object, row.context, op.operation) ?? `${row.object}/${op.operation}`,
        type: 'IO',
        backendType: row.backend_type,
        object: row.object,
        context: row.context,
        operation: op.operation,
        count,
        bytes: op.bytes ? num(row[op.bytes]) - num(old[op.bytes]) : null,
        timeMs: round(num(row[op.time]) - num(old[op.time])),
      });
    }
  }

  waits.sort((a, b) => b.timeMs - a.timeMs || b.count - a.count);
  return { waits, ...buffers, totalMs: round(waits.reduce((sum, w) => sum + w.timeMs, 0)) };
}

/** Aggregate wait rows from several statements by wait event. */
export function waitProfile(waitRows) {
  const byEvent = new Map();
  for (const wait of waitRows) {
    const entry = byEvent.get(wait.waitEvent) ?? {
      waitEvent: wait.waitEvent,
      type: wait.type,
      context: new Set(),
      count: 0,
      bytes: 0,
      timeMs: 0,
    };
    entry.count += wait.count;
    entry.bytes += wait.bytes ?? 0;
    entry.timeMs += wait.timeMs;
    entry.context.add(wait.context);
    byEvent.set(wait.waitEvent, entry);
  }

  return [...byEvent.values()]
    .map((entry) => ({ ...entry, context: [...entry.context].sort().join(','), timeMs: round(entry.timeMs) }))
    .sort((a, b) => b.timeMs - a.timeMs || b.count - a.count);
}

/** Add the catalog description to each row of a profile. */
export async function describeWaits(pg, rows) {
  if (!rows.length) return rows;
  const { rows: catalog } = await pg.query(
    'SELECT name, type, description FROM pg_wait_events WHERE name = ANY($1)',
    [rows.map((row) => row.waitEvent)],
  );
  const byName = new Map(catalog.map((row) => [row.name, row]));
  return rows.map((row) => ({
    ...row,
    type: byName.get(row.waitEvent)?.type ?? row.type,
    description: byName.get(row.waitEvent)?.description ?? '',
  }));
}

/**
 * `pg_stat_activity` as the backend sees itself. In PGlite this is always the
 * one backend running the query that asks, so `wait_event` is normally empty
 * -- it is here to mirror what you would run on a real server.
 */
export async function currentActivity(pg) {
  const { rows } = await pg.query(
    `SELECT pid, backend_type, state, wait_event_type, wait_event,
            coalesce(extract(epoch FROM now() - query_start) * 1000, 0)::numeric(10,1) AS running_ms,
            query
       FROM pg_stat_activity
      ORDER BY backend_type, pid`,
  );
  return rows;
}

const round = (value) => Math.round(value * 1000) / 1000;
