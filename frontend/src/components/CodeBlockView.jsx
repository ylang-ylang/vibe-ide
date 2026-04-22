import { useEffect, useState } from "react";

import { buildPlainHighlightedRows, highlightCodeRows } from "../lib/shiki";

function getGitMarker(status) {
  if (status === "added") {
    return "+";
  }
  if (status === "deleted") {
    return "-";
  }
  if (status === "modified") {
    return "~";
  }
  return "";
}

export default function CodeBlockView({ rows, language = null }) {
  const [highlightedRows, setHighlightedRows] = useState(() => buildPlainHighlightedRows(rows));

  useEffect(() => {
    let cancelled = false;

    setHighlightedRows(buildPlainHighlightedRows(rows));

    async function highlight() {
      try {
        const nextRows = await highlightCodeRows(rows, language);
        if (!cancelled) {
          setHighlightedRows(nextRows);
        }
      } catch {
        if (!cancelled) {
          setHighlightedRows(buildPlainHighlightedRows(rows));
        }
      }
    }

    void highlight();

    return () => {
      cancelled = true;
    };
  }, [language, rows]);

  return (
    <div className="code-view" role="table" aria-label="selected symbol source">
      {highlightedRows.map((row) => (
        <div key={row.id} className={`code-row code-row-${row.status}`} role="row">
          <span className={`code-git-marker code-git-marker-${row.status}`} role="cell">
            {getGitMarker(row.status)}
          </span>
          <span className="code-line-number" role="cell">
            {row.lineNumber}
          </span>
          <code className="code-line-text" role="cell">
            {row.tokens.map((token) => (
              <span key={token.id} className="code-token" style={token.style || undefined}>
                {token.content}
              </span>
            ))}
          </code>
        </div>
      ))}
    </div>
  );
}
