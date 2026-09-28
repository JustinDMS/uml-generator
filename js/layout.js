/*
 * Layout: AST -> positioned diagram geometry.
 *
 * Every statement becomes a *fragment*: a box with a vertical axis `cx`.
 * Control enters at (cx, 0). If flow can leave the fragment, `exit` holds a
 * *dangling* path: an unfinished polyline that ends heading down on the
 * fragment's bottom edge (y = h), not necessarily at cx. The parent finishes
 * that path to wherever flow goes next (the next statement, a merge, a loop's
 * decision). Drawing each flow as one polyline this way avoids routing back to
 * the axis only to turn away again, and bounds every edge to 4 bends:
 * a dangling path has at most 1 bend, and completing it adds at most 3.
 *
 * A DEF is a definition, not a step: each block's frames are drawn in a
 * column to the right of that block's flow, unconnected to it. Actions that
 * call a frame get a dashed "invokes" edge to the frame's title tab.
 *
 * Output (all coordinates absolute, node x/y are centres):
 *   {
 *     width, height,
 *     frames: [{ x, y, w, h, title, tabW, name, frameId, line }],   (outermost first)
 *     nodes:  [{ kind: 'initial'|'final'|'action'|'decision'|'merge', x, y, w, h, lines?, line?, calls? }],
 *     edges:  [{ points: [[x, y], ...], arrow: boolean, kind: 'flow'|'loop'|'call' }],
 *     labels: [{ text, x, y, anchor: 'start'|'middle'|'end' }],
 *   }
 * Anything may also carry `loops` / `inFrames`: ids of the loops / frames it
 * sits in (innermost first), used for hover highlighting. A call action's
 * `calls` holds the frameIds it invokes.
 */
