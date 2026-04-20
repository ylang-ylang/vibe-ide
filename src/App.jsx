import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import mermaid from "mermaid";
import { Tree } from "react-arborist";

const KIND_ICON = {
  directory: "D",
  module: "PY",
  file: "F",
};
const TRANSLATE_API_BASE_URL = resolveTranslateApiBaseUrl();
let mermaidInitialized = false;
let mermaidRenderCounter = 0;

function logClient(event, detail = undefined) {
  if (detail === undefined) {
    console.info(`[repo-symbol-tree] ${event}`);
    return;
  }
  console.info(`[repo-symbol-tree] ${event}`, detail);
}

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
    node.data.symbol_mermaid,
  ].filter(Boolean);

  const normalizedTerm = searchTerm.toLowerCase();
  return haystacks.some((value) => String(value).toLowerCase().includes(normalizedTerm));
}

function collectInternalNodeDepths(nodes) {
  const idsByDepth = [];
  let maxInternalDepth = -1;

  function walk(nodeList, depth) {
    for (const node of nodeList || []) {
      const children = Array.isArray(node.children) ? node.children : [];
      if (children.length > 0) {
        if (!idsByDepth[depth]) {
          idsByDepth[depth] = [];
        }
        idsByDepth[depth].push(node.id);
        maxInternalDepth = Math.max(maxInternalDepth, depth);
        walk(children, depth + 1);
      }
    }
  }

  walk(nodes, 0);
  return {
    idsByDepth,
    maxExpandDepth: maxInternalDepth + 1,
  };
}

function CopyStatus({ copyStatus }) {
  if (!copyStatus) {
    return <span className="status muted">click one `.py` to preview + copy Mermaid flowchart</span>;
  }

  return <span className={`status ${copyStatus.kind}`}>{copyStatus.message}</span>;
}

function ensureMermaidInitialized() {
  if (mermaidInitialized) {
    return;
  }

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "loose",
    theme: "neutral",
    flowchart: {
      htmlLabels: true,
      useMaxWidth: false,
      curve: "basis",
    },
  });
  mermaidInitialized = true;
}

