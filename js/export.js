/*
 * Exporters: standalone SVG and PNG.
 */
(function () {
  'use strict';
  const P2U = (globalThis.P2U = globalThis.P2U || {});

  // Colour tokens from css/styles.css that the diagram uses.
  const TOKENS = [
    'canvas', 'text', 'edge', 'action-fill', 'action-stroke', 'diamond-fill', 'diamond-stroke',
    'loop-fill', 'loop-stroke', 'terminal', 'guard', 'frame',
  ];

  /**
   * The concrete colours of `theme` ('light' | 'dark'), read from the page's
   * own CSS tokens so exports always match what's on screen. The theme is
   * switched and restored within one synchronous call, so nothing repaints.
   */
  function themeColours(theme) {
    const root = document.documentElement;
    const previous = root.getAttribute('data-theme');
    root.setAttribute('data-theme', theme);
    const cs = getComputedStyle(root);
    const colours = Object.fromEntries(TOKENS.map((t) => [t, cs.getPropertyValue(`--${t}`).trim()]));
    if (previous === null) root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', previous);
    return colours;
  }

  /**
   * Styles baked into exported files, with concrete colours rather than CSS
   * variables so the files render the same in any viewer.
   */
  function exportCSS(c) {
    return `
    .p2u-diagram { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; font-size: 13px; }
    .p2u-edge { fill: none; stroke: ${c.edge}; stroke-width: 1.4; }
    .p2u-arrowhead { fill: none; stroke: ${c.edge}; stroke-width: 1.4; stroke-linejoin: round; }
    .p2u-action rect { fill: ${c['action-fill']}; stroke: ${c['action-stroke']}; stroke-width: 1.4; }
    .p2u-action text, .p2u-decision text { fill: ${c.text}; }
    .p2u-decision polygon, .p2u-merge polygon { fill: ${c['diamond-fill']}; stroke: ${c['diamond-stroke']}; stroke-width: 1.4; }
    .p2u-loop polygon { fill: ${c['loop-fill']}; stroke: ${c['loop-stroke']}; }
    .p2u-loop .p2u-inner { fill: none; stroke-width: 1; }
    .p2u-loop-edge, .p2u-arrowhead-loop { stroke: ${c['loop-stroke']}; }
    .p2u-initial circle, .p2u-final-dot { fill: ${c.terminal}; }
    .p2u-final-ring { fill: ${c.canvas}; stroke: ${c.terminal}; stroke-width: 1.5; }
    .p2u-guard { fill: ${c.guard}; font-size: 12px; }
    .p2u-value { fill: ${c.text}; font-weight: 600; }
    .p2u-frame rect, .p2u-frame-tab { fill: none; stroke: ${c.frame}; stroke-width: 1.2; }
    .p2u-frame-title { fill: ${c.text}; font-size: 14px; font-weight: 600; }
    .p2u-rake { fill: none; stroke: ${c['action-stroke']}; stroke-width: 1.4; stroke-linecap: round; }
    .p2u-call-edge, .p2u-arrowhead-call { stroke: ${c.guard}; }
    .p2u-call-edge { stroke-dasharray: 5 4; }
  `;
  }

  /** A self-contained SVG document of the diagram in `theme`'s colours. */
  function standaloneSVG(svgEl, theme = 'light') {
    const clone = svgEl.cloneNode(true);
    // Hover affordances don't belong in a file.
    clone.querySelectorAll('.p2u-hit').forEach((el) => el.remove());
    clone.querySelectorAll('.in-focus').forEach((el) => el.classList.remove('in-focus'));
    clone.classList.remove('focus');
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = exportCSS(themeColours(theme));
    clone.insertBefore(style, clone.firstChild);
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
  }

  function download(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadSVG(svgEl, name) {
    download(`${name}.svg`, new Blob([standaloneSVG(svgEl)], { type: 'image/svg+xml' }));
  }

  /** Download a 2× PNG in `theme`'s colours, on that theme's canvas background. */
  function downloadPNG(svgEl, name, theme = 'light', scale = 2) {
    const w = svgEl.viewBox.baseVal.width;
    const h = svgEl.viewBox.baseVal.height;
    const background = themeColours(theme).canvas;
    const url = URL.createObjectURL(new Blob([standaloneSVG(svgEl, theme)], { type: 'image/svg+xml' }));
    const img = new Image();
    return new Promise((resolve, reject) => {
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(w * scale);
        canvas.height = Math.ceil(h * scale);
        const c = canvas.getContext('2d');
        c.fillStyle = background;
        c.fillRect(0, 0, canvas.width, canvas.height);
        c.drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        canvas.toBlob((blob) => {
          download(`${name}.png`, blob);
          resolve();
        }, 'image/png');
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Could not rasterise the diagram'));
      };
      img.src = url;
    });
  }

  P2U.exporters = { standaloneSVG, downloadSVG, downloadPNG };
})();
