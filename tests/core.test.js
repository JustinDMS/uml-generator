// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');

require('../js/parser.js');
require('../js/layout.js');
require('../js/render.js');
require('../js/export.js');
require('../js/examples.js');
const { parse, layout, render, examples } = globalThis.P2U;

const strip = (ast) => JSON.parse(JSON.stringify(ast, (k, v) => (k === 'line' ? undefined : v)));
const errors = (ast) => ast.diagnostics.filter((d) => d.severity === 'error');

test('plain lines become actions', () => {
  const ast = parse('read x\nprint x * 2');
  assert.deepEqual(strip(ast.body), [
    { type: 'action', text: 'read x' },
    { type: 'action', text: 'print x * 2' },
  ]);
  assert.equal(ast.diagnostics.length, 0);
});

test('comments and blank lines are ignored', () => {
  const ast = parse('# header comment\n\nx <- 1 // set x\n');
  assert.deepEqual(strip(ast.body), [{ type: 'action', text: 'x ← 1' }]);
});

test('indented if / elif / else', () => {
  const ast = parse(`IF a
    one
ELIF b
    two
ELSE
    three`);
  assert.deepEqual(strip(ast.body), [
    {
      type: 'if',
      branches: [
        { cond: 'a', body: [{ type: 'action', text: 'one' }] },
        { cond: 'b', body: [{ type: 'action', text: 'two' }] },
      ],
      elseBody: [{ type: 'action', text: 'three' }],
    },
  ]);
  assert.equal(ast.diagnostics.length, 0);
});

test('optional trailing colons and wrapping parentheses', () => {
  const py = parse('if (x > 0):\n    print x\nelse:\n    print 0');
  assert.equal(py.body[0].branches[0].cond, 'x > 0');
  assert.equal(py.body[0].elseBody.length, 1);
  assert.equal(py.diagnostics.length, 0);
});

test('THEN is not a keyword: it stays in the condition, with a warning', () => {
  const ast = parse('IF x < 0 THEN\n\tx <- -x');
  assert.equal(ast.body[0].branches[0].cond, 'x < 0 THEN');
  assert.ok(ast.diagnostics.some((d) => d.severity === 'warning' && /THEN/.test(d.message)));
});

test('ELSE IF is rejected in favour of ELIF, but still drawn as a branch', () => {
  const ast = parse('IF a\n\tone\nELSE IF b\n\ttwo');
  assert.ok(errors(ast).some((d) => d.line === 3 && /ELIF/.test(d.message)));
  assert.deepEqual(ast.body[0].branches.map((b) => b.cond), ['a', 'b']);
});

test('ELSEIF and ELSIF get the same pointer to ELIF', () => {
  for (const kw of ['ELSEIF', 'ELSIF']) {
    const ast = parse(`IF a\n\tone\n${kw} b\n\ttwo`);
    assert.ok(errors(ast).some((d) => d.message === `Use ELIF instead of ${kw}`), kw);
  }
});

test('inline ELSE is not supported', () => {
  const ast = parse('IF a\n\tone\nELSE two');
  assert.equal(ast.body[0].elseBody, null);
  assert.ok(errors(ast).some((d) => d.line === 3));
});

test('unindented bodies are empty blocks, not terminator mode', () => {
  const ast = parse('WHILE x\nx = x - 1\nEND WHILE');
  assert.deepEqual(strip(ast.body[0]), { type: 'while', cond: 'x', body: [] });
  assert.ok(ast.diagnostics.some((d) => d.line === 1 && /Empty WHILE/.test(d.message)));
  // END is plain text now, with a hint.
  assert.deepEqual(strip(ast.body[2]), { type: 'action', text: 'END WHILE' });
  assert.ok(ast.diagnostics.some((d) => d.line === 3 && /END is not a keyword/.test(d.message)));
});

test('END only warns as a whole line, not inside ordinary actions', () => {
  assert.equal(parse('end session').diagnostics.length, 0);
  for (const src of ['END', 'END IF', 'endwhile', 'End For']) {
    assert.ok(parse(src).diagnostics.some((d) => /END is not a keyword/.test(d.message)), src);
  }
});

test('FOR takes any header text; TO is not special', () => {
  const ast = parse('FOR i = 1 TO n\n\tvisit i');
  assert.deepEqual(strip(ast.body), [
    { type: 'while', cond: 'FOR i = 1 TO n', body: [{ type: 'action', text: 'visit i' }], iterate: true },
  ]);
  assert.equal(parse('FOR x IN xs\n\tvisit x').body[0].cond, 'FOR x IN xs');
});

