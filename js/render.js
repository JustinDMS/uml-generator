/*
 * Renderer: positioned diagram -> SVG markup.
 *
 * Styling is done with CSS classes (see css/styles.css) so the page can
 * theme the diagram; the exporter inlines concrete styles for standalone files.
 */
(function () {
  'use strict';
  const P2U = (globalThis.P2U = globalThis.P2U || {});

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const r = (n) => Math.round(n * 10) / 10;

  /** Centred, possibly multi-line node text. */
  function textSVG(n) {
    if (!n.lines || !n.lines.length) return '';
    const lh = P2U.layoutConfig.lineHeight;
    const firstY = n.y - ((n.lines.length - 1) * lh) / 2;
    const tspans = n.lines
      .map((l, i) => `<tspan x="${r(n.x)}" y="${r(firstY + i * lh)}">${esc(l)}</tspan>`)
      .join('');
    return `<text text-anchor="middle" dominant-baseline="central">${tspans}</text>`;
  }

  function diamondPoints(x, y, hw, hh) {
    return [[x, y - hh], [x + hw, y], [x, y + hh], [x - hw, y]].map((p) => p.map(r).join(',')).join(' ');
  }

  /**
   * Membership for hover highlighting (see js/app.js): `data-loops` and
   * `data-frames` list the loops / frames an element sits in. Hover handles:
   * `data-loop-id` (a loop's decision and back edge) and `data-calls` (a call
   * action, listing the frames it invokes).
   */
  function groupAttrs(item) {
    const list = (name, ids) => (ids && ids.length ? ` ${name}="${ids.join(' ')}"` : '');
    return (
      list('data-loops', item.loops) +
      list('data-frames', item.inFrames) +
      list('data-calls', item.calls) +
      (item.loopId ? ` data-loop-id="${item.loopId}"` : '') +
      (item.frameId ? ` data-frame-id="${item.frameId}"` : '')
    );
  }

  /**
   * The UML call-behaviour "rake" (a small trident) in an action's lower
   * right corner, marking an action that invokes another activity (a DEF).
   */
  function rakeSVG(n) {
    const cx = r(n.x + n.w / 2 - 14);
    const cy = r(n.y + n.h / 2 - 12);
    return (
      `<path class="p2u-rake" d="M${cx},${r(cy - 4)} V${r(cy + 5)} ` +
      `M${r(cx - 5)},${r(cy + 5)} V${cy} H${r(cx + 5)} V${r(cy + 5)}"/>`
    );
  }

  function nodeSVG(n) {
    const attrs = (n.line ? ` data-line="${n.line}"` : '') + groupAttrs(n);
    const x0 = r(n.x - n.w / 2);
    const y0 = r(n.y - n.h / 2);
    switch (n.kind) {
      case 'initial':
        return `<g class="p2u-node p2u-initial"${attrs}><circle cx="${r(n.x)}" cy="${r(n.y)}" r="${n.w / 2}"/></g>`;
      case 'final':
        return (
          `<g class="p2u-node p2u-final"${attrs}>` +
          `<circle class="p2u-final-ring" cx="${r(n.x)}" cy="${r(n.y)}" r="${n.w / 2 - 0.75}"/>` +
          `<circle class="p2u-final-dot" cx="${r(n.x)}" cy="${r(n.y)}" r="${n.w / 2 - 5}"/></g>`
        );
      case 'decision':
      case 'merge': {
        const cls = `p2u-node p2u-${n.kind}${n.loop ? ' p2u-loop' : ''}`;
        const outer = `<polygon points="${diamondPoints(n.x, n.y, n.w / 2, n.h / 2)}"/>`;
        // Loop decisions get a second, inset outline so they read as loops
        // even without colour. Inset along the diagonal = perpendicular × √2.
        const d = P2U.layoutConfig.loopInset * Math.SQRT2;
        const inner = n.loop
          ? `<polygon class="p2u-inner" points="${diamondPoints(n.x, n.y, n.w / 2 - d, n.h / 2 - d)}"/>`
          : '';
        return `<g class="${cls}"${attrs}>${outer}${inner}${textSVG(n)}</g>`;
      }
      case 'action':
        return (
          `<g class="p2u-node p2u-action${n.calls ? ' p2u-call' : ''}"${attrs}>` +
          `<rect x="${x0}" y="${y0}" width="${r(n.w)}" height="${r(n.h)}" rx="10" ry="10"/>` +
          `${textSVG(n)}${n.calls ? rakeSVG(n) : ''}</g>`
        );
      default:
        return '';
    }
  }

  function edgeSVG(e) {
    const d = e.points.map(([x, y], i) => `${i ? 'L' : 'M'}${r(x)},${r(y)}`).join(' ');
    const kind = { loop: ['-loop', ' p2u-loop-edge'], call: ['-call', ' p2u-call-edge'] }[e.kind] || ['', ''];
    const marker = e.arrow ? ` marker-end="url(#p2u-arrow${kind[0]})"` : '';
    const path = `<path class="p2u-edge${kind[1]}" d="${d}"${marker}${groupAttrs(e)}/>`;
    // Edges are too thin to hover comfortably: give loop-back edges an
    // invisible, wider hit area.
    const hit = e.loopId
      ? `<path class="p2u-hit" d="${d}" fill="none" stroke="transparent" stroke-width="12" data-loop-id="${e.loopId}"/>`
      : '';
    return path + hit;
  }

  // Markers don't inherit the referencing path's stroke, so each edge colour
  // needs its own arrowhead.
  const marker = (id, cls) =>
    `<marker id="${id}" viewBox="0 0 10 10" refX="9.5" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto">` +
    `<path class="${cls}" d="M1,1.5 L9.5,5 L1,8.5"/></marker>`;

  function labelSVG(l) {
    const cls = l.kind === 'value' ? 'p2u-guard p2u-value' : 'p2u-guard';
    return `<text class="${cls}" x="${r(l.x)}" y="${r(l.y)}" text-anchor="${l.anchor}" dominant-baseline="central"${groupAttrs(l)}>${esc(l.text)}</text>`;
  }

  function frameSVG(f) {
    const tabW = Math.min(f.w, f.tabW);
    const [x, y] = [r(f.x), r(f.y)];
    const attrs = (f.line ? ` data-line="${f.line}"` : '') + groupAttrs(f);
    return (
      `<g class="p2u-frame"${attrs}>` +
      `<rect x="${x}" y="${y}" width="${r(f.w)}" height="${r(f.h)}" rx="14" ry="14"/>` +
      `<text class="p2u-frame-title" x="${r(x + 14)}" y="${r(y + 19)}">${esc(f.title)}</text>` +
      `<path class="p2u-frame-tab" d="M${x},${r(y + 30)} H${r(x + tabW - 10)} L${r(x + tabW)},${r(y + 20)} V${y}"/>` +
      `</g>`
    );
  }

  /** @returns {string} SVG markup */
  function render(diagram) {
    const { width: w, height: h } = diagram;
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" class="p2u-diagram" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">`,
      '<defs>',
      marker('p2u-arrow', 'p2u-arrowhead'),
      marker('p2u-arrow-loop', 'p2u-arrowhead p2u-arrowhead-loop'),
      marker('p2u-arrow-call', 'p2u-arrowhead p2u-arrowhead-call'),
      '</defs>',
      ...diagram.frames.map(frameSVG), // outermost first, behind everything else
      // Invokes edges are an overlay: draw them under control flow and nodes.
      ...diagram.edges.filter((e) => e.kind === 'call').map(edgeSVG),
      ...diagram.edges.filter((e) => e.kind !== 'call').map(edgeSVG),
      ...diagram.nodes.map(nodeSVG),
      ...diagram.labels.map(labelSVG),
      '</svg>',
    ].join('');
  }

  P2U.render = render;
})();
