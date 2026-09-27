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
 * Output (all coordinates absolute, node x/y are centres):
 *   {
 *     width, height,
 *     frame: { x, y, w, h, title, tabW } | null,
 *     nodes:  [{ kind: 'initial'|'final'|'action'|'decision'|'merge', x, y, w, h, lines?, line? }],
 *     edges:  [{ points: [[x, y], ...], arrow: boolean }],
 *     labels: [{ text, x, y, anchor: 'start'|'middle'|'end' }],
 *   }
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

  function frag(w, h, cx) {
    return { w, h, cx, exit: null, nodes: [], edges: [], labels: [] };
  }

  /** An empty statement list: no size, flow passes straight through. */
  function emptyFrag() {
    const f = frag(0, 0, 0);
    f.exit = [[0, 0]];
    return f;
  }

  const isEmpty = (f) => f.nodes.length === 0;
  const last = (path) => path[path.length - 1];
  const shift = (path, dx, dy) => path.map(([x, y]) => [x + dx, y + dy]);

  function place(parent, child, dx, dy) {
    for (const n of child.nodes) parent.nodes.push({ ...n, x: n.x + dx, y: n.y + dy });
    for (const e of child.edges) parent.edges.push({ ...e, points: shift(e.points, dx, dy) });
    for (const l of child.labels) parent.labels.push({ ...l, x: l.x + dx, y: l.y + dy });
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
    const e = { points: simplify(points), arrow: true, kind };
    f.edges.push(e);
    return e;
  }

  function label(f, text, x, y, anchor = 'start') {
    f.labels.push({ text, x, y, anchor });
  }

  /**
   * Place `body` at (dx, dy) and draw the `into` path that feeds it.
   * Returns the body's dangling exit in parent coordinates, or null.
   * An empty body has nothing to point at, so `into` itself keeps dangling.
   */
  function enter(f, into, body, dx, dy) {
    if (isEmpty(body)) return into;
    place(f, body, dx, dy);
    edge(f, into);
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
    for (const item of [...f.nodes, ...f.edges, ...f.labels]) item.loops = [...(item.loops || []), id];
  }

  // -------------------------------------------------------------- leaves

  function layoutAction(text, line) {
    const { lines, width } = wrap(text, C.actionMaxW - 2 * C.padX);
    const w = Math.max(C.actionMinW, Math.ceil(width) + 2 * C.padX);
    const h = lines.length * C.lineHeight + 2 * C.padY;
    const f = frag(w, h, w / 2);
    f.nodes.push({ kind: 'action', x: w / 2, y: h / 2, w, h, lines, line });
    f.exit = [[w / 2, h]];
    return f;
  }

  function layoutInitial() {
    const d = 2 * C.initialR;
    const f = frag(d, d, C.initialR);
    f.nodes.push({ kind: 'initial', x: C.initialR, y: C.initialR, w: d, h: d });
    f.exit = [[C.initialR, d]];
    return f;
  }

  function layoutFinal(line) {
    const d = 2 * C.finalR;
    const f = frag(d, d, C.finalR);
    f.nodes.push({ kind: 'final', x: C.finalR, y: C.finalR, w: d, h: d, line });
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
      const reachable = i === 0 || exitX !== null;
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
        if (pending) finish(f, pending, [[last(pending)[0], top]]);
        y = top;
      }
      const reachable = i === 0 || pending !== null;
      // Derive the offset from the incoming flow itself so the drop is exact.
      const dx = pending ? last(pending)[0] - p.cx : axes[i] - minX - p.cx;
      place(f, p, dx, y);
      pending = reachable && p.exit ? shift(p.exit, dx, y) : null;
      y += p.h;
    });
    f.h = y;
    f.exit = pending;
    return f;
  }

  function layoutSeq(stmts) {
    return stack(stmts.map(layoutStmt));
  }

  function layoutStmt(s) {
    switch (s.type) {
      case 'action':
        return layoutAction(s.text, s.line);
      case 'if':
        return layoutIf(s);
      case 'while':
        return layoutWhile(s);
      case 'doWhile':
        return layoutDoWhile(s);
      case 'return':
        return s.text ? stack([layoutAction(s.text, s.line), layoutFinal(s.line)]) : layoutFinal(s.line);
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

  /**
   * @param {{ title: string|null, body: object[] }} ast
   */
  function layout(ast) {
    nextLoopId = 1;
    const body = layoutSeq(ast.body);
    const parts = [layoutInitial(), body];
    if (body.exit) parts.push(layoutFinal());
    const main = stack(parts);

    // Labels are left-anchored beside their edge and may poke past fragment
    // bounds; include them in the extent.
    let minX = 0;
    let maxX = main.w;
    for (const l of main.labels) {
      const w = measure(l.text, C.labelFont);
      const x0 = l.anchor === 'end' ? l.x - w : l.anchor === 'middle' ? l.x - w / 2 : l.x;
      minX = Math.min(minX, x0);
      maxX = Math.max(maxX, x0 + w);
    }

    const title = ast.title || null;
    const inset = title ? C.framePad : 0;
    const top = title ? C.frameTitleH + C.framePad / 2 : 0;
    const contentW = Math.max(maxX - minX, title ? measure(title, C.titleFont) + 40 : 0);

    const out = frag(0, 0, 0);
    place(out, main, C.margin + inset - minX + (contentW - (maxX - minX)) / 2, C.margin + top);

    const frame = title
      ? { x: C.margin, y: C.margin, w: contentW + 2 * inset, h: main.h + top + inset, title, tabW: measure(title, C.titleFont) + 36 }
      : null;

    return {
      width: Math.ceil(contentW + 2 * inset + 2 * C.margin),
      height: Math.ceil(main.h + top + inset + 2 * C.margin),
      frame,
      nodes: out.nodes,
      edges: out.edges,
      labels: out.labels,
    };
  }

  P2U.layout = layout;
  P2U.layoutConfig = C;
})();
