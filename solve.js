// A fast drop-in for csv-reader 1.0.0: run(input) returns exactly what csv-reader
// returns for {text, header} as {columns, rows, errors}, but without reading the
// text one character at a time.
//
// How it stays identical: it follows the same broken-row policy, in the same
// order, with the same error records. A U+FEFF at the very start is dropped. A
// record ends at LF or CRLF, and a line left with no characters is no record.
// Outside quotes a CR not followed by LF is dropped (stray_cr). A field that
// opens with a quote runs to the next quote that is not doubled ("" inside it is
// one quote, each CRLF or lone CR inside it is read as LF); what follows its
// closing quote, up to the next comma or line break, is appended as it stands
// (quote_junk, when the field ends); a quote that never closes is a literal
// character, and the text after it is read again as unquoted
// (unterminated_quote). A quote inside an unquoted field is a literal character.
// Fields stay strings, never trimmed or converted. columns is the first record
// when header is true, else null; rows holds the records after it, each padded
// with "" (short_row, with fields: its field count) or cut (long_row, with
// extra: the cut fields) to the first record's width. Each error is
// {code, line, row}, in the order met; line is the 1-based line its record
// starts on, counting every LF, CRLF and lone CR inside quotes, and row is its
// record's index in rows, null for the header.
//
// How it is fast: the reference builds every field a character at a time. This
// one never does that on the common path. A record with no quote on its line
// and no stray CR is cut out whole and split once by the native split. Any
// other unquoted field is cut out with two native indexOf searches (the next
// comma and the next LF) plus one slice, and a quoted field with one native
// indexOf search for its closing quote, its body copied with a single slice
// and only transformed when it actually holds a doubled quote or a line break.
// The slow work is kept for the rare cases only: stray CRs, junk after a
// closing quote, and a quote that never closes. Line numbers are tracked the
// same way, but a quoted field's inner line breaks are counted from its copied
// body instead of one character at a time.

