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
  // A terminator-style closer is plain text, with a hint.
  assert.deepEqual(strip(ast.body[2]), { type: 'action', text: 'END WHILE' });
  assert.ok(ast.diagnostics.some((d) => d.line === 3 && /END WHILE is not a keyword/.test(d.message)));
});

test('block closers warn and stay text; END alone does not', () => {
  assert.equal(parse('END').diagnostics.length, 0);
  for (const src of ['END IF', 'endwhile', 'End For', 'END DEF', 'END FRAME']) {
    const ast = parse(src);
    assert.ok(ast.diagnostics.some((d) => /is not a keyword/.test(d.message)), src);
    assert.equal(ast.body[0].type, 'action', src);
  }
});

test('START and END are start and end nodes; END x ends with a value', () => {
  const ast = parse('START\nstep\nEND');
  assert.deepEqual(strip(ast.body), [{ type: 'start' }, { type: 'action', text: 'step' }, { type: 'end' }]);
  assert.equal(ast.diagnostics.length, 0);
  assert.deepEqual(strip(parse('END -1').body), [{ type: 'end', value: '-1' }]);
});

test('RETURN and FRAME are no longer keywords: warned, drawn as text', () => {
  for (const [src, hint] of [['RETURN x', 'END'], ['FRAME Main', 'DEF']]) {
    const ast = parse(src);
    assert.equal(ast.body[0].type, 'action', src);
    assert.ok(ast.diagnostics.some((d) => d.message.includes(`use ${hint} instead`)), src);
  }
});

