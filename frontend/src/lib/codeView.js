export function buildCodeRowsForSelectedSymbol(sourceText, sourceGitInfo, selectedSymbol) {
  if (!sourceText || !selectedSymbol) {
    return [];
  }

  const startLine = Math.max(1, selectedSymbol.line || 1);
  const endLine = Math.max(startLine, selectedSymbol.line_end || startLine);
  const sourceLines = sourceText.split(/\r?\n/);
  const currentStatuses = new Map(
    (sourceGitInfo?.current || []).map((entry) => [entry.line, entry.kind]),
  );
  const deletedByBeforeLine = new Map();

  for (const entry of sourceGitInfo?.deleted || []) {
    if (!deletedByBeforeLine.has(entry.before_line)) {
      deletedByBeforeLine.set(entry.before_line, []);
    }
    deletedByBeforeLine.get(entry.before_line).push(entry);
  }

  const rows = [];

  function pushDeletedRows(beforeLine) {
    for (const entry of deletedByBeforeLine.get(beforeLine) || []) {
      rows.push({
        id: `deleted-${entry.old_line}-${beforeLine}-${rows.length}`,
        status: "deleted",
        lineNumber: entry.old_line,
        text: entry.text,
      });
    }
  }

  pushDeletedRows(startLine);

  for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
    const status = currentStatuses.get(lineNumber) || "context";
    rows.push({
      id: `line-${lineNumber}`,
      status,
      lineNumber,
      text: sourceLines[lineNumber - 1] ?? "",
    });
    pushDeletedRows(lineNumber + 1);
  }

  return rows;
}

export function buildCodeRowsForWholeFile(sourceText, sourceGitInfo) {
  if (!sourceText) {
    return [];
  }

  const lineCount = sourceText.split(/\r?\n/).length;
  return buildCodeRowsForSelectedSymbol(sourceText, sourceGitInfo, {
    line: 1,
    line_end: lineCount,
  });
}
