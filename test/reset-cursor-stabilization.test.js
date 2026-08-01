import assert from "node:assert/strict";
import test from "node:test";
import { TerminalModel } from "../src/meja-client.js";

function cursorColumn(event) {
  return event.rows[0]?.row.cells.findIndex(
    (cell) => cell.className?.includes("__mjc")
  );
}

test("hides a reset cursor until its row receives the settled update", async () => {
  const model = new TerminalModel("test", 3, 1);
  const screen = model.screen(0);
  const events = [];
  model.subscribe((event) => events.push(event));

  screen.reset(3, 1, 1);
  screen.cursor = { x: 1, y: 0, visible: true };
  screen.presentCount = 1;
  model.present(0, screen);
  assert.equal(cursorColumn(events[0]), -1);

  screen.resetPending = false;
  screen.dirtyRows = new Set([0]);
  screen.cursor = { x: 2, y: 0, visible: true };
  screen.cursorUpdatePending = true;
  screen.presentCount = 2;
  model.present(0, screen);
  assert.equal(cursorColumn(events[1]), 2);

  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(events.length, 2);
  model.disconnect();
});

test("reveals a reset cursor when no follow-up row arrives", async () => {
  const model = new TerminalModel("test", 3, 1);
  const screen = model.screen(0);
  const events = [];
  model.subscribe((event) => events.push(event));

  screen.reset(3, 1, 1);
  screen.cursor = { x: 1, y: 0, visible: true };
  screen.presentCount = 1;
  model.present(0, screen);
  screen.resetPending = false;
  screen.dirtyRows.clear();

  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(events.length, 2);
  assert.equal(cursorColumn(events[1]), 1);
  model.disconnect();
});
