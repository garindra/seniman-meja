import { posix as pathPosix } from "node:path";
import {
  createCollection,
  createRef,
  createRoot,
  onCleanup,
  onDispose,
  untrack,
  useClient,
  useEffect,
  useState,
} from "seniman";
import { Style } from "seniman/head";
import { createServer as createSenimanServer } from "seniman/server";
import {
  STATUS_MESSAGE,
  STATUS_PROMPT,
  SESSION_REPLACED_ERROR_CODE,
  TerminalModel,
  attachMeja,
  paneAt,
  requestAttachmentGrant,
  runMejaCommand,
  spanRuns,
} from "./meja-client.js";
import { parseArgs } from "./parse-args.js";
import {
  createPasswordGate,
  promptForPassword,
} from "./password-auth.js";

const VIEWPORT_RESIZE_SETTLE_MS = 80;
const TERMINAL_LINE_HEIGHT = 1.24;
const SPAN_WIDTH_CLASS_MAX = 10;
const KEY_INPUT = {
  Enter: "\r",
  Backspace: "\x7f",
  Tab: "\t",
  Escape: "\x1b",
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowRight: "\x1b[C",
  ArrowLeft: "\x1b[D",
  Home: "\x1b[H",
  End: "\x1b[F",
  Insert: "\x1b[2~",
  Delete: "\x1b[3~",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
  F1: "\x1bOP",
  F2: "\x1bOQ",
  F3: "\x1bOR",
  F4: "\x1bOS",
  F5: "\x1b[15~",
  F6: "\x1b[17~",
  F7: "\x1b[18~",
  F8: "\x1b[19~",
  F9: "\x1b[20~",
  F10: "\x1b[21~",
  F11: "\x1b[23~",
  F12: "\x1b[24~",
};
const TERMINAL_KEY_NAMES = Object.keys(KEY_INPUT);
const HELPER_INPUT = {
  "ctrl-b": "\x02",
  "ctrl-c": "\x03",
  tab: "\t",
  escape: KEY_INPUT.Escape,
  "arrow-up": KEY_INPUT.ArrowUp,
  "arrow-down": KEY_INPUT.ArrowDown,
  "arrow-right": KEY_INPUT.ArrowRight,
  "arrow-left": KEY_INPUT.ArrowLeft,
  home: KEY_INPUT.Home,
  end: KEY_INPUT.End,
  "page-up": KEY_INPUT.PageUp,
  "page-down": KEY_INPUT.PageDown,
  colon: ":",
  comma: ",",
  slash: "/",
  dash: "-",
  tilde: "~",
  pipe: "|",
};
const KEY_HELPERS = [
  ["tab", "Tab"],
  ["ctrl-c", "Ctrl+C"],
  ["ctrl-b", "Ctrl+B"],
  ["arrow-left", "←"],
  ["arrow-right", "→"],
  ["slash", "/"],
];
const PREFIX_HELPERS = [
  [":", ":"],
  ["%", "%"],
  ['"', '"'],
  ["$", "$"],
  [",", ","],
  ["[", "["],
];
const FULL_KEY_HELPERS = [
  ["escape", "Esc"],
  ["ctrl", "Ctrl"],
  ["alt", "Alt"],
  ["arrow-left", "←"],
  ["arrow-down", "↓"],
  ["arrow-up", "↑"],
  ["arrow-right", "→"],
];
const REPEATABLE_KEY_HELPERS = new Set([
  "arrow-left",
  "arrow-down",
  "arrow-up",
  "arrow-right",
  "home",
  "end",
  "page-up",
  "page-down",
]);

function applyControl(value) {
  if (value.length !== 1) {
    return null;
  }
  const key = value.toUpperCase();
  const code = key.codePointAt(0);
  if (value === " " || value === "2") {
    return "\x00";
  }
  if (value === "?") {
    return "\x7f";
  }
  return code >= 64 && code <= 95
    ? String.fromCodePoint(code & 0x1f)
    : null;
}

function spanClassName(span) {
  const width = span.end - span.start;
  return `${span.className} mjw-${width}`;
}

function spanHasCursor(span) {
  return span.className.split(/\s+/).includes("__mjc");
}

function spanMatches(left, right) {
  return (
    left.key === right.key &&
    left.text === right.text &&
    left.spaceOnly === right.spaceOnly &&
    left.className === right.className &&
    left.start === right.start &&
    left.end === right.end
  );
}

function spanPartitionMatches(previous, next) {
  return (
    previous.length === next.length &&
    previous.every((span, index) => {
      const candidate = next[index];
      return (
        span.start === candidate.start &&
        span.end === candidate.end &&
        (
          span.className === candidate.className ||
          (!spanHasCursor(span) && !spanHasCursor(candidate))
        )
      );
    })
  );
}

const cssText = `
html {
  --mj-attach-bar-height: 32px;
  --mj-visual-viewport-height: 100%;
  width: 100%;
  height: var(--mj-visual-viewport-height);
  min-height: 0;
  margin: 0;
  overflow: hidden;
  overflow: clip;
  overscroll-behavior: none;
  background: #101318;
  color: #d8dee9;
  -webkit-text-size-adjust: none;
  text-size-adjust: none;
}

body {
  width: 100%;
  height: var(--mj-visual-viewport-height);
  min-height: 0;
  margin: 0;
  overflow: hidden;
  overflow: clip;
  overscroll-behavior: none;
  background: #101318;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
}

* {
  box-sizing: border-box;
}

.window-tabs {
  display: flex;
}

.window-tabs-keys {
  display: none;
}

.mjr {
  --mj-fg: #d8dee9;
  --mj-bg: #101318;
  height: ${TERMINAL_LINE_HEIGHT}em;
  min-height: ${TERMINAL_LINE_HEIGHT}em;
  white-space: pre;
  line-height: ${TERMINAL_LINE_HEIGHT};
  font-variant-ligatures: none;
}

:where(.mjr > span) {
  display: inline-block;
  vertical-align: top;
  color: var(--mj-fg);
  background-color: var(--mj-bg);
  font-weight: 400;
  font-style: normal;
  text-decoration: none;
  opacity: 1;
  visibility: visible;
}

${Array.from(
  { length: SPAN_WIDTH_CLASS_MAX },
  (_, index) => `.mjw-${index + 1}{width:${index + 1}ch}`
).join("\n")}

.mjp-focused .mjr > .__mjc {
  color: #101318 !important;
  background-color: #ffffff !important;
  visibility: visible !important;
}

.mjp:not(.mjp-focused) .mjr > .__mjc {
  color: var(--mj-fg) !important;
  background-color: var(--mj-bg) !important;
  visibility: visible !important;
}

.key-helper {
  display: none;
}

@media (hover: none), (pointer: coarse), (max-width: 700px) {
  html {
    --mj-attach-bar-height: 42px;
  }

  .attach-bar.mj-mode-keys .window-tabs,
  .attach-bar.mj-mode-full .window-tabs,
  .attach-bar.mj-mode-prefix .window-tabs {
    display: none;
  }

  .attach-bar.mj-mode-keys .key-helper,
  .attach-bar.mj-mode-full .key-helper,
  .attach-bar.mj-mode-prefix .key-helper {
    display: flex;
  }

  .attach-bar.mj-mode-tabs .window-tabs-keys {
    display: block;
  }
}

.key-helper-group {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
}

.key-helper-group[hidden] {
  display: none;
}

.key-helper-group::-webkit-scrollbar {
  display: none;
}

.key-helper button {
  position: relative;
  flex: 0 0 auto;
  min-width: 38px;
  height: 100%;
  padding: 0 6px;
  border: 0;
  border-right: 1px solid #343b46;
  border-radius: 0;
  color: #d8dee9;
  background: #202630;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06), inset 0 -2px 0 #151a21;
  font: 12px/calc(var(--mj-attach-bar-height) - 1px) ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: color 120ms ease, background-color 120ms ease, box-shadow 120ms ease, transform 80ms ease;
}

.key-helper button:hover {
  color: #f3f6fb;
  background: #2a3340;
}

.key-helper button:active {
  transform: translateY(1px);
  color: #ffffff;
  background: #171d26;
  box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.02);
  transition-duration: 40ms;
}

.key-helper button.is-pressed {
  transform: translateY(1px);
  color: #ffffff;
  background: #171d26;
  box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.02);
  transition-duration: 40ms;
}

.key-helper button:focus-visible {
  z-index: 1;
  outline: 2px solid #54a8ff;
  outline-offset: -3px;
}

.key-helper button.is-active {
  color: #07111f;
  background: #54a8ff;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.42), inset 0 -2px 0 #1f6fb5;
}

.key-helper button.is-active:hover {
  color: #07111f;
  background: #79bdff;
}

.key-helper button.is-active:active {
  background: #2586df;
  box-shadow: inset 0 2px 4px rgba(3, 31, 63, 0.36), inset 0 1px 0 rgba(255, 255, 255, 0.16);
}

.key-helper button.is-active.is-pressed {
  background: #2586df;
  box-shadow: inset 0 2px 4px rgba(3, 31, 63, 0.36), inset 0 1px 0 rgba(255, 255, 255, 0.16);
}

.prompt-cancel {
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition: filter 80ms ease, transform 80ms ease, box-shadow 80ms ease;
}

.prompt-cancel:active,
.prompt-cancel.is-pressed {
  transform: translateY(1px);
  filter: brightness(0.76);
  box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.42);
  transition-duration: 40ms;
}

.key-helper .key-helper-tabs,
.key-helper .key-helper-swap {
  flex: 0 0 46px;
  min-width: 46px;
  border-left: 1px solid #4b5565;
  color: #54a8ff;
  background: #171b22;
}

.key-helper .key-helper-swap {
  border-right: 0;
  font-size: 18px;
}

@media (max-width: 480px) {
  .window-tabs-location {
    display: none;
  }
}

`;