test('braces are not block delimiters', () => {
  const ast = parse('IF x {\n\ty\n}');
  assert.equal(ast.body[0].branches[0].cond, 'x {');
  assert.deepEqual(strip(ast.body[1]), { type: 'action', text: '}' });
});

test('DO … WHILE', () => {
  const d = parse('DO\n    step\nWHILE more');
  assert.deepEqual(strip(d.body), [{ type: 'doWhile', body: [{ type: 'action', text: 'step' }], cond: 'more' }]);
  assert.equal(d.diagnostics.length, 0);

  // A WHILE with its own indented body after a DO block is a new loop, not a terminator.
  const e = parse('DO\n    step\nWHILE more\n    other');
  assert.ok(errors(e).some((x) => /DO without a closing WHILE/.test(x.message)));
});

test('REPEAT, UNTIL and STOP are not keywords', () => {
  const ast = parse('REPEAT\nUNTIL done\nSTOP');
  assert.deepEqual(strip(ast.body), [
    { type: 'action', text: 'REPEAT' },
    { type: 'action', text: 'UNTIL done' },
    { type: 'action', text: 'STOP' },
  ]);
  assert.equal(ast.diagnostics.length, 0);
});

test('FRAME sets the title and unreachable code is flagged', () => {
  const ast = parse('FRAME Demo\n    RETURN 1\n    print "never"');
  assert.equal(ast.title, 'Demo');
  assert.equal(ast.body[0].type, 'return');
  assert.equal(ast.body.length, 2);
  assert.ok(ast.diagnostics.some((d) => /Unreachable/.test(d.message)));
});

test('only FRAME creates a frame (DEF, FUNCTION, ALGORITHM are plain actions)', () => {
  for (const kw of ['def', 'FUNCTION', 'ALGORITHM', 'PROCEDURE']) {
    const ast = parse(`${kw} foo`);
    assert.equal(ast.title, null, kw);
    assert.deepEqual(strip(ast.body), [{ type: 'action', text: `${kw} foo` }]);
  }
});

test('a tab is one indentation character', () => {
  const ast = parse('IF a\n\tone\n\tIF b\n\t\ttwo\n\tthree\nfour');
  assert.equal(ast.diagnostics.length, 0, JSON.stringify(ast.diagnostics));
  const outer = ast.body[0];
  assert.equal(outer.branches[0].body.length, 3);
  assert.equal(outer.branches[0].body[1].type, 'if');
  assert.deepEqual(strip(ast.body[1]), { type: 'action', text: 'four' });
});

test('mixing tabs and spaces is flagged', () => {
  const ast = parse('IF a\n\tone\n    two');
  assert.ok(ast.diagnostics.some((d) => d.line === 3 && /tabs and spaces/.test(d.message)));
});

test('stray ELSE and ELIF are errors', () => {
  assert.ok(errors(parse('ELSE\nx')).length > 0);
  assert.ok(errors(parse('ELIF x\n\ty')).length > 0);
});

// ------------------------------------------------------------------ layout

function checkGeometry(d) {
  for (const n of d.nodes) {
    for (const v of [n.x, n.y, n.w, n.h]) assert.ok(Number.isFinite(v), `bad node ${JSON.stringify(n)}`);
    assert.ok(n.x - n.w / 2 >= -0.01 && n.x + n.w / 2 <= d.width + 0.01, `node outside width: ${n.kind}`);
    assert.ok(n.y - n.h / 2 >= -0.01 && n.y + n.h / 2 <= d.height + 0.01, `node outside height: ${n.kind}`);
  }
  for (let i = 0; i < d.nodes.length; i++) {
    for (let j = i + 1; j < d.nodes.length; j++) {
      const [a, b] = [d.nodes[i], d.nodes[j]];
      const apart = Math.abs(a.x - b.x) >= (a.w + b.w) / 2 || Math.abs(a.y - b.y) >= (a.h + b.h) / 2;
      assert.ok(apart, `nodes overlap: ${a.kind}@${a.x},${a.y} and ${b.kind}@${b.x},${b.y}`);
    }
  }
  for (const e of d.edges) {
    assert.ok(e.points.length >= 2, 'edge needs 2+ points');
    for (let i = 1; i < e.points.length; i++) {
      const [a, b] = [e.points[i - 1], e.points[i]];
      assert.ok(a[0] === b[0] || a[1] === b[1], `non-orthogonal segment ${JSON.stringify(e.points)}`);
    }
    assert.ok(e.points.length - 2 <= 4, `more than 4 bends: ${JSON.stringify(e.points)}`);
    assert.ok(e.arrow, `edge without an arrowhead: ${JSON.stringify(e.points)}`);
  }
}

