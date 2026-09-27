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

test('FRAME owns its indented block; unreachable code inside is flagged', () => {
  const ast = parse('FRAME Demo\n    RETURN 1\n    print "never"');
  assert.deepEqual(strip(ast.body), [
    {
      type: 'frame',
      title: 'Demo',
      body: [
        { type: 'return', text: 'RETURN 1' },
        { type: 'action', text: 'print "never"' },
      ],
    },
  ]);
  assert.ok(ast.diagnostics.some((d) => /Unreachable/.test(d.message)));
});

test('frames nest and sit anywhere in the flow', () => {
  const ast = parse('before\nFRAME Outer\n\tFRAME Inner\n\t\tstep\n\tbetween\nafter');
  const [before, outer, after] = ast.body;
  assert.equal(before.text, 'before');
  assert.equal(after.text, 'after');
  assert.equal(outer.type, 'frame');
  assert.equal(outer.body[0].type, 'frame');
  assert.equal(outer.body[0].title, 'Inner');
  assert.equal(ast.diagnostics.length, 0);
});

test('an unindented FRAME is an empty frame with a warning', () => {
  const ast = parse('FRAME Lonely\nstep');
  assert.deepEqual(strip(ast.body[0]), { type: 'frame', title: 'Lonely', body: [] });
  assert.ok(ast.diagnostics.some((d) => d.line === 1 && /Empty FRAME/.test(d.message)));
});

test('only FRAME creates a frame (DEF, FUNCTION, ALGORITHM are plain actions)', () => {
  for (const kw of ['def', 'FUNCTION', 'ALGORITHM', 'PROCEDURE']) {
    const ast = parse(`${kw} foo`);
    assert.deepEqual(strip(ast.body), [{ type: 'action', text: `${kw} foo` }]);
  }
});

test('version is semver', () => {
  require('../js/version.js');
  assert.match(globalThis.P2U.version, /^\d+\.\d+\.\d+$/);
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
  // Frames: inside the canvas, never cutting through a node, and either
  // nested or disjoint with respect to each other.
  const box = (n) => ({ x0: n.x - n.w / 2, y0: n.y - n.h / 2, x1: n.x + n.w / 2, y1: n.y + n.h / 2 });
  const fbox = (f) => ({ x0: f.x, y0: f.y, x1: f.x + f.w, y1: f.y + f.h });
  const contains = (o, i) => i.x0 >= o.x0 - 0.01 && i.x1 <= o.x1 + 0.01 && i.y0 >= o.y0 - 0.01 && i.y1 <= o.y1 + 0.01;
  const disjoint = (a, b) => a.x1 <= b.x0 + 0.01 || b.x1 <= a.x0 + 0.01 || a.y1 <= b.y0 + 0.01 || b.y1 <= a.y0 + 0.01;
  const frames = d.frames.map(fbox);
  for (const [i, f] of frames.entries()) {
    assert.ok(contains({ x0: 0, y0: 0, x1: d.width, y1: d.height }, f), `frame outside canvas: ${d.frames[i].title}`);
    for (const n of d.nodes) {
      assert.ok(contains(f, box(n)) || disjoint(f, box(n)), `frame "${d.frames[i].title}" cuts through a ${n.kind}`);
    }
    for (const [j, g] of frames.entries()) {
      if (i < j) assert.ok(contains(f, g) || contains(g, f) || disjoint(f, g), 'frames partially overlap');
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

const nodeByText = (d, text) => d.nodes.find((n) => n.lines && n.lines.join(' ') === text);
const insideFrame = (n, f) =>
  n.x - n.w / 2 >= f.x && n.x + n.w / 2 <= f.x + f.w && n.y - n.h / 2 >= f.y && n.y + n.h / 2 <= f.y + f.h;

test('a program that is one FRAME is the activity frame, holding initial and final nodes', () => {
  const d = layout(parse('FRAME Main\n\tstep'));
  assert.equal(d.frames.length, 1);
  for (const kind of ['initial', 'final']) {
    assert.ok(insideFrame(d.nodes.find((n) => n.kind === kind), d.frames[0]), kind);
  }
  checkGeometry(d);
});

test('inline frames: flow crosses the top border in and the bottom border out', () => {
  const d = layout(parse('before\nFRAME Sub\n\tinside\nafter'));
  const [frame] = d.frames;
  assert.equal(frame.title, 'Sub');
  const inside = nodeByText(d, 'inside');
  const after = nodeByText(d, 'after');
  assert.ok(insideFrame(inside, frame));
  for (const n of ['before', 'after'].map((t) => nodeByText(d, t)).concat(d.nodes.filter((n) => n.kind !== 'action'))) {
    assert.ok(!insideFrame(n, frame), `${n.kind} should be outside the frame`);
  }
  const endingAt = (n) => d.edges.find((e) => {
    const [x, y] = e.points[e.points.length - 1];
    return Math.abs(x - n.x) < 0.01 && Math.abs(y - (n.y - n.h / 2)) < 0.01;
  });
  const into = endingAt(inside);
  assert.ok(into.points[0][1] < frame.y, 'incoming edge starts above the frame');
  const out = endingAt(after);
  assert.ok(out.points[0][1] < frame.y + frame.h && out.points[0][1] > frame.y, 'outgoing edge starts inside the frame');
  checkGeometry(d);
});

test('nested frames nest geometrically and loops inside frames stay tagged', () => {
  const d = layout(parse('FRAME Outer\n\tFRAME Inner\n\t\tWHILE a\n\t\t\tstep\n\tafter'));
  const outer = d.frames.find((f) => f.title === 'Outer');
  const inner = d.frames.find((f) => f.title === 'Inner');
  assert.ok(inner.x > outer.x && inner.y > outer.y && inner.x + inner.w < outer.x + outer.w && inner.y + inner.h < outer.y + outer.h);
  assert.ok(insideFrame(nodeByText(d, 'step'), inner));
  assert.ok(!insideFrame(nodeByText(d, 'after'), inner) && insideFrame(nodeByText(d, 'after'), outer));
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
      const kind = depth > 0 ? rand(9) : 0;
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
      } else if (kind === 7) {
        lines.push(`${pad}FRAME Part ${rand(99)}`, ...gen(depth - 1, indent + 1));
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