function statusLocation(hostname, root, home) {
  let normalizedRoot = root ? pathPosix.normalize(root) : "";
  const normalizedHome = home ? pathPosix.normalize(home) : "";
  if (normalizedRoot === ".") {
    normalizedRoot = "";
  }
  if (normalizedRoot && normalizedHome) {
    const relative = pathPosix.relative(
      normalizedHome,
      normalizedRoot
    );
    if (relative !== ".." && !relative.startsWith("../")) {
      normalizedRoot =
        relative === "." || relative === ""
          ? "~"
          : `~/${relative}`;
    }
  }
  return {
    hostname: hostname || "?",
    root: normalizedRoot,
  };
}

function createRowRecord(snapshot) {
  return {
    snapshot,
    applySnapshot: null,
  };
}

function updateRowRecord(record, snapshot) {
  if (record.applySnapshot) {
    record.applySnapshot(snapshot);
  } else {
    record.snapshot = snapshot;
  }
}

function createPaneRecord(model, placement, focusedPaneId) {
  return {
    model,
    slot: placement.slot,
    placement,
    focused: placement.paneId === focusedPaneId,
  };
}

function isPaneWireCell(placements, column, row) {
  if (placements.length === 0) {
    return false;
  }
  let minX = placements[0].rect.x;
  let minY = placements[0].rect.y;
  let maxX =
    placements[0].rect.x + placements[0].rect.width;
  let maxY =
    placements[0].rect.y + placements[0].rect.height;
  for (const { rect } of placements.slice(1)) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }
  return (
    column >= minX &&
    column < maxX &&
    row >= minY &&
    row < maxY &&
    !paneAt(placements, column, row)
  );
}

function paneBorderGlyph(placements, column, row) {
  if (!isPaneWireCell(placements, column, row)) {
    return "";
  }
  const up = isPaneWireCell(placements, column, row - 1);
  const down = isPaneWireCell(placements, column, row + 1);
  const left = isPaneWireCell(placements, column - 1, row);
  const right = isPaneWireCell(placements, column + 1, row);
  if (up && down && left && right) return "┼";
  if (up && down && right) return "├";
  if (up && down && left) return "┤";
  if (left && right && down) return "┬";
  if (left && right && up) return "┴";
  if (down && right) return "┌";
  if (down && left) return "┐";
  if (up && right) return "└";
  if (up && left) return "┘";
  if (up || down) return "│";
  if (left || right) return "─";
  if (
    paneAt(placements, column - 1, row) &&
    paneAt(placements, column + 1, row)
  ) {
    return "│";
  }
  if (
    paneAt(placements, column, row - 1) &&
    paneAt(placements, column, row + 1)
  ) {
    return "─";
  }
  return "";
}

function borderPointKey(column, row) {
  return `${column},${row}`;
}

function paneBorderCells(placements) {
  const borders = new Map();
  const add = (paneId, column, row) => {
    let cells = borders.get(paneId);
    if (!cells) {
      cells = new Set();
      borders.set(paneId, cells);
    }
    cells.add(borderPointKey(column, row));
  };

  for (let firstIndex = 0; firstIndex < placements.length; firstIndex += 1) {
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < placements.length;
      secondIndex += 1
    ) {
      let first = placements[firstIndex];
      let second = placements[secondIndex];
      if (
        second.rect.x + second.rect.width ===
        first.rect.x - 1
      ) {
        [first, second] = [second, first];
      }
      if (
        first.rect.x + first.rect.width ===
        second.rect.x - 1
      ) {
        const start = Math.max(first.rect.y, second.rect.y);
        const end = Math.min(
          first.rect.y + first.rect.height,
          second.rect.y + second.rect.height
        );
        const column = first.rect.x + first.rect.width;
        for (let row = start; row < end; row += 1) {
          add(first.paneId, column, row);
          add(second.paneId, column, row);
        }
      }

      first = placements[firstIndex];
      second = placements[secondIndex];
      if (
        second.rect.y + second.rect.height ===
        first.rect.y - 1
      ) {
        [first, second] = [second, first];
      }
      if (
        first.rect.y + first.rect.height ===
        second.rect.y - 1
      ) {
        const start = Math.max(first.rect.x, second.rect.x);
        const end = Math.min(
          first.rect.x + first.rect.width,
          second.rect.x + second.rect.width
        );
        const row = first.rect.y + first.rect.height;
        for (let column = start; column < end; column += 1) {
          add(first.paneId, column, row);
          add(second.paneId, column, row);
        }
      }
    }
  }

  const right = placements.reduce(
    (maximum, { rect }) =>
      Math.max(maximum, rect.x + rect.width),
    0
  );
  const bottom = placements.reduce(
    (maximum, { rect }) =>
      Math.max(maximum, rect.y + rect.height),
    0
  );
  for (let row = 0; row < bottom; row += 1) {
    for (let column = 0; column < right; column += 1) {
      const key = borderPointKey(column, row);
      if (
        !paneBorderGlyph(placements, column, row) ||
        Array.from(borders.values()).some((cells) => cells.has(key))
      ) {
        continue;
      }
      for (const [paneId, cells] of borders) {
        if (
          cells.has(borderPointKey(column - 1, row)) ||
          cells.has(borderPointKey(column + 1, row)) ||
          cells.has(borderPointKey(column, row - 1)) ||
          cells.has(borderPointKey(column, row + 1))
        ) {
          add(paneId, column, row);
        }
      }
    }
  }
  return borders;
}

function sameBorderCells(first, second) {
  return (
    first.size === second.size &&
    Array.from(first).every((point) => second.has(point))
  );
}

function splitAmbiguousBorder(
  placements,
  focusedPaneId,
  otherPaneId,
  border
) {
  const focused = placements.find(
    ({ paneId }) => paneId === focusedPaneId
  );
  const other = placements.find(
    ({ paneId }) => paneId === otherPaneId
  );
  if (!focused || !other) {
    return border;
  }

  const vertical = focused.rect.x !== other.rect.x;
  const firstHalf = vertical
    ? focused.rect.x < other.rect.x
    : focused.rect.y < other.rect.y;
  const ordered = Array.from(border, (key) => {
    const [column, row] = key.split(",").map(Number);
    return { column, row, key };
  }).sort((left, right) =>
    vertical
      ? left.row - right.row || left.column - right.column
      : left.column - right.column || left.row - right.row
  );
  return new Set(
    ordered
      .filter((point, index) =>
        firstHalf
          ? index * 2 < ordered.length
          : (index + 1) * 2 > ordered.length
      )
      .map(({ key }) => key)
  );
}

function focusedPaneBorderCells(placements, focusedPaneId) {
  const borders = paneBorderCells(placements);
  const focused = borders.get(focusedPaneId);
  if (!focused?.size) {
    return new Set();
  }
  for (const [paneId, candidate] of borders) {
    if (
      paneId !== focusedPaneId &&
      sameBorderCells(focused, candidate)
    ) {
      return splitAmbiguousBorder(
        placements,
        focusedPaneId,
        paneId,
        focused
      );
    }
  }
  return focused;
}

function paneBorderRecords(layout) {
  const placements = layout?.panes ?? [];
  if (placements.length < 2) {
    return [];
  }
  const maxX = placements.reduce(
    (maximum, { rect }) =>
      Math.max(maximum, rect.x + rect.width),
    0
  );
  const maxY = placements.reduce(
    (maximum, { rect }) =>
      Math.max(maximum, rect.y + rect.height),
    0
  );
  const focusedCells = focusedPaneBorderCells(
    placements,
    layout.focusedPaneId
  );
  const records = [];
  for (let row = 0; row < maxY; row += 1) {
    for (let column = 0; column < maxX; column += 1) {
      const glyph = paneBorderGlyph(placements, column, row);
      if (!glyph) {
        continue;
      }
      const focused = focusedCells.has(
        borderPointKey(column, row)
      );
      records.push({ column, row, glyph, focused });
    }
  }
  return records;
}

function fitWindowTitle(title, columns) {
  const value = String(title ?? "");
  if (value.length <= columns) {
    return value;
  }
  if (columns <= 1) {
    return "…";
  }

  const words = value.trim().split(/\s+/);
  let prefix = "";
  for (const word of words) {
    const candidate = prefix ? `${prefix} ${word}` : word;
    if (candidate.length + 1 > columns) {
      break;
    }
    prefix = candidate;
  }

  if (prefix) {
    return `${prefix}…`;
  }
  return `${words[0].slice(0, columns - 1)}…`;
}

function fitPathTail(path, columns) {
  const value = String(path ?? "");
  if (value.length <= columns) {
    return value;
  }
  if (columns <= 1) {
    return "…";
  }
  return `…${value.slice(-(columns - 1))}`;
}

function fitStatusLocation({ hostname, root }, columns) {
  const prefix = root ? `[${hostname}:` : `[${hostname}`;
  const suffix = "]";
  if (!root) {
    return `${prefix}${suffix}`;
  }
  const pathColumns = Math.max(
    1,
    columns - prefix.length - suffix.length
  );
  return `${prefix}${fitPathTail(root, pathColumns)}${suffix}`;
}

