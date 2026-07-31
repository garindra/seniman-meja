import assert from "node:assert/strict";
import test from "node:test";
import { planSpanReconciliation } from "../dist/terminal-row.js";

function span(start, end, overrides = {}) {
  return {
    start,
    end,
    text: "x",
    className: "s0",
    spaceOnly: false,
    ...overrides,
  };
}

function compact(plan) {
  return {
    start: plan.start,
    removeCount: plan.removeCount,
    insertCount: plan.insertCount,
    reusedPairs: plan.reusedPairs,
  };
}

test("plans a one-span split as one insertion", () => {
  assert.deepEqual(
    compact(planSpanReconciliation(
      [span(0, 4)],
      [span(0, 2), span(2, 4)]
    )),
    {
      start: 1,
      removeCount: 0,
      insertCount: 1,
      reusedPairs: [[0, 0]],
    }
  );
});

test("plans a two-span merge as one removal", () => {
  assert.deepEqual(
    compact(planSpanReconciliation(
      [span(0, 2), span(2, 4)],
      [span(0, 4)]
    )),
    {
      start: 1,
      removeCount: 1,
      insertCount: 0,
      reusedPairs: [[0, 0]],
    }
  );
});

test("reuses all records when only boundaries move", () => {
  assert.deepEqual(
    compact(planSpanReconciliation(
      [span(0, 2), span(2, 4)],
      [span(0, 1), span(1, 4)]
    )),
    {
      start: 2,
      removeCount: 0,
      insertCount: 0,
      reusedPairs: [[0, 0], [1, 1]],
    }
  );
});

test("splices only a changed middle", () => {
  assert.deepEqual(
    compact(planSpanReconciliation(
      [span(0, 2), span(2, 4), span(4, 6)],
      [span(0, 2), span(2, 3), span(3, 4), span(4, 6)]
    )),
    {
      start: 2,
      removeCount: 0,
      insertCount: 1,
      reusedPairs: [[0, 0], [1, 1], [2, 3]],
    }
  );
});

test("preserves a stable suffix when the prefix changes", () => {
  const plan = planSpanReconciliation(
    [span(0, 11), span(11, 13)],
    [span(0, 5), span(5, 11), span(11, 13)]
  );
  assert.deepEqual(plan.reusedPairs.at(-1), [1, 2]);
});

test("preserves a stable prefix when the suffix changes", () => {
  const plan = planSpanReconciliation(
    [span(0, 2), span(2, 4)],
    [span(0, 2), span(2, 3), span(3, 4)]
  );
  assert.deepEqual(plan.reusedPairs[0], [0, 0]);
});

test("fully replaces incompatible inline-width modes", () => {
  assert.deepEqual(
    compact(planSpanReconciliation(
      [span(0, 10)],
      [span(0, 11)]
    )),
    {
      start: 0,
      removeCount: 1,
      insertCount: 1,
      reusedPairs: [],
    }
  );
});

test("keeps wide, space-only, and grapheme spans reusable", () => {
  const values = [
    span(0, 2, { text: "界" }),
    span(2, 8, { text: " ", spaceOnly: true }),
    span(8, 10, { text: "e\u0301" }),
  ];
  const next = values.map((value) => ({
    ...value,
    className: "s1",
  }));
  assert.deepEqual(
    planSpanReconciliation(values, next).reusedPairs,
    [[0, 0], [1, 1], [2, 2]]
  );
});
