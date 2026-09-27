/*
 * Pseudocode parser: source text -> AST.
 *
 * Blocks are delimited by indentation only: a compound statement owns the
 * lines indented below it, and its block ends where the indentation does.
 *
 * AST node shapes:
 *   { type: 'action', text, line }
 *   { type: 'if', branches: [{ cond, body, line }], elseBody: Stmt[] | null, line }
 *   { type: 'while', cond, body, iterate?: true, line }   (iterate: FOR loop)
 *   { type: 'doWhile', body, cond, line }                  (DO ... WHILE cond)
 *   { type: 'return', text: string | null, line }
 *   { type: 'frame', title, body, line }                   (named frame; may nest)
 */
(function () {
  'use strict';
  const P2U = (globalThis.P2U = globalThis.P2U || {});

  const RE = {
    frame: /^frame\s+(.+)$/i,
    ifStmt: /^if\s+(.+)$/i,
    elif: /^elif\s+(.+)$/i,
    elseStmt: /^else$/i,
    elseIf: /^(else\s*if|elsif)\s+(.+)$/i, // not supported: reported with a pointer to ELIF
    strayElse: /^(?:else|elif)\b/i,
    forStmt: /^(for)\s+(.+)$/i,
    whileStmt: /^while\s+(.+)$/i,
    doStmt: /^do$/i,
    doEnd: /^while\s+(.+)$/i,
    returnStmt: /^return\b\s*(.*)$/i,
    trailingThen: /\s+then$/i,
    endLine: /^end(?:\s*(?:if|while|for|do|frame))?$/i, // leftovers from terminator-style code
    unsupported: /^(break|continue|goto|switch|case|try|catch)\b/i,
  };

  /** Strip `//` comments (outside double quotes) and whole-line `#` comments. */
  function stripComment(text) {
    if (/^\s*#/.test(text)) return '';
    let inQuote = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '"') inQuote = !inQuote;
      else if (!inQuote && c === '/' && text[i + 1] === '/') return text.slice(0, i);
    }
    return text;
  }

  /** Drop an optional trailing colon or semicolon. */
  function normalize(text) {
    return text.replace(/\s*[;:]$/, '').trim();
  }

  /** "(a > b)" -> "a > b", but leave "(a) and (b)" alone. */
  function unwrapParens(text) {
    const t = text.trim();
    if (!t.startsWith('(') || !t.endsWith(')')) return t;
    let depth = 0;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '(') depth++;
      else if (t[i] === ')') depth--;
      if (depth === 0 && i < t.length - 1) return t;
    }
    return t.slice(1, -1).trim();
  }

  function action(text, line) {
    return { type: 'action', text: text.replace(/<-/g, '←'), line };
  }

  function cond(text) {
    return unwrapParens(normalize(text));
  }

  /**
   * Split into non-empty lines. Indentation is the number of leading
   * whitespace characters, so a tab is one character, same as a space.
   * Also returns the first line whose indentation character (tab vs space)
   * differs from earlier lines, since mixing them nests surprisingly.
   */
  function toLines(source) {
    const out = [];
    let style = null;
    let mixedLine = null;
    source.replace(/\r\n?/g, '\n').split('\n').forEach((raw, i) => {
      const text = stripComment(raw);
      if (!text.trim()) return;
      const lead = text.match(/^[ \t]*/)[0];
      const body = normalize(text.trim());
      if (!body) return;
      for (const ch of new Set(lead)) {
        if (style === null) style = ch;
        else if (ch !== style && mixedLine === null) mixedLine = i + 1;
      }
      out.push({ indent: lead.length, text: body, line: i + 1 });
    });
    return { lines: out, mixedLine };
  }

  class Parser {
    constructor(lines) {
      this.lines = lines;
      this.i = 0;
      this.diagnostics = [];
    }

    peek(offset = 0) {
      return this.lines[this.i + offset];
    }

    report(line, severity, message) {
      this.diagnostics.push({ line, severity, message });
    }

    /** Parse statements at `indent` until the indentation drops below it. */
    parseBlock(indent) {
      const stmts = [];
      let terminated = null;
      while (this.i < this.lines.length) {
        const ln = this.peek();
        if (ln.indent < indent) break;
        if (ln.indent > indent) {
          this.report(ln.line, 'warning', 'Unexpected indentation');
          stmts.push(...this.parseBlock(ln.indent));
          continue;
        }
        const parsed = this.parseStatement();
        if (terminated && parsed.length) {
          this.report(ln.line, 'warning', `Unreachable: follows RETURN on line ${terminated.line}`);
          terminated = null; // report once per block
        }
        for (const s of parsed) {
          stmts.push(s);
          if (s.type === 'return') terminated = s;
        }
      }
      return stmts;
    }

    /** Parse the indented block that belongs to `header`. */
    parseBody(header, keyword) {
      const next = this.peek();
      if (next && next.indent > header.indent) return this.parseBlock(next.indent);
      this.report(header.line, 'warning', `Empty ${keyword}: indent the lines that belong to it`);
      return [];
    }

    parseStatement() {
      const ln = this.peek();
      const t = ln.text;
      let m;
      this.i++;

      if ((m = t.match(RE.frame))) {
        return [{ type: 'frame', title: normalize(m[1]), body: this.parseBody(ln, 'FRAME'), line: ln.line }];
      }

      if (RE.strayElse.test(t)) {
        const kw = t.split(/\s+/)[0].toUpperCase();
        this.report(ln.line, 'error', `${kw} must directly follow an IF block at the same indentation, alone on its line`);
        return [];
      }

      if ((m = t.match(RE.ifStmt))) return [this.parseIf(ln, m[1])];

      if ((m = t.match(RE.whileStmt))) {
        return [{ type: 'while', cond: cond(m[1]), body: this.parseBody(ln, 'WHILE'), line: ln.line }];
      }

      if ((m = t.match(RE.forStmt))) {
        const body = this.parseBody(ln, 'FOR');
        return [{ type: 'while', cond: `${m[1]} ${cond(m[2])}`, body, iterate: true, line: ln.line }];
      }

      if (RE.doStmt.test(t)) return [this.parseDoWhile(ln)];

      if ((m = t.match(RE.returnStmt))) {
        return [{ type: 'return', text: m[1] ? t : null, line: ln.line }];
      }

      if (RE.endLine.test(t)) {
        this.report(ln.line, 'warning', 'END is not a keyword; blocks end where their indentation does');
      } else if ((m = t.match(RE.unsupported))) {
        this.report(ln.line, 'warning', `${m[1].toUpperCase()} is not supported yet; drawn as a plain action`);
      }

      return [action(t, ln.line)];
    }

    /** Condition of an IF / ELIF header, flagging a leftover THEN. */
    condition(text, line) {
      if (RE.trailingThen.test(text)) {
        this.report(line, 'warning', 'THEN is not a keyword; it is shown as part of the condition');
      }
      return cond(text);
    }

    parseIf(ln, condText) {
      const node = { type: 'if', branches: [], elseBody: null, line: ln.line };
      const addBranch = (header, text, keyword) => {
        node.branches.push({ cond: this.condition(text, header.line), body: this.parseBody(header, keyword), line: header.line });
      };

      addBranch(ln, condText, 'IF');

      let next;
      while ((next = this.peek()) && next.indent === ln.indent) {
        let mm;
        if ((mm = next.text.match(RE.elif))) {
          this.i++;
          addBranch(next, mm[1], 'ELIF');
        } else if ((mm = next.text.match(RE.elseIf))) {
          // Recover as ELIF so the rest of the diagram still makes sense.
          this.report(next.line, 'error', `Use ELIF instead of ${mm[1].toUpperCase()}`);
          this.i++;
          addBranch(next, mm[2], 'ELIF');
        } else if (RE.elseStmt.test(next.text)) {
          this.i++;
          node.elseBody = this.parseBody(next, 'ELSE');
          break;
        } else break;
      }
      return node;
    }

    parseDoWhile(ln) {
      const body = this.parseBody(ln, 'DO');
      const end = this.peek();
      // `WHILE cond` closes the DO block unless it has an indented body of its own.
      const after = this.peek(1);
      let m;
      if (end && end.indent === ln.indent && (m = end.text.match(RE.doEnd)) && !(after && after.indent > end.indent)) {
        this.i++;
        return { type: 'doWhile', body, cond: cond(m[1]), line: ln.line };
      }
      this.report(ln.line, 'error', 'DO without a closing WHILE');
      return { type: 'doWhile', body, cond: '?', line: ln.line };
    }
  }

  /**
   * @param {string} source
   * @returns {{ body: object[], diagnostics: {line:number, severity:string, message:string}[] }}
   */
  function parse(source) {
    const { lines, mixedLine } = toLines(source);
    const parser = new Parser(lines);
    if (mixedLine !== null) {
      parser.report(mixedLine, 'warning', 'Indentation mixes tabs and spaces; each counts as one character');
    }
    const body = lines.length ? parser.parseBlock(lines[0].indent) : [];
    // A dedent below the first line's indent leaves lines unread; keep going.
    while (parser.i < lines.length) {
      body.push(...parser.parseBlock(parser.peek().indent));
    }
    return { body, diagnostics: parser.diagnostics };
  }

  P2U.parse = parse;
})();
