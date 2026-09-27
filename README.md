# Pseudocode → UML Activity Diagram

A static web page that turns structured pseudocode into a UML activity diagram as you type.
No build step, no dependencies, no server-side code.

**Live:** https://justindms.github.io/uml-generator/

## Running it

The site is deployed with GitHub Pages straight from the repository root (`index.html`), with no build step.
`.nojekyll` tells Pages to serve the files as they are.

To run it locally, serve the folder with any static file server and open `index.html`, for example:

```bash
python -m http.server 8765
```

Then visit http://localhost:8765. Opening `index.html` straight from disk also works in most browsers,
because the scripts are plain classic scripts rather than ES modules.

Run the tests (Node 18+):

```bash
node --test tests/
```

## Supported pseudocode

| Pseudocode | Diagram |
| --- | --- |
| any other line | action (rounded rectangle) |
| `IF c` / `ELIF c` / `ELSE` | square decision node with `c` written inside; `yes` continues down, `no` exits right; then a merge node (omitted when only one branch continues). Each `ELIF` becomes its own nested decision. `ELSE` must be alone on its line. |
| `WHILE c` | decision `c` → `yes` body → loops back into the decision's left corner; `no` exits right |
| `FOR …` (e.g. `FOR x IN xs`) | the same loop shape with the header text in the diamond; paths are `next` / `done` |
| `DO … WHILE c` | post-test loop |
| `RETURN` · `RETURN x` | flow ends at an activity final node |
| `FRAME Name` | named frame (rounded rectangle with a title tab) around its indented block. Frames nest and can sit anywhere: flow enters through the top border straight to the first step inside and leaves through the bottom border. A program that is exactly one `FRAME` is the activity's own frame, with the initial and final nodes inside it. `RETURN` inside a frame still ends the whole activity. |

- **Blocks** are defined by indentation alone: a block is the lines indented below its header and ends
  where the indentation does. An unindented body is an empty block and gets a warning. Each leading
  whitespace character counts as one level (one tab = one space); the editor's Tab key inserts a real tab,
  and mixing tabs and spaces in one file produces a warning. A trailing `:` is optional.
- **Not keywords:** `THEN`, `ELSE IF`, `END`, `TO`, `REPEAT`, `UNTIL` and `STOP`. Braces don't delimit blocks.
  `ELSE IF`, `ELSEIF` and `ELSIF` are errors that suggest `ELIF`. A trailing `THEN` or a leftover `END …` line
  gets a warning. The other words are drawn as plain text.
- **Loops vs. conditionals:** loop decisions (WHILE, FOR, DO) have a double outline and their own colour,
  and their loop-back edges share that colour. IF decisions are plain diamonds. Hovering a loop's decision
  or its loop-back edge dims everything outside that loop.
- **Layout:** each statement sits directly below the flow that reaches it. After a loop, that is the loop's
  exit line rather than the program's starting axis, which keeps connecting lines straight and short.
- **Comments:** `// …` anywhere, or `#` at the start of a line.
- The examples use `=` for assignment and `==` for comparison. `<-` is still accepted and displayed as `←`.
  Keywords are case-insensitive.

## Architecture

```
source text ─▶ parser.js ─▶ AST ─▶ layout.js ─▶ geometry ─▶ render.js ─▶ SVG
                                                                         └─▶ export.js (SVG / PNG files)
```

| File | Responsibility |
| --- | --- |
| `js/parser.js` | Line-based parser that produces an AST (`action`, `if`, `while`, `doWhile`, `return`, `frame`) plus diagnostics with line numbers. |
| `js/layout.js` | Structured layout. Each statement becomes a *fragment* with a vertical axis. Compound statements place their children and route orthogonal edges and loop rails around them. A fragment's outgoing flow is left *dangling* for the parent to finish, so every flow is one polyline with at most 4 bends (enforced by a randomized test). It knows nothing about SVG. |
| `js/render.js` | Turns the geometry into SVG markup with CSS classes, so the page theme drives the colours. |
| `js/export.js` | Standalone SVG (styles inlined) and PNG (2× raster). Exports always use the light theme. |
| `js/app.js` | UI: live update, gutter and problem list, zoom/pan, click a node to jump to its source line, loop hover highlighting, examples, light/dark toggle (follows the system until you choose), `localStorage` persistence. |
| `js/examples.js` | Sample programs. They double as test fixtures. |
| `js/version.js` | The release version shown in the top bar (semver). Bump it with each release. |

All modules attach to one global, `P2U`, so they load with plain `<script>` tags and can be `require`d in Node for the tests.

Because the layout is built from the AST's structure rather than by a generic graph layouter, the output has
no crossing edges and stays stable while you type. The tradeoff is that each new construct needs its own
layout function.

## Known limitations / next steps

- `BREAK`, `CONTINUE`, `GOTO` and `SWITCH/CASE` are not modelled yet. They are drawn as plain actions with a warning.
  - `SWITCH/CASE` can be lowered to nested decisions the way `ELIF` chains are, or drawn as one
    multi-way decision with the switched expression inside and case values labelling the outgoing edges.
  - `BREAK` / `CONTINUE` need the loop layouts to expose exit and loop-back ports to nested fragments.
- `RETURN` inside a nested frame ends the whole activity. Treating frames as sub-activities, where `RETURN` leaves only
  the innermost frame, would need the same exit ports as `BREAK`.
- Swimlanes (partitions), fork/join for `PARALLEL` blocks, object nodes and signals (`SEND` / `RECEIVE`) are
  natural extensions: add an AST node, a layout function and a render case.
- The editor is a plain `<textarea>`. Swapping in CodeMirror would add syntax highlighting.
