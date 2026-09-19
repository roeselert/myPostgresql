/** Plain text rendering of results, plans and statistics, shared by both beds. */

import { summarize } from './sql-split.mjs';

export function formatValue(value) {
  if (value === null || value === undefined) return '∅';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Render rows as an aligned ASCII table. */
export function formatTable(rows, { maxRows = 20, maxWidth = 60, fields } = {}) {
  if (!rows || rows.length === 0) return '(no rows)';
  const columns = fields ?? Object.keys(rows[0]);
  const shown = rows.slice(0, maxRows);
  const cells = shown.map((row) => columns.map((c) => clip(formatValue(row[c]), maxWidth)));
  const widths = columns.map((c, i) =>
    Math.max(c.length, ...cells.map((row) => row[i].length)),
  );

  const line = (left, fill, mid, right) =>
    left + widths.map((w) => fill.repeat(w + 2)).join(mid) + right;
  const render = (values) =>
    '│ ' + values.map((v, i) => v.padEnd(widths[i])).join(' │ ') + ' │';

  const out = [
    line('┌', '─', '┬', '┐'),
    render(columns),
    line('├', '─', '┼', '┤'),
    ...cells.map(render),
    line('└', '─', '┴', '┘'),
  ];
  if (rows.length > shown.length) out.push(`… ${rows.length - shown.length} more row(s)`);
  return out.join('\n');
}

/** One `auto_explain` entry as `duration + plan`. */
export function formatPlan(entry, { indent = '  ' } = {}) {
  const head = `${entry.durationMs} ms`;
  const body = (entry.plan ?? '')
    .split('\n')
    .filter((line) => !line.startsWith('Query Text:'))
    .join('\n');
  return [`${indent}plan (${head}):`, ...dropQueryText(body).split('\n').map((l) => indent + l)].join('\n');
}

function dropQueryText(plan) {
  const lines = plan.split('\n');
  const start = lines.findIndex((l) => /^\S.*\(cost=/.test(l));
  return (start === -1 ? lines : lines.slice(start)).join('\n');
}

/** The IO waits of one statement, as one compact line per wait event. */
export function formatWaits(io, { indent = '  ' } = {}) {
  if (io?.deferred) return `${indent}waits: deferred — inside a transaction block they land on the COMMIT`;
  if (!io || !io.waits.length) return `${indent}waits: none (${io?.hits ?? 0} buffer hits)`;
  const lines = io.waits.map(
    (wait) =>
      `${indent}  IO:${wait.waitEvent} [${wait.context}] ` +
      `${wait.count}× ${wait.timeMs} ms${wait.bytes ? ` ${formatBytes(wait.bytes)}` : ''}`,
  );
  return [`${indent}waits: ${io.totalMs} ms over ${io.waits.length} event(s), ${io.hits} buffer hits`, ...lines].join('\n');
}

/** The accumulated wait profile, with the description from pg_wait_events. */
export function formatWaitProfile(rows, { maxWidth = 52 } = {}) {
  if (!rows.length) return '(no waits recorded — run with wait measurement enabled)';
  return formatTable(
    rows.map((row) => ({
      wait_event: `${row.type}:${row.waitEvent}`,
      context: row.context,
      count: row.count,
      total_ms: row.timeMs,
      bytes: row.bytes ? formatBytes(row.bytes) : '',
      description: row.description,
    })),
    { maxRows: rows.length, maxWidth },
  );
}

/** Rows out of pg_wait_events. */
export function formatWaitEvents(rows, { maxWidth = 70 } = {}) {
  if (!rows.length) return '(no wait event matches)';
  return formatTable(rows, { maxRows: rows.length, maxWidth, fields: ['type', 'name', 'description'] });
}

export function formatBytes(bytes) {
  const units = ['B', 'kB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/** A single statement outcome: header, result rows, plans. */
export function formatOutcome(outcome, { index, total, maxRows = 20, showPlans = true, showWaits = false } = {}) {
  const position = index && total ? `[${index}/${total}] ` : '';
  const out = [`${position}${summarize(outcome.sql, 100)}   (${outcome.elapsedMs.toFixed(1)} ms)`];

  if (outcome.error) {
    out.push(`  ERROR: ${outcome.error.message}`);
    return out.join('\n');
  }

  for (const result of outcome.results) {
    if (result?.rows?.length) out.push(indentBlock(formatTable(result.rows, { maxRows }), '  '));
    else if (result?.affectedRows) out.push(`  ${result.affectedRows} row(s) affected`);
  }

  if (showPlans) for (const plan of outcome.plans) out.push(formatPlan(plan));
  if (showWaits && outcome.io) out.push(formatWaits(outcome.io));
  return out.join('\n');
}

/** The pg_stat_statements report. */
export function formatStatements(rows, { maxWidth = 70 } = {}) {
  if (!rows.length) return '(pg_stat_statements is empty)';
  const compact = rows.map((row) => ({
    calls: row.calls,
    total_ms: row.total_ms,
    mean_ms: row.mean_ms,
    max_ms: row.max_ms,
    rows: row.rows,
    hit: row.blks_hit,
    read: row.blks_read,
    level: row.level,
    query: summarize(row.query, maxWidth),
  }));
  return formatTable(compact, { maxRows: rows.length, maxWidth });
}

export function heading(text, width = 78) {
  const bar = '═'.repeat(width);
  return `\n${bar}\n  ${text}\n${bar}`;
}

function indentBlock(text, indent) {
  return text.split('\n').map((line) => indent + line).join('\n');
}

function clip(text, max) {
  const flat = text.replace(/\s+/g, ' ');
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
