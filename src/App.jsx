import { useEffect, useMemo, useRef, useState } from "react";

import PreviewPanel from "./components/PreviewPanel";
import RepoTreePanel from "./components/RepoTreePanel";
import { useTreeViewportHeight } from "./hooks/useTreeViewportHeight";
import { TRANSLATE_API_BASE_URL, copyText, fetchJson, logClient } from "./lib/api";
import { buildCodeRowsForSelectedSymbol, buildCodeRowsForWholeFile } from "./lib/codeView";
import { isObviouslyBinaryPath, isPythonPath, resolveCodeLanguageFromPath } from "./lib/fileDisplay";
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
  const [previewContentKind, setPreviewContentKind] = useState("");
  const [previewSourceText, setPreviewSourceText] = useState("");
  const [previewSourceGitInfo, setPreviewSourceGitInfo] = useState({ current: [], deleted: [] });
  const [previewSourceSignature, setPreviewSourceSignature] = useState("");
  const [previewSymbols, setPreviewSymbols] = useState([]);
  const [selectedPreviewSymbolId, setSelectedPreviewSymbolId] = useState("");
  const [copyStatus, setCopyStatus] = useState(null);
  const [translationText, setTranslationText] = useState("");
  const [translationError, setTranslationError] = useState("");
  const [translationModel, setTranslationModel] = useState("");
  const [previewMode, setPreviewMode] = useState("original");
  const [isBooting, setIsBooting] = useState(true);
  const [isLoadingTree, setIsLoadingTree] = useState(false);
  const [isLoadingPythonSymbols, setIsLoadingPythonSymbols] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const [treeBrowseDepth, setTreeBrowseDepth] = useState(0);
  const [isTreeCollapsed, setIsTreeCollapsed] = useState(false);
  const [isChangesOnly, setIsChangesOnly] = useState(false);
  const [mermaidDirection, setMermaidDirection] = useState("LR");
  const [treePanelWidth, setTreePanelWidth] = useState(520);
  const [isResizingPanels, setIsResizingPanels] = useState(false);
  const translationRequestIdRef = useRef(0);
  const previewRequestIdRef = useRef(0);
  const pythonSymbolRequestIdRef = useRef(0);
  const treeWatchRequestIdRef = useRef(0);
  const treeWatchRef = useRef(null);
  const previewWatchRequestIdRef = useRef(0);
  const previewWatchRef = useRef(null);
  const treeViewStateRef = useRef({ openIds: [], selectedId: "" });
  const pendingTreeStateRestoreRef = useRef(false);
  const treeStateRestoreFrameRef = useRef(0);
  const activeTreeNodeIdRef = useRef("");
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
  const previewSourceLanguage = useMemo(
    () => resolveCodeLanguageFromPath(previewPath),
    [previewPath],
  );
  const selectedPreviewSymbol = useMemo(
    () => previewSymbols.find((symbol) => symbol.id === selectedPreviewSymbolId) ?? null,
    [previewSymbols, selectedPreviewSymbolId],
  );
  const rawPreviewCodeRows = useMemo(
    () => buildCodeRowsForWholeFile(previewSourceText, previewSourceGitInfo),
    [previewSourceGitInfo, previewSourceText],
  );
  const selectedPreviewSymbolCodeRows = useMemo(
    () => buildCodeRowsForSelectedSymbol(previewSourceText, previewSourceGitInfo, selectedPreviewSymbol),
    [previewSourceGitInfo, previewSourceText, selectedPreviewSymbol],
  );
  const isMermaidInteractive = previewMode === "original" && previewSymbols.length > 0;

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
    if (!pendingTreeStateRestoreRef.current || !treePayload || treeViewportHeight <= 0) {
      return undefined;
    }

    if (treeStateRestoreFrameRef.current) {
      window.cancelAnimationFrame(treeStateRestoreFrameRef.current);
    }

    treeStateRestoreFrameRef.current = window.requestAnimationFrame(() => {
      treeStateRestoreFrameRef.current = 0;
      const tree = treeApiRef.current;
      if (!tree) {
        return;
      }

      for (const openId of treeViewStateRef.current.openIds) {
        const targetNode = tree.get(openId);
        if (targetNode?.isInternal && !targetNode.isOpen) {
          tree.open(openId);
        }
      }

      if (treeViewStateRef.current.selectedId && tree.get(treeViewStateRef.current.selectedId)) {
        tree.select(treeViewStateRef.current.selectedId, { focus: false });
      }

      pendingTreeStateRestoreRef.current = false;
      scheduleTreeBrowseDepthSync();
    });

    return () => {
      if (treeStateRestoreFrameRef.current) {
        window.cancelAnimationFrame(treeStateRestoreFrameRef.current);
        treeStateRestoreFrameRef.current = 0;
      }
    };
  }, [treePayload, visibleTreeNodes, treeViewportHeight]);

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

  function stopTreeWatch() {
    treeWatchRequestIdRef.current += 1;
    if (!treeWatchRef.current) {
      return;
    }
    treeWatchRef.current.close();
    treeWatchRef.current = null;
  }

  function resetTreeViewState() {
    treeViewStateRef.current = { openIds: [], selectedId: "" };
    pendingTreeStateRestoreRef.current = false;
    activeTreeNodeIdRef.current = "";
    if (treeStateRestoreFrameRef.current) {
      window.cancelAnimationFrame(treeStateRestoreFrameRef.current);
      treeStateRestoreFrameRef.current = 0;
    }
  }

  function captureTreeViewState() {
    const tree = treeApiRef.current;
    if (!tree) {
      treeViewStateRef.current = {
        ...treeViewStateRef.current,
        selectedId: activeTreeNodeIdRef.current || treeViewStateRef.current.selectedId,
      };
      return;
    }

    const openIds = tree.visibleNodes
      .filter((treeNode) => treeNode.isInternal && treeNode.isOpen)
      .map((treeNode) => treeNode.id);
    const selectedId = tree.selectedNodes?.[0]?.id || activeTreeNodeIdRef.current || "";
    treeViewStateRef.current = {
      openIds,
      selectedId,
    };
  }

  function applyTreePayload(
    payload,
    {
      preserveTreeState = false,
      resetBrowseDepth = false,
    } = {},
  ) {
    if (preserveTreeState) {
      captureTreeViewState();
      pendingTreeStateRestoreRef.current = true;
    } else {
      resetTreeViewState();
    }

    setTreePayload(payload);
    if (resetBrowseDepth) {
      setTreeBrowseDepth(0);
    }
  }

  function stopPreviewWatch() {
    previewWatchRequestIdRef.current += 1;
    if (!previewWatchRef.current) {
      return;
    }
    previewWatchRef.current.close();
    previewWatchRef.current = null;
  }

  function cancelPythonSymbolRequest() {
    pythonSymbolRequestIdRef.current += 1;
    setIsLoadingPythonSymbols(false);
  }

  function resetPythonPreviewState() {
    cancelPythonSymbolRequest();
    setPreviewText("");
    setPreviewSymbols([]);
    setSelectedPreviewSymbolId("");
  }

  function clearPreview() {
    stopPreviewWatch();
    resetPythonPreviewState();
    setPreviewPath("");
    setPreviewContentKind("");
    setPreviewSourceText("");
    setPreviewSourceGitInfo({ current: [], deleted: [] });
    setPreviewSourceSignature("");
    setCopyStatus(null);
    resetTranslation();
  }

  function applyRawPreviewPayload(
    payload,
    {
      fallbackPath = "",
      resetTranslatedView = false,
    } = {},
  ) {
    const nextPath = payload.path || fallbackPath;
    const nextContentKind = payload.content_kind || "";
    const nextSourceText = payload.source_text || "";
    const nextSourceGitInfo = payload.source_git_info || { current: [], deleted: [] };
    const nextSourceSignature = payload.source_signature || "";

    if (resetTranslatedView) {
      resetTranslation();
    }

    resetPythonPreviewState();
    setPreviewPath(nextPath);
    setPreviewContentKind(nextContentKind);
    setPreviewSourceText(nextSourceText);
    setPreviewSourceGitInfo(nextSourceGitInfo);
    setPreviewSourceSignature(nextSourceSignature);
  }

  function applyPythonSymbolPayload(payload, { preserveSelectedSymbol = true } = {}) {
    const nextMermaidText = payload.symbol_mermaid || "";
    const nextSymbolNodes = payload.symbol_nodes || [];

    setPreviewText(nextMermaidText);
    setPreviewSymbols(nextSymbolNodes);
    setSelectedPreviewSymbolId((currentSymbolId) => {
      if (preserveSelectedSymbol && nextSymbolNodes.some((symbol) => symbol.id === currentSymbolId)) {
        return currentSymbolId;
      }
      return nextSymbolNodes[0]?.id || "";
    });
  }

  async function loadPythonSymbolPreview({
    repoRoot,
    relativePath,
    preserveSelectedSymbol = true,
    copyOutline = false,
  }) {
    if (!repoRoot || !relativePath || !isPythonPath(relativePath)) {
      return;
    }

    const requestId = pythonSymbolRequestIdRef.current + 1;
    pythonSymbolRequestIdRef.current = requestId;
    setIsLoadingPythonSymbols(true);
    logClient("preview.python_symbol.start", { path: relativePath });

    try {
      const payload = await fetchJson(
        `/api/python-symbol-preview?repo_root=${encodeURIComponent(repoRoot)}&path=${encodeURIComponent(relativePath)}`,
      );
      if (pythonSymbolRequestIdRef.current !== requestId) {
        return;
      }

      applyPythonSymbolPayload(payload, { preserveSelectedSymbol });
      logClient("preview.python_symbol.success", {
        path: relativePath,
        symbolCount: Array.isArray(payload.symbol_nodes) ? payload.symbol_nodes.length : 0,
      });

      if (!copyOutline || !payload.symbol_outline_xml) {
        return;
      }

      try {
        const copied = await copyText(payload.symbol_outline_xml);
        if (!copied) {
          throw new Error("copy returned false");
        }
        if (pythonSymbolRequestIdRef.current === requestId) {
          setCopyStatus({
            kind: "success",
            message: `copied XML outline for ${relativePath.split("/").at(-1)}`,
          });
        }
      } catch {
        if (pythonSymbolRequestIdRef.current === requestId) {
          setCopyStatus({
            kind: "warning",
            message: "Python symbol preview updated, XML outline copy failed",
          });
        }
      }
    } catch (error) {
      if (pythonSymbolRequestIdRef.current !== requestId) {
        return;
      }
      setCopyStatus({
        kind: "warning",
        message: error instanceof Error ? error.message : String(error),
      });
      logClient("preview.python_symbol.error", {
        path: relativePath,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (pythonSymbolRequestIdRef.current === requestId) {
        setIsLoadingPythonSymbols(false);
      }
    }
  }

  async function loadTree(repoRoot, cancelled = false) {
    setIsLoadingTree(true);
    setLoadError("");
    previewRequestIdRef.current += 1;
    logClient("tree.load", { repoRoot });

    try {
      const payload = await fetchJson(`/api/tree?repo_root=${encodeURIComponent(repoRoot)}`);
      if (cancelled) {
        return;
      }
      applyTreePayload(payload, { resetBrowseDepth: true });
      clearPreview();
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
    previewRequestIdRef.current += 1;
    if (!nextRepoRoot) {
      stopTreeWatch();
      setTreePayload(null);
      setTreeBrowseDepth(0);
      resetTreeViewState();
      clearPreview();
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

      applyTreePayload(payload.tree_payload, { resetBrowseDepth: true });
      setSelectedRepoRoot(payload.selected_repo_root);
      clearPreview();
      setCopyStatus({
        kind: "success",
        message: `remembered ${nextRepoRoot.split("/").at(-1)}`,
      });
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
      setTreePayload(null);
    } finally {
      setIsLoadingTree(false);
    }
  }

  async function handlePreviewNodeActivate(node) {
    if (!selectedRepoRoot) {
      return;
    }

    const targetPath = node.data.path || "";

    if (targetPath !== previewPath) {
      stopPreviewWatch();
    }
    const requestId = previewRequestIdRef.current + 1;
    previewRequestIdRef.current = requestId;
    cancelPythonSymbolRequest();
    resetTranslation();
    logClient("preview.activate", {
      nodeId: node.id,
      path: targetPath,
      kind: node.data.kind,
    });

    if (isObviouslyBinaryPath(targetPath)) {
      applyRawPreviewPayload({
        path: targetPath,
        content_kind: "binary",
        source_signature: "",
      }, {
        fallbackPath: targetPath,
      });
      setCopyStatus(null);
      logClient("preview.activate.skip_obvious_binary", {
        path: targetPath,
      });
      return;
    }

    setCopyStatus({
      kind: "muted",
      message: `loading preview for ${node.data.name}...`,
    });

    let payload;
    try {
      payload = await fetchJson(
        `/api/preview?repo_root=${encodeURIComponent(selectedRepoRoot)}&path=${encodeURIComponent(targetPath)}`,
      );
    } catch (error) {
      if (previewRequestIdRef.current !== requestId) {
        return;
      }
      setCopyStatus({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (previewRequestIdRef.current !== requestId) {
      return;
    }

    applyRawPreviewPayload(payload, {
      fallbackPath: targetPath,
    });

    const resolvedPath = payload.path || targetPath;
    if (payload.content_kind !== "text" || !isPythonPath(resolvedPath)) {
      setCopyStatus(null);
      return;
    }

    await loadPythonSymbolPreview({
      repoRoot: selectedRepoRoot,
      relativePath: resolvedPath,
      preserveSelectedSymbol: false,
      copyOutline: true,
    });
  }

  useEffect(() => {
    stopTreeWatch();

    const repoRootPath = treePayload?.meta?.repo_root_path || "";
    const treeSignature = treePayload?.meta?.tree_signature || "";
    if (!selectedRepoRoot || !repoRootPath || repoRootPath !== selectedRepoRoot || !treeSignature) {
      return undefined;
    }

    const watchRequestId = treeWatchRequestIdRef.current + 1;
    treeWatchRequestIdRef.current = watchRequestId;
    const watchUrl = `/api/watch-tree?repo_root=${encodeURIComponent(selectedRepoRoot)}&since_signature=${encodeURIComponent(treeSignature)}`;
    const eventSource = new EventSource(watchUrl);
    treeWatchRef.current = eventSource;
    logClient("tree.watch.start", {
      repoRoot: selectedRepoRoot,
      treeSignature,
    });

    function handleWatchReady(event) {
      if (treeWatchRequestIdRef.current !== watchRequestId) {
        return;
      }
      try {
        const payload = JSON.parse(event.data);
        logClient("tree.watch.ready", payload);
      } catch (error) {
        logClient("tree.watch.ready.parse_error", {
          repoRoot: selectedRepoRoot,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    function handleTreeRefresh(event) {
      if (treeWatchRequestIdRef.current !== watchRequestId) {
        return;
      }

      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch (error) {
        logClient("tree.watch.parse_error", {
          repoRoot: selectedRepoRoot,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      applyTreePayload(payload, {
        preserveTreeState: true,
      });
      logClient("tree.watch.refresh", {
        repoRoot: selectedRepoRoot,
        treeSignature: payload.meta?.tree_signature || "",
      });
    }

    function handleTreeWatchError() {
      if (treeWatchRequestIdRef.current !== watchRequestId) {
        return;
      }
      logClient("tree.watch.connection_error", {
        repoRoot: selectedRepoRoot,
      });
    }

    eventSource.addEventListener("watch_ready", handleWatchReady);
    eventSource.addEventListener("tree", handleTreeRefresh);
    eventSource.onerror = handleTreeWatchError;

    return () => {
      eventSource.removeEventListener("watch_ready", handleWatchReady);
      eventSource.removeEventListener("tree", handleTreeRefresh);
      eventSource.close();
      if (treeWatchRef.current === eventSource) {
        treeWatchRef.current = null;
      }
      logClient("tree.watch.stop", { repoRoot: selectedRepoRoot });
    };
  }, [selectedRepoRoot, treePayload?.meta?.repo_root_path]);

  useEffect(() => {
    stopPreviewWatch();

    if (!selectedRepoRoot || !previewPath || previewContentKind !== "text") {
      return undefined;
    }

    const watchRequestId = previewWatchRequestIdRef.current + 1;
    previewWatchRequestIdRef.current = watchRequestId;
    const watchUrl = `/api/watch-preview?repo_root=${encodeURIComponent(selectedRepoRoot)}&path=${encodeURIComponent(previewPath)}&since_signature=${encodeURIComponent(previewSourceSignature)}`;
    const eventSource = new EventSource(watchUrl);
    previewWatchRef.current = eventSource;
    logClient("preview.watch.start", {
      previewPath,
      sourceSignature: previewSourceSignature,
    });

    function handleWatchReady(event) {
      if (previewWatchRequestIdRef.current !== watchRequestId) {
        return;
      }
      try {
        const payload = JSON.parse(event.data);
        logClient("preview.watch.ready", payload);
      } catch (error) {
        logClient("preview.watch.ready.parse_error", {
          previewPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    async function handleWatchPreview(event) {
      if (previewWatchRequestIdRef.current !== watchRequestId) {
        return;
      }

      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch (error) {
        logClient("preview.watch.parse_error", {
          previewPath,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      applyRawPreviewPayload(payload, {
        fallbackPath: previewPath,
        resetTranslatedView: true,
      });
      setCopyStatus({
        kind: "muted",
        message: `refreshed ${payload.path.split("/").at(-1)} from disk`,
      });
      logClient("preview.watch.refresh", {
        previewPath: payload.path,
        sourceSignature: payload.source_signature || "",
      });

      if (payload.content_kind === "text" && isPythonPath(payload.path)) {
        await loadPythonSymbolPreview({
          repoRoot: selectedRepoRoot,
          relativePath: payload.path,
          preserveSelectedSymbol: true,
          copyOutline: false,
        });
      }
    }

    function handleWatchPreviewError(event) {
      if (previewWatchRequestIdRef.current !== watchRequestId) {
        return;
      }

      let message = "preview watch stopped";
      try {
        const payload = JSON.parse(event.data);
        if (typeof payload.error === "string" && payload.error) {
          message = payload.error;
        }
      } catch {
        // Ignore JSON parse failures for watch error events.
      }

      setCopyStatus({
        kind: "error",
        message,
      });
      logClient("preview.watch.error", {
        previewPath,
        error: message,
      });
    }

    function handleWatchConnectionError() {
      if (previewWatchRequestIdRef.current !== watchRequestId) {
        return;
      }
      logClient("preview.watch.connection_error", { previewPath });
    }

    eventSource.addEventListener("watch_ready", handleWatchReady);
    eventSource.addEventListener("preview", handleWatchPreview);
    eventSource.addEventListener("preview_error", handleWatchPreviewError);
    eventSource.onerror = handleWatchConnectionError;

    return () => {
      eventSource.removeEventListener("watch_ready", handleWatchReady);
      eventSource.removeEventListener("preview", handleWatchPreview);
      eventSource.removeEventListener("preview_error", handleWatchPreviewError);
      eventSource.close();
      if (previewWatchRef.current === eventSource) {
        previewWatchRef.current = null;
      }
      logClient("preview.watch.stop", { previewPath });
    };
  }, [previewContentKind, previewPath, selectedRepoRoot]);

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
    activeTreeNodeIdRef.current = node.id;
    treeViewStateRef.current = {
      ...treeViewStateRef.current,
      selectedId: node.id,
    };
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
    captureTreeViewState();
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
    captureTreeViewState();
    scheduleTreeBrowseDepthSync();
    logClient("tree.collapse_level", {
      fromDepth: result.fromDepth,
      toDepth: result.toDepth,
      affectedCount: result.affectedCount,
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
    captureTreeViewState();
    scheduleTreeBrowseDepthSync();
    logClient("tree.toggle.applied", {
      nodeId,
      isOpen,
      depth: tree ? getVisibleTreeDepth(tree) : 0,
    });
  }

  function handlePreviewSymbolSelect(symbolId) {
    setSelectedPreviewSymbolId(symbolId);
    logClient("preview.symbol.select", {
      previewPath,
      symbolId: symbolId || "",
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
          onSearchTermChange={setSearchTerm}
          onExpandTarget={handleExpandTarget}
          onCollapseTarget={handleCollapseTarget}
          onRememberActiveNode={rememberActiveNode}
          onPreviewNodeActivate={handlePreviewNodeActivate}
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
          previewSourceLanguage={previewSourceLanguage}
          previewContentKind={previewContentKind}
          rawSourceCodeRows={rawPreviewCodeRows}
          selectedSymbolCodeRows={selectedPreviewSymbolCodeRows}
          previewSymbols={previewSymbols}
          selectedSymbol={selectedPreviewSymbol}
          copyStatus={copyStatus}
          translationError={translationError}
          translationModel={translationModel}
          isTranslating={isTranslating}
          isShowingTranslated={previewMode === "translated" && Boolean(translationText)}
          isLoadingPythonSymbols={isLoadingPythonSymbols}
          isMermaidInteractive={isMermaidInteractive}
          mermaidDirection={mermaidDirection}
          onMermaidDirectionChange={handleMermaidDirectionChange}
          onSymbolSelect={handlePreviewSymbolSelect}
          onTranslate={() => void handleTranslatePreview()}
        />
      </div>
    </main>
  );
}
