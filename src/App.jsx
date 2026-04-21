import { useEffect, useMemo, useRef, useState } from "react";

import PreviewPanel from "./components/PreviewPanel";
import RepoTreePanel from "./components/RepoTreePanel";
import { useTreeViewportHeight } from "./hooks/useTreeViewportHeight";
import { TRANSLATE_API_BASE_URL, copyText, fetchJson, logClient } from "./lib/api";
import {
  collapseFromDeepestVisibleLevel,
  collectInternalNodeDepths,
  expandFromDeepestVisibleLevel,
  filterTreeByGitStatus,
  getVisibleTreeDepth,
} from "./lib/tree";

function applyMermaidDirection(chart, direction) {
  if (!chart) {
    return chart;
  }

  if (/^flowchart\s+(?:TB|TD|BT|RL|LR)\b/m.test(chart)) {
    return chart.replace(/^flowchart\s+(?:TB|TD|BT|RL|LR)\b/m, `flowchart ${direction}`);
  }

  if (/^graph\s+(?:TB|TD|BT|RL|LR)\b/m.test(chart)) {
    return chart.replace(/^graph\s+(?:TB|TD|BT|RL|LR)\b/m, `graph ${direction}`);
  }

  return chart;
}

export default function App() {
  const treePanelMinWidth = 280;
  const previewPanelMinWidth = 360;
  const panelDividerWidth = 10;
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
  const [previewMode, setPreviewMode] = useState("original");
  const [isBooting, setIsBooting] = useState(true);
  const [isRefreshingRoots, setIsRefreshingRoots] = useState(false);
  const [isLoadingTree, setIsLoadingTree] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const [treeBrowseDepth, setTreeBrowseDepth] = useState(0);
  const [isTreeCollapsed, setIsTreeCollapsed] = useState(false);
  const [isChangesOnly, setIsChangesOnly] = useState(false);
  const [mermaidDirection, setMermaidDirection] = useState("LR");
  const [treePanelWidth, setTreePanelWidth] = useState(520);
  const [isResizingPanels, setIsResizingPanels] = useState(false);
  const translationRequestIdRef = useRef(0);
  const resizeStateRef = useRef({ startX: 0, startWidth: 520 });
  const treeBrowseSyncFrameRef = useRef(0);
  const treeApiRef = useRef(null);
  const treeViewportRef = useRef(null);
  const workspacePanelsRef = useRef(null);

  const selectedRepoOption = useMemo(
    () => repoRoots.find((item) => item.path === selectedRepoRoot) ?? null,
    [repoRoots, selectedRepoRoot],
  );
  const displayedPreviewText = useMemo(() => (
    previewMode === "translated" && translationText ? translationText : previewText
  ), [previewMode, previewText, translationText]);
  const visibleTreeNodes = useMemo(() => {
    const nodes = treePayload?.nodes || [];
    return isChangesOnly ? filterTreeByGitStatus(nodes) : nodes;
  }, [treePayload, isChangesOnly]);
  const orientedPreviewText = useMemo(
    () => applyMermaidDirection(displayedPreviewText, mermaidDirection),
    [displayedPreviewText, mermaidDirection],
  );
  const treeDepthControl = useMemo(
    () => collectInternalNodeDepths(visibleTreeNodes),
    [visibleTreeNodes],
  );
  const treeViewportHeight = useTreeViewportHeight(treeViewportRef, [isBooting, treePayload]);

  function syncTreeBrowseDepth() {
    const tree = treeApiRef.current;
    if (tree) {
      setTreeBrowseDepth(getVisibleTreeDepth(tree));
      return;
    }

    setTreeBrowseDepth(visibleTreeNodes.length > 0 ? 1 : 0);
  }

  function scheduleTreeBrowseDepthSync() {
    if (treeBrowseSyncFrameRef.current) {
      window.cancelAnimationFrame(treeBrowseSyncFrameRef.current);
    }

    treeBrowseSyncFrameRef.current = window.requestAnimationFrame(() => {
      treeBrowseSyncFrameRef.current = 0;
      syncTreeBrowseDepth();
    });
  }

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

  useEffect(() => {
    if (!treePayload || treeViewportHeight <= 0) {
      return undefined;
    }

    scheduleTreeBrowseDepthSync();
    return () => {
      if (treeBrowseSyncFrameRef.current) {
        window.cancelAnimationFrame(treeBrowseSyncFrameRef.current);
        treeBrowseSyncFrameRef.current = 0;
      }
    };
  }, [treePayload, visibleTreeNodes, searchTerm, treeViewportHeight]);

  useEffect(() => {
    if (!isResizingPanels) {
      return undefined;
    }

    function handlePointerMove(event) {
      const workspaceElement = workspacePanelsRef.current;
      if (!workspaceElement) {
        return;
      }

      const workspaceWidth = workspaceElement.getBoundingClientRect().width;
      const maxTreeWidth = Math.max(
        treePanelMinWidth,
        workspaceWidth - panelDividerWidth - previewPanelMinWidth,
      );
      const nextWidth = resizeStateRef.current.startWidth + (event.clientX - resizeStateRef.current.startX);
      const clampedWidth = Math.min(maxTreeWidth, Math.max(treePanelMinWidth, nextWidth));
      setTreePanelWidth(clampedWidth);
    }

    function handlePointerUp() {
      setIsResizingPanels(false);
    }

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [isResizingPanels]);

  function resetTranslation() {
    translationRequestIdRef.current += 1;
    setTranslationText("");
    setTranslationError("");
    setTranslationModel("");
    setPreviewMode("original");
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
      setTreeBrowseDepth(0);
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
      setTreeBrowseDepth(0);
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
      setTreeBrowseDepth(0);
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
    const mermaidText = node.data.symbol_mermaid || "";
    const xmlOutlineText = node.data.symbol_outline_xml || "";
    setPreviewText(mermaidText);
    setPreviewPath(node.data.path);
    resetTranslation();
    logClient("module.activate", {
      nodeId: node.id,
      path: node.data.path,
    });

    try {
      const copied = await copyText(xmlOutlineText);
      if (!copied) {
        throw new Error("copy returned false");
      }
      setCopyStatus({
        kind: "success",
        message: `copied XML outline for ${node.data.name}`,
      });
    } catch {
      setCopyStatus({
        kind: "warning",
        message: "Mermaid preview updated, XML outline copy failed",
      });
    }
  }

  async function handleTranslatePreview() {
    if (!previewText) {
      return;
    }

    if (translationText) {
      const nextMode = previewMode === "translated" ? "original" : "translated";
      setPreviewMode(nextMode);
      logClient("translate.toggle", {
        previewPath,
        nextMode,
      });
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
      setPreviewMode("translated");
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

  function handleToggleNode(node) {
    logClient("tree.toggle", {
      nodeId: node.id,
      path: node.data?.path || node.data?.name || node.id,
      nextOpen: !node.isOpen,
    });
  }

  function handleExpandTarget() {
    const tree = treeApiRef.current;
    if (!tree) {
      return;
    }

    const result = expandFromDeepestVisibleLevel(tree);
    scheduleTreeBrowseDepthSync();
    logClient("tree.expand_level", {
      fromDepth: result.fromDepth,
      toDepth: result.toDepth,
      affectedCount: result.affectedCount,
      maxDepth: Math.max(1, treeDepthControl.maxExpandDepth + 1),
    });
  }

  function handleCollapseTarget() {
    const tree = treeApiRef.current;
    if (!tree) {
      return;
    }

    const result = collapseFromDeepestVisibleLevel(tree);
    scheduleTreeBrowseDepthSync();
    logClient("tree.collapse_level", {
      fromDepth: result.fromDepth,
      toDepth: result.toDepth,
      affectedCount: result.affectedCount,
    });
  }

  function handleExpandAll() {
    const tree = treeApiRef.current;
    if (!tree) {
      return;
    }

    const fromDepth = getVisibleTreeDepth(tree);
    tree.openAll();
    scheduleTreeBrowseDepthSync();
    logClient("tree.expand_all", {
      fromDepth,
      toDepth: getVisibleTreeDepth(tree),
    });
  }

  function handleToggleTreeCollapsed() {
    setIsTreeCollapsed((currentValue) => {
      const nextValue = !currentValue;
      logClient("tree.panel.collapse.toggle", { collapsed: nextValue });
      return nextValue;
    });
  }

  function handleMermaidDirectionChange(nextDirection) {
    setMermaidDirection(nextDirection);
    logClient("preview.direction.change", {
      direction: nextDirection,
      previewPath,
    });
  }

  function handleToggleChangesOnly() {
    setIsChangesOnly((currentValue) => {
      const nextValue = !currentValue;
      logClient("tree.filter.git_status.toggle", {
        enabled: nextValue,
      });
      return nextValue;
    });
  }

  function handleTreeToggleStateChange(nodeId) {
    const tree = treeApiRef.current;
    const isOpen = tree?.isOpen(nodeId) || false;
    scheduleTreeBrowseDepthSync();
    logClient("tree.toggle.applied", {
      nodeId,
      isOpen,
      depth: tree ? getVisibleTreeDepth(tree) : 0,
    });
  }

  function handlePanelResizeStart(event) {
    if (isTreeCollapsed) {
      return;
    }

    resizeStateRef.current = {
      startX: event.clientX,
      startWidth: treePanelWidth,
    };
    setIsResizingPanels(true);
    logClient("panel.resize.start", { treePanelWidth });
  }

  const workspacePanelStyle = isTreeCollapsed
    ? undefined
    : { gridTemplateColumns: `${treePanelWidth}px ${panelDividerWidth}px minmax(0, 1fr)` };

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
      <div
        ref={workspacePanelsRef}
        className={`workspace-panels ${isTreeCollapsed ? "tree-collapsed" : ""} ${isResizingPanels ? "is-resizing" : ""}`}
        style={workspacePanelStyle}
      >
        <RepoTreePanel
          selectedRepoRoot={selectedRepoRoot}
          repoRoots={repoRoots}
          selectedRepoOption={selectedRepoOption}
          isRefreshingRoots={isRefreshingRoots}
          isLoadingTree={isLoadingTree}
          treePayload={treePayload}
          visibleTreeNodes={visibleTreeNodes}
          loadError={loadError}
          searchTerm={searchTerm}
          isChangesOnly={isChangesOnly}
          treeBrowseDepth={treeBrowseDepth}
          treeDepthControl={treeDepthControl}
          treeViewportHeight={treeViewportHeight}
          treeApiRef={treeApiRef}
          treeViewportRef={treeViewportRef}
          onRepoRootChange={handleRepoRootChange}
          onRefreshRepoRoots={refreshRepoRoots}
          onSearchTermChange={setSearchTerm}
          onExpandTarget={handleExpandTarget}
          onCollapseTarget={handleCollapseTarget}
          onExpandAll={handleExpandAll}
          onRememberActiveNode={rememberActiveNode}
          onModuleActivate={handleModuleActivate}
          onToggleNode={handleToggleNode}
          onTreeToggleStateChange={handleTreeToggleStateChange}
          onToggleChangesOnly={handleToggleChangesOnly}
          isCollapsed={isTreeCollapsed}
          onToggleCollapsed={handleToggleTreeCollapsed}
        />

        {!isTreeCollapsed ? (
          <div
            className="panel-divider"
            role="separator"
            aria-orientation="vertical"
            aria-label="resize panels"
            onPointerDown={handlePanelResizeStart}
          />
        ) : null}

        <PreviewPanel
          previewText={previewText}
          displayedPreviewText={orientedPreviewText}
          previewPath={previewPath}
          copyStatus={copyStatus}
          translationError={translationError}
          translationModel={translationModel}
          isTranslating={isTranslating}
          isShowingTranslated={previewMode === "translated" && Boolean(translationText)}
          mermaidDirection={mermaidDirection}
          onMermaidDirectionChange={handleMermaidDirectionChange}
          onTranslate={() => void handleTranslatePreview()}
        />
      </div>
    </main>
  );
}
