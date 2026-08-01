const KITTY_FUNCTIONAL_CODES = Object.freeze({
  Escape: 57344,
  Enter: 57345,
  Tab: 57346,
  Backspace: 57347,
  Insert: 57348,
  Delete: 57349,
  ArrowLeft: 57350,
  ArrowRight: 57351,
  ArrowUp: 57352,
  ArrowDown: 57353,
  PageUp: 57354,
  PageDown: 57355,
  Home: 57356,
  End: 57357,
  F1: 57364,
  F2: 57365,
  F3: 57366,
  F4: 57367,
  F5: 57368,
  F6: 57369,
  F7: 57370,
  F8: 57371,
  F9: 57372,
  F10: 57373,
  F11: 57374,
  F12: 57375,
});

const PHYSICAL_CHARACTERS = Object.freeze({
  Space: " ",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Comma: ",",
  Period: ".",
  Slash: "/",
});

const ACTION_CODES = Object.freeze({
  press: 1,
  repeat: 2,
  release: 3,
});

function physicalCharacter(code) {
  if (/^Key[A-Z]$/.test(code)) {
    return code.slice(3).toLowerCase();
  }
  if (/^(?:Digit|Numpad)[0-9]$/.test(code)) {
    return code.at(-1);
  }
  return PHYSICAL_CHARACTERS[code] ?? null;
}

function keyCodepoint({ key, code, ctrl, alt }) {
  const functional = KITTY_FUNCTIONAL_CODES[key];
  if (functional !== undefined) {
    return functional;
  }

  const characters = Array.from(key);
  if (alt) {
    // macOS Option commonly changes `key` into a different glyph. Terminal Alt
    // chords describe the underlying key instead, as Terminal.app does when
    // Option is configured as Meta.
    const physical = physicalCharacter(code);
    if (physical !== null) {
      return physical.codePointAt(0);
    }
  }
  if (characters.length === 1) {
    return characters[0].codePointAt(0);
  }
  if (ctrl) {
    return physicalCharacter(code)?.codePointAt(0) ?? null;
  }
  return null;
}

export function encodeTerminalKey({
  key,
  code = "",
  ctrl = false,
  alt = false,
  shift = false,
  action = "press",
}) {
  const codepoint = keyCodepoint({ key, code, ctrl, alt });
  const actionCode = ACTION_CODES[action];
  if (codepoint === null || actionCode === undefined) {
    return null;
  }

  const modifiers =
    1 +
    (shift ? 1 : 0) +
    (alt ? 2 : 0) +
    (ctrl ? 4 : 0);
  return `\x1b[${codepoint};${modifiers}:${actionCode}u`;
}
