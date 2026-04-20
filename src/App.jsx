import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Tree } from "react-arborist";

const KIND_ICON = {
  directory: "D",
  module: "PY",
  file: "F",
};
const TRANSLATE_API_BASE_URL = resolveTranslateApiBaseUrl();

function resolveTranslateApiBaseUrl() {
  const override = import.meta.env.VITE_TRANSLATE_API_BASE_URL;
  if (override) {
    return override.replace(/\/$/, "");
  }

  return "/translate-api";
}

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

function PreviewPanel({
  previewText,
  previewPath,
  copyStatus,
  translationText,
  translationError,
  translationModel,
  isTranslating,
  onTranslate,
}) {
  return (
    <section className="panel preview-panel">
      <div className="strip">
        <div className="strip-left">
          <strong>module summary</strong>
          {previewPath ? <span className="preview-path">{previewPath}</span> : null}
        </div>
        <div className="panel-actions">
          <CopyStatus copyStatus={copyStatus} />
          <button
            type="button"
            className="action-button"
            onClick={onTranslate}
            disabled={!previewText || isTranslating}
          >
            {isTranslating ? "translating..." : "translate"}
          </button>
        </div>
      </div>

      <div className="preview-content">
        <section className="preview-section">
          <div className="preview-section-strip">
            <strong>ascii tree</strong>
          </div>
          <pre className="preview-block">
            {previewText || "click one Python module node to render its ASCII summary here"}
          </pre>
        </section>

        <section className="preview-section">
          <div className="preview-section-strip">
            <strong>ai translation</strong>
            <span className={`status ${translationError ? "error" : "muted"}`}>
              {translationError
                ? "translation failed"
                : translationModel
                  ? `via ${translationModel}`
                  : "send only the ascii tree to the local translator"}
            </span>
          </div>
          <pre className="preview-block translation-block">
            {translationError
              || translationText
              || (isTranslating
                ? "translating..."
                : "click translate to send only this ASCII tree to the local translator")}
          </pre>
        </section>
      </div>
    </section>
  );
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the legacy copy path below
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

async function fetchJson(path, options = undefined) {
  let response;
  try {
    response = await fetch(path, options);
  } catch (error) {
    if (
      typeof path === "string"
      && (
        path.startsWith(TRANSLATE_API_BASE_URL)
      )
    ) {
      throw new Error(
        "cannot reach local translator through the same-origin proxy. restart the frontend server and check the translator process.",
      );
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || `${response.status} ${response.statusText}`);
  }
  return payload;
}

export default function App() {
  const [searchTerm, setSearchTerm] = useState("");
  const [repoRoots, setRepoRoots] = useState([]);
  const [selectedRepoRoot, setSelectedRepoRoot] = useState("");
  const [treePayload, setTreePayload] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [previewText, setPreviewText] = useState("");
  const [previewPath, setPreviewPath] = useState("");
  const [copyStatus, setCopyStatus] = useState(null);
  const [translationText, setTranslationText] = useState("");
  const [translationError, setTranslationError] = useState("");
  const [translationModel, setTranslationModel] = useState("");
  const [isBooting, setIsBooting] = useState(true);
  const [isRefreshingRoots, setIsRefreshingRoots] = useState(false);
  const [isLoadingTree, setIsLoadingTree] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const [treeViewportHeight, setTreeViewportHeight] = useState(0);
  const translationRequestIdRef = useRef(0);
  const treeApiRef = useRef(null);
  const treeViewportRef = useRef(null);

  const selectedRepoOption = useMemo(
    () => repoRoots.find((item) => item.path === selectedRepoRoot) ?? null,
    [repoRoots, selectedRepoRoot],
  );

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      setIsBooting(true);
      setLoadError("");

      try {
        const [statePayload, rootsPayload] = await Promise.all([
          fetchJson("/api/state"),
          fetchJson("/api/repo-roots"),
        ]);

        if (cancelled) {
          return;
        }

        setRepoRoots(rootsPayload.repo_roots);

        if (statePayload.selected_repo_root) {
          setSelectedRepoRoot(statePayload.selected_repo_root);
          await loadTree(statePayload.selected_repo_root, cancelled);
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!cancelled) {
          setIsBooting(false);
        }
      }
    }

    bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  useLayoutEffect(() => {
    const element = treeViewportRef.current;
    if (!element) {
      return undefined;
    }

    function updateHeight(nextHeight) {
      const normalizedHeight = Math.max(0, Math.floor(nextHeight));
      setTreeViewportHeight((previousHeight) => (
        previousHeight === normalizedHeight ? previousHeight : normalizedHeight
      ));
    }

    updateHeight(element.getBoundingClientRect().height);

    if (typeof ResizeObserver === "undefined") {
      return undefined;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      updateHeight(entry.contentRect.height);
    });

    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [isBooting, treePayload]);

  function resetTranslation() {
    translationRequestIdRef.current += 1;
    setTranslationText("");
    setTranslationError("");
    setTranslationModel("");
    setIsTranslating(false);
  }

  async function loadTree(repoRoot, cancelled = false) {
    setIsLoadingTree(true);
    setLoadError("");

    try {
      const payload = await fetchJson(`/api/tree?repo_root=${encodeURIComponent(repoRoot)}`);
      if (cancelled) {
        return;
      }
      setTreePayload(payload);
      setPreviewText("");
      setPreviewPath("");
      setCopyStatus(null);
      resetTranslation();
    } catch (error) {
      if (!cancelled) {
        setLoadError(error instanceof Error ? error.message : String(error));
        setTreePayload(null);
      }
    } finally {
      if (!cancelled) {
        setIsLoadingTree(false);
      }
    }
  }

  async function handleRepoRootChange(nextRepoRoot) {
    setSelectedRepoRoot(nextRepoRoot);
    if (!nextRepoRoot) {
      setTreePayload(null);
      setPreviewText("");
      setPreviewPath("");
      setCopyStatus(null);
      resetTranslation();
      return;
    }

    setIsLoadingTree(true);
    setLoadError("");

    try {
      const payload = await fetchJson("/api/select-root", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ repo_root: nextRepoRoot }),
      });

      setTreePayload(payload.tree_payload);
      setSelectedRepoRoot(payload.selected_repo_root);
      setPreviewText("");
      setPreviewPath("");
      setCopyStatus({
        kind: "success",
        message: `remembered ${nextRepoRoot.split("/").at(-1)}`,
      });
      resetTranslation();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
      setTreePayload(null);
    } finally {
      setIsLoadingTree(false);
    }
  }

  async function refreshRepoRoots() {
    setIsRefreshingRoots(true);
    setLoadError("");

    try {
      const payload = await fetchJson("/api/repo-roots");
      setRepoRoots(payload.repo_roots);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsRefreshingRoots(false);
    }
  }

  async function handleModuleActivate(node) {
    const text = node.data.symbol_text || `${node.data.name}\n└── No symbol summary found.`;
    setPreviewText(text);
    setPreviewPath(node.data.path);
    resetTranslation();

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
        message: "preview updated, clipboard copy failed",
      });
    }
  }

  async function handleTranslatePreview() {
    if (!previewText) {
      return;
    }

    const requestId = translationRequestIdRef.current + 1;
    translationRequestIdRef.current = requestId;
    setIsTranslating(true);
    setTranslationError("");
    setTranslationText("");
    setTranslationModel("");

    try {
      const payload = await fetchJson(`${TRANSLATE_API_BASE_URL}/api/translate-symbol`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ascii_tree: previewText }),
      });
      if (translationRequestIdRef.current !== requestId) {
        return;
      }
      setTranslationText(payload.translation || "");
      setTranslationModel(payload.model || "");
    } catch (error) {
      if (translationRequestIdRef.current !== requestId) {
        return;
      }
      setTranslationError(error instanceof Error ? error.message : String(error));
    } finally {
      if (translationRequestIdRef.current === requestId) {
        setIsTranslating(false);
      }
    }
  }

  function getTreeActionTarget() {
    const tree = treeApiRef.current;
    if (!tree) {
      return null;
    }

    let target = tree.mostRecentNode || tree.focusedNode || tree.firstNode;
    if (!target) {
      return null;
    }

    if (target.isLeaf) {
      target = target.parent || tree.firstNode;
    }

    if (target?.isRoot) {
      target = tree.firstNode;
    }

    return target?.isInternal ? target : null;
  }

  function handleExpandTarget() {
    const target = getTreeActionTarget();
    if (!target) {
      return;
    }
    target.open();
  }

  function handleCollapseTarget() {
    const target = getTreeActionTarget();
    if (!target) {
      return;
    }
    target.close();
  }

  function handleExpandAll() {
    treeApiRef.current?.openAll();
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

  if (isBooting) {
    return (
      <main className="app-shell">
        <section className="panel preview-panel">
          <pre className="preview-block">loading repo roots...</pre>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <div className="workspace-panels">
        <section className="panel tree-panel">
          <div className="strip controls-strip">
            <div className="control-group repo-root-control">
              <label htmlFor="repo-root-select">repo root</label>
              <select
                id="repo-root-select"
                value={selectedRepoRoot}
                onChange={(event) => void handleRepoRootChange(event.target.value)}
              >
                <option value="">select one repo under home</option>
                {repoRoots.map((item) => (
                  <option key={item.path} value={item.path}>
                    {item.label}
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => void refreshRepoRoots()} disabled={isRefreshingRoots}>
                {isRefreshingRoots ? "refreshing..." : "refresh"}
              </button>
            </div>

            <div className="control-group search-control">
              <input
                type="search"
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder={
                  treePayload ? `search in ${treePayload.meta.repo_root}` : "select one repo root first"
                }
                disabled={!treePayload}
              />
            </div>
          </div>

          <div className="substrip">
            <span className="status muted">
              {selectedRepoOption?.label || "no repo root selected"}
            </span>
            <div className="tree-toolbar">
              <span className="status muted">
                {isLoadingTree
                  ? "scanning..."
                  : treePayload
                    ? `${treePayload.meta.python_files} py files`
                    : ""}
              </span>
              <div className="action-button-group" role="group" aria-label="tree branch actions">
                <button
                  type="button"
                  className="action-button"
                  onClick={handleExpandTarget}
                  disabled={!treePayload}
                >
                  expand
                </button>
                <button
                  type="button"
                  className="action-button"
                  onClick={handleCollapseTarget}
                  disabled={!treePayload}
                >
                  collapse
                </button>
              </div>
              <button
                type="button"
                className="action-button"
                onClick={handleExpandAll}
                disabled={!treePayload}
              >
                expand all
              </button>
            </div>
          </div>

          {loadError ? <div className="error-banner">{loadError}</div> : null}

          <div className="tree-frame">
            <div ref={treeViewportRef} className="tree-viewport">
              {treePayload ? (
                treeViewportHeight > 0 ? (
                  <Tree
                    ref={treeApiRef}
                    data={treePayload.nodes}
                    openByDefault={false}
                    rowHeight={34}
                    indent={18}
                    paddingTop={8}
                    paddingBottom={8}
                    width="100%"
                    height={treeViewportHeight}
                    searchTerm={searchTerm}
                    searchMatch={matchNode}
                  >
                    {NodeRenderer}
                  </Tree>
                ) : (
                  <div className="empty-state">measuring tree viewport...</div>
                )
              ) : (
                <div className="empty-state">choose one repo root under your home directory</div>
              )}
            </div>
          </div>
        </section>

        <PreviewPanel
          previewText={previewText}
          previewPath={previewPath}
          copyStatus={copyStatus}
          translationText={translationText}
          translationError={translationError}
          translationModel={translationModel}
          isTranslating={isTranslating}
          onTranslate={() => void handleTranslatePreview()}
        />
      </div>
    </main>
  );
}