function useTextColumns() {
  const [columns, setColumns] = useState(1024);
  const reportColumns = (nextColumns) => {
    if (
      Number.isSafeInteger(nextColumns) &&
      nextColumns >= 1 &&
      nextColumns !== columns()
    ) {
      setColumns(nextColumns);
    }
  };
  const mount = $c((element) => {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    let frame = 0;
    let lastColumns = 0;
    const measure = () => {
      frame = 0;
      const style = getComputedStyle(element);
      const width =
        element.getBoundingClientRect().width -
        (parseFloat(style.paddingLeft) || 0) -
        (parseFloat(style.paddingRight) || 0);
      context.font =
        `${style.fontStyle} ${style.fontWeight} ` +
        `${style.fontSize} ${style.fontFamily}`;
      const glyphWidth = context.measureText("0").width;
      if (width <= 0 || glyphWidth <= 0) {
        return;
      }
      const nextColumns = Math.max(
        1,
        Math.floor(width / glyphWidth)
      );
      if (nextColumns !== lastColumns) {
        lastColumns = nextColumns;
        $s(reportColumns)(nextColumns);
      }
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    frame = requestAnimationFrame(measure);
    return () => {
      observer.disconnect();
      if (frame) {
        cancelAnimationFrame(frame);
      }
    };
  });
  return [columns, mount];
}

function PromptStatus({ readStatus, readDraft }) {
  const status = readStatus();
  const draft = readDraft();
  if (
    status.kind !== STATUS_MESSAGE &&
    (!draft || draft.resolved)
  ) {
    return null;
  }

  return <div
    role="status"
    aria-live="polite"
    aria-label={
      status.kind === STATUS_MESSAGE
        ? "Meja status message"
        : "Meja command prompt"
    }
    style={{ position: "absolute", zIndex: 1, inset: 0, display: "flex", minWidth: 0, alignItems: "center", overflow: "hidden", padding: "0 7px", color: "#f5f9ff", background: "#287dcc", fontSize: "12px", lineHeight: "calc(var(--mj-attach-bar-height) - 1px)", whiteSpace: "pre" }}
  >
    {status.kind === STATUS_MESSAGE
      ? <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "clip" }}>
          {status.message.text}
        </span>
      : null}
    {status.kind !== STATUS_MESSAGE
      ? <span style={{ flex: "0 0 auto" }}>{draft.label}</span>
      : null}
    {status.kind !== STATUS_MESSAGE
      ? <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "clip" }}>
          {draft.before}<span style={{ color: "#287dcc", background: "#101318" }}>{draft.caret}</span>{draft.after}
        </span>
      : null}
    {status.kind !== STATUS_MESSAGE
      ? <button
          type="button"
          class="prompt-cancel"
          value="helper:ctrl-c"
          aria-label="Cancel prompt"
          style={{ appearance: "none", flex: "0 0 auto", alignSelf: "stretch", margin: "0 -7px 0 auto", padding: "0 9px", border: 0, borderLeft: "1px solid #101318", borderRadius: 0, color: "#54a8ff", background: "#101318", font: "inherit", lineHeight: "inherit" }}
        >
          Ctrl+C
        </button>
      : null}
  </div>;
}

