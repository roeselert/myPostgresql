/**
 * Splitting a SQL script into single statements.
 *
 * The test beds run scripts statement by statement so that every
 * `auto_explain` plan and every `pg_stat_statements` entry can be attributed
 * to the statement that produced it. Sending the whole file in one `exec()`
 * works too, but then the "Query Text" of every plan is the entire file.
 *
 * The splitter understands the lexical constructs that may legally contain a
 * semicolon: line comments, (nestable) block comments, single quoted strings
 * including the `E'..\\..'` escape form, quoted identifiers and dollar quoted
 * bodies such as `$$ .. $$` or `$func$ .. $func$`.
 */

const DOLLAR_TAG = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;

export function splitSql(sql) {
  const statements = [];
  let buf = '';
  let i = 0;

  const push = () => {
    const trimmed = buf.trim();
    if (trimmed && !isCommentOnly(trimmed)) statements.push(trimmed);
    buf = '';
  };

  while (i < sql.length) {
    const ch = sql[i];
    const two = sql.slice(i, i + 2);

    if (two === '--') {
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? sql.length : nl + 1;
      buf += sql.slice(i, end);
      i = end;
      continue;
    }

    if (two === '/*') {
      const end = skipBlockComment(sql, i);
      buf += sql.slice(i, end);
      i = end;
      continue;
    }

    if (ch === "'" || ch === '"') {
      // `E'...'` (and `e'...'`) treats the backslash as an escape character,
      // plain strings do not (standard_conforming_strings is on).
      const escapes = ch === "'" && /(^|[^A-Za-z0-9_$])[Ee]$/.test(buf);
      const end = skipQuoted(sql, i, ch, escapes);
      buf += sql.slice(i, end);
      i = end;
      continue;
    }

    if (ch === '$') {
      const match = DOLLAR_TAG.exec(sql.slice(i));
      // `$1` and `a$b` are not dollar quotes; the regex only matches `$tag$`.
      if (match && !/[A-Za-z0-9_$]/.test(sql[i - 1] ?? '')) {
        const tag = match[0];
        const close = sql.indexOf(tag, i + tag.length);
        const end = close === -1 ? sql.length : close + tag.length;
        buf += sql.slice(i, end);
        i = end;
        continue;
      }
    }

    if (ch === ';') {
      push();
      i += 1;
      continue;
    }

    buf += ch;
    i += 1;
  }

  push();
  return statements;
}

function skipBlockComment(sql, start) {
  let depth = 0;
  let i = start;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (two === '/*') {
      depth += 1;
      i += 2;
    } else if (two === '*/') {
      depth -= 1;
      i += 2;
      if (depth === 0) return i;
    } else {
      i += 1;
    }
  }
  return sql.length;
}

function skipQuoted(sql, start, quote, escapes) {
  let i = start + 1;
  while (i < sql.length) {
    const ch = sql[i];
    if (escapes && ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) {
      if (sql[i + 1] === quote) {
        i += 2; // doubled quote is an escaped quote
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return sql.length;
}

/** True when the fragment carries no executable SQL, only comments. */
export function isCommentOnly(sql) {
  return stripComments(sql).trim() === '';
}

export function stripComments(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === '--') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl;
      continue;
    }
    if (two === '/*') {
      i = skipBlockComment(sql, i);
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = skipQuoted(sql, i, ch, ch === "'" && /[Ee]$/.test(out));
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** First meaningful line of a statement, for compact log headers. */
export function summarize(sql, maxLength = 90) {
  const oneLine = stripComments(sql).replace(/\s+/g, ' ').trim() || sql.replace(/\s+/g, ' ').trim();
  return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength - 1)}…` : oneLine;
}