test('empty program is initial -> final', () => {
  const d = layout(parse(''));
  assert.deepEqual(d.nodes.map((n) => n.kind), ['initial', 'final']);
  assert.equal(d.edges.length, 1);
});

test('if without else gets a no path and a merge; condition sits in the diamond', () => {
  const d = layout(parse('IF a > b\n    x'));
  const kinds = d.nodes.map((n) => n.kind);
  assert.ok(kinds.includes('decision') && kinds.includes('merge'));
  assert.deepEqual(d.nodes.find((n) => n.kind === 'decision').lines, ['a > b']);
  assert.deepEqual(d.labels.map((l) => l.text).sort(), ['no', 'yes']);
  checkGeometry(d);
});

test('else-if chains become one decision per condition', () => {
  const d = layout(parse('IF a\n\tx\nELIF b\n\ty\nELIF c\n\tz\nELSE\n\tw'));
  const decisions = d.nodes.filter((n) => n.kind === 'decision');
  assert.deepEqual(decisions.map((n) => n.lines.join(' ')), ['a', 'b', 'c']);
  assert.deepEqual(decisions.map((n) => n.line), [1, 3, 5]);
  checkGeometry(d);
});

test('long conditions wrap and the diamond grows to contain them', () => {
  const d = layout(parse('WHILE the queue still has unprocessed items and the deadline has not passed\n\tstep'));
  const dec = d.nodes.find((n) => n.kind === 'decision');
  assert.ok(dec.lines.length > 1);
  const { lineHeight } = globalThis.P2U.layoutConfig;
  const tw = Math.max(...dec.lines.map((l) => l.length * 13 * 0.55)); // headless measure
  const th = dec.lines.length * lineHeight;
  assert.equal(dec.w, dec.h, 'decision diamonds are square');
  assert.ok(tw / 2 / (dec.w / 2) + th / 2 / (dec.h / 2) <= 1, 'text box corner lies inside the diamond');
});

test('WHILE loops back into its own decision, with no merge in front of it', () => {
  const d = layout(parse('WHILE a\n\tstep'));
  assert.ok(!d.nodes.some((n) => n.kind === 'merge'));
  const dec = d.nodes.find((n) => n.kind === 'decision');
  const leftVertex = [dec.x - dec.w / 2, dec.y];
  const into = d.edges.filter((e) => {
    const [x, y] = e.points[e.points.length - 1];
    return x === leftVertex[0] && y === leftVertex[1];
  });
  assert.equal(into.length, 1, "loop-back ends on the decision's left vertex");
  checkGeometry(d);
});

test('loop decisions and back edges are marked as loops; IF decisions are not', () => {
  const d = layout(parse('IF a\n\tx\nWHILE b\n\ty\nDO\n\tz\nWHILE c'));
  const decisions = d.nodes.filter((n) => n.kind === 'decision');
  assert.deepEqual(decisions.map((n) => [n.lines.join(' '), !!n.loop]), [['a', false], ['b', true], ['c', true]]);
  assert.equal(d.edges.filter((e) => e.kind === 'loop').length, 2);
  const svg = render(d);
  assert.equal((svg.match(/p2u-inner/g) || []).length, 2, 'loop decisions get an inner outline');
  assert.match(svg, /marker-end="url\(#p2u-arrow-loop\)"/);
});

test('elements are tagged with their enclosing loops for hover highlighting', () => {
  const d = layout(parse('before\nWHILE a\n\touter\n\tFOR x IN xs\n\t\tinner\nafter'));
  const loopsOf = (text) => d.nodes.find((n) => n.lines && n.lines[0] === text).loops;
  const [outerDec, innerDec] = ['a', 'FOR x IN xs'].map((t) => d.nodes.find((n) => n.kind === 'decision' && n.lines.join(' ') === t));
  assert.ok(outerDec.loopId && innerDec.loopId && outerDec.loopId !== innerDec.loopId);

  assert.equal(loopsOf('before'), undefined);
  assert.equal(loopsOf('after'), undefined);
  assert.deepEqual(loopsOf('outer'), [outerDec.loopId]);
  assert.deepEqual(loopsOf('inner'), [innerDec.loopId, outerDec.loopId]);

  // Each loop's back edge is a hover handle for that loop.
  const handles = d.edges.filter((e) => e.loopId).map((e) => e.loopId).sort();
  assert.deepEqual(handles, [outerDec.loopId, innerDec.loopId].sort());

  const svg = render(d);
  assert.equal((svg.match(/class="p2u-hit"/g) || []).length, 2);
  assert.match(svg, new RegExp(`data-loops="${innerDec.loopId} ${outerDec.loopId}"`));
});