function App({ model }) {
  const initial = model.snapshot();
  const initialLayout = initial.meta.layout;
  const keyboardRef = createRef();
  let paneRecords = (initialLayout?.panes ?? []).map(
    (placement) =>
      createPaneRecord(
        model,
        placement,
        initialLayout.focusedPaneId
      )
  );
  const paneCollection = createCollection(paneRecords);
  let borderRecords = paneBorderRecords(initialLayout);
  const borderCollection = createCollection(borderRecords);
  let windowRecords = initial.meta.status.windows.slice();
  const windowCollection = createCollection(windowRecords);
  const [error, setError] = useState(initial.meta.error);
  const [terminalColumns, setTerminalColumns] = useState(
    initial.meta.cols || 80
  );
  const [terminalRows, setTerminalRows] = useState(
    initial.meta.rows || model.requestedRows
  );
  const [terminalMetrics, setTerminalMetrics] = useState(null);
  const [clientStatus, setClientStatus] = useState(
    initial.meta.status
  );
  const [statusLocationColumns, mountStatusLocation] =
    useTextColumns();
  const statusLocationParts = () =>
    statusLocation(
      clientStatus().serverHostname,
      clientStatus().root,
      clientStatus().serverHome
    );
  let promptDraftRevision = initial.meta.promptDraftRevision;
  const [promptDraft, setPromptDraft] = useState(
    initial.meta.promptDraft
  );
  const [keyboardActive, setKeyboardActive] = useState(false);
  const [attachView, setAttachView] = useState("keys");
  const [helperCtrl, setHelperCtrl] = useState(false);
  const [helperAlt, setHelperAlt] = useState(false);
  const attachMode = () =>
    keyboardActive() ? attachView() : "idle";
  const client = useClient();
  const writeClipboard = (text) => {
    client.exec($c(() => {
      const value = $s(text);
      const fallback = () => {
        const previous = document.activeElement;
        const textarea = document.createElement("textarea");
        textarea.value = value;
        textarea.setAttribute("readonly", "");
        textarea.style.cssText =
          "position:fixed;left:-10000px;top:0;opacity:0;";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
        previous?.focus?.({ preventScroll: true });
      };
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(value).catch(fallback);
      } else {
        fallback();
      }
    }));
  };
  const handleKeyPress = async (press) => {
    const { key, ctrl, alt, shift } = press;
    let data = null;

    if (ctrl && !alt && key.length === 1) {
      data = applyControl(key);
    } else if (KEY_INPUT[key] !== undefined) {
      data =
        key === "Tab" && shift
          ? "\x1b[Z"
          : KEY_INPUT[key];
      if (alt && key !== "Escape") {
        data = "\x1b" + data;
      }
    } else if (!ctrl && key.length === 1) {
      data = (alt ? "\x1b" : "") + key;
    }

    if (data !== null) {
      await model.sendInput(
        data,
        key === "Escape" && !alt
      );
      if (attachView() === "prefix") {
        setAttachView("keys");
      }
    }
  };
  const consumeHelperModifiers = (value) => {
    const ctrl = helperCtrl();
    const alt = helperAlt();
    let data = value;
    if (ctrl) {
      data = applyControl(data) ?? data;
    }
    if (alt) {
      data = "\x1b" + data;
    }
    if (ctrl) {
      setHelperCtrl(false);
    }
    if (alt) {
      setHelperAlt(false);
    }
    return data;
  };
  const handleTextInput = async (kind, value) => {
    const input =
      kind === "text"
        ? value
        : kind === "enter"
          ? KEY_INPUT.Enter
          : kind === "backspace"
            ? KEY_INPUT.Backspace
            : kind === "delete"
              ? KEY_INPUT.Delete
              : null;
    if (input) {
      await model.sendInput(
        consumeHelperModifiers(input),
        false
      );
      if (attachView() === "prefix") {
        setAttachView("keys");
      }
    }
  };
  const handlePasteInput = async (text) =>
    model.sendInput(`\x1b[200~${text}\x1b[201~`, false);
  const applyHelperPress = async (press) => {
    if (press === "ctrl") {
      setHelperCtrl((active) => !active);
      return;
    }
    if (press === "alt") {
      setHelperAlt((active) => !active);
      return;
    }
    const input = HELPER_INPUT[press];
    if (input === undefined) {
      return;
    }
    await model.sendInput(
      consumeHelperModifiers(input),
      press === "escape"
    );
  };
  const handleAttachAction = async (action) => {
    if (action === "view:tabs") {
      setAttachView("tabs");
      return;
    }
    if (action === "view:keys") {
      setAttachView("keys");
      return;
    }
    if (action === "view:swap") {
      setAttachView((mode) =>
        mode === "full" ? "keys" : "full"
      );
      return;
    }
    if (action === "window:create") {
      await model.createWindow();
      return;
    }
    if (action.startsWith("window:")) {
      const windowId = Number(action.slice(7));
      if (Number.isSafeInteger(windowId)) {
        await model.selectWindow(windowId);
      }
      return;
    }
    if (action.startsWith("helper:")) {
      const press = action.slice(7);
      await applyHelperPress(press);
      if (press === "ctrl-b") {
        setAttachView("prefix");
      }
      return;
    }
    if (action.startsWith("prefix:")) {
      await model.sendInput(action.slice(7), false);
      setAttachView("keys");
    }
  };
  const reportKeyboardActive = (active) => {
    const next = !!active;
    if (next === keyboardActive()) {
      return;
    }
    setKeyboardActive(next);
    if (!next) {
      setAttachView("keys");
      setHelperCtrl(false);
      setHelperAlt(false);
    }
  };
  const onShowTabs = () => setAttachView("tabs");
  const onShowKeys = () => setAttachView("keys");
  const onSwapHelpers = () => {
    setAttachView((mode) =>
      mode === "full" ? "keys" : "full"
    );
  };
  const sendWheelInput =
    async (buttonCode, column, row, modifiers, reportCount) =>
      model.sendWheel(
        buttonCode,
        column,
        row,
        modifiers,
        reportCount
      );
  const sendPointerInput =
    async (action, button, column, row, modifiers) =>
      model.sendPointer(
        action,
        button,
        column,
        row,
        modifiers
      );
  const selectWindow = async (windowId) =>
    model.selectWindow(windowId);
  const createWindow = async () => model.createWindow();
  const reportTerminalMetrics =
    (
      cellWidth,
      rowHeight,
      left,
      viewportWidth,
      availableHeight
    ) => {
      setTerminalMetrics({
        cellWidth,
        rowHeight,
        left,
        viewportWidth,
        availableHeight,
      });
    };
  const focusKeyboard = $c(() => {
    $s(keyboardRef).current?.focus({ preventScroll: true });
  });
  const mountTerminalMetrics = $c((probe) => {
    const terminal = probe.parentElement;
    if (!terminal) {
      return;
    }
    let observer = null;
    let observedBar = null;
    let measureFrame = 0;
    let lastMetrics = "";

    const measure = () => {
      measureFrame = 0;
      const probeRect = probe.getBoundingClientRect();
      if (probeRect.width <= 0 || probeRect.height <= 0) {
        return;
      }

      const terminalRect = terminal.getBoundingClientRect();
      const viewportRect =
        terminal.parentElement?.getBoundingClientRect();
      const attachBar =
        terminal.parentElement?.querySelector(".attach-bar");
      if (
        !viewportRect ||
        !attachBar ||
        viewportRect.width <= 0 ||
        viewportRect.height <= 0
      ) {
        return;
      }
      if (observer && attachBar !== observedBar) {
        observer.observe(attachBar);
        observedBar = attachBar;
      }
      const attachBarRect = attachBar.getBoundingClientRect();
      const metrics = [
        probeRect.width,
        probeRect.height,
        Math.max(0, terminalRect.left - viewportRect.left),
        viewportRect.width,
        Math.max(0, attachBarRect.top - terminalRect.top),
      ];
      const key = metrics.join(":");

      if (key === lastMetrics) {
        return;
      }
      lastMetrics = key;
      $s(reportTerminalMetrics)(
        metrics[0],
        metrics[1],
        metrics[2],
        metrics[3],
        metrics[4]
      );
    };

    if (window.ResizeObserver) {
      observer = new ResizeObserver(measure);
      observer.observe(probe);
      observer.observe(terminal);
      if (terminal.parentElement) {
        observer.observe(terminal.parentElement);
      }
    }
    measureFrame = requestAnimationFrame(measure);

    return () => {
      observer?.disconnect();
      if (measureFrame) {
        cancelAnimationFrame(measureFrame);
      }
    };
  });
  useEffect(() => {
    const metrics = terminalMetrics();
    if (
      !metrics ||
      !Number.isFinite(metrics.viewportWidth) ||
      !Number.isFinite(metrics.availableHeight) ||
      metrics.cellWidth <= 0 ||
      metrics.rowHeight <= 0
    ) {
      return;
    }

    const columns = Math.max(
      2,
      Math.min(
        1024,
        Math.floor(
          (metrics.viewportWidth - metrics.left) /
            metrics.cellWidth
        )
      )
    );
    const rows = Math.max(
      2,
      Math.min(
        1024,
        Math.floor(metrics.availableHeight / metrics.rowHeight)
      )
    );
    const resizeTimer = setTimeout(() => {
      model.sendResize(columns, rows).catch(() => {});
    }, VIEWPORT_RESIZE_SETTLE_MS);
    onCleanup(() => clearTimeout(resizeTimer));
  });
  const handleKeyDown = $c((event) => {
    if (event.isComposing || event.metaKey) {
      return;
    }
    if (
      event.ctrlKey &&
      event.shiftKey &&
      ["c", "v", "x"].includes(event.key.toLowerCase())
    ) {
      return;
    }

    const controlCode = event.key
      .toUpperCase()
      .codePointAt(0);
    const controlCharacter =
      event.key === " " ||
      event.key === "2" ||
      event.key === "?" ||
      (
        controlCode >= 64 &&
        controlCode <= 95
      );
    const handled =
      $s(TERMINAL_KEY_NAMES).includes(event.key) ||
      (
        event.key.length === 1 &&
        (
          !event.ctrlKey ||
          (!event.altKey && controlCharacter)
        )
      );
    if (!handled) {
      return;
    }

    event.preventDefault();
    $s(handleKeyPress)({
      key: event.key,
      ctrl: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
    });
  });
  const mountTextInput = $c((target) => {
    target.focus({ preventScroll: true });
    let handledBeforeInput = false;

    const beforeInput = (event) => {
      if (event.isComposing) {
        return;
      }

      let kind = null;
      let value = null;
      const inputType = event.inputType || "";
      if (
        inputType === "insertText" ||
        inputType === "insertReplacementText"
      ) {
        kind = "text";
        value = event.data;
      } else if (
        inputType === "insertLineBreak" ||
        inputType === "insertParagraph"
      ) {
        kind = "enter";
      } else if (
        inputType === "deleteContentBackward" ||
        inputType === "deleteWordBackward" ||
        inputType === "deleteSoftLineBackward" ||
        inputType === "deleteHardLineBackward"
      ) {
        kind = "backspace";
      } else if (
        inputType === "deleteContentForward" ||
        inputType === "deleteWordForward" ||
        inputType === "deleteSoftLineForward" ||
        inputType === "deleteHardLineForward"
      ) {
        kind = "delete";
      }

      if (kind && (kind !== "text" || value)) {
        event.preventDefault();
        target.value = "";
        handledBeforeInput = true;
        queueMicrotask(() => {
          handledBeforeInput = false;
        });
        $s(handleTextInput)(kind, value);
      }
    };

    const input = (event) => {
      if (handledBeforeInput) {
        target.value = "";
        return;
      }
      if (event.isComposing) {
        return;
      }

      const value = target.value || event.data || "";
      const inputType = event.inputType || "";
      const kind =
        !value && inputType.startsWith("delete")
          ? inputType.includes("Forward")
            ? "delete"
            : "backspace"
          : "text";

      target.value = "";
      if (kind !== "text" || value) {
        $s(handleTextInput)(kind, value);
      }
    };

    target.addEventListener("beforeinput", beforeInput);
    target.addEventListener("input", input);

    return () => {
      target.removeEventListener("beforeinput", beforeInput);
      target.removeEventListener("input", input);
    };
  });
  const mountAttachBar = $c((bar) => {
    const target = $s(keyboardRef).current;
    if (!target) {
      return;
    }

    let suppressedButton = null;
    let suppressClickTimer = 0;
    let pressedButton = null;
    let repeatDelayTimer = 0;
    let repeatIntervalTimer = 0;
    let repeatingButton = null;
    const activateButton = (button) => {
      if (button.value) {
        $s(handleAttachAction)(button.value);
      }
    };
    const stopButtonRepeat = () => {
      clearTimeout(repeatDelayTimer);
      clearInterval(repeatIntervalTimer);
      repeatDelayTimer = 0;
      repeatIntervalTimer = 0;
      repeatingButton = null;
    };
    const startButtonRepeat = (button) => {
      stopButtonRepeat();
      if (button.dataset.repeatable !== "true") {
        return;
      }
      repeatingButton = button;
      repeatDelayTimer = setTimeout(() => {
        repeatDelayTimer = 0;
        if (repeatingButton !== button) {
          return;
        }
        activateButton(button);
        repeatIntervalTimer = setInterval(() => {
          if (repeatingButton === button) {
            activateButton(button);
          }
        }, 100);
      }, 500);
    };
    const clearPressedButton = () => {
      stopButtonRepeat();
      pressedButton?.classList.remove("is-pressed");
      pressedButton = null;
    };
    const setPressedButton = (button) => {
      clearPressedButton();
      pressedButton = button;
      button.classList.add("is-pressed");
    };
    const suppressButtonClick = (button) => {
      suppressedButton = button;
      clearTimeout(suppressClickTimer);
      suppressClickTimer = setTimeout(() => {
        suppressedButton = null;
      }, 750);
    };
    const press = (event) => {
      if (
        event.type === "pointerdown" &&
        event.pointerType === "touch"
      ) {
        return;
      }
      const button = event.target.closest("button");
      if (!button || !bar.contains(button)) {
        return;
      }
      setPressedButton(button);
      if (bar.classList.contains("mj-mode-idle")) {
        if (button.classList.contains("prompt-cancel")) {
          event.preventDefault();
          suppressButtonClick(button);
          activateButton(button);
          return;
        }
        if (
          event.type === "pointerdown" &&
          event.pointerType === "mouse"
        ) {
          event.preventDefault();
          target.focus({ preventScroll: true });
        }
        return;
      }
      event.preventDefault();
      target.focus({ preventScroll: true });
      suppressButtonClick(button);
      activateButton(button);
      startButtonRepeat(button);
      target.focus({ preventScroll: true });
    };
    const release = (event) => {
      if (
        event.type === "pointerup" &&
        event.pointerType === "touch"
      ) {
        return;
      }
      clearPressedButton();
    };
    const handleAccessoryClick = (event) => {
      const button = event.target.closest("button");
      if (!button || !bar.contains(button)) {
        return;
      }
      const idle = bar.classList.contains("mj-mode-idle");
      if (
        idle &&
        !button.classList.contains("prompt-cancel")
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (button === suppressedButton) {
        clearTimeout(suppressClickTimer);
        suppressedButton = null;
      } else {
        activateButton(button);
      }
      if (!idle) {
        target.focus({ preventScroll: true });
      }
    };
    const touchOptions = { passive: false };
    bar.addEventListener("touchstart", press, touchOptions);
    bar.addEventListener("pointerdown", press);
    bar.addEventListener("touchend", release, touchOptions);
    bar.addEventListener("touchcancel", release, touchOptions);
    bar.addEventListener("pointerup", release);
    bar.addEventListener("pointercancel", release);
    bar.addEventListener("pointerleave", release);
    bar.addEventListener("click", handleAccessoryClick, true);

    return () => {
      bar.removeEventListener("touchstart", press, touchOptions);
      bar.removeEventListener("pointerdown", press);
      bar.removeEventListener("touchend", release, touchOptions);
      bar.removeEventListener("touchcancel", release, touchOptions);
      bar.removeEventListener("pointerup", release);
      bar.removeEventListener("pointercancel", release);
      bar.removeEventListener("pointerleave", release);
      bar.removeEventListener(
        "click",
        handleAccessoryClick,
        true
      );
      clearPressedButton();
      clearTimeout(suppressClickTimer);
      stopButtonRepeat();
    };
  });
  const mountViewportShell = $c((shell) => {
    let frame = 0;
    let timers = [];
    let lastKeyboardActive = null;
    const viewportBaselines = {};
    const mobileInputQuery = window.matchMedia(
      "(hover: none), (pointer: coarse)"
    );
    const position = () => {
      frame = 0;
      const viewport = window.visualViewport;
      const width =
        viewport && Number.isFinite(viewport.width)
          ? viewport.width
          : window.innerWidth;
      const height =
        viewport && Number.isFinite(viewport.height)
          ? viewport.height
          : window.innerHeight;

      document.documentElement.style.setProperty(
        "--mj-visual-viewport-height",
        `${Math.max(0, height)}px`
      );
      shell.style.position = "absolute";
      shell.style.top = "0px";
      shell.style.right = "auto";
      shell.style.bottom = "auto";
      shell.style.left = "0px";
      shell.style.width = `${Math.max(0, width)}px`;
      shell.style.height = `${Math.max(0, height)}px`;

      const orientation =
        window.screen?.orientation?.type?.startsWith("landscape") ||
        (
          !window.screen?.orientation?.type &&
          window.screen?.width > window.screen?.height
        )
          ? "landscape"
          : "portrait";
      const baseline = Math.max(
        viewportBaselines[orientation] || 0,
        height
      );
      viewportBaselines[orientation] = baseline;
      const virtualKeyboardHeight =
        navigator.virtualKeyboard?.boundingRect?.height || 0;
      const keyboardInset = Math.max(
        virtualKeyboardHeight,
        baseline - height
      );
      const keyboardThreshold = Math.max(80, baseline * 0.12);
      const keyboardActive =
        (
          mobileInputQuery.matches ||
          navigator.maxTouchPoints > 0
        ) &&
        keyboardInset >= keyboardThreshold;
      if (keyboardActive !== lastKeyboardActive) {
        lastKeyboardActive = keyboardActive;
        $s(reportKeyboardActive)(keyboardActive);
      }
    };
    const schedule = () => {
      if (!frame) {
        frame = requestAnimationFrame(position);
      }
    };
    const settle = () => {
      schedule();
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers = [50, 150, 300, 500].map((delay) =>
        setTimeout(schedule, delay)
      );
    };

    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    navigator.virtualKeyboard?.addEventListener?.(
      "geometrychange",
      schedule
    );
    window.addEventListener("orientationchange", settle);
    window.addEventListener("pageshow", settle);
    document.addEventListener("focusin", settle);
    document.addEventListener("focusout", settle);
    settle();

    return () => {
      window.visualViewport?.removeEventListener(
        "resize",
        schedule
      );
      window.visualViewport?.removeEventListener(
        "scroll",
        schedule
      );
      window.removeEventListener("resize", schedule);
      navigator.virtualKeyboard?.removeEventListener?.(
        "geometrychange",
        schedule
      );
      window.removeEventListener("orientationchange", settle);
      window.removeEventListener("pageshow", settle);
      document.removeEventListener("focusin", settle);
      document.removeEventListener("focusout", settle);
      if (frame) {
        cancelAnimationFrame(frame);
      }
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers = [];
      document.documentElement.style.removeProperty(
        "--mj-visual-viewport-height"
      );
    };
  });
  const handlePaste = $c((event) => {
    const text = event.clipboardData?.getData("text/plain");
    if (text) {
      event.preventDefault();
      event.currentTarget.value = "";
      $s(handlePasteInput)(text);
    }
  });
  const mountTerminalInput = $c((terminal) => {
    const pointForClient = (clientX, clientY) => {
      const rect = terminal.getBoundingClientRect();
      const columns = Number(terminal.dataset.columns);
      const rows = Number(terminal.dataset.rows);
      if (
        !Number.isFinite(columns) ||
        !Number.isFinite(rows) ||
        columns <= 0 ||
        rows <= 0 ||
        rect.width <= 0 ||
        rect.height <= 0
      ) {
        return null;
      }
      return {
        column: Math.min(
          columns - 1,
          Math.max(
            0,
            Math.floor(
              ((clientX - rect.left) * columns) / rect.width
            )
          )
        ),
        row: Math.min(
          rows - 1,
          Math.max(
            0,
            Math.floor(
              ((clientY - rect.top) * rows) / rect.height
            )
          )
        ),
      };
    };

    const dispatchWheel = (
      horizontal,
      steps,
      clientX,
      clientY,
      modifiers
    ) => {
      if (!steps) {
        return;
      }
      const point = pointForClient(clientX, clientY);
      if (!point) {
        return;
      }
      const buttonCode = horizontal
        ? steps < 0 ? 66 : 67
        : steps < 0 ? 64 : 65;
      $s(sendWheelInput)(
        buttonCode,
        point.column,
        point.row,
        modifiers,
        Math.min(Math.abs(steps), 8)
      );
    };

    const wheelFrame = {
      id: 0,
      horizontal: false,
      delta: 0,
      clientX: 0,
      clientY: 0,
      modifiers: 0,
    };
    const wheel = (event) => {
      const horizontal =
        Math.abs(event.deltaX) > Math.abs(event.deltaY);
      const delta = horizontal ? event.deltaX : event.deltaY;
      if (!delta) {
        return;
      }
      event.preventDefault();

      const terminalRect = terminal.getBoundingClientRect();
      const pixelDelta =
        event.deltaMode === 0
          ? delta
          : event.deltaMode === 1
            ? delta * 16
            : delta * (
                horizontal
                  ? terminalRect.width
                  : terminalRect.height
              );
      const modifiers =
        (event.shiftKey ? 4 : 0) +
        (event.altKey ? 8 : 0) +
        (event.ctrlKey ? 16 : 0);
      if (
        wheelFrame.horizontal !== horizontal ||
        (
          wheelFrame.delta !== 0 &&
          Math.sign(wheelFrame.delta) !== Math.sign(pixelDelta)
        )
      ) {
        wheelFrame.delta = 0;
      }
      wheelFrame.horizontal = horizontal;
      wheelFrame.delta += pixelDelta;
      wheelFrame.clientX = event.clientX;
      wheelFrame.clientY = event.clientY;
      wheelFrame.modifiers = modifiers;
      if (wheelFrame.id) {
        return;
      }
      wheelFrame.id = requestAnimationFrame(() => {
        wheelFrame.id = 0;
        const total = wheelFrame.delta;
        wheelFrame.delta = 0;
        if (!total) {
          return;
        }
        const magnitude = Math.min(
          8,
          Math.max(1, Math.round(Math.abs(total) / 24))
        );
        dispatchWheel(
          wheelFrame.horizontal,
          Math.sign(total) * magnitude,
          wheelFrame.clientX,
          wheelFrame.clientY,
          wheelFrame.modifiers
        );
      });
    };

    let gesture = null;
    let mouseCapture = null;
    const pointerDown = (event) => {
      if (event.pointerType === "mouse") {
        const point = pointForClient(
          event.clientX,
          event.clientY
        );
        if (!point || event.button < 0 || event.button > 2) {
          return;
        }
        event.preventDefault();
        const modifiers =
          (event.shiftKey ? 4 : 0) +
          (event.altKey ? 8 : 0) +
          (event.ctrlKey ? 16 : 0);
        mouseCapture = {
          id: event.pointerId,
          button: event.button,
          modifiers,
          column: point.column,
          row: point.row,
        };
        terminal.setPointerCapture?.(event.pointerId);
        $s(sendPointerInput)(
          "press",
          event.button,
          point.column,
          point.row,
          modifiers
        );
        return;
      }
      if (event.pointerType !== "touch") {
        return;
      }
      gesture = {
        id: event.pointerId,
        lastY: event.clientY,
        accumulatedY: 0,
      };
      terminal.setPointerCapture?.(event.pointerId);
    };
    const pointerMove = (event) => {
      if (
        mouseCapture &&
        event.pointerId === mouseCapture.id
      ) {
        event.preventDefault();
        const point = pointForClient(
          event.clientX,
          event.clientY
        );
        if (
          !point ||
          (
            point.column === mouseCapture.column &&
            point.row === mouseCapture.row
          )
        ) {
          return;
        }
        mouseCapture.column = point.column;
        mouseCapture.row = point.row;
        $s(sendPointerInput)(
          "move",
          mouseCapture.button,
          point.column,
          point.row,
          mouseCapture.modifiers
        );
        return;
      }
      if (!gesture || event.pointerId !== gesture.id) {
        return;
      }
      event.preventDefault();
      const movement = event.clientY - gesture.lastY;
      gesture.lastY = event.clientY;
      if (
        gesture.accumulatedY !== 0 &&
        movement !== 0 &&
        Math.sign(gesture.accumulatedY) !== Math.sign(movement)
      ) {
        gesture.accumulatedY = 0;
      }
      gesture.accumulatedY += movement;

      const rows = Number(terminal.dataset.rows);
      const rowHeight =
        terminal.getBoundingClientRect().height / rows;
      if (!Number.isFinite(rowHeight) || rowHeight <= 0) {
        return;
      }
      const steps = Math.trunc(
        gesture.accumulatedY / rowHeight
      );
      if (steps === 0) {
        return;
      }
      gesture.accumulatedY -= steps * rowHeight;

      // A downward finger drag moves terminal content downward,
      // which is the same terminal action as wheel-up.
      dispatchWheel(
        false,
        -steps,
        event.clientX,
        event.clientY,
        0
      );
    };
    const pointerEnd = (event) => {
      if (
        mouseCapture &&
        event.pointerId === mouseCapture.id
      ) {
        event.preventDefault();
        const point =
          pointForClient(event.clientX, event.clientY) ??
          {
            column: mouseCapture.column,
            row: mouseCapture.row,
          };
        $s(sendPointerInput)(
          "release",
          mouseCapture.button,
          point.column,
          point.row,
          mouseCapture.modifiers
        );
        if (terminal.hasPointerCapture?.(event.pointerId)) {
          terminal.releasePointerCapture(event.pointerId);
        }
        mouseCapture = null;
        return;
      }
      if (!gesture || event.pointerId !== gesture.id) {
        return;
      }
      if (terminal.hasPointerCapture?.(event.pointerId)) {
        terminal.releasePointerCapture(event.pointerId);
      }
      gesture = null;
    };

    terminal.addEventListener("wheel", wheel, { passive: false });
    terminal.addEventListener("pointerdown", pointerDown);
    terminal.addEventListener("pointermove", pointerMove, {
      passive: false,
    });
    terminal.addEventListener("pointerup", pointerEnd);
    terminal.addEventListener("pointercancel", pointerEnd);

    return () => {
      terminal.removeEventListener("wheel", wheel);
      terminal.removeEventListener("pointerdown", pointerDown);
      terminal.removeEventListener("pointermove", pointerMove);
      terminal.removeEventListener("pointerup", pointerEnd);
      terminal.removeEventListener("pointercancel", pointerEnd);
      if (wheelFrame.id) {
        cancelAnimationFrame(wheelFrame.id);
      }
    };
  });
  const paneView = paneCollection.map((pane) =>
    <PaneView readRecord={pane} />
  );
  const borderView = borderCollection.map((border) =>
    <PaneBorderCell readRecord={border} />
  );
  const windowView = windowCollection.map((window) =>
    <WindowTab
      readWindow={window}
      selectWindow={selectWindow}
    />
  );
  const applyStatusWindows = (windows, forceReplace = false) => {
    const identitiesMatch =
      !forceReplace &&
      windows.length === windowRecords.length &&
      windows.every(
        (window, index) =>
          window.windowId === windowRecords[index].windowId
      );
    if (identitiesMatch) {
      for (let index = 0; index < windows.length; index += 1) {
        windowCollection.set(index, windows[index]);
      }
      windowRecords = windows.slice();
      return;
    }

    const nextRecords = windows.slice();
    windowCollection.splice(
      0,
      windowRecords.length,
      ...nextRecords
    );
    windowRecords = nextRecords;
  };
  const applyLayout = (layout) => {
    const placements = layout?.panes ?? [];
    const identitiesMatch =
      placements.length === paneRecords.length &&
      placements.every(
        (placement, index) =>
          placement.slot === paneRecords[index].slot
      );
    if (identitiesMatch) {
      for (let index = 0; index < placements.length; index += 1) {
        const nextRecord = createPaneRecord(
          model,
          placements[index],
          layout.focusedPaneId
        );
        paneCollection.set(index, nextRecord);
        paneRecords[index] = nextRecord;
      }
    } else {
      const nextRecords = placements.map(
        (placement) =>
          createPaneRecord(
            model,
            placement,
            layout?.focusedPaneId
          )
      );
      paneCollection.splice(
        0,
        paneRecords.length,
        ...nextRecords
      );
      paneRecords = nextRecords;
    }

    const nextBorders = paneBorderRecords(layout);
    const borderIdentitiesMatch =
      nextBorders.length === borderRecords.length &&
      nextBorders.every(
        (border, index) =>
          border.column === borderRecords[index].column &&
          border.row === borderRecords[index].row &&
          border.glyph === borderRecords[index].glyph
      );
    if (borderIdentitiesMatch) {
      for (let index = 0; index < nextBorders.length; index += 1) {
        if (
          nextBorders[index].focused !==
          borderRecords[index].focused
        ) {
          borderCollection.set(index, nextBorders[index]);
        }
      }
    } else {
      borderCollection.splice(
        0,
        borderRecords.length,
        ...nextBorders
      );
    }
    borderRecords = nextBorders;
  };

  const unsubscribe = model.subscribe((event) => {
    if (event.clipboardText !== null) {
      writeClipboard(event.clipboardText);
    }
    if (event.meta.error) {
      setError(event.meta.error);
    }
    if (event.meta.cols > 0 && event.meta.cols !== terminalColumns()) {
      setTerminalColumns(event.meta.cols);
    }
    if (event.meta.rows > 0 && event.meta.rows !== terminalRows()) {
      setTerminalRows(event.meta.rows);
    }
    if (
      event.meta.status.revision > clientStatus().revision
    ) {
      const sessionChanged =
        clientStatus().sessionId !== 0 &&
        event.meta.status.sessionId !== clientStatus().sessionId;
      setClientStatus(event.meta.status);
      applyStatusWindows(
        event.meta.status.windows,
        sessionChanged
      );
    }
    if (
      event.meta.promptDraftRevision !== promptDraftRevision
    ) {
      promptDraftRevision = event.meta.promptDraftRevision;
      setPromptDraft(event.meta.promptDraft);
    }
    if (event.layoutChanged) {
      applyLayout(event.meta.layout);
    }
  });
  onDispose(() => {
    unsubscribe();
  });

  const windowTabs = <div class="window-tabs" role="tablist" style={{ position: "absolute", inset: 0, alignItems: "stretch", width: "100%", height: "100%", minWidth: 0, overflow: "hidden", color: "#9aa5b5", background: "#171b22", fontSize: "12px", lineHeight: "calc(var(--mj-attach-bar-height) - 1px)", whiteSpace: "nowrap" }}>
        <div style={{ flex: "0 0 auto", padding: "0 7px", color: "#687386", borderRight: "1px solid #343b46" }}>
          {clientStatus().sessionName ||
            (
              clientStatus().sessionId > 0
                ? `#${clientStatus().sessionId}`
                : model.sessionName
            )}
        </div>
        {windowView}
        <button
          type="button"
          aria-label="Create window"
          title="Create window"
          value="window:create"
          onClick={createWindow}
          style={{ appearance: "none", flex: "0 0 28px", width: "28px", padding: 0, border: 0, borderRight: "1px solid #343b46", borderRadius: 0, color: "#9aa5b5", background: "#171b22", font: "inherit", fontSize: "16px", cursor: "pointer" }}
        >
          +
        </button>
        <button
          type="button"
          class="window-tabs-keys"
          value="view:keys"
          aria-label="Show terminal keys"
          onClick={onShowKeys}
          style={{ appearance: "none", flex: "0 0 auto", alignItems: "center", minWidth: 0, overflow: "hidden", padding: "0 8px", border: 0, borderRight: "1px solid #252b34", borderRadius: 0, color: "inherit", background: "transparent", font: "inherit", lineHeight: "inherit", whiteSpace: "nowrap", cursor: "pointer" }}
        >
          Keys
        </button>
        <div class="window-tabs-location" onMount={mountStatusLocation} style={{ flex: "0 0 25%", marginLeft: "auto", width: "25%", maxWidth: "25%", minWidth: 0, overflow: "hidden", padding: "0 7px", color: "#9aa5b5", background: "#171b22", fontSize: "12px", whiteSpace: "nowrap" }}>
          {fitStatusLocation(
            statusLocationParts(),
            statusLocationColumns()
          )}
        </div>
      </div>;

  const keyHelper = <nav
        class="key-helper"
        aria-label="Terminal helper keys"
        style={{ position: "absolute", inset: 0, height: "100%", overflow: "hidden", background: "#171b22", userSelect: "none" }}
      >
        <div
          class="key-helper-group"
          hidden={attachMode() !== "keys"}
        >
          {KEY_HELPERS.map(([action, label]) =>
            <button
              type="button"
              value={`helper:${action}`}
              data-repeatable={REPEATABLE_KEY_HELPERS.has(action)}
            >
              <KeyHelperLabel action={action} label={label} />
            </button>
          )}
        </div>
        <div
          class="key-helper-group"
          hidden={attachMode() !== "prefix"}
        >
          {PREFIX_HELPERS.map(([input, label]) =>
            <button
              type="button"
              value={`prefix:${input}`}
            >
              {label}
            </button>
          )}
        </div>
        <div
          class="key-helper-group"
          hidden={attachMode() !== "full"}
        >
          {FULL_KEY_HELPERS.map(([action, label]) =>
            <button
              type="button"
              value={`helper:${action}`}
              data-repeatable={REPEATABLE_KEY_HELPERS.has(action)}
              class={
                (
                  action === "ctrl" && helperCtrl()
                ) ||
                (
                  action === "alt" && helperAlt()
                )
                  ? "is-active"
                  : ""
              }
            >
              <KeyHelperLabel action={action} label={label} />
            </button>
          )}
        </div>
        <button
          type="button"
          class="key-helper-tabs"
          value="view:tabs"
          aria-label="Show window tabs"
          onClick={onShowTabs}
        >
          Tabs
        </button>
        <button
          type="button"
          class="key-helper-swap"
          value="view:swap"
          aria-label="Swap helper keys"
          onClick={onSwapHelpers}
        >
          ⇄
        </button>
      </nav>;

  const promptStatus = <PromptStatus
    readStatus={clientStatus}
    readDraft={promptDraft}
  />;

  const attachBar = <footer
      class={`attach-bar mj-mode-${attachMode()}`}
      onMount={mountAttachBar}
      style={{ position: "absolute", zIndex: 2147483647, right: 0, bottom: 0, left: 0, width: "100%", height: "var(--mj-attach-bar-height)", overflow: "hidden", borderTop: "1px solid #343b46", background: "#171b22", userSelect: "none" }}
    >
      {windowTabs}
      {keyHelper}
      {promptStatus}
    </footer>;

  return <main onMount={mountViewportShell} style={{ position: "absolute", inset: 0, margin: 0, padding: "0 0 var(--mj-attach-bar-height)", width: "100%", height: "var(--mj-visual-viewport-height)", overflow: "hidden", outline: "none" }}>
    <textarea
      ref={keyboardRef}
      aria-label="Terminal keyboard input"
      autocapitalize="off"
      autocomplete="off"
      autocorrect="off"
      inputmode="text"
      spellcheck="false"
      onMount={mountTextInput}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      style={{ position: "absolute", top: 0, left: 0, width: "1px", height: "1px", margin: 0, padding: 0, border: 0, fontSize: "16px", opacity: 0, pointerEvents: "none" }}
    />
    <section
      data-columns={terminalColumns()}
      data-rows={terminalRows()}
      onClick={focusKeyboard}
      onMount={mountTerminalInput}
      style={{ position: "relative", display: "block", contain: "layout paint", margin: 0, padding: 0, overflow: "hidden", border: 0, outline: 0, background: "#101318", fontSize: "12px", touchAction: "none", userSelect: "none", width: `${terminalColumns()}ch`, maxWidth: "100%", height: `${terminalRows() * TERMINAL_LINE_HEIGHT}em`, maxHeight: "calc(var(--mj-visual-viewport-height) - var(--mj-attach-bar-height))" }}
    >
      <span
        aria-hidden="true"
        onMount={mountTerminalMetrics}
        style={{ position: "absolute", display: "block", visibility: "hidden", width: "1ch", height: `${TERMINAL_LINE_HEIGHT}em`, pointerEvents: "none", whiteSpace: "pre", font: "inherit", lineHeight: TERMINAL_LINE_HEIGHT }}
      >
        0
      </span>
      {error() ? <div style={{ maxWidth: "70ch", color: "#ff9b9b", whiteSpace: "pre-wrap" }}>{error()}</div> : null}
      {paneCollection.size() === 0
        ? <div style={{ color: "#687386", fontSize: "12px" }}>Waiting for the first Meja frame…</div>
        : null}
      {paneView}
      <div
        aria-hidden="true"
        style={{ position: "absolute", zIndex: 2, inset: 0, overflow: "hidden", pointerEvents: "none" }}
      >
        {borderView}
      </div>
    </section>
    {attachBar}
  </main>;
}

