import { useEffect, useMemo, useRef, useState } from "react";

import PreviewPanel from "./components/PreviewPanel";
import RepoTreePanel from "./components/RepoTreePanel";
import { useTreeViewportHeight } from "./hooks/useTreeViewportHeight";
import { TRANSLATE_API_BASE_URL, copyText, fetchJson, logClient } from "./lib/api";
import { collectInternalNodeDepths } from "./lib/tree";

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
  const [previewMode, setPreviewMode] = useState("original");
  const [isBooting, setIsBooting] = useState(true);
  const [isRefreshingRoots, setIsRefreshingRoots] = useState(false);
  const [isLoadingTree, setIsLoadingTree] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const [treeExpandDepth, setTreeExpandDepth] = useState(0);
  const translationRequestIdRef = useRef(0);
  const treeApiRef = useRef(null);
  const treeViewportRef = useRef(null);

  const selectedRepoOption = useMemo(
    () => repoRoots.find((item) => item.path === selectedRepoRoot) ?? null,
    [repoRoots, selectedRepoRoot],
  );
  const displayedPreviewText = useMemo(() => (
    previewMode === "translated" && translationText ? translationText : previewText
  ), [previewMode, previewText, translationText]);
  const treeDepthControl = useMemo(
    () => collectInternalNodeDepths(treePayload?.nodes || []),
    [treePayload],
  );
  const treeViewportHeight = useTreeViewportHeight(treeViewportRef, [isBooting, treePayload]);

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
        <RepoTreePanel
          selectedRepoRoot={selectedRepoRoot}
          repoRoots={repoRoots}
          selectedRepoOption={selectedRepoOption}
          isRefreshingRoots={isRefreshingRoots}
          isLoadingTree={isLoadingTree}
          treePayload={treePayload}
          loadError={loadError}
          searchTerm={searchTerm}
          treeExpandDepth={treeExpandDepth}
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
        />

        <PreviewPanel
          previewText={previewText}
          displayedPreviewText={displayedPreviewText}
          previewPath={previewPath}
          copyStatus={copyStatus}
          translationError={translationError}
          translationModel={translationModel}
          isTranslating={isTranslating}
          isShowingTranslated={previewMode === "translated" && Boolean(translationText)}
          onTranslate={() => void handleTranslatePreview()}
        />
      </div>
    </main>
  );
}
