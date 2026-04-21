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

export default function CodeBlockView({ rows }) {
  return (
    <div className="code-view" role="table" aria-label="selected symbol source">
      {rows.map((row) => (
        <div key={row.id} className={`code-row code-row-${row.status}`} role="row">
          <span className={`code-git-marker code-git-marker-${row.status}`} role="cell">
            {getGitMarker(row.status)}
          </span>
          <span className="code-line-number" role="cell">
            {row.lineNumber}
          </span>
          <code className="code-line-text" role="cell">
            {row.text || " "}
          </code>
        </div>
      ))}
    </div>
  );
}