test('statements after a loop sit straight below its exit', () => {
  const d = layout(parse('WHILE a\n\tstep\nafter\nRETURN x'));
  const after = d.nodes.find((n) => n.kind === 'action' && n.lines[0] === 'after');
  const into = d.edges.find((e) => {
    const [x, y] = e.points[e.points.length - 1];
    return x === after.x && y === after.y - after.h / 2;
  });
  assert.ok(into, 'an edge ends at the top of "after"');
  const exitX = into.points[into.points.length - 1][0];
  // The loop's exit bends once (right, then down) and never jogs back.
  assert.equal(into.points.length, 3, JSON.stringify(into.points));
  assert.ok(into.points.every(([x], i) => i === 0 || x === exitX));
  checkGeometry(d);
});

test('FOR EACH loops use next / done', () => {
  const d = layout(parse('FOR EACH x IN xs\n\tvisit x'));
  assert.deepEqual(d.labels.map((l) => l.text).sort(), ['done', 'next']);
});

test('branches that all return produce no merge and no global final', () => {
  const d = layout(parse('IF a\n    RETURN 1\nELSE\n    RETURN 2'));
  const kinds = d.nodes.map((n) => n.kind);
  assert.ok(!kinds.includes('merge'));
  assert.equal(kinds.filter((k) => k === 'final').length, 2);
});

test('a merge is omitted when only one branch continues', () => {
  const d = layout(parse('IF a\n    RETURN 1\nprint 2'));
  assert.ok(!d.nodes.some((n) => n.kind === 'merge'));
  checkGeometry(d);
});

test('unreachable code after RETURN does not flow onwards', () => {
  const d = layout(parse('IF a\n    x\nELSE\n    RETURN 0\n    dead\ny'));
  // Only the [a] branch continues, so no merge is needed.
  assert.ok(!d.nodes.some((n) => n.kind === 'merge'));
  checkGeometry(d);
});

test('all examples parse cleanly, lay out and render', () => {
  for (const ex of examples) {
    const ast = parse(ex.source);
    assert.deepEqual(ast.diagnostics, [], ex.name);
    const d = layout(ast);
    checkGeometry(d);
    const svg = render(d);
    assert.match(svg, /^<svg[\s\S]*<\/svg>$/);
  }
});

// Deterministic random programs: routing must stay orthogonal, with every
// edge ending in an arrow and bending at most 4 times.
test('random nested programs keep edges within 4 bends', () => {
  let seed = 42;
  const rand = (n) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
  const gen = (depth, indent) => {
    const lines = [];
    const count = 1 + rand(3);
    for (let i = 0; i < count; i++) {
      const pad = '\t'.repeat(indent);
      const kind = depth > 0 ? rand(8) : 0;
      if (kind === 1 || kind === 2) {
        lines.push(`${pad}IF c${rand(99)}`, ...gen(depth - 1, indent + 1));
        if (rand(2)) lines.push(`${pad}ELIF d${rand(99)}`, ...gen(depth - 1, indent + 1));
        if (rand(2)) lines.push(`${pad}ELSE`, ...gen(depth - 1, indent + 1));
      } else if (kind === 3) {
        lines.push(`${pad}WHILE w${rand(99)}`, ...gen(depth - 1, indent + 1));
      } else if (kind === 4) {
        lines.push(`${pad}FOR EACH x IN list${rand(9)}`, ...gen(depth - 1, indent + 1));
      } else if (kind === 5) {
        lines.push(`${pad}DO`, ...gen(depth - 1, indent + 1), `${pad}WHILE u${rand(99)}`);
      } else if (kind === 6 && i === count - 1) {
        lines.push(`${pad}RETURN r`);
      } else {
        lines.push(`${pad}step ${rand(999)}`);
      }
    }
    return lines;
  };
  for (let i = 0; i < 300; i++) {
    const src = gen(4, 0).join('\n');
    try {
      checkGeometry(layout(parse(src)));
    } catch (err) {
      err.message += `\n--- program ---\n${src}`;
      throw err;
    }
  }
});
