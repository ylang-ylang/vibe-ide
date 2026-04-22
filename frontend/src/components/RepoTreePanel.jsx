import { Tree } from "react-arborist";

import { KIND_ICON, matchNode } from "../lib/tree";

export default function RepoTreePanel({
  selectedRepoRoot,
  repoRoots,
  selectedRepoOption,
  isLoadingTree,
  treePayload,
  visibleTreeNodes,
  loadError,
  searchTerm,
  isChangesOnly,
  treeBrowseDepth,
  treeDepthControl,
  treeViewportHeight,
  treeApiRef,
  treeViewportRef,
  onRepoRootChange,
  onSearchTermChange,
  onExpandTarget,
  onCollapseTarget,
  onRememberActiveNode,
  onPreviewNodeActivate,
  onToggleNode,
  onTreeToggleStateChange,
  onToggleChangesOnly,
  isCollapsed,
  onToggleCollapsed,
}) {
  function NodeRenderer({ node, style }) {
    const isBranch = !node.isLeaf;
    const icon = KIND_ICON[node.data.kind] ?? "?";
    const gitStatus = node.data.git_status || null;
    const gitStatusKind = gitStatus?.display_kind || gitStatus?.kind || null;
    const isGitIgnored = Boolean(node.data.git_ignored);
    const isDirectory = node.data.kind === "directory";
    const displayLabel = isDirectory ? `${node.data.name}/` : node.data.name;

    function handleActivate() {
      node.select();
      onRememberActiveNode(node, "click");

      if (node.data.kind === "file") {
        void onPreviewNodeActivate(node);
        return;
      }

      if (isBranch) {
        onToggleNode(node);
        node.toggle();
      }
    }

    return (
      <div
        style={style}
        className={`tree-row ${node.isSelected ? "selected" : ""} ${isGitIgnored ? "tree-row-ignored" : ""}`}
        onClick={handleActivate}
        role="treeitem"
        aria-label={node.data.name}
      >
        <div className="tree-row-content" style={{ paddingLeft: `${node.level * 14 + 6}px` }}>
          <button
            type="button"
            className={`toggle ${isBranch ? "" : "toggle-leaf"} ${node.isOpen ? "is-open" : ""}`}
            onClick={(event) => {
              event.stopPropagation();
              if (isBranch) {
                onRememberActiveNode(node, "toggle");
                onToggleNode(node);
                node.toggle();
              }
            }}
            aria-label={isBranch ? (node.isOpen ? "collapse directory" : "expand directory") : undefined}
          >
            {isBranch ? <span className="toggle-chevron" aria-hidden="true" /> : null}
          </button>
          <span className={`kind kind-${node.data.kind} ${isGitIgnored ? "kind-ignored" : ""}`}>{icon}</span>
          <span className={`label ${isDirectory ? "label-directory" : ""} ${isGitIgnored ? "label-ignored" : ""}`}>{displayLabel}</span>
          {gitStatus ? (
            <span
              className={`git-status-badge git-status-${gitStatusKind} git-status-scope-${gitStatus.scope}`}
              title={gitStatus.title}
            >
              {gitStatus.code}
            </span>
          ) : null}
        </div>
      </div>
    );
  }

  if (isCollapsed) {
    return (
      <section className="panel tree-panel tree-panel-collapsed">
        <div className="tree-collapsed-shell">
          <span className="tree-collapsed-label">tree</span>
          {selectedRepoOption ? (
            <span className="tree-collapsed-indicator" title={selectedRepoOption.label} />
          ) : null}
          <button
            type="button"
            className="action-button tree-collapse-button"
            onClick={onToggleCollapsed}
          >
            open
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="panel tree-panel">
      <div className="strip controls-strip">
        <div className="control-group repo-root-control">
          <label htmlFor="repo-root-select">repo root</label>
          <select
            id="repo-root-select"
            value={selectedRepoRoot}
            onChange={(event) => void onRepoRootChange(event.target.value)}
          >
            <option value="">select one repo under home</option>
            {repoRoots.map((item) => (
              <option key={item.path} value={item.path}>
                {item.label}
              </option>
            ))}
          </select>
        </div>

        <div className="control-group search-control">
          <input
            type="search"
            value={searchTerm}
            onChange={(event) => onSearchTermChange(event.target.value)}
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
                ? `${treePayload.meta.python_files} py files · deepest ${treeBrowseDepth}/${Math.max(1, treeDepthControl.maxExpandDepth + 1)}`
                : ""}
          </span>
          <div className="action-button-group" role="group" aria-label="tree depth actions">
            <button
              type="button"
              className="action-button"
              onClick={onExpandTarget}
              disabled={!treePayload}
            >
              expand
            </button>
            <button
              type="button"
              className="action-button"
              onClick={onCollapseTarget}
              disabled={!treePayload}
            >
              collapse
            </button>
          </div>
          <button
            type="button"
            className={`action-button ${isChangesOnly ? "is-active" : ""}`}
            onClick={onToggleChangesOnly}
            disabled={!treePayload}
            title="show only nodes with git status and their parent folders"
          >
            changes only
          </button>
        </div>
      </div>

      {loadError ? <div className="error-banner">{loadError}</div> : null}

      <div className="tree-frame">
        <div ref={treeViewportRef} className="tree-viewport">
          {treePayload ? (
            treeViewportHeight > 0 ? (
              visibleTreeNodes.length > 0 ? (
                <Tree
                  ref={treeApiRef}
                  data={visibleTreeNodes}
                  openByDefault={false}
                  onToggle={onTreeToggleStateChange}
                  rowHeight={32}
                  indent={14}
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
                <div className="empty-state">
                  {isChangesOnly ? "no git changes under selected repo root" : "no tree nodes to display"}
                </div>
              )
            ) : (
              <div className="empty-state">measuring tree viewport...</div>
            )
          ) : (
            <div className="empty-state">choose one repo root under your home directory</div>
          )}
        </div>
      </div>
    </section>
  );
}
