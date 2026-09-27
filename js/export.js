/*
 * Exporters: standalone SVG and PNG.
 */
(function () {
  'use strict';
  const P2U = (globalThis.P2U = globalThis.P2U || {});

  // Concrete (light) styles baked into exported files so they render anywhere.
  const EXPORT_CSS = `
    .p2u-diagram { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; font-size: 13px; }
    .p2u-edge { fill: none; stroke: #3d4550; stroke-width: 1.4; }
    .p2u-arrowhead { fill: none; stroke: #3d4550; stroke-width: 1.4; stroke-linejoin: round; }
    .p2u-action rect { fill: #eef3fb; stroke: #3d5a80; stroke-width: 1.4; }
    .p2u-action text, .p2u-decision text { fill: #1b2230; }
    .p2u-decision polygon, .p2u-merge polygon { fill: #fdf6e3; stroke: #9a6b12; stroke-width: 1.4; }
    .p2u-loop polygon { fill: #e3f3ef; stroke: #1d7a6b; }
    .p2u-loop .p2u-inner { fill: none; stroke-width: 1; }
    .p2u-loop-edge, .p2u-arrowhead-loop { stroke: #1d7a6b; }
    .p2u-initial circle, .p2u-final-dot { fill: #1b2230; }
    .p2u-final-ring { fill: #ffffff; stroke: #1b2230; stroke-width: 1.5; }
    .p2u-guard { fill: #5b4a8a; font-size: 12px; }
    .p2u-frame rect, .p2u-frame-tab { fill: none; stroke: #8a93a0; stroke-width: 1.2; }
    .p2u-frame-title { fill: #1b2230; font-size: 14px; font-weight: 600; }
  `;

  function standaloneSVG(svgEl) {
    const clone = svgEl.cloneNode(true);
    // Hover affordances don't belong in a file.
    clone.querySelectorAll('.p2u-hit').forEach((el) => el.remove());
    clone.querySelectorAll('.in-loop').forEach((el) => el.classList.remove('in-loop'));
    clone.classList.remove('loop-focus');
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = EXPORT_CSS;
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

  function downloadPNG(svgEl, name, scale = 2) {
    const w = svgEl.viewBox.baseVal.width;
    const h = svgEl.viewBox.baseVal.height;
    const url = URL.createObjectURL(new Blob([standaloneSVG(svgEl)], { type: 'image/svg+xml' }));
    const img = new Image();
    return new Promise((resolve, reject) => {
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(w * scale);
        canvas.height = Math.ceil(h * scale);
        const c = canvas.getContext('2d');
        c.fillStyle = '#ffffff';
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