function PaneView({ readRecord }) {
  const record = untrack(readRecord);
  const initial = record.model.paneSnapshot(record.slot);
  let styleRecords = initial.styles;
  const styleCollection = createCollection(styleRecords);
  let rowRecords = initial.rows.map(createRowRecord);
  const rowCollection = createCollection(rowRecords);
  const styleView = styleCollection.view((style) =>
    <Style text={style.text} />
  );
  const rowView = rowCollection.view((row) =>
    <TerminalRow record={row} />
  );
  const applyRowScrollRegions = (scrollRegions, rows) => {
    const snapshots = new Map(
      rows.map((entry) => [entry.index, entry.row])
    );

    for (const { top, bottom, delta } of scrollRegions) {
      const height = bottom - top;
      const count = Math.abs(delta);
      const exposedStart = delta < 0 ? bottom - count : top;
      const exposedEnd = delta < 0 ? bottom : top + count;
      const added = [];
      for (let index = exposedStart; index < exposedEnd; index += 1) {
        const snapshot = snapshots.get(index);
        if (!snapshot) {
          throw new Error(
            `scroll region omitted exposed row ${index}`
          );
        }
        added.push(createRowRecord(snapshot));
      }
      if (delta < 0) {
        rowCollection.splice(bottom, 0, ...added);
        rowCollection.splice(top, count);
        rowRecords.splice(bottom, 0, ...added);
        rowRecords.splice(top, count);
      } else {
        rowCollection.splice(top, 0, ...added);
        rowCollection.splice(bottom, count);
        rowRecords.splice(top, 0, ...added);
        rowRecords.splice(bottom, count);
      }
      if (
        rowRecords.length !== rowCollection.length ||
        height < count
      ) {
        throw new Error("scroll region changed terminal row count");
      }
    }
  };

  const unsubscribe = record.model.subscribe((event) => {
    if (event.slot !== record.slot) {
      return;
    }
    if (event.styleReset) {
      styleRecords = event.styles;
      styleCollection.splice(
        0,
        styleCollection.length,
        ...styleRecords
      );
    } else if (event.styles.length > 0) {
      styleRecords.push(...event.styles);
      styleCollection.push(...event.styles);
    }
    if (!event.reset && event.scrollRegions.length > 0) {
      applyRowScrollRegions(event.scrollRegions, event.rows);
    }
    if (event.reset) {
      if (event.rows.length !== rowRecords.length) {
        const sharedRows = Math.min(
          event.rows.length,
          rowRecords.length
        );
        for (let index = 0; index < sharedRows; index += 1) {
          updateRowRecord(
            rowRecords[index],
            event.rows[index].row
          );
        }
        if (event.rows.length < rowRecords.length) {
          const nextLength = event.rows.length;
          rowCollection.splice(
            nextLength,
            rowCollection.length - nextLength
          );
          rowRecords.splice(nextLength);
        } else {
          const addedRows = [];
          for (
            let index = rowRecords.length;
            index < event.rows.length;
            index += 1
          ) {
            addedRows.push(
              createRowRecord(event.rows[index].row)
            );
          }
          rowRecords.push(...addedRows);
          rowCollection.push(...addedRows);
        }
      } else {
        for (const entry of event.rows) {
          updateRowRecord(rowRecords[entry.index], entry.row);
        }
      }
      return;
    }
    for (const entry of event.rows) {
      if (entry.index < rowRecords.length) {
        updateRowRecord(rowRecords[entry.index], entry.row);
      }
    }
  });

  onDispose(() => {
    unsubscribe();
  });

  return <section
    class={readRecord().focused ? "mjp mjp-focused" : "mjp"}
    style={{ position: "absolute", zIndex: 1, overflow: "hidden", left: `${readRecord().placement.rect.x}ch`, top: `${readRecord().placement.rect.y * TERMINAL_LINE_HEIGHT}em`, width: `${readRecord().placement.rect.width}ch`, height: `${readRecord().placement.rect.height * TERMINAL_LINE_HEIGHT}em` }}
  >
    {styleView}
    {rowView}
  </section>;
}