function MermaidDiagram({ chart }) {
  const containerRef = useRef(null);
  const [renderError, setRenderError] = useState("");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }

    if (!chart) {
      container.innerHTML = "";
      setRenderError("");
      return undefined;
    }

    let cancelled = false;
    container.innerHTML = "";
    setRenderError("");
    ensureMermaidInitialized();

    mermaid
      .render(`module-flowchart-${mermaidRenderCounter += 1}`, chart)
      .then(({ svg, bindFunctions }) => {
        if (cancelled || !containerRef.current) {
          return;
        }
        containerRef.current.innerHTML = svg;
        bindFunctions?.(containerRef.current);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setRenderError(error instanceof Error ? error.message : String(error));
      });

    return () => {
      cancelled = true;
      if (containerRef.current) {
        containerRef.current.innerHTML = "";
      }
    };
  }, [chart]);

  if (!chart) {
    return <div className="empty-state">click one Python module node to render its Mermaid flowchart here</div>;
  }

  if (renderError) {
    return (
      <div className="diagram-fallback">
        <div className="error-banner diagram-error">{renderError}</div>
        <pre className="preview-block">{chart}</pre>
      </div>
    );
  }

  return (
    <div className="diagram-stage">
      <div ref={containerRef} className="mermaid-diagram" />
    </div>
  );
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
          <strong>module flowchart</strong>
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
            <strong>module flowchart</strong>
          </div>
          <MermaidDiagram chart={previewText} />
        </section>

        <section className="preview-section">
          <div className="preview-section-strip">
            <strong>ai translation</strong>
            <span className={`status ${translationError ? "error" : "muted"}`}>
              {translationError
                ? "translation failed"
                : translationModel
                  ? `via ${translationModel}`
                  : "send only the Mermaid flowchart to the local translator"}
            </span>
          </div>
          <pre className="preview-block translation-block">
            {translationError
              || translationText
              || (isTranslating
                ? "translating..."
                : "click translate to send only this Mermaid flowchart to the local translator")}
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
  logClient("request.start", {
    method: options?.method || "GET",
    path,
  });
  let response;
  try {
    response = await fetch(path, options);
  } catch (error) {
    logClient("request.network_error", {
      method: options?.method || "GET",
      path,
      error: error instanceof Error ? error.message : String(error),
    });
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
    logClient("request.error", {
      method: options?.method || "GET",
      path,
      status: response.status,
      error: payload.error || `${response.status} ${response.statusText}`,
    });
    throw new Error(payload.error || `${response.status} ${response.statusText}`);
  }
  logClient("request.success", {
    method: options?.method || "GET",
    path,
    status: response.status,
  });
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
  const [treeExpandDepth, setTreeExpandDepth] = useState(0);
  const translationRequestIdRef = useRef(0);
  const treeApiRef = useRef(null);
  const treeViewportRef = useRef(null);

  const selectedRepoOption = useMemo(
    () => repoRoots.find((item) => item.path === selectedRepoRoot) ?? null,
    [repoRoots, selectedRepoRoot],
  );
  const treeDepthControl = useMemo(
    () => collectInternalNodeDepths(treePayload?.nodes || []),
    [treePayload],
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

  useEffect(() => {
    const tree = treeApiRef.current;
    if (!tree || !treePayload || treeViewportHeight <= 0) {
      return;
    }

    tree.closeAll();
    for (let depth = 0; depth < treeExpandDepth; depth += 1) {
      for (const id of treeDepthControl.idsByDepth[depth] || []) {
        tree.open(id);
      }
    }

    logClient("tree.depth.apply", {
      depth: treeExpandDepth,
      maxDepth: treeDepthControl.maxExpandDepth,
    });
  }, [treePayload, treeViewportHeight, treeExpandDepth, treeDepthControl]);

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
    logClient("tree.load", { repoRoot });

    try {
      const payload = await fetchJson(`/api/tree?repo_root=${encodeURIComponent(repoRoot)}`);
      if (cancelled) {
        return;
      }
      setTreePayload(payload);
      setTreeExpandDepth(0);
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
    logClient("repo_root.change", { repoRoot: nextRepoRoot });
    setSelectedRepoRoot(nextRepoRoot);
    if (!nextRepoRoot) {
      setTreePayload(null);
      setTreeExpandDepth(0);
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
      setTreeExpandDepth(0);
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
    logClient("repo_root.refresh");

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
    const text = node.data.symbol_mermaid || "";
    setPreviewText(text);
    setPreviewPath(node.data.path);
    resetTranslation();
    logClient("module.activate", {
      nodeId: node.id,
      path: node.data.path,
    });

    try {
      const copied = await copyText(text);
      if (!copied) {
        throw new Error("copy returned false");
      }
      setCopyStatus({
        kind: "success",
        message: `copied Mermaid for ${node.data.name}`,
      });
    } catch {
      setCopyStatus({
        kind: "warning",
        message: "Mermaid preview updated, clipboard copy failed",
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
    logClient("translate.start", { previewPath });

    try {
      const payload = await fetchJson(`${TRANSLATE_API_BASE_URL}/api/translate-symbol`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ mermaid_flowchart: previewText }),
      });
      if (translationRequestIdRef.current !== requestId) {
        return;
      }
      setTranslationText(payload.translation || "");
      setTranslationModel(payload.model || "");
      logClient("translate.success", {
        previewPath,
        model: payload.model || "",
      });
    } catch (error) {
      if (translationRequestIdRef.current !== requestId) {
        return;
      }
      setTranslationError(error instanceof Error ? error.message : String(error));
      logClient("translate.error", {
        previewPath,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (translationRequestIdRef.current === requestId) {
        setIsTranslating(false);
      }
    }
  }

  function rememberActiveNode(node, reason) {
    if (!node) {
      return;
    }
    logClient("tree.active_node", {
      reason,
      nodeId: node.id,
      path: node.data?.path || node.data?.name || node.id,
      kind: node.data?.kind || "unknown",
    });
  }

  function handleExpandTarget() {
    setTreeExpandDepth((currentDepth) => {
      const nextDepth = Math.min(treeDepthControl.maxExpandDepth, currentDepth + 1);
      logClient("tree.expand_level", {
        fromDepth: currentDepth,
        toDepth: nextDepth,
        maxDepth: treeDepthControl.maxExpandDepth,
      });
      return nextDepth;
    });
  }

  function handleCollapseTarget() {
    setTreeExpandDepth((currentDepth) => {
      const nextDepth = Math.max(0, currentDepth - 1);
      logClient("tree.collapse_level", {
        fromDepth: currentDepth,
        toDepth: nextDepth,
      });
      return nextDepth;
    });
  }

  function handleExpandAll() {
    logClient("tree.expand_all", {
      fromDepth: treeExpandDepth,
      toDepth: treeDepthControl.maxExpandDepth,
    });
    setTreeExpandDepth(treeDepthControl.maxExpandDepth);
  }

  function NodeRenderer({ node, style }) {
    const isBranch = !node.isLeaf;
    const icon = KIND_ICON[node.data.kind] ?? "?";

    return (
      <div
        style={style}
        className={`tree-row ${node.isSelected ? "selected" : ""}`}
        onClick={() => {
          rememberActiveNode(node, "row-click");
          node.select();
          if (node.data.kind === "module") {
            void handleModuleActivate(node);
            return;
          }
          if (isBranch) {
            logClient("tree.toggle", {
              nodeId: node.id,
              path: node.data?.path || node.data?.name || node.id,
              nextOpen: !node.isOpen,
            });
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
                rememberActiveNode(node, "toggle-click");
                logClient("tree.toggle", {
                  nodeId: node.id,
                  path: node.data?.path || node.data?.name || node.id,
                  nextOpen: !node.isOpen,
                });
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
                    ? `${treePayload.meta.python_files} py files · L${treeExpandDepth}/${treeDepthControl.maxExpandDepth}`
                    : ""}
              </span>
              <div className="action-button-group" role="group" aria-label="tree branch actions">
                <button
                  type="button"
                  className="action-button"
                  onClick={handleExpandTarget}
                  disabled={!treePayload || treeExpandDepth >= treeDepthControl.maxExpandDepth}
                >
                  expand
                </button>
                <button
                  type="button"
                  className="action-button"
                  onClick={handleCollapseTarget}
                  disabled={!treePayload || treeExpandDepth <= 0}
                >
                  collapse
                </button>
              </div>
              <button
                type="button"
                className="action-button"
                onClick={handleExpandAll}
                disabled={!treePayload || treeExpandDepth >= treeDepthControl.maxExpandDepth}
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
