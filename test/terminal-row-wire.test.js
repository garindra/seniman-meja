import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "../node_modules/seniman/dist/window.js";
import {
  deregisterWindow,
  registerWindow,
} from "../node_modules/seniman/dist/state.js";
import { TerminalRow } from "../dist/terminal-row.js";

const delay = () => new Promise((resolve) => setTimeout(resolve, 20));

function snapshot(runs) {
  const cells = [];
  for (const run of runs) {
    for (let column = 0; column < run.width; column += 1) {
      cells.push({
        key: run.className,
        text: run.text,
        width: 1,
        className: run.className,
      });
    }
  }
  return { cells };
}

async function createHarness(initialSnapshot) {
  const record = {
    snapshot: initialSnapshot,
    applySnapshot: null,
  };
  const messages = [];
  const windowManager = { lowMemoryMode: false };
  const pageParams = {
    windowId: "123456789012345678901",
    href: "http://localhost/",
    viewportSize: [800, 600],
    cookieString: "",
    currentPath: "/",
    readOffset: 0,
  };
  const window = new Window(
    windowManager,
    pageParams,
    null,
    () => TerminalRow({ record }),
    (buffer) => messages.push(Buffer.from(buffer))
  );
  window.onDestroy(() => deregisterWindow(window));
  registerWindow(window);
  window.start();
  await delay();
  messages.length = 0;

  return {
    record,
    messages,
    async update(nextSnapshot) {
      messages.length = 0;
      record.applySnapshot(nextSnapshot);
      await delay();
      return messages.slice();
    },
    async close() {
      window.destroy();
      await delay();
    },
  };
}

function opcodes(messages) {
  return messages.map((message) => message[0]);
}

test("stable spans emit only the field-level Seniman command", async () => {
  const harness = await createHarness(
    snapshot([{ text: "A", className: "s0", width: 1 }])
  );
  try {
    const styleMessages = await harness.update(
      snapshot([{ text: "A", className: "s1", width: 1 }])
    );
    assert.deepEqual(opcodes(styleMessages), [7]);
    assert.equal(styleMessages[0][4], 2, "class uses SET_ATTR");

    const textMessages = await harness.update(
      snapshot([{ text: "B", className: "s1", width: 1 }])
    );
    assert.deepEqual(opcodes(textMessages), [3]);

    const identicalMessages = await harness.update(
      snapshot([{ text: "B", className: "s1", width: 1 }])
    );
    assert.deepEqual(identicalMessages, []);
  } finally {
    await harness.close();
  }
});

test("inline width changes do not retransmit text or class", async () => {
  const harness = await createHarness(
    snapshot([{ text: " ", className: "s0", width: 11 }])
  );
  try {
    const messages = await harness.update(
      snapshot([{ text: " ", className: "s0", width: 12 }])
    );
    assert.deepEqual(opcodes(messages), [7]);
    assert.equal(messages[0][4], 1, "width uses STYLEPROP");
  } finally {
    await harness.close();
  }
});