// Delimiters of an unquoted field, used by the slow path only.
const DELIM = /[,\r\n]/g;
// One line break inside a quoted field: CRLF counts once, a lone CR once, LF once.
const BREAKS = /\r\n|\r|\n/g;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes.
  let recordLine = 1;
  let recordRow = null;

  // Reads unquoted characters onto `value` up to the next comma or line break,
  // dropping a CR not followed by LF (stray_cr). Returns the field, how it
  // ended, and how many characters were kept. Only used where the fast paths
  // cannot run: a field holding a stray CR, junk after a closing quote, and
  // the re-read of a quote that never closes.
  function readUnquoted(value) {
    let added = 0;
    while (pos < n) {
      DELIM.lastIndex = pos;
      const m = DELIM.exec(text);
      if (m === null) {
        added += n - pos;
        value += text.slice(pos);
        pos = n;
        return { value, ended: 2, added };
      }
      const d = m.index;
      if (d > pos) {
        added += d - pos;
        value += text.slice(pos, d);
      }
      const c = text.charCodeAt(d);
      if (c === 44) {
        pos = d + 1;
        return { value, ended: 0, added };
      }
      if (c === 10) {
        pos = d + 1;
        line += 1;
        return { value, ended: 1, added };
      }
      if (text.charCodeAt(d + 1) === 10) {
        pos = d + 2;
        line += 1;
        return { value, ended: 1, added };
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      pos = d + 1;
    }
    return { value, ended: 2, added };
  }

  // Finishes a record: the header is kept as columns, any other record is
  // padded or cut to the first record's width, with its short_row or long_row
  // error, and pushed to rows.
  function commit(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: a record with no quote on its line and no stray CR. Its line
    // is cut out whole and split once. A CR is only allowed as the line's last
    // character, where it belongs to a CRLF ending.
    const nl = text.indexOf('\n', pos);
    if (nl !== -1) {
      const qi = text.indexOf('"', pos);
      if (qi === -1 || qi > nl) {
        const seg = text.slice(pos, nl);
        const ri = seg.indexOf('\r');
        if (ri === -1 || ri === seg.length - 1) {
          const body = ri === seg.length - 1 ? seg.slice(0, -1) : seg;
          pos = nl + 1;
          line += 1;
          if (body.length !== 0) commit(body.split(','));
          continue;
        }
      }
    } else {
      const qi = text.indexOf('"', pos);
      if (qi === -1) {
        const seg = text.slice(pos);
        if (seg.indexOf('\r') === -1) {
          pos = n;
          commit(seg.split(','));
          continue;
        }
      }
    }

    const fields = [];
    let ended = 0; // 0: comma, the record goes on; 1: line break; 2: end of text
    let quoted = false; // whether the last field read opened with a quote

    do {
      let value;
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        const open = pos;
        const openLine = line;
        // The closing quote is the next quote not followed by another quote.
        let q = text.indexOf('"', pos + 1);
        let doubled = false;
        while (q !== -1 && text.charCodeAt(q + 1) === 34) {
          doubled = true;
          q = text.indexOf('"', q + 2);
        }
        if (q === -1) {
          // The quote never closes: it is a literal character, and the text
          // after it is read again as unquoted.
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          pos = open + 1;
          line = openLine;
          const r = readUnquoted('"');
          value = r.value;
          ended = r.ended;
        } else {
          let body = text.slice(pos + 1, q);
          if (doubled) body = body.replaceAll('""', '"');
          if (body.indexOf('\n') !== -1 || body.indexOf('\r') !== -1) {
            const breaks = body.match(BREAKS);
            if (breaks !== null) line += breaks.length;
            if (body.indexOf('\r') !== -1) value = body.replace(/\r\n?/g, '\n');
            else value = body;
          } else {
            value = body;
          }
          pos = q + 1;
          if (pos >= n) {
            ended = 2;
          } else {
            const c = text.charCodeAt(pos);
            if (c === 44) {
              pos += 1;
              ended = 0;
            } else if (c === 10) {
              pos += 1;
              line += 1;
              ended = 1;
            } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
              pos += 2;
              line += 1;
              ended = 1;
            } else {
              // What follows the closing quote is appended as it stands, up
              // to the next comma or line break.
              const r = readUnquoted(value);
              value = r.value;
              ended = r.ended;
              if (r.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
            }
          }
        }
      } else {
        quoted = false;
        // An unquoted field ends at the nearer of the next comma and the next
        // LF; a CR inside it (other than a CRLF line ending) goes slow.
        const ci = text.indexOf(',', pos);
        const li = text.indexOf('\n', pos);
        if (ci === -1 && li === -1) {
          const v = text.slice(pos);
          if (v.indexOf('\r') === -1) {
            value = v;
            pos = n;
            ended = 2;
          } else {
            const r = readUnquoted('');
            value = r.value;
            ended = r.ended;
          }
        } else if (ci !== -1 && (li === -1 || ci < li)) {
          const v = text.slice(pos, ci);
          if (v.indexOf('\r') === -1) {
            value = v;
            pos = ci + 1;
            ended = 0;
          } else {
            const r = readUnquoted('');
            value = r.value;
            ended = r.ended;
          }
        } else {
          const v = text.slice(pos, li);
          if (v.charCodeAt(v.length - 1) === 13) {
            // CRLF line ending: the CR belongs to the break, but a CR
            // earlier in the field is still a stray one, so check the rest.
            const w = v.slice(0, -1);
            if (w.indexOf('\r') === -1) {
              value = w;
              pos = li + 1;
              line += 1;
              ended = 1;
            } else {
              const r = readUnquoted('');
              value = r.value;
              ended = r.ended;
            }
          } else if (v.indexOf('\r') === -1) {
            value = v;
            pos = li + 1;
            line += 1;
            ended = 1;
          } else {
            const r = readUnquoted('');
            value = r.value;
            ended = r.ended;
          }
        }
      }
      fields.push(value);
    } while (ended === 0);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    commit(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