function PaneBorderCell({ readRecord }) {
  return <span
    aria-hidden="true"
    style={{ position: "absolute", display: "block", width: "1ch", height: `${TERMINAL_LINE_HEIGHT}em`, color: readRecord().focused ? "#2a58aa" : "#687386", font: "inherit", lineHeight: TERMINAL_LINE_HEIGHT, textAlign: "left", whiteSpace: "pre", left: `${readRecord().column}ch`, top: `${readRecord().row * TERMINAL_LINE_HEIGHT}em` }}
  >
    {readRecord().glyph}
  </span>;
}

function WindowTab({ readWindow, selectWindow }) {
  const windowId = untrack(() => readWindow().windowId);
  const [titleColumns, mountTitle] = useTextColumns();

  return <button
    type="button"
    role="tab"
    aria-selected={readWindow().active ? "true" : "false"}
    value={`window:${windowId}`}
    onClick={() => selectWindow(windowId)}
    style={{ appearance: "none", display: "flex", flex: "0 1 24ch", maxWidth: "24ch", alignItems: "center", minWidth: 0, overflow: "hidden", padding: "0 8px", border: 0, borderRight: "1px solid #252b34", borderRadius: 0, color: readWindow().active ? "#ffffff" : "inherit", background: readWindow().active ? "#2a58aa" : "transparent", font: "inherit", lineHeight: "inherit", whiteSpace: "nowrap", cursor: "pointer" }}
  >
    <span style={{ flex: "0 0 auto" }}>{readWindow().index}:</span>
    <span onMount={mountTitle} style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
      {fitWindowTitle(readWindow().title, titleColumns())}
    </span>
    {readWindow().zoomed
      ? <span style={{ flex: "0 0 auto" }}> Z</span>
      : null}
  </button>;
}

