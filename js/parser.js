/*
 * Pseudocode parser: source text -> AST.
 *
 * Blocks are delimited by indentation only: a compound statement owns the
 * lines indented below it, and its block ends where the indentation does.
 *
 * AST node shapes:
 *   { type: 'action', text, calls?: [frameName], line }
 *   { type: 'if', branches: [{ cond, body, line }], elseBody: Stmt[] | null, line }
 *   { type: 'while', cond, body, iterate?: true, line }   (iterate: FOR loop)
 *   { type: 'doWhile', body, cond, line }                  (DO ... WHILE cond)
 *   { type: 'start', line }                                (initial node)
 *   { type: 'end', value?: string, line }                  (activity final node; END x ends with x)
 *   { type: 'frame', title, name: string | null, body, line }   (DEF)
 *
 * A DEF is a definition, not a step in the surrounding flow. Its `name` is
 * the identifier its title starts with (`fib` for `DEF fib(n, d)`); an action
 * whose text uses `name(` is a call to it and lists it in `calls`.
 */
(function () {
  'use strict';
  const P2U = (globalThis.P2U = globalThis.P2U || {});

  const RE = {
    def: /^def\s+(.+)$/i,
    ifStmt: /^if\s+(.+)$/i,
    elif: /^elif\s+(.+)$/i,
    elseStmt: /^else$/i,
    elseIf: /^(else\s*if|elsif)\s+(.+)$/i, // not supported: reported with a pointer to ELIF
    strayElse: /^(?:else|elif)\b/i,
    forStmt: /^(for)\s+(.+)$/i,
    whileStmt: /^while\s+(.+)$/i,
    doStmt: /^do$/i,
    doEnd: /^while\s+(.+)$/i,
    start: /^start$/i,
    end: /^end(?:\s+(.+))?$/i,
    frameName: /^([A-Za-z_]\w*)\s*(?:\(|$)/, // `fib(n, d)` -> fib, `Main` -> Main
    trailingThen: /\s+then$/i,
    endLine: /^end\s*(?:if|while|for|do|def|frame)$/i, // leftovers from terminator-style code
    // Old keywords that were renamed: warn and point at the new one.
    renamed: /^(frame|return)\b/i,
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

    /**
     * Parse statements at `indent` until the indentation drops below it.
     * `allowStart`: START may open this block (the program or a DEF body).
     */
    parseBlock(indent, allowStart = false) {
      const stmts = [];
      let terminated = null;
      let steps = 0; // flow statements so far (DEF definitions don't count)
      while (this.i < this.lines.length) {
        const ln = this.peek();
        if (ln.indent < indent) break;
        if (ln.indent > indent) {
          this.report(ln.line, 'warning', 'Unexpected indentation');
          stmts.push(...this.parseBlock(ln.indent));
          continue;
        }
        const parsed = this.parseStatement();
        for (const s of parsed) {
          if (s.type === 'frame') {
            stmts.push(s);
            continue;
          }
          if (s.type === 'start' && (!allowStart || steps > 0)) {
            this.report(s.line, 'warning', 'START belongs at the beginning of the program or of a DEF; nothing can flow into it');
          }
          if (terminated) {
            this.report(s.line, 'warning', `Unreachable: follows ${terminated.type.toUpperCase()} on line ${terminated.line}`);
            terminated = null; // report once per block
          }
          stmts.push(s);
          steps++;
          if (s.type === 'end') terminated = s;
        }
      }
      return stmts;
    }

    /** Parse the indented block that belongs to `header`. */
    parseBody(header, keyword) {
      const next = this.peek();
      if (next && next.indent > header.indent) return this.parseBlock(next.indent, keyword === 'DEF');
      this.report(header.line, 'warning', `Empty ${keyword}: indent the lines that belong to it`);
      return [];
    }

    parseStatement() {
      const ln = this.peek();
      const t = ln.text;
      let m;
      this.i++;

      if ((m = t.match(RE.def))) {
        const title = normalize(m[1]);
        const name = (title.match(RE.frameName) || [])[1] || null;
        return [{ type: 'frame', title, name, body: this.parseBody(ln, 'DEF'), line: ln.line }];
      }

      if (RE.start.test(t)) return [{ type: 'start', line: ln.line }];

      // `END IF` and friends are terminator-style leftovers, not `END <value>`.
      if (RE.endLine.test(t)) {
        this.report(ln.line, 'warning', `${t.toUpperCase()} is not a keyword; blocks end where their indentation does (END alone is an end node)`);
        return [action(t, ln.line)];
      }
      if ((m = t.match(RE.end))) {
        return [m[1] ? { type: 'end', value: m[1].trim(), line: ln.line } : { type: 'end', line: ln.line }];
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

      if ((m = t.match(RE.renamed))) {
        const kw = m[1].toUpperCase();
        this.report(ln.line, 'warning', `${kw} is not a keyword; use ${kw === 'FRAME' ? 'DEF' : 'END'} instead`);
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

  /** Every statement in the tree, depth first. */
  function* walk(stmts) {
    for (const s of stmts) {
      yield s;
      if (s.body) yield* walk(s.body);
      if (s.branches) for (const b of s.branches) yield* walk(b.body);
      if (s.elseBody) yield* walk(s.elseBody);
    }
  }

  /**
   * Mark actions that call a DEF: their text uses `name(` where
   * `name` is a frame's name. Frames can be called before they're defined and
   * can call themselves (recursion).
   */
  function annotateCalls(body, parser) {
    const frames = new Map();
    for (const s of walk(body)) {
      if (s.type !== 'frame' || !s.name) continue;
      const first = frames.get(s.name);
      if (first) {
        parser.report(s.line, 'warning', `Another DEF is already named ${s.name} (line ${first.line}); calls go to that one`);
      } else frames.set(s.name, s);
    }
    if (!frames.size) return;
    const patterns = [...frames.keys()].map((name) => [name, new RegExp(`(?:^|[^\\w.])${name}\\s*\\(`)]);
    for (const s of walk(body)) {
      if (s.type !== 'action') continue;
      const calls = patterns.filter(([, re]) => re.test(s.text)).map(([name]) => name);
      if (calls.length) s.calls = calls;
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
    const body = lines.length ? parser.parseBlock(lines[0].indent, true) : [];
    // A dedent below the first line's indent leaves lines unread; keep going.
    while (parser.i < lines.length) {
      body.push(...parser.parseBlock(parser.peek().indent, true));
    }
    annotateCalls(body, parser);
    return { body, diagnostics: parser.diagnostics };
  }

  P2U.parse = parse;
})();
