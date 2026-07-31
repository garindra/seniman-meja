import {
  createCollection,
  onDispose,
  untrack,
  useState,
} from "seniman";
import { spanRuns } from "./meja-client.js";
import { renderDiagnostics } from "./render-diagnostics.js";

const SPAN_WIDTH_CLASS_MAX = 10;

function spanWidth(span) {
  return span.end - span.start;
}

function usesInlineWidth(span) {
  return spanWidth(span) > SPAN_WIDTH_CLASS_MAX;
}

function spanPartitionMatches(previous, next) {
  return (
    previous.length === next.length &&
    previous.every((span, index) => {
      const candidate = next[index];
      return usesInlineWidth(span) === usesInlineWidth(candidate);
    })
  );
}

function canReuseByStart(previous, next) {
  return (
    usesInlineWidth(previous) === usesInlineWidth(next) &&
    previous.start === next.start
  );
}

function canReuseByEnd(previous, next) {
  return (
    usesInlineWidth(previous) === usesInlineWidth(next) &&
    previous.end === next.end
  );
}

export function planSpanReconciliation(previous, next) {
  if (spanPartitionMatches(previous, next)) {
    return {
      start: previous.length,
      removeCount: 0,
      insertCount: 0,
      reusedPairs: previous.map((_, index) => [index, index]),
    };
  }

  const sharedLength = Math.min(previous.length, next.length);
  let prefixLength = 0;
  while (
    prefixLength < sharedLength &&
    canReuseByStart(previous[prefixLength], next[prefixLength])
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < sharedLength - prefixLength &&
    canReuseByEnd(
      previous[previous.length - 1 - suffixLength],
      next[next.length - 1 - suffixLength]
    )
  ) {
    suffixLength += 1;
  }

  const reusedPairs = [];
  for (let index = 0; index < prefixLength; index += 1) {
    reusedPairs.push([index, index]);
  }
  for (let offset = suffixLength; offset > 0; offset -= 1) {
    reusedPairs.push([
      previous.length - offset,
      next.length - offset,
    ]);
  }

  return {
    start: prefixLength,
    removeCount: previous.length - prefixLength - suffixLength,
    insertCount: next.length - prefixLength - suffixLength,
    reusedPairs,
  };
}

export function createSpanRecord(span) {
  return {
    current: span,
    apply: null,
  };
}

function updateSpanRecord(record, span) {
  if (record.apply) {
    record.apply(span);
  } else {
    record.current = span;
  }
}

export function TerminalSpan({ record }) {
  let current = record.current;
  const inlineWidth = usesInlineWidth(current);
  const [text, setText] = useState(current.text);
  const [className, setClassName] = useState(current.className);
  const [width, setWidth] = useState(spanWidth(current));

  record.apply = (next) => {
    if (current.text !== next.text) {
      setText(next.text);
    }
    if (current.className !== next.className) {
      setClassName(next.className);
    }
    const nextWidth = spanWidth(next);
    if (spanWidth(current) !== nextWidth) {
      setWidth(nextWidth);
    }
    current = next;
    record.current = next;
  };

  onDispose(() => {
    record.apply = null;
  });

  return inlineWidth
    ? <span
        class={className()}
        style={{ width: `${width()}ch` }}
      >
        {text()}
      </span>
    : <span class={`${className()} mjw-${width()}`}>
        {text()}
      </span>;
}

export function TerminalRow({ record }) {
  let spanRecords = spanRuns(record.snapshot).map(createSpanRecord);
  const spans = createCollection(spanRecords);
  const spanView = spans.map((readRecord) =>
    <TerminalSpan record={untrack(readRecord)} />
  );

  record.applySnapshot = (snapshot) => {
    record.snapshot = snapshot;
    const nextSpans = spanRuns(snapshot);
    const previousSpans = spanRecords.map((entry) => entry.current);
    const plan = planSpanReconciliation(
      previousSpans,
      nextSpans
    );
    renderDiagnostics.spanReconciliation(
      previousSpans,
      nextSpans,
      plan
    );
    for (const [beforeIndex, afterIndex] of plan.reusedPairs) {
      updateSpanRecord(
        spanRecords[beforeIndex],
        nextSpans[afterIndex]
      );
    }

    if (!plan.removeCount && !plan.insertCount) {
      return;
    }

    const insertedRecords = nextSpans
      .slice(plan.start, plan.start + plan.insertCount)
      .map(createSpanRecord);
    spans.splice(
      plan.start,
      plan.removeCount,
      ...insertedRecords
    );
    spanRecords.splice(
      plan.start,
      plan.removeCount,
      ...insertedRecords
    );
  };

  onDispose(() => {
    record.applySnapshot = null;
  });

  return <div class="mjr">{spanView}</div>;
}