function KeyHelperLabel({ action, label }) {
  const path =
    action === "arrow-left"
      ? "M15 4 7 12l8 8"
      : action === "arrow-down"
        ? "M4 9l8 8 8-8"
        : action === "arrow-up"
          ? "M4 15l8-8 8 8"
          : action === "arrow-right"
            ? "M9 4l8 8-8 8"
            : "";
  return path
    ? <svg
        aria-hidden="true"
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        style={{ transform: "translateY(1px)" }}
      >
        <path d={path} />
      </svg>
    : label;
}

function TerminalRow({ record }) {
  let spanRecords = spanRuns(record.snapshot);
  const spans = createCollection(spanRecords);
  const spanView = spans.map((span) => {
    const inlineWidth = untrack(
      () => span().end - span().start > SPAN_WIDTH_CLASS_MAX
    );
    return inlineWidth
      ? <span
          class={span().className}
          style={{ width: `${span().end - span().start}ch` }}
        >
          {span().text}
        </span>
      : <span class={spanClassName(span())}>
          {span().text}
        </span>;
  });

  record.applySnapshot = (snapshot) => {
    record.snapshot = snapshot;
    const nextRecords = spanRuns(snapshot);
    if (spanPartitionMatches(spanRecords, nextRecords)) {
      for (let index = 0; index < nextRecords.length; index += 1) {
        if (!spanMatches(spanRecords[index], nextRecords[index])) {
          spans.set(index, nextRecords[index]);
        }
      }
      spanRecords = nextRecords;
      return;
    }

    spanRecords = nextRecords;
    spans.splice(
      0,
      spans.length,
      ...nextRecords
    );
  };

  onDispose(() => {
    record.applySnapshot = null;
  });

  return <div class="mjr">{spanView}</div>;
}

async function listenOnHosts(
  root,
  port,
  hosts,
  allowedOrigins,
  passwordGate
) {
  const servers = [];
  try {
    for (const host of hosts) {
      const server = createSenimanServer(root, {
        allowedOrigins,
      });
      passwordGate?.protectServer(server);
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
      servers.push(server);
    }
    return servers;
  } catch (error) {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise((resolve) => server.close(resolve))
      )
    );
    throw error;
  }
}

const options = parseArgs(process.argv.slice(2));
const activeAttachments = new Set();
let webServers = [];
let passwordGate = null;

function connectionCloseState(error) {
  const close = error?.data;
  if (
    close?.isApp === true &&
    close?.errorCode === SESSION_REPLACED_ERROR_CODE
  ) {
    return {
      phase: "replaced",
      message:
        "This session was opened in another Meja client. " +
        "Terminal input and rendering have stopped here.",
    };
  }
  return {
    phase: "connection-error",
    message:
      error instanceof Error
        ? error.message
        : "The connection to Meja closed.",
  };
}

function sessionTargetFromPath(pathname) {
  const match = /^\/session\/([^/]+)\/?$/.exec(pathname);
  if (!match) {
    return null;
  }
  try {
    const target = decodeURIComponent(match[1]);
    return target.length > 0 ? target : null;
  } catch {
    return null;
  }
}

function sessionPath(target) {
  return `/session/${encodeURIComponent(target)}`;
}

function parseSessionList(output) {
  return output
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id, name, created] = line.split("\t");
      if (!/^[1-9]\d*$/.test(id ?? "")) {
        throw new Error("Meja returned an invalid session list");
      }
      return {
        id,
        name: name || "<unnamed>",
        created: Number(created) || 0,
      };
    });
}

function SessionChoice({ session, selectSession }) {
  return <button
    type="button"
    onClick={() => selectSession(session.id)}
    style={{ appearance: "none", display: "flex", width: "100%", alignItems: "center", justifyContent: "space-between", gap: "16px", padding: "8px 10px", border: "1px solid #303846", borderRadius: 0, color: "#d8dee9", background: "#171c24", font: "inherit", textAlign: "left", cursor: "pointer" }}
  >
    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
      {session.name}
    </span>
    <span style={{ flex: "0 0 auto", color: "#687386" }}>
      {session.id}
    </span>
  </button>;
}