(function () {
  'use strict';
  const P2U = (globalThis.P2U = globalThis.P2U || {});

  const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

  const C = {
    font: `13px ${FONT_FAMILY}`,
    labelFont: `12px ${FONT_FAMILY}`,
    titleFont: `600 14px ${FONT_FAMILY}`,
    lineHeight: 17,
    padX: 14,
    padY: 9,
    actionMinW: 72,
    actionMaxW: 240,
    diamond: 13, // half the width/height of a merge diamond
    decisionMinHalf: 22, // smallest half-diagonal of a decision diamond
    decisionPad: 6, // clearance between condition text and the diamond's edges
    loopInset: 4, // gap between a loop decision's outer and inner outline
    decisionTextMaxW: 200, // condition text never wraps wider than this
    guards: { yes: 'yes', no: 'no', next: 'next', done: 'done' },
    initialR: 10,
    finalR: 12,
    gapY: 26, // vertical gap between consecutive fragments
    gapX: 30, // horizontal gap between IF branches
    guardGap: 42, // vertical room for a guard label on an edge
    rail: 20, // clearance for loop-back / exit rails
    labelOffset: 6,
    margin: 24,
    framePad: 24,
    frameTitleH: 30,
    defsGap: 44, // between a block's flow and its column of DEF definitions
    callIconW: 16, // extra action width that makes room for the call (rake) symbol
    callStub: 12, // length of an invokes edge's final run into the frame
  };

  // ---------------------------------------------------------------- text

  let ctx = null;
  function measure(text, font) {
    if (ctx === null && typeof document !== 'undefined') {
      ctx = document.createElement('canvas').getContext('2d');
    }
    if (ctx) {
      ctx.font = font;
      return ctx.measureText(text).width;
    }
    const px = parseFloat(font.match(/(\d+)px/)[1]);
    return text.length * px * 0.55; // headless fallback (tests)
  }

  function wrap(text, maxWidth) {
    const words = text.split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    for (const w of words) {
      const candidate = cur ? cur + ' ' + w : w;
      if (cur && measure(candidate, C.font) > maxWidth) {
        lines.push(cur);
        cur = w;
      } else cur = candidate;
    }
    if (cur || !lines.length) lines.push(cur);
    const width = Math.max(...lines.map((l) => measure(l, C.font)));
    return { lines, width };
  }

  const guardWidth = (g) => measure(g, C.labelFont);

  // ----------------------------------------------------------- fragments

  /**
   * `entryY` is how far below the top edge incoming flow really ends: 0 for
   * most fragments, deeper for a frame, whose incoming edge crosses the
   * border and continues to the first node inside.
   */
  function frag(w, h, cx) {
    // noEntry: the fragment starts a flow (START), so nothing may flow into it.
    return { w, h, cx, entryY: 0, noEntry: false, exit: null, nodes: [], edges: [], labels: [], frames: [] };
  }

  /** An empty statement list: no size, flow passes straight through. */
  function emptyFrag() {
    const f = frag(0, 0, 0);
    f.exit = [[0, 0]];
    return f;
  }

  const isEmpty = (f) => f.nodes.length === 0 && f.frames.length === 0;
  const last = (path) => path[path.length - 1];
  const shift = (path, dx, dy) => path.map(([x, y]) => [x + dx, y + dy]);

  function place(parent, child, dx, dy) {
    for (const n of child.nodes) parent.nodes.push({ ...n, x: n.x + dx, y: n.y + dy });
    for (const e of child.edges) parent.edges.push({ ...e, points: shift(e.points, dx, dy) });
    for (const l of child.labels) parent.labels.push({ ...l, x: l.x + dx, y: l.y + dy });
    for (const fr of child.frames) parent.frames.push({ ...fr, x: fr.x + dx, y: fr.y + dy });
  }

  /** Drop duplicate and collinear interior points. */
  function simplify(points) {
    const out = [];
    for (const p of points) {
      const prev = out[out.length - 1];
      if (prev && prev[0] === p[0] && prev[1] === p[1]) continue;
      if (out.length >= 2) {
        const a = out[out.length - 2];
        if ((a[0] === prev[0] && prev[0] === p[0]) || (a[1] === prev[1] && prev[1] === p[1])) out.pop();
      }
      out.push(p);
    }
    return out;
  }

  /** `kind` is 'flow' for ordinary control flow, 'loop' for a loop's back edge. */
  function edge(f, points, kind = 'flow') {
    // Snap away floating-point noise (e.g. 431.3 vs 431.29999999999995) that
    // arises when the same x is reached by different sums; otherwise a
    // vertical segment can come out a hair off vertical.
    const snap = (v) => Math.round(v * 1000) / 1000;
    const e = { points: simplify(points.map(([x, y]) => [snap(x), snap(y)])), arrow: true, kind };
    f.edges.push(e);
    return e;
  }

  /** `kind`: 'guard' for an edge's guard, 'value' for the value an END ends with. */
  function label(f, text, x, y, anchor = 'start', kind = 'guard') {
    f.labels.push({ text, x, y, anchor, kind });
  }

  /**
   * Place `body` at (dx, dy) and draw the `into` path that feeds it.
   * Returns the body's dangling exit in parent coordinates, or null.
   * An empty body has nothing to point at, so `into` itself keeps dangling.
   */
  function enter(f, into, body, dx, dy) {
    if (isEmpty(body)) return into;
    place(f, body, dx, dy);
    const [x, y] = last(into);
    if (!body.noEntry) edge(f, [...into.slice(0, -1), [x, y + body.entryY]]);
    return body.exit ? shift(body.exit, dx, dy) : null;
  }

  /** Complete a dangling path with `tail` and draw it. */
  function finish(f, path, tail, kind) {
    return edge(f, [...path, ...tail], kind);
  }

  // Loops get ids so the UI can highlight one: everything drawn inside a loop
  // lists the ids of its enclosing loops in `loops` (innermost first), and the
  // loop's decision and back edge carry `loopId` as hover handles.
  let nextLoopId = 1;

  function tagLoop(f, id) {
    for (const item of [...f.nodes, ...f.edges, ...f.labels, ...f.frames]) item.loops = [...(item.loops || []), id];
  }

  // Frames get ids the same way, listed in `inFrames`, so hovering a call can
  // light up the frame it invokes.
  let nextFrameId = 1;

  function tagFrame(f, id) {
    for (const item of [...f.nodes, ...f.edges, ...f.labels, ...f.frames]) item.inFrames = [...(item.inFrames || []), id];
  }

  // -------------------------------------------------------------- leaves

  /** An action; `calls` (frame names) makes it a UML call action with a rake symbol. */
  function layoutAction(text, line, calls) {
    const { lines, width } = wrap(text, C.actionMaxW - 2 * C.padX);
    const icon = calls ? C.callIconW : 0;
    const w = Math.max(C.actionMinW, Math.ceil(width) + 2 * C.padX + 2 * icon);
    const h = lines.length * C.lineHeight + 2 * C.padY;
    const f = frag(w, h, w / 2);
    const node = { kind: 'action', x: w / 2, y: h / 2, w, h, lines, line };
    if (calls) node.callNames = calls;
    f.nodes.push(node);
    f.exit = [[w / 2, h]];
    return f;
  }

  /** START: an initial node. Flow leaves it but never enters it. */
  function layoutStart(line) {
    const d = 2 * C.initialR;
    const f = frag(d, d, C.initialR);
    f.nodes.push({ kind: 'initial', x: C.initialR, y: C.initialR, w: d, h: d, line });
    f.exit = [[C.initialR, d]];
    f.noEntry = true;
    return f;
  }

  /** END: an activity final node, with the value it ends with (END x) beside it. */
  function layoutFinal(line, value) {
    const d = 2 * C.finalR;
    const valueW = value ? C.labelOffset + measure(value, C.labelFont) : 0;
    const f = frag(d + valueW, d, C.finalR);
    f.nodes.push({ kind: 'final', x: C.finalR, y: C.finalR, w: d, h: d, line });
    if (value) label(f, value, d + C.labelOffset, C.finalR, 'start', 'value');
    return f;
  }

  // ------------------------------------------------------------ diamonds

  /** Small empty diamond used for merge nodes. */
  function mergeNode(f, x, y) {
    const s = 2 * C.diamond;
    f.nodes.push({ kind: 'merge', x, y, w: s, h: s });
  }

  /**
   * Size a square (equal-diagonal) decision diamond around its condition.
   * A tw × th text box fits in a square diamond of half-diagonal `a` when
   * tw/2 + th/2 ≤ a, so try each wrap width and keep the one that minimises
   * tw + th. An extra line must shrink the diamond noticeably to be worth
   * breaking up the condition.
   */
  function decisionShape(text, loop = false) {
    // Loop decisions draw an inner outline, so leave room inside it.
    const pad = C.decisionPad + (loop ? 2 * C.loopInset : 0);
    let best = null;
    for (let maxW = C.decisionTextMaxW; maxW >= 30; maxW -= 10) {
      const { lines, width } = wrap(text, maxW);
      const half = (width + lines.length * C.lineHeight) / 2 + pad;
      if (!best || (lines.length > best.lines.length ? half < best.half * 0.92 : half < best.half)) {
        best = { lines, half };
      }
    }
    const half = Math.max(C.decisionMinHalf, Math.ceil(best.half));
    return { lines: best.lines, hw: half, hh: half, loop };
  }

  function decisionNode(f, shape, x, y, line) {
    const { hw, hh, lines, loop } = shape;
    const node = { kind: 'decision', x, y, w: 2 * hw, h: 2 * hh, lines, loop, line };
    f.nodes.push(node);
    return node;
  }

  // ----------------------------------------------------------- sequences

  /**
   * Stack fragments vertically. Each one is centred under the flow that
   * reaches it (e.g. a loop's exit rail), so every connection is a straight
   * drop rather than a jog back to a shared axis.
   */
  function stack(parts) {
    parts = parts.filter((p) => !isEmpty(p));
    if (!parts.length) return emptyFrag();

    // Pass 1: choose each fragment's axis in a provisional frame.
    // Anything after a fragment without an exit is unreachable: it keeps the
    // previous axis and flow never leaves it (the parser already warns).
    const axes = [];
    let axis = 0;
    let exitX = null;
    parts.forEach((p, i) => {
      if (exitX !== null) axis = exitX;
      axes.push(axis);
      const reachable = i === 0 || exitX !== null || p.noEntry;
      exitX = reachable && p.exit ? axis - p.cx + last(p.exit)[0] : null;
    });
    const minX = Math.min(...parts.map((p, i) => axes[i] - p.cx));
    const maxX = Math.max(...parts.map((p, i) => axes[i] - p.cx + p.w));

    // Pass 2: place them and draw the drops between them.
    const f = frag(maxX - minX, 0, axes[0] - minX);
    let y = 0;
    let pending = null;
    parts.forEach((p, i) => {
      if (i > 0) {
        const top = y + C.gapY;
        if (pending && !p.noEntry) finish(f, pending, [[last(pending)[0], top + p.entryY]]);
        y = top;
      }
      const reachable = i === 0 || pending !== null || p.noEntry;
      // Derive the offset from the incoming flow itself so the drop is exact.
      const dx = pending ? last(pending)[0] - p.cx : axes[i] - minX - p.cx;
      place(f, p, dx, y);
      pending = reachable && p.exit ? shift(p.exit, dx, y) : null;
      y += p.h;
    });
    f.h = y;
    f.exit = pending;
    f.entryY = parts[0].entryY;
    f.noEntry = parts[0].noEntry;
    return f;
  }

  // DEF definitions belong to a *scope*: the program or a DEF body. One
  // written inside an IF or loop body is lifted to its enclosing scope, since
  // a definition isn't a step and has no place in the middle of a flow.
  const scopes = [];

  /** A non-scope block (IF branch, loop body): just its flow. */
  function layoutSeq(stmts) {
    scopes[scopes.length - 1].push(...stmts.filter((s) => s.type === 'frame'));
    return stack(stmts.filter((s) => s.type !== 'frame').map(layoutStmt));
  }

  /**
   * A scope: its flow on the left and every DEF defined in it in a column
   * to the right, unconnected to the flow. Each frame slides vertically so
   * its entry (its START, else its title tab) is level with the first call to
   * it from this flow, making that invokes edge a straight line; frames only
   * get pushed down to avoid overlapping each other. A scope's flow never
   * continues outside it, so the result has no exit.
   */
  function layoutScope(stmts, ownName = null) {
    scopes.push([]);
    const flow = layoutSeq(stmts);
    // A leading START is the scope's entry; its frame's calls will aim at it.
    if (flow.noEntry) flow.nodes[0].scopeStart = true;
    const defs = scopes.pop().map((s) => ({ s, f: layoutFrame(s) }));

    const firstCallY = new Map();
    for (const n of flow.nodes) {
      for (const name of n.callNames || []) {
        if (!firstCallY.has(name) || n.y < firstCallY.get(name)) firstCallY.set(name, n.y);
      }
    }
    for (const d of defs) {
      const { frameId } = d.f.frames[0];
      const start = d.f.nodes.find((n) => n.startOf === frameId);
      const entryY = start ? start.y : C.frameTitleH / 2;
      const callY = d.s.name ? firstCallY.get(d.s.name) : undefined;
      d.want = callY === undefined ? null : callY - entryY;
    }

    // In a frame that calls itself, keep the row beside its leading START
    // clear: recursive calls reach START from the frame's right margin.
    const callsSelf = (nodes) => nodes.some((n) => (n.callNames || []).includes(ownName));
    const recursive = ownName && (callsSelf(flow.nodes) || defs.some((d) => callsSelf(d.f.nodes)));
    let next = recursive && flow.noEntry ? C.initialR + 6 : -Infinity;
    const aligned = defs.filter((d) => d.want !== null).sort((a, b) => a.want - b.want);
    for (const d of aligned) {
      d.y = Math.max(d.want, next);
      next = d.y + d.f.h + C.gapY;
    }
    next = Math.max(next, 0);
    for (const d of defs.filter((d) => d.want === null)) {
      d.y = next;
      next = d.y + d.f.h + C.gapY;
    }
    // A frame that wants to start above the flow pushes the flow down instead.
    const shift = Math.max(0, ...defs.map((d) => -d.y));

    const [, flowRight] = labelBounds(flow);
    const colX = isEmpty(flow) ? 0 : flowRight + C.defsGap;
    const f = frag(0, 0, flow.cx);
    place(f, flow, 0, shift);
    let right = flowRight;
    let bottom = flow.h + shift;
    for (const d of defs) {
      place(f, d.f, colX, d.y + shift);
      right = Math.max(right, colX + d.f.w);
      bottom = Math.max(bottom, d.y + shift + d.f.h);
    }
    f.w = right;
    f.h = bottom;
    return f;
  }

  function layoutStmt(s) {
    switch (s.type) {
      case 'action':
        return layoutAction(s.text, s.line, s.calls);
      case 'if':
        return layoutIf(s);
      case 'while':
        return layoutWhile(s);
      case 'doWhile':
        return layoutDoWhile(s);
      case 'start':
        return layoutStart(s.line);
      case 'end':
        return layoutFinal(s.line, s.value);
      default:
        throw new Error(`Unknown statement type: ${s.type}`);
    }
  }

  // ------------------------------------------------------------------ if

  function layoutIf(s) {
    const [first, ...rest] = s.branches;
    // One condition per diamond: ELIF chains become nested decisions.
    const elseStmts = rest.length
      ? [{ type: 'if', branches: rest, elseBody: s.elseBody, line: rest[0].line }]
      : s.elseBody || [];

    const shape = decisionShape(first.cond);
    const { hw, hh } = shape;
    const m = C.diamond;
    const { yes: yesG, no: noG } = C.guards;
    const yes = layoutSeq(first.body);
    const no = layoutSeq(elseStmts);

    // [yes] continues straight down the axis; [no] leaves from the right vertex.
    const axis = Math.max(yes.cx, hw);
    const yesRight = Math.max(yes.w - yes.cx, guardWidth(yesG) + 2 * C.labelOffset);
    const noAxis = axis + Math.max(yesRight + C.gapX + no.cx, hw + guardWidth(noG) + 2 * C.labelOffset + 8);
    const width = Math.max(noAxis + (no.w - no.cx), axis + hw);

    const yBranch = 2 * hh + C.guardGap - 12;
    const rowBottom = yBranch + Math.max(yes.h, no.h);

    const f = frag(width, rowBottom, axis);
    decisionNode(f, shape, axis, hh, s.line);

    const yesExit = enter(f, [[axis, 2 * hh], [axis, yBranch]], yes, axis - yes.cx, yBranch);
    label(f, yesG, axis + C.labelOffset, yBranch - 12);
    const noExit = enter(f, [[axis + hw, hh], [noAxis, hh], [noAxis, yBranch]], no, noAxis - no.cx, yBranch);
    label(f, noG, axis + hw + C.labelOffset, hh - 10);

    if (yesExit && noExit) {
      // The merge sits straight below the [yes] flow; [no] comes in from the
      // right (its column is always right of anything in the [yes] column).
      const xMerge = last(yesExit)[0];
      const yMerge = rowBottom + C.gapY + m;
      mergeNode(f, xMerge, yMerge);
      finish(f, yesExit, [[xMerge, yMerge - m]]);
      finish(f, noExit, [[last(noExit)[0], yMerge], [xMerge + m, yMerge]]);
      f.h = yMerge + m;
      f.exit = [[xMerge, f.h]];
    } else {
      // A merge with one incoming flow is redundant: let that flow dangle
      // down to the bottom edge and have the parent route it onwards.
      const only = yesExit || noExit;
      if (only) f.exit = [...only, [last(only)[0], rowBottom]];
    }
    return f;
  }

  // --------------------------------------------------------------- while

  /**
   * Pre-test loop. Entry comes into the decision's top vertex; the body's
   * flow loops back into its left vertex, so no separate merge node is used.
   */
  function layoutWhile(s) {
    const shape = decisionShape(s.cond, true);
    const { hw, hh } = shape;
    const body = layoutSeq(s.body);
    const [inG, outG] = s.iterate ? [C.guards.next, C.guards.done] : [C.guards.yes, C.guards.no];

    const axis = Math.max(body.cx, hw) + C.rail;
    const xl = 0;
    const xr =
      axis +
      Math.max(body.w - body.cx, hw + guardWidth(outG) + 2 * C.labelOffset, guardWidth(inG) + 2 * C.labelOffset) +
      C.rail;

    const yBody = 2 * hh + C.guardGap - 12;
    const yBack = yBody + body.h + 14;
    const f = frag(xr, yBack + 10, axis);
    const id = nextLoopId++;
    decisionNode(f, shape, axis, hh, s.line).loopId = id;

    const bodyExit = enter(f, [[axis, 2 * hh], [axis, yBody]], body, axis - body.cx, yBody);
    if (bodyExit) {
      const back = finish(f, bodyExit, [[last(bodyExit)[0], yBack], [xl, yBack], [xl, hh], [axis - hw, hh]], 'loop');
      back.loopId = id;
    }
    label(f, inG, axis + C.labelOffset, yBody - 12);

    // Exit leaves the right vertex and dangles down the right rail.
    f.exit = [[axis + hw, hh], [xr, hh], [xr, f.h]];
    label(f, outG, axis + hw + C.labelOffset, hh - 10);
    tagLoop(f, id);
    return f;
  }

  // ------------------------------------------------------------ do-while

  /**
   * Post-test loop (DO … WHILE c). The merge at the top joins the entry flow
   * with the loop-back before the body's first action.
   */
  function layoutDoWhile(s) {
    const shape = decisionShape(s.cond, true);
    const { hw, hh } = shape;
    const m = C.diamond;
    const body = layoutSeq(s.body);
    const [backG, exitG] = [C.guards.yes, C.guards.no];

    // The decision sits straight below the body's exit, which may be off the
    // entry axis (e.g. when the body ends in a loop). `offset` is that shift.
    const offset = body.exit ? last(body.exit)[0] - body.cx : 0;
    const backRoom = hw + guardWidth(backG) + 2 * C.labelOffset;
    const axis = C.rail + Math.max(body.cx, m, backRoom - offset);
    const xd = axis + offset;
    const xl = 0;
    const width = Math.max(axis - body.cx + body.w, xd + hw, xd + guardWidth(exitG) + 2 * C.labelOffset);

    const yBody = 2 * m + C.gapY;
    const yBodyEnd = yBody + body.h;
    const yDecision = yBodyEnd + C.gapY + hh;
    const f = frag(width, yDecision + hh + 22, axis);
    const id = nextLoopId++;
    mergeNode(f, axis, m);
    decisionNode(f, shape, xd, yDecision, s.line).loopId = id;

    const bodyExit = enter(f, [[axis, 2 * m], [axis, yBody]], body, axis - body.cx, yBody);
    if (bodyExit) finish(f, bodyExit, [[xd, yDecision - hh]]);

    edge(f, [[xd - hw, yDecision], [xl, yDecision], [xl, m], [axis - m, m]], 'loop').loopId = id;
    label(f, backG, xd - hw - C.labelOffset, yDecision - 10, 'end');

    f.exit = [[xd, yDecision + hh], [xd, f.h]];
    label(f, exitG, xd + C.labelOffset, yDecision + hh + 11);
    tagLoop(f, id);
    return f;
  }

  // ------------------------------------------------------------- diagram

  /** Horizontal extent of a fragment including labels that poke past it. */
  function labelBounds(f) {
    let min = 0;
    let max = f.w;
    for (const l of f.labels) {
      const w = measure(l.text, C.labelFont);
      const x0 = l.anchor === 'end' ? l.x - w : l.anchor === 'middle' ? l.x - w / 2 : l.x;
      min = Math.min(min, x0);
      max = Math.max(max, x0 + w);
    }
    return [min, max];
  }

  // --------------------------------------------------------------- frames

  /**
   * A DEF definition: a named frame (rounded rectangle with a title tab)
   * around its own scope. It has no incoming or outgoing flow; its START and
   * END nodes, if any, are inside it, and it is reached through calls.
   */
  function layoutFrame(s) {
    const inner = layoutScope(s.body, s.name);
    const tabW = measure(s.title, C.titleFont) + 36;
    const top = C.frameTitleH + C.framePad / 2;
    const pad = C.framePad;
    const [lo, hi] = labelBounds(inner);
    const needW = Math.max(hi - lo + 2 * pad, tabW + 20);
    // Centre the content when the title makes the frame wider than it.
    const left = Math.max(pad - lo, (needW - (hi - lo)) / 2 - lo);
    const w = Math.max(needW, left + hi + pad);
    const h = top + inner.h + pad;

    const f = frag(w, h, left + inner.cx);
    const frameId = nextFrameId++;
    f.frames.push({ x: 0, y: 0, w, h, title: s.title, tabW, name: s.name, frameId, line: s.line });
    place(f, inner, left, top);
    // This frame's own START (nested frames' STARTs are already tagged).
    const start = f.nodes.find((n) => n.scopeStart && !n.inFrames);
    if (start) start.startOf = frameId;
    tagFrame(f, frameId);
    return f;
  }

  // ---------------------------------------------------------------- calls

  /**
   * Dashed "invokes" edge from a call action to the frame it calls, ending at
   * the frame's START (else its title tab).
   * - From outside: into the entry from the left. When the frame was placed
   *   level with the call (see layoutScope) it's a straight line; otherwise
   *   it jogs through the gap left of the frame.
   * - Recursive (made inside its own target): up the frame's inner right
   *   margin and into the entry from the right.
   * At most 2 bends either way.
   */
  function callEdge(out, node, target, start) {
    const [x0, x1] = [node.x - node.w / 2, node.x + node.w / 2];
    const entryY = start ? start.y : target.y + C.frameTitleH / 2;
    let points;
    if ((node.inFrames || []).includes(target.frameId)) {
      const rx = target.x + target.w - C.callStub;
      const ex = start ? start.x + start.w / 2 : target.x + target.tabW;
      points = [[x1, node.y], [rx, node.y], [rx, entryY], [ex, entryY]];
    } else {
      const ex = start ? start.x - start.w / 2 : target.x;
      const cx = target.x - C.callStub;
      const sx = x1 <= cx ? x1 : x0;
      points =
        Math.abs(node.y - entryY) < 0.5 && sx < ex
          ? [[sx, node.y], [ex, node.y]]
          : [[sx, node.y], [cx, node.y], [cx, entryY], [ex, entryY]];
    }
    edge(out, points, 'call').inFrames = [target.frameId];
  }

  /** Resolve call actions' frame names to frames and draw their edges. */
  function routeCalls(out) {
    const byName = new Map();
    for (const fr of out.frames) if (fr.name && !byName.has(fr.name)) byName.set(fr.name, fr);
    const starts = new Map(out.nodes.filter((n) => n.startOf).map((n) => [n.startOf, n]));
    for (const node of out.nodes) {
      if (!node.callNames) continue;
      const targets = node.callNames.map((name) => byName.get(name)).filter(Boolean);
      node.calls = targets.map((t) => t.frameId);
      for (const t of targets) callEdge(out, node, t, starts.get(t.frameId));
    }
  }

  // ------------------------------------------------------------- diagram

  /**
   * Nothing is added implicitly: start and end nodes are exactly the START
   * and END statements written in the source.
   *
   * @param {{ body: object[] }} ast
   */
  function layout(ast) {
    nextLoopId = 1;
    nextFrameId = 1;
    const main = layoutScope(ast.body);

    const [minX, maxX] = labelBounds(main);
    const out = frag(0, 0, 0);
    place(out, main, C.margin - minX, C.margin);
    routeCalls(out);

    return {
      width: Math.ceil(maxX - minX + 2 * C.margin),
      height: Math.ceil(main.h + 2 * C.margin),
      nodes: out.nodes,
      edges: out.edges,
      labels: out.labels,
      frames: out.frames,
    };
  }

  P2U.layout = layout;
  P2U.layoutConfig = C;
})();
