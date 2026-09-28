/*
 * UI controller: wires the editor to parse -> layout -> render, and handles
 * zoom/pan, source <-> diagram cross-highlighting, examples and export.
 */
(function () {
  'use strict';
  const { parse, layout, render, exporters, examples, version } = globalThis.P2U;

  const STORAGE_KEY = 'p2u.source';
  const THEME_KEY = 'p2u.theme'; // also read by the inline script in index.html
  const INDENT = '\t';
  const MIN_SCALE = 0.2;
  const MAX_SCALE = 4;

  const $ = (id) => document.getElementById(id);
  const els = {
    source: $('source'),
    gutter: $('gutter'),
    problems: $('problems'),
    viewport: $('viewport'),
    stage: $('stage'),
    examples: $('examples'),
    zoomLevel: $('zoom-reset'),
    toast: $('toast'),
    syntax: $('syntax'),
    syntaxToggle: $('syntax-toggle'),
  };

  const state = { ast: null, scale: 1, tx: 0, ty: 0, focusKey: null };

  // ------------------------------------------------------------ storage

  function load(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function save(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* storage unavailable: nothing to do */
    }
  }

  // -------------------------------------------------------------- theme

  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

  /** The theme in effect: an explicit choice, else the system preference. */
  function currentTheme() {
    const chosen = document.documentElement.dataset.theme;
    if (chosen === 'light' || chosen === 'dark') return chosen;
    return systemDark.matches ? 'dark' : 'light';
  }

  function syncThemeButton() {
    const label = `Switch to ${currentTheme() === 'dark' ? 'light' : 'dark'} mode`;
    const btn = $('theme-toggle');
    btn.setAttribute('aria-label', label);
    btn.title = label;
  }

  function setupThemeToggle() {
    $('theme-toggle').addEventListener('click', () => {
      const next = currentTheme() === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      save(THEME_KEY, next);
      syncThemeButton();
    });
    // Without an explicit choice the page follows the system; keep the label in step.
    systemDark.addEventListener('change', syncThemeButton);
    syncThemeButton();
  }

  // ------------------------------------------------------------ convert

  function update() {
    const text = els.source.value;
    save(STORAGE_KEY, text);
    let ast;
    try {
      ast = parse(text);
      els.stage.innerHTML = render(layout(ast));
    } catch (err) {
      console.error(err);
      ast = { body: [], diagnostics: [{ line: 0, severity: 'error', message: `Internal error: ${err.message}` }] };
    }
    state.ast = ast;
    state.focusKey = null; // the old diagram's elements are gone
    showProblems(ast.diagnostics);
    renderGutter(ast.diagnostics);
    highlightCurrentLine();
  }

  let pending = 0;
  function scheduleUpdate() {
    clearTimeout(pending);
    pending = setTimeout(update, 120);
  }

  function showProblems(diags) {
    els.problems.replaceChildren(
      ...[...diags]
        .sort((a, b) => a.line - b.line)
        .map((d) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = d.severity;
          b.innerHTML = '<span class="sev"></span><span class="loc"></span><span class="msg"></span>';
          b.children[0].textContent = d.severity;
          b.children[1].textContent = d.line ? `line ${d.line}` : '';
          b.children[2].textContent = d.message;
          b.addEventListener('click', () => d.line && selectLine(d.line));
          return b;
        })
    );
  }

  function renderGutter(diags) {
    const marks = new Map();
    for (const d of diags) if (d.severity === 'error' || !marks.has(d.line)) marks.set(d.line, d.severity);
    const count = els.source.value.split('\n').length;
    const html = [];
    for (let i = 1; i <= count; i++) {
      const sev = marks.get(i);
      html.push(sev ? `<span class="${sev === 'error' ? 'err' : 'warn'}">${i}</span>` : String(i));
    }
    els.gutter.innerHTML = html.join('\n') + '\n';
    els.gutter.scrollTop = els.source.scrollTop;
  }

  // -------------------------------------------- source <-> diagram links

  function lineStart(text, line) {
    let pos = 0;
    for (let i = 1; i < line; i++) pos = text.indexOf('\n', pos) + 1;
    return pos;
  }

  function selectLine(line) {
    const ta = els.source;
    const start = lineStart(ta.value, line);
    let end = ta.value.indexOf('\n', start);
    if (end < 0) end = ta.value.length;
    const indent = ta.value.slice(start, end).match(/^\s*/)[0].length;
    ta.focus();
    ta.setSelectionRange(start + indent, end);
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 20;
    ta.scrollTop = Math.max(0, (line - 1) * lh - ta.clientHeight / 3);
    highlightCurrentLine();
  }

  function currentLine() {
    return els.source.value.slice(0, els.source.selectionStart).split('\n').length;
  }

  function highlightCurrentLine() {
    const line = document.activeElement === els.source ? currentLine() : null;
    for (const n of els.stage.querySelectorAll('.p2u-node[data-line], .p2u-frame[data-line]')) {
      n.classList.toggle('active', Number(n.dataset.line) === line);
    }
  }

  // ------------------------------------------------------- editor keys

  function insertText(text) {
    // execCommand keeps the browser's undo stack intact; fall back if unsupported.
    if (!document.execCommand('insertText', false, text)) {
      els.source.setRangeText(text, els.source.selectionStart, els.source.selectionEnd, 'end');
      scheduleUpdate();
    }
  }

  const OPENS_BLOCK = /^\s*(?:if\b.*|elif\b.*|else|while\b.*|for\b.*|do|def\b.*)$|:\s*$/i;

  function onKeyDown(e) {
    const ta = els.source;
    if (e.key === 'Tab') {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: end, value } = ta;
      const multi = value.slice(s, end).includes('\n');
      if (!multi && !e.shiftKey) return insertText(INDENT);
      // Indent / dedent every selected line.
      const from = value.lastIndexOf('\n', s - 1) + 1;
      const lines = value.slice(from, end).split('\n');
      // Dedent removes one tab (or, for pasted space-indented code, up to four spaces).
      const changed = lines.map((l) => (e.shiftKey ? l.replace(/^(?:\t| {1,4})/, '') : INDENT + l)).join('\n');
      ta.setSelectionRange(from, end);
      insertText(changed);
      ta.setSelectionRange(from, from + changed.length);
    } else if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      const before = ta.value.slice(0, ta.selectionStart);
      const lineText = before.slice(before.lastIndexOf('\n') + 1);
      const indent = lineText.match(/^\s*/)[0];
      insertText('\n' + indent + (OPENS_BLOCK.test(lineText) ? INDENT : ''));
    }
  }

  // ------------------------------------------------------------ divider

  const EDITOR_WIDTH_KEY = 'p2u.editorWidth';
  const MIN_EDITOR = 240;
  const MIN_DIAGRAM = 280;

  /**
   * Draggable split between editor and diagram. The width lives in the
   * --editor-w custom property on .workspace; without it the CSS default
   * (38%, at least 300px) applies.
   */
  function setupDivider() {
    const divider = $('divider');
    const workspace = divider.parentElement;
    const editor = $('editor-pane');

    const maxWidth = () => workspace.clientWidth - divider.offsetWidth - MIN_DIAGRAM;
    const clamp = (px) => Math.round(Math.max(MIN_EDITOR, Math.min(px, maxWidth())));

    function syncAria() {
      const total = workspace.clientWidth || 1;
      divider.setAttribute('aria-valuemin', String(Math.round((MIN_EDITOR / total) * 100)));
      divider.setAttribute('aria-valuemax', String(Math.round((maxWidth() / total) * 100)));
      divider.setAttribute('aria-valuenow', String(Math.round((editor.offsetWidth / total) * 100)));
    }

    function setWidth(px, persist) {
      const width = clamp(px);
      workspace.style.setProperty('--editor-w', `${width}px`);
      if (persist) save(EDITOR_WIDTH_KEY, String(width));
      syncAria();
    }

    function reset() {
      workspace.style.removeProperty('--editor-w');
      try {
        localStorage.removeItem(EDITOR_WIDTH_KEY);
      } catch {
        /* storage unavailable */
      }
      syncAria();
    }

    let drag = null;
    divider.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      drag = { x: e.clientX, width: editor.offsetWidth };
      divider.setPointerCapture(e.pointerId);
      divider.classList.add('dragging');
      document.body.classList.add('resizing');
    });
    divider.addEventListener('pointermove', (e) => {
      if (drag) setWidth(drag.width + e.clientX - drag.x, false);
    });
    const endDrag = () => {
      if (!drag) return;
      drag = null;
      divider.classList.remove('dragging');
      document.body.classList.remove('resizing');
      save(EDITOR_WIDTH_KEY, String(editor.offsetWidth));
    };
    divider.addEventListener('pointerup', endDrag);
    divider.addEventListener('pointercancel', endDrag);
    divider.addEventListener('dblclick', reset);

    divider.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 96 : 24;
      const width = editor.offsetWidth;
      const next = { ArrowLeft: width - step, ArrowRight: width + step, Home: MIN_EDITOR, End: maxWidth() }[e.key];
      if (next === undefined) return;
      e.preventDefault();
      setWidth(next, true);
    });

    // Keep a saved width inside the window as it resizes.
    window.addEventListener('resize', () => {
      if (workspace.style.getPropertyValue('--editor-w')) setWidth(editor.offsetWidth, false);
      else syncAria();
    });

    const saved = Number(load(EDITOR_WIDTH_KEY));
    if (saved > 0) setWidth(saved, false);
    else syncAria();
  }

  // ------------------------------------------------------------- focus

  /**
   * What hovering `target` should highlight, or null:
   * - a loop's decision or back edge (data-loop-id) lights that loop;
   * - a call action (data-calls) lights the frames it invokes, and itself.
   * `attr` names the membership list (data-loops / data-frames) to match.
   */
  function focusFor(target) {
    const loop = target.closest('[data-loop-id]');
    if (loop) return { key: `loop:${loop.dataset.loopId}`, attr: 'loops', ids: [loop.dataset.loopId] };
    const call = target.closest('.p2u-node[data-calls]');
    if (call) {
      return { key: `call:${call.dataset.line}:${call.dataset.calls}`, attr: 'frames', ids: call.dataset.calls.split(' '), keep: call };
    }
    return null;
  }

  /** Dim everything outside the focused group; null clears. */
  function applyFocus(focus) {
    const svg = els.stage.querySelector('svg');
    if (!svg) return;
    svg.classList.toggle('focus', !!focus);
    for (const el of svg.querySelectorAll('.p2u-node, .p2u-edge, .p2u-guard, .p2u-frame')) {
      let on = false;
      if (focus) {
        const mine = (el.dataset[focus.attr] || '').split(' ');
        on = el === focus.keep || focus.ids.some((id) => mine.includes(id));
      }
      el.classList.toggle('in-focus', on);
    }
  }

  function setupHoverFocus() {
    els.stage.addEventListener('pointerover', (e) => {
      const focus = focusFor(e.target);
      const key = focus ? focus.key : null;
      if (key !== state.focusKey) {
        state.focusKey = key;
        applyFocus(focus);
      }
    });
    els.stage.addEventListener('pointerleave', () => {
      state.focusKey = null;
      applyFocus(null);
    });
  }

  // ---------------------------------------------------------- zoom/pan

  function applyTransform() {
    els.stage.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.scale})`;
    els.zoomLevel.textContent = `${Math.round(state.scale * 100)}%`;
  }

  function zoomAt(factor, cx, cy) {
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, state.scale * factor));
    const k = next / state.scale;
    state.tx = cx - (cx - state.tx) * k;
    state.ty = cy - (cy - state.ty) * k;
    state.scale = next;
    applyTransform();
  }

  function zoomCentre(factor) {
    zoomAt(factor, els.viewport.clientWidth / 2, els.viewport.clientHeight / 2);
  }

  function fit() {
    const svg = els.stage.querySelector('svg');
    if (!svg) return;
    const w = svg.viewBox.baseVal.width;
    const h = svg.viewBox.baseVal.height;
    const vw = els.viewport.clientWidth;
    const vh = els.viewport.clientHeight - 56; // keep clear of the zoom bar
    state.scale = Math.min(1.25, Math.max(MIN_SCALE, Math.min(vw / w, vh / h)));
    state.tx = (vw - w * state.scale) / 2;
    state.ty = Math.max(0, (vh - h * state.scale) / 2);
    applyTransform();
  }

  function setupPanZoom() {
    const vp = els.viewport;
    vp.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const rect = vp.getBoundingClientRect();
        const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
        zoomAt(factor, e.clientX - rect.left, e.clientY - rect.top);
      },
      { passive: false }
    );

    let drag = null;
    vp.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, tx: state.tx, ty: state.ty, moved: false, target: e.target };
      vp.setPointerCapture(e.pointerId);
    });
    vp.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      vp.classList.add('panning');
      state.tx = drag.tx + dx;
      state.ty = drag.ty + dy;
      applyTransform();
    });
    const end = () => {
      if (drag && !drag.moved) {
        const node = drag.target.closest && drag.target.closest('.p2u-node[data-line], .p2u-frame[data-line]');
        if (node) selectLine(Number(node.dataset.line));
      }
      drag = null;
      vp.classList.remove('panning');
    };
    vp.addEventListener('pointerup', end);
    vp.addEventListener('pointercancel', end);

    vp.addEventListener('keydown', (e) => {
      const step = 40;
      const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
      if (moves[e.key]) {
        state.tx += moves[e.key][0];
        state.ty += moves[e.key][1];
        applyTransform();
      } else if (e.key === '+' || e.key === '=') zoomCentre(1.2);
      else if (e.key === '-') zoomCentre(1 / 1.2);
      else if (e.key === '0') fit();
      else return;
      e.preventDefault();
    });

    $('zoom-in').addEventListener('click', () => zoomCentre(1.2));
    $('zoom-out').addEventListener('click', () => zoomCentre(1 / 1.2));
    $('zoom-fit').addEventListener('click', fit);
    els.zoomLevel.addEventListener('click', () => zoomCentre(1 / state.scale));
  }

  // ------------------------------------------------------------ export

  let toastTimer = 0;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 1800);
  }

  function fileName() {
    // Name the file after the first top-level DEF, if any.
    const frame = state.ast && state.ast.body.find((s) => s.type === 'frame');
    const title = frame && frame.title;
    return (title || 'activity-diagram').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'activity-diagram';
  }

  function setupExport() {
    const svg = () => els.stage.querySelector('svg');
    $('export-svg').addEventListener('click', () => svg() && exporters.downloadSVG(svg(), fileName()));
    // PNG follows the theme on screen; SVG stays light for embedding in documents.
    $('export-png').addEventListener('click', () => {
      if (svg()) exporters.downloadPNG(svg(), fileName(), currentTheme()).catch((err) => toast(err.message));
    });
  }

  // -------------------------------------------------------------- init

  function loadSource(text) {
    els.source.value = text;
    update();
    fit();
  }

  function init() {
    $('version').textContent = `v${version}`;

    for (const [i, ex] of examples.entries()) {
      els.examples.add(new Option(ex.name, String(i)));
    }
    els.examples.addEventListener('change', () => {
      const ex = examples[Number(els.examples.value)];
      if (ex) loadSource(ex.source);
      els.examples.value = '';
    });

    els.syntaxToggle.addEventListener('click', () => {
      const open = els.syntax.hidden;
      els.syntax.hidden = !open;
      els.syntaxToggle.setAttribute('aria-expanded', String(open));
    });

    els.source.addEventListener('input', scheduleUpdate);
    els.source.addEventListener('keydown', onKeyDown);
    els.source.addEventListener('scroll', () => (els.gutter.scrollTop = els.source.scrollTop));
    for (const ev of ['keyup', 'click', 'focus', 'blur']) els.source.addEventListener(ev, highlightCurrentLine);

    setupPanZoom();
    setupHoverFocus();
    setupDivider();
    setupExport();
    setupThemeToggle();

    const saved = load(STORAGE_KEY);
    loadSource(saved !== null && saved.trim() ? saved : examples[0].source);
  }

  init();
})();
