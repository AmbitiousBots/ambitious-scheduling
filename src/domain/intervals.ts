export type Span = { readonly start: number; readonly end: number };

export const merge = (spans: readonly Span[]): readonly Span[] => {
  const sorted = spans.filter((span) => span.end > span.start).toSorted((a, b) => a.start - b.start || a.end - b.end);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && span.start <= last.end) merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, span.end) };
    else merged.push(span);
  }
  return merged;
};

export const subtract = (from: readonly Span[], remove: readonly Span[]): readonly Span[] => {
  const holes = merge(remove);
  const kept: Span[] = [];
  for (const span of merge(from)) {
    let cursor = span.start;
    for (const hole of holes) {
      if (hole.end <= cursor) continue;
      if (hole.start >= span.end) break;
      if (hole.start > cursor) kept.push({ start: cursor, end: hole.start });
      cursor = Math.max(cursor, hole.end);
    }
    if (cursor < span.end) kept.push({ start: cursor, end: span.end });
  }
  return kept;
};

export const clip = (spans: readonly Span[], bounds: Span): readonly Span[] =>
  spans
    .map((span) => ({ start: Math.max(span.start, bounds.start), end: Math.min(span.end, bounds.end) }))
    .filter((span) => span.end > span.start);

export const overlaps = (a: Span, b: Span): boolean => a.start < b.end && b.start < a.end;

export const contains = (spans: readonly Span[], inner: Span): boolean => spans.some((span) => span.start <= inner.start && inner.end <= span.end);
