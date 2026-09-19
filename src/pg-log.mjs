/**
 * Capturing the PostgreSQL server log out of PGlite.
 *
 * PGlite pipes the stderr of the WASM backend to `console.error`, but only
 * while its `debug` option is truthy. `debug: 1` also starts the backend with
 * `-d 1`, which floods the log with DEBUG1 messages -- we switch that back off
 * with `SET log_min_messages = 'warning'` once the server is up. `LOG` ranks
 * *above* `WARNING` in `log_min_messages`, so the `auto_explain` plans
 * (emitted at LOG level) still come through while the debug chatter does not.
 *
 * `debug: 1` additionally makes PGlite echo every statement through
 * `console.log`, so the hooks below drop console output while a database call
 * is in flight and pass everything else on to the real console.
 */

const LOG_HEADER =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \S+) \[(\d+)\] ([A-Z]+[1-5]?):\s{0,2}([\s\S]*)$/;

/** The untouched console, for output that must never be swallowed. */
export const realConsole = {
  log: console.log.bind(console),
  debug: console.debug.bind(console),
  error: console.error.bind(console),
  warn: console.warn.bind(console),
};

export class PgLog {
  constructor({ onEntry } = {}) {
    this.entries = [];
    this.onEntry = onEntry;
    this._lines = [];
    this._parsed = 0;
    this._depth = 0;
    this._installed = false;
  }

  /** Redirect the console so backend output lands in this collector. */
  install() {
    if (this._installed) return this;
    this._installed = true;
    // Remember what was in place, so nesting collectors restores correctly.
    this._previous = { log: console.log, debug: console.debug, error: console.error, warn: console.warn };
    console.error = (...args) => {
      const text = args.map(stringify).join(' ');
      if (this._depth > 0 || LOG_HEADER.test(text)) this._lines.push(...text.split('\n'));
      else realConsole.error(...args);
    };
    console.log = (...args) => {
      if (this._depth === 0) realConsole.log(...args);
    };
    console.debug = (...args) => {
      if (this._depth === 0) realConsole.debug(...args);
    };
    // PGlite dumps the raw notice object here whenever debug is on.
    console.warn = (...args) => {
      if (this._depth === 0) realConsole.warn(...args);
    };
    return this;
  }

  uninstall() {
    if (!this._installed) return;
    this._installed = false;
    Object.assign(console, this._previous ?? realConsole);
  }

  /**
   * Run `fn` with console capture active and return its result together with
   * every log entry the backend produced while it ran.
   */
  async capture(fn) {
    const from = this.entries.length;
    this._depth += 1;
    try {
      return { result: await fn(), entries: this._sliceAfter(from) };
    } catch (error) {
      error.pgLogEntries = this._sliceAfter(from);
      throw error;
    } finally {
      this._depth -= 1;
    }
  }

  _sliceAfter(from) {
    if (this._depth === 1) this.flush();
    return this.entries.slice(from);
  }

  /** Turn the raw stderr lines collected so far into structured entries. */
  flush() {
    let current = null;
    const commit = () => {
      if (!current) return;
      this.entries.push(finalize(current));
      if (this.onEntry) this.onEntry(this.entries[this.entries.length - 1]);
      current = null;
    };

    for (const line of this._lines.slice(this._parsed)) {
      const header = LOG_HEADER.exec(line);
      if (header) {
        commit();
        current = { time: header[1], pid: Number(header[2]), level: header[3], message: header[4], detail: [] };
      } else if (current) {
        current.detail.push(line.replace(/^\t/, ''));
      }
    }
    commit();
    this._parsed = this._lines.length;
    return this.entries;
  }

  clear() {
    this.entries.length = 0;
    this._lines.length = 0;
    this._parsed = 0;
  }
}

const PLAN_HEADER = /^duration:\s+([\d.]+)\s+ms\s+plan:/;

function finalize(entry) {
  const plan = PLAN_HEADER.exec(entry.message);
  if (plan) {
    entry.kind = 'plan';
    entry.durationMs = Number(plan[1]);
    entry.plan = entry.detail.join('\n');
    entry.queryText = extractQueryText(entry.detail);
  } else {
    entry.kind = entry.level.toLowerCase();
  }
  entry.text = [`${entry.level}:  ${entry.message}`, ...entry.detail.map((l) => `\t${l}`)].join('\n');
  return entry;
}

/**
 * `Query Text:` is one block that may span many lines; the plan root node is
 * the first following line that carries a `(cost=..)` estimate.
 */
function extractQueryText(detail) {
  const start = detail.findIndex((line) => line.startsWith('Query Text:'));
  if (start === -1) return undefined;
  const lines = [detail[start].slice('Query Text:'.length).trim()];
  for (const line of detail.slice(start + 1)) {
    if (/^\S.*\(cost=/.test(line)) break;
    lines.push(line);
  }
  return lines.join('\n').trim();
}

function stringify(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Only the `auto_explain` plans out of a list of entries. */
export function plansOf(entries) {
  return entries.filter((entry) => entry.kind === 'plan');
}
