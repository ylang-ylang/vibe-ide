import { useEffect, useState } from "react";
import { Tree } from "react-arborist";

const KIND_ICON = {
  directory: "D",
  module: "PY",
  file: "F",
};

function matchNode(node, searchTerm) {
  if (!searchTerm) {
    return false;
  }

  const haystacks = [
    node.data.name,
    node.data.path,
    node.data.summary,
    node.data.symbol_text,
  ].filter(Boolean);

  const normalizedTerm = searchTerm.toLowerCase();
  return haystacks.some((value) => String(value).toLowerCase().includes(normalizedTerm));
}

function CopyStatus({ copyStatus }) {
  if (!copyStatus) {
    return <span className="status muted">click one `.py` to preview + copy ASCII summary</span>;
  }

  return <span className={`status ${copyStatus.kind}`}>{copyStatus.message}</span>;
}

function PreviewPanel({ previewText, previewPath, copyStatus }) {
  return (
    <section className="panel preview-panel">
      <div className="strip">
        <div className="strip-left">
          <strong>module summary</strong>
          {previewPath ? <span className="preview-path">{previewPath}</span> : null}
        </div>
        <CopyStatus copyStatus={copyStatus} />
      </div>

      <pre className="preview-block">
        {previewText || "click one Python module node to render its ASCII summary here"}
      </pre>
    </section>
  );
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy copy path below.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  textarea.style.left = "-1000px";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  try {
    return document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }
}

export default function App() {
  const [searchTerm, setSearchTerm] = useState("");
  const [treePayload, setTreePayload] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [previewText, setPreviewText] = useState("");
  const [previewPath, setPreviewPath] = useState("");
  const [copyStatus, setCopyStatus] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function loadTree() {
      try {
        const response = await fetch("/tree-data.json");
        if (!response.ok) {
          throw new Error(`failed to load tree-data.json: ${response.status}`);
        }
        const payload = await response.json();
        if (!cancelled) {
          setTreePayload(payload);
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      }
    }

    loadTree();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleModuleActivate(node) {
    const text = node.data.symbol_text || `${node.data.name}\n└── No symbol summary found.`;
    setPreviewText(text);
    setPreviewPath(node.data.path);

    try {
      const copied = await copyText(text);
      if (!copied) {
        throw new Error("copy returned false");
      }
      setCopyStatus({
        kind: "success",
        message: `copied ${node.data.name}`,
      });
    } catch {
      setCopyStatus({
        kind: "warning",
        message: `preview updated, clipboard copy failed`,
      });
    }
  }

  function NodeRenderer({ node, style }) {
    const isBranch = !node.isLeaf;
    const icon = KIND_ICON[node.data.kind] ?? "?";

    return (
      <div
        style={style}
        className={`tree-row ${node.isSelected ? "selected" : ""}`}
        onClick={() => {
          node.select();
          if (node.data.kind === "module") {
            void handleModuleActivate(node);
            return;
          }
          if (isBranch) {
            node.toggle();
          }
        }}
        role="treeitem"
        aria-label={node.data.name}
      >
        <div className="tree-row-content" style={{ paddingLeft: `${node.level * 18 + 8}px` }}>
          <button
            type="button"
            className="toggle"
            onClick={(event) => {
              event.stopPropagation();
              if (isBranch) {
                node.toggle();
              }
            }}
          >
            {isBranch ? (node.isOpen ? "-" : "+") : ""}
          </button>
          <span className={`kind kind-${node.data.kind}`}>{icon}</span>
          <span className="label">{node.data.name}</span>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <main className="app-shell">
        <section className="panel preview-panel">
          <pre className="preview-block">failed to load tree data: {loadError}</pre>
        </section>
      </main>
    );
  }

  if (!treePayload) {
    return (
      <main className="app-shell">
        <section className="panel preview-panel">
          <pre className="preview-block">loading tree data...</pre>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <section className="panel tree-panel">
        <div className="strip">
          <input
            type="search"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder={`search in ${treePayload.meta.repo_root}`}
          />
          <span className="status muted">
            {treePayload.meta.python_files} py files
          </span>
        </div>

        <div className="tree-frame">
          <Tree
            data={treePayload.nodes}
            openByDefault={false}
            rowHeight={34}
            indent={18}
            paddingTop={8}
            paddingBottom={8}
            width="100%"
            height={560}
            searchTerm={searchTerm}
            searchMatch={matchNode}
          >
            {NodeRenderer}
          </Tree>
        </div>
      </section>

      <PreviewPanel
        previewText={previewText}
        previewPath={previewPath}
        copyStatus={copyStatus}
      />
    </main>
  );
}