function DetachedPage({ message, createSession, selectSession }) {
  const [listState, setListState] = useState("loading");
  const [listError, setListError] = useState("");
  const sessions = createCollection();
  let generation = 0;
  let disposed = false;

  const loadSessions = async () => {
    const currentGeneration = ++generation;
    setListState("loading");
    setListError("");
    try {
      const result = await runMejaCommand(options, [
        "list-sessions",
        "-F",
        "#{session_id}\t#{session_name}\t#{session_created}",
      ]);
      if (result.exitCode !== 0) {
        throw new Error(
          result.stderr.trim() ||
          `Meja command exited with ${result.exitCode}`
        );
      }
      if (disposed || currentGeneration !== generation) {
        return;
      }
      const nextRecords = parseSessionList(result.stdout);
      sessions.splice(0, sessions.length, ...nextRecords);
      setListState("loaded");
    } catch (error) {
      if (disposed || currentGeneration !== generation) {
        return;
      }
      setListError(
        error instanceof Error ? error.message : String(error)
      );
      setListState("error");
    }
  };

  const sessionView = sessions.view((session) =>
    <SessionChoice
      session={session}
      selectSession={selectSession}
    />
  );

  useEffect(() => {
    void loadSessions();
  });
  onDispose(() => {
    disposed = true;
    generation += 1;
  });

  return <main style={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", padding: "24px" }}>
    <section style={{ width: "min(100%, 58ch)", color: "#9aa5b5", lineHeight: 1.5 }}>
      <h1 style={{ margin: "0 0 8px", color: "#d8dee9", fontSize: "16px" }}>
        No session attached
      </h1>
      <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{message}</p>
      <div style={{ marginTop: "18px" }}>
        <div style={{ display: "flex", gap: "8px" }}>
          <button
            type="button"
            onClick={createSession}
            style={{ appearance: "none", padding: "7px 10px", border: "1px solid #4b5565", borderRadius: 0, color: "#d8dee9", background: "#202630", font: "inherit", cursor: "pointer" }}
          >
            Create
          </button>
          <button
            type="button"
            onClick={loadSessions}
            disabled={listState() === "loading"}
            style={{ appearance: "none", padding: "7px 10px", border: "1px solid #303846", borderRadius: 0, color: "#9aa5b5", background: "transparent", font: "inherit", cursor: "pointer" }}
          >
            Refresh
          </button>
        </div>
        <div style={{ marginTop: "20px" }}>
          <div style={{ marginBottom: "7px", color: "#687386", fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            Active sessions
          </div>
          {listState() === "loading" && sessions.size() === 0
            ? <div>Loading…</div>
            : listState() === "error"
              ? <div style={{ color: "#d06c75" }}>{listError()}</div>
              : listState() === "loaded" && sessions.size() === 0
                ? <div>No active sessions.</div>
                : <div style={{ display: "grid", gap: "6px" }}>{sessionView}</div>}
        </div>
      </div>
    </section>
  </main>;
}

function ConnectionPage({ phase, message, retryConnection }) {
  return <main style={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", padding: "24px" }}>
    <section style={{ width: "min(100%, 58ch)", color: "#9aa5b5", lineHeight: 1.5 }}>
      <h1 style={{ margin: "0 0 8px", color: "#d8dee9", fontSize: "16px" }}>
        {phase === "connecting"
          ? "Connecting to Meja"
          : phase === "replaced"
            ? "Session moved to another client"
            : "Meja connection closed"}
      </h1>
      <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{message}</p>
      {phase !== "connecting"
        ? <div style={{ display: "flex", gap: "12px", alignItems: "center", marginTop: "18px" }}>
            <button
              type="button"
              onClick={retryConnection}
              style={{ appearance: "none", padding: "7px 10px", border: "1px solid #4b5565", borderRadius: 0, color: "#d8dee9", background: "#202630", font: "inherit", cursor: "pointer" }}
            >
              {phase === "replaced" ? "Take over session" : "Reconnect"}
            </button>
            <a href="/" style={{ color: "#9fb9ea", textDecoration: "underline" }}>
              Home
            </a>
          </div>
        : null}
    </section>
  </main>;
}

function BrowserRoot() {
  const client = useClient();
  const initialSessionTarget = sessionTargetFromPath(
    untrack(() => client.location.pathname())
  );
  const [phase, setPhase] = useState(
    initialSessionTarget ? "connecting" : "detached"
  );
  const [message, setMessage] = useState(
    initialSessionTarget
      ? `Connecting to ${initialSessionTarget}…`
      : "No session attached to this browser window yet."
  );
  const [model, setModel] = useState(null);
  let attachment = null;
  let currentSessionTarget = initialSessionTarget;
  let generation = 0;
  let disposed = false;

  const connect = async (mode = "attach") => {
    if (mode === "attach" && !currentSessionTarget) {
      setModel(null);
      setPhase("detached");
      setMessage("No session attached to this browser window yet.");
      return;
    }

    const currentGeneration = ++generation;
    const previousAttachment = attachment;
    attachment = null;
    if (previousAttachment) {
      activeAttachments.delete(previousAttachment);
      await previousAttachment.destroy();
    }
    if (disposed || currentGeneration !== generation) {
      return;
    }

    const targetAtStart = currentSessionTarget;
    const commandArgs = mode === "create"
      ? ["new"]
      : ["attach-session", "-t", targetAtStart];
    const nextModel = new TerminalModel(
      targetAtStart ?? "",
      options.cols,
      options.rows,
      (target) => {
        if (
          !disposed &&
          currentGeneration === generation
        ) {
          currentSessionTarget = target;
          const nextPath = sessionPath(target);
          if (
            untrack(() => client.location.pathname()) !== nextPath
          ) {
            client.history.replaceState(nextPath);
          }
        }
      }
    );
    let closeState = null;
    let nextAttachment = null;
    setModel(null);
    setPhase("connecting");
    setMessage(
      mode === "create"
        ? "Creating a new Meja session…"
        : `Connecting to ${targetAtStart}…`
    );

    try {
      const grant = await requestAttachmentGrant(
        options,
        commandArgs
      );
      if (disposed || currentGeneration !== generation) {
        return;
      }
      nextAttachment = await attachMeja(
        grant.bootstrap,
        grant.connectionHost,
        options,
        nextModel,
        (error) => {
          closeState = connectionCloseState(error);
          if (
            disposed ||
            currentGeneration !== generation
          ) {
            return;
          }
          if (nextAttachment) {
            activeAttachments.delete(nextAttachment);
          }
          attachment = null;
          setModel(null);
          setMessage(closeState.message);
          setPhase(closeState.phase);
        },
        (terminalExitMessage) => {
          closeState = {
            phase: "detached",
            message: "No session attached to this browser window yet.",
          };
          if (
            disposed ||
            currentGeneration !== generation
          ) {
            return;
          }
          console.log(
            `seniman-meja: ${terminalExitMessage || "detached"}`
          );
          currentSessionTarget = null;
          if (untrack(() => client.location.pathname()) !== "/") {
            client.history.replaceState("/");
          }
          if (nextAttachment) {
            activeAttachments.delete(nextAttachment);
          }
          attachment = null;
          setModel(null);
          setMessage(closeState.message);
          setPhase(closeState.phase);
        }
      );
      if (disposed || currentGeneration !== generation || closeState) {
        await nextAttachment.destroy();
        return;
      }
      attachment = nextAttachment;
      activeAttachments.add(nextAttachment);
      setModel(nextModel);
      setPhase("attached");
      console.log(
        `seniman-meja: browser attached to ` +
        `${currentSessionTarget ?? "new session"} ` +
        "(SPKI verified)"
      );
    } catch (error) {
      if (nextAttachment) {
        activeAttachments.delete(nextAttachment);
        await nextAttachment.destroy();
      }
      if (disposed || currentGeneration !== generation) {
        return;
      }
      const state = closeState ?? {
        phase: "connection-error",
        message: error instanceof Error
          ? error.message
          : String(error),
      };
      console.error(
        `seniman-meja: connection failed: ${state.message}`
      );
      setModel(null);
      setMessage(state.message);
      setPhase(state.phase);
    }
  };

  const createSession = async () => connect("create");
  const selectSession = async (target) => {
    currentSessionTarget = target;
    await connect("attach");
  };
  const retryConnection = async () =>
    connect(currentSessionTarget ? "attach" : "create");

  useEffect(() => {
    if (currentSessionTarget) {
      void connect("attach");
    }
  });
  onDispose(() => {
    disposed = true;
    generation += 1;
    const currentAttachment = attachment;
    attachment = null;
    if (currentAttachment) {
      activeAttachments.delete(currentAttachment);
      void currentAttachment.destroy();
    }
  });

  return <div style={{ display: "contents" }}>
    <Style text={cssText} />
    {phase() === "attached" && model()
      ? <App model={model()} />
      : phase() === "detached"
        ? <DetachedPage
            message={message()}
            createSession={createSession}
            selectSession={selectSession}
          />
        : <ConnectionPage
            phase={phase()}
            message={message()}
            retryConnection={retryConnection}
          />}
  </div>;
}

try {
  if (options.skipPassword) {
    console.warn(
      "seniman-meja: WARNING: built-in password authentication is disabled.\n" +
      "Every user and process that can reach the web listener can read " +
      "terminal output and control Meja. Browser Origin checks are not " +
      "authentication.\nOnly use --skip-password when all such clients " +
      "are trusted or a trusted upstream performs authentication. For " +
      "remote access, use HTTPS, Tailscale, or another encrypted transport."
    );
  } else {
    const password = await promptForPassword();
    passwordGate = await createPasswordGate(password);
  }
  const root = createRoot(BrowserRoot);
  // Terminal input routinely exceeds Seniman's form-oriented event limit.
  root.setRateLimit({ disabled: true });
  webServers = await listenOnHosts(
    root,
    options.port,
    options.listenHosts,
    options.allowedOrigins,
    passwordGate
  );
  for (const host of options.listenHosts) {
    console.log(`seniman-meja: http://${host}:${options.port}`);
  }
} catch (error) {
  passwordGate?.close();
  passwordGate = null;
  console.error(`seniman-meja: ${error.message}`);
  process.exitCode = 1;
}

async function shutdown() {
  passwordGate?.close();
  passwordGate = null;
  await Promise.all(
    webServers.map(
      (server) =>
        new Promise((resolve) => {
          server.close(resolve);
          server.closeAllConnections?.();
        })
    )
  );
  const attachments = Array.from(activeAttachments);
  activeAttachments.clear();
  await Promise.all(
    attachments.map((attachment) => attachment.destroy())
  );
  process.exit();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
