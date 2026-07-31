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

function structuralOpcodes(messages) {
  const result = [];
  for (const message of messages) {
    let offset = 0;
    while (offset < message.length) {
      const opcode = message[offset];
      result.push(opcode);
      if (opcode === 3) {
        const length = message.readUInt16BE(offset + 5);
        offset += 7 + length;
      } else if (opcode === 7) {
        const mode = message[offset + 4];
        if (mode !== 1 && mode !== 2) {
          throw new Error(`unsupported test element mode ${mode}`);
        }
        const length = message.readUInt16BE(offset + 6);
        offset += 8 + length;
      } else if (opcode === 8) {
        offset += 5;
      } else if (opcode === 9) {
        offset += 1;
        while (message.readUInt16BE(offset) !== 0) {
          offset += 2;
        }
        offset += 2;
      } else if (opcode === 18) {
        const count = message.readUInt16BE(offset + 5);
        offset += 7;
        for (let index = 0; index < count; index += 1) {
          const item = message.readUInt16BE(offset);
          offset += 2;
          if ((item & 0x8000) === 0) {
            offset += item;
          }
        }
      } else if (opcode === 19) {
        offset += 7;
      } else {
        throw new Error(`unsupported test opcode ${opcode}`);
      }
    }
  }
  return result;
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

test("span splits and merges use localized sequence mutations", async () => {
  const harness = await createHarness(
    snapshot([{ text: "A", className: "s0", width: 2 }])
  );
  try {
    const splitMessages = await harness.update(snapshot([
      { text: "A", className: "s0", width: 1 },
      { text: "A", className: "s1", width: 1 },
    ]));
    const splitOpcodes = structuralOpcodes(splitMessages);
    assert.equal(splitOpcodes.filter((value) => value === 18).length, 1);
    assert.equal(splitOpcodes.includes(19), false);

    const mergeMessages = await harness.update(
      snapshot([{ text: "A", className: "s0", width: 2 }])
    );
    const mergeOpcodes = structuralOpcodes(mergeMessages);
    assert.equal(mergeOpcodes.filter((value) => value === 19).length, 1);
    assert.equal(mergeOpcodes.includes(18), false);
  } finally {
    await harness.close();
  }
});

test("stable islands survive multiple localized insertions", async () => {
  const harness = await createHarness(snapshot([
    { text: "A", className: "s0", width: 1 },
    { text: "B", className: "s1", width: 1 },
    { text: "C", className: "s2", width: 1 },
    { text: "D", className: "s3", width: 1 },
  ]));
  try {
    const messages = await harness.update(snapshot([
      { text: "A", className: "s0", width: 1 },
      { text: "X", className: "sx", width: 1 },
      { text: "B", className: "s1", width: 1 },
      { text: "C", className: "s2", width: 1 },
      { text: "Y", className: "sy", width: 1 },
      { text: "D", className: "s3", width: 1 },
    ]));
    const commands = structuralOpcodes(messages);
    assert.equal(commands.filter((value) => value === 18).length, 2);
    assert.equal(commands.includes(19), false);
  } finally {
    await harness.close();
  }
});