test('START must open the program or a DEF; code after END is unreachable', () => {
  assert.ok(parse('step\nSTART').diagnostics.some((d) => d.line === 2 && /START belongs/.test(d.message)));
  assert.ok(parse('IF a\n\tSTART').diagnostics.some((d) => /START belongs/.test(d.message)));
  assert.equal(parse('DEF f\n\tSTART\n\tstep').diagnostics.length, 0);
  // DEF definitions before START don't count as steps.
  assert.equal(parse('DEF f\n\tstep\nSTART\ngo').diagnostics.length, 0);
  assert.ok(parse('END\nstep').diagnostics.some((d) => d.line === 2 && /Unreachable: follows END/.test(d.message)));
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

test('DEF owns its indented block; unreachable code inside is flagged', () => {
  const ast = parse('DEF Demo\n    END 1\n    print "never"');
  assert.deepEqual(strip(ast.body), [
    {
      type: 'frame',
      title: 'Demo',
      name: 'Demo',
      body: [
        { type: 'end', value: '1' },
        { type: 'action', text: 'print "never"' },
      ],
    },
  ]);
  assert.ok(ast.diagnostics.some((d) => /Unreachable/.test(d.message)));
});

test('a frame is callable by the identifier its title starts with', () => {
  const names = ['DEF fib(n, d)', 'DEF Main', 'DEF Fibonacci Trace'].map((src) => parse(src + '\n\tstep').body[0].name);
  assert.deepEqual(names, ['fib', 'Main', null]);
});

test('actions that use a frame name are calls, including recursion and forward use', () => {
  const ast = parse('fib(3)\nfibonacci(3)\nx.fib(3)\nDEF fib(n)\n\tfib(n - 1) + fib(n - 2)');
  const [call, notCall, method, frame] = ast.body;
  assert.deepEqual(call.calls, ['fib']);
  assert.equal(notCall.calls, undefined, 'a longer identifier is not a call');
  assert.equal(method.calls, undefined, 'a method with the same name is not a call');
  assert.deepEqual(frame.body[0].calls, ['fib']);
});

test('two frames with the same name are flagged', () => {
  const ast = parse('DEF f()\n\ta\nDEF f()\n\tb');
  assert.ok(ast.diagnostics.some((d) => d.line === 3 && /already named f/.test(d.message)));
});

test('frames nest and sit anywhere in the flow', () => {
  const ast = parse('before\nDEF Outer\n\tDEF Inner\n\t\tstep\n\tbetween\nafter');
  const [before, outer, after] = ast.body;
  assert.equal(before.text, 'before');
  assert.equal(after.text, 'after');
  assert.equal(outer.type, 'frame');
  assert.equal(outer.body[0].type, 'frame');
  assert.equal(outer.body[0].title, 'Inner');
  assert.equal(ast.diagnostics.length, 0);
});

test('an unindented DEF is an empty frame with a warning', () => {
  const ast = parse('DEF Lonely\nstep');
  assert.deepEqual(strip(ast.body[0]), { type: 'frame', title: 'Lonely', name: 'Lonely', body: [] });
  assert.ok(ast.diagnostics.some((d) => d.line === 1 && /Empty DEF/.test(d.message)));
});

test('only DEF creates a frame (FUNCTION, ALGORITHM, PROCEDURE are plain actions)', () => {
  for (const kw of ['FUNCTION', 'ALGORITHM', 'PROCEDURE']) {
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

test('start and end nodes are only where START / END are written', () => {
  assert.deepEqual(layout(parse('')).nodes, []);
  assert.deepEqual(layout(parse('step')).nodes.map((n) => n.kind), ['action']);
  const d = layout(parse('START\nstep\nEND'));
  assert.deepEqual(d.nodes.map((n) => n.kind), ['initial', 'action', 'final']);
  assert.equal(d.edges.length, 2);
  checkGeometry(d);
});

test('END x shows its value beside the end node', () => {
  const d = layout(parse('START\nEND -1'));
  const end = d.nodes.find((n) => n.kind === 'final');
  const [value] = d.labels.filter((l) => l.kind === 'value');
  assert.equal(value.text, '-1');
  assert.ok(value.x > end.x + end.w / 2 && Math.abs(value.y - end.y) < 0.01, 'to the right, vertically centred');
  assert.ok(value.x + 20 <= d.width, 'inside the canvas');
  assert.match(render(d), /class="p2u-guard p2u-value"[^>]*>-1</);
});

test('nothing flows into a START', () => {
  const d = layout(parse('before\nSTART\nafter'));
  const start = d.nodes.find((n) => n.kind === 'initial');
  const into = d.edges.filter((e) => {
    const [x, y] = e.points[e.points.length - 1];
    return Math.abs(x - start.x) < 0.01 && Math.abs(y - (start.y - start.h / 2)) < 0.01;
  });
  assert.equal(into.length, 0);
  assert.equal(d.edges.length, 1, 'only START → after');
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
  const d = layout(parse('WHILE a\n\tstep\nafter\nEND x'));
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
  const d = layout(parse('IF a\n    END 1\nELSE\n    END 2'));
  const kinds = d.nodes.map((n) => n.kind);
  assert.ok(!kinds.includes('merge'));
  assert.equal(kinds.filter((k) => k === 'final').length, 2);
});

test('a merge is omitted when only one branch continues', () => {
  const d = layout(parse('IF a\n    END 1\nprint 2'));
  assert.ok(!d.nodes.some((n) => n.kind === 'merge'));
  checkGeometry(d);
});

test('unreachable code after END does not flow onwards', () => {
  const d = layout(parse('IF a\n    x\nELSE\n    END 0\n    dead\ny'));
  // Only the [a] branch continues, so no merge is needed.
  assert.ok(!d.nodes.some((n) => n.kind === 'merge'));
  checkGeometry(d);
});

const nodeByText = (d, text) => d.nodes.find((n) => n.lines && n.lines.join(' ') === text);
const insideFrame = (n, f) =>
  n.x - n.w / 2 >= f.x && n.x + n.w / 2 <= f.x + f.w && n.y - n.h / 2 >= f.y && n.y + n.h / 2 <= f.y + f.h;

const touching = (e, n) => e.points.some(([x, y]) => Math.abs(x - n.x) <= n.w / 2 + 0.01 && Math.abs(y - n.y) <= n.h / 2 + 0.01);

test('a frame has its own START and END inside it', () => {
  const d = layout(parse('DEF Main\n\tSTART\n\tstep\n\tEND'));
  assert.equal(d.frames.length, 1);
  for (const kind of ['initial', 'final']) {
    assert.ok(insideFrame(d.nodes.find((n) => n.kind === kind), d.frames[0]), kind);
  }
  checkGeometry(d);
});

test('frames are definitions: drawn beside the flow and not connected to it by control flow', () => {
  const d = layout(parse('before\nDEF Sub()\n\tinside\nafter'));
  const [frame] = d.frames;
  const [before, inside, after] = ['before', 'inside', 'after'].map((t) => nodeByText(d, t));
  assert.ok(insideFrame(inside, frame));
  assert.ok(!insideFrame(before, frame) && !insideFrame(after, frame));
  assert.ok(frame.x > Math.max(before.x + before.w / 2, after.x + after.w / 2), 'definitions sit right of the flow');
  const flow = d.edges.filter((e) => e.kind !== 'call');
  assert.equal(flow.length, 1, 'before → after only');
  assert.ok(!touching(flow[0], inside));
  checkGeometry(d);
});

test('a DEF written inside an IF is lifted to the enclosing scope', () => {
  const d = layout(parse('DEF Main\n\tIF a\n\t\tDEF helper()\n\t\t\tstep\n\t\tx\n\ty'));
  const main = d.frames.find((f) => f.title === 'Main');
  const helper = d.frames.find((f) => f.title === 'helper()');
  assert.ok(helper.x > nodeByText(d, 'x').x && helper.x > nodeByText(d, 'y').x);
  assert.ok(helper.x > main.x && helper.x + helper.w < main.x + main.w);
  checkGeometry(d);
});

test('calls get a rake and a dashed invokes edge to the called frame', () => {
  const d = layout(parse('START\nrun()\nEND\nDEF run()\n\tSTART\n\twork\n\tEND'));
  const call = nodeByText(d, 'run()');
  const [frame] = d.frames;
  assert.deepEqual(call.calls, [frame.frameId]);
  const edges = d.edges.filter((e) => e.kind === 'call');
  assert.equal(edges.length, 1);
  // The frame slides down so its START is level with the call: a straight line into START's left side.
  const start = d.nodes.find((n) => n.kind === 'initial' && insideFrame(n, frame));
  assert.equal(edges[0].points.length, 2, JSON.stringify(edges[0].points));
  const [x, y] = edges[0].points[1];
  assert.ok(Math.abs(x - (start.x - start.w / 2)) < 0.01 && Math.abs(y - start.y) < 0.5, 'ends at the frame START');
  assert.deepEqual(edges[0].inFrames, [frame.frameId]);
  const svg = render(d);
  assert.match(svg, /class="p2u-rake"/);
  assert.match(svg, /class="p2u-edge p2u-call-edge"/);
  assert.match(svg, new RegExp(`data-calls="${frame.frameId}"`));
  checkGeometry(d);
});

test('recursive calls route back to their own frame through its right margin', () => {
  const d = layout(parse('DEF fib(n)\n\tSTART\n\tIF n <= 1\n\t\tEND n\n\tr = fib(n - 1) + fib(n - 2)\n\tEND r'));
  const [frame] = d.frames;
  const call = d.nodes.find((n) => n.calls);
  assert.ok(insideFrame(call, frame));
  const [edge] = d.edges.filter((e) => e.kind === 'call');
  assert.ok(edge.points.every(([x, y]) => x >= frame.x && x <= frame.x + frame.w && y >= frame.y && y <= frame.y + frame.h), 'stays inside the frame');
  const start = d.nodes.find((n) => n.kind === 'initial');
  const [x, y] = edge.points[edge.points.length - 1];
  assert.deepEqual([x, y], [start.x + start.w / 2, start.y], "ends at the right side of the frame's START");
  assert.equal(edge.points.length, 4, 'right, up, left');
  checkGeometry(d);
});

test("a recursive call's last run to START doesn't cut through nested frames", () => {
  const d = layout(parse('DEF f()\n\tSTART\n\tg()\n\tf()\n\tDEF g()\n\t\tSTART\n\t\tx'));
  const outer = d.frames.find((fr) => fr.name === 'f');
  const nested = d.frames.find((fr) => fr.name === 'g');
  const rec = d.edges.find((e) => e.kind === 'call' && e.inFrames[0] === outer.frameId);
  const [[ax, y], [bx]] = rec.points.slice(-2);
  const [lo, hi] = [Math.min(ax, bx), Math.max(ax, bx)];
  const crosses = y > nested.y && y < nested.y + nested.h && lo < nested.x + nested.w && hi > nested.x;
  assert.ok(!crosses, JSON.stringify({ y, nested: [nested.y, nested.y + nested.h] }));
  checkGeometry(d);
});

test('a frame without START is called at its title tab', () => {
  const d = layout(parse('go()\nDEF go()\n\twork'));
  const [frame] = d.frames;
  const [edge] = d.edges.filter((e) => e.kind === 'call');
  const [x, y] = edge.points[edge.points.length - 1];
  assert.equal(x, frame.x);
  assert.ok(Math.abs(y - (frame.y + 15)) < 0.5, 'at the title tab');
  assert.equal(edge.points.length, 2, 'still straight: the frame is placed level with the call');
  checkGeometry(d);
});

test('frames placed above the flow push the flow down instead', () => {
  // The call is the very first step, higher than the frame's START can sit.
  const d = layout(parse('go()\nDEF go()\n\tSTART\n\twork'));
  const [edge] = d.edges.filter((e) => e.kind === 'call');
  assert.equal(edge.points.length, 2);
  checkGeometry(d);
});

test('frames in a column never overlap, even when two want the same height', () => {
  const d = layout(parse('START\na() + b()\nDEF a()\n\tSTART\n\tx\nDEF b()\n\tSTART\n\ty'));
  assert.equal(d.frames.length, 2);
  const edges = d.edges.filter((e) => e.kind === 'call');
  assert.equal(edges.length, 2);
  assert.deepEqual(edges.map((e) => e.points.length).sort(), [2, 4], 'one straight, one jogs to the pushed-down frame');
  checkGeometry(d);
});

test('the Fibonacci example calls fib from Main and recursively', () => {
  const d = layout(parse(examples.find((e) => /Fibonacci/.test(e.name)).source));
  const fib = d.frames.find((f) => f.name === 'fib');
  const callers = d.nodes.filter((n) => n.calls && n.calls.includes(fib.frameId)).map((n) => n.lines.join(' '));
  assert.deepEqual(callers.sort(), ['fib(n - 1, d + 1) + fib(n - 2, d + 1)', 'fib(n, 0)'].sort());
  const outer = d.edges.find((e) => e.kind === 'call' && e.points.length === 2);
  assert.ok(outer, 'fib(n, 0) → fib is a straight line');
});

test('nested frames nest geometrically and loops inside frames stay tagged', () => {
  const d = layout(parse('DEF Outer\n\tDEF Inner\n\t\tWHILE a\n\t\t\tstep\n\tafter'));
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
        lines.push(`${pad}END r`);
      } else if (kind === 7) {
        lines.push(`${pad}DEF f${rand(5)}(x)`, `${pad}\tSTART`, ...gen(depth - 1, indent + 1));
      } else if (kind === 8) {
        lines.push(`${pad}call f${rand(5)}(y)`);
      } else {
        lines.push(`${pad}step ${rand(999)}`);
      }
    }
    return lines;
  };
  for (let i = 0; i < 300; i++) {
    const src = ['START', ...gen(4, 0)].join('\n');
    try {
      checkGeometry(layout(parse(src)));
    } catch (err) {
      err.message += `\n--- program ---\n${src}`;
      throw err;
    }
  }
});
