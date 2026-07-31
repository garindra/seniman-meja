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
    const partitionMatches = spanPartitionMatches(
      previousSpans,
      nextSpans
    );
    renderDiagnostics.spanTransition(
      previousSpans,
      nextSpans,
      partitionMatches
    );
    if (partitionMatches) {
      for (let index = 0; index < nextSpans.length; index += 1) {
        updateSpanRecord(spanRecords[index], nextSpans[index]);
      }
      return;
    }

    spanRecords = nextSpans.map(createSpanRecord);
    spans.splice(0, spans.length, ...spanRecords);
  };

  onDispose(() => {
    record.applySnapshot = null;
  });

  return <div class="mjr">{spanView}</div>;
}
