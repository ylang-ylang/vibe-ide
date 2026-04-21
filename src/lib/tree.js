export const KIND_ICON = {
  directory: "D",
  module: "PY",
  file: "F",
};

export function matchNode(node, searchTerm) {
  if (!searchTerm) {
    return false;
  }

  const haystacks = [
    node.data.name,
    node.data.path,
    node.data.summary,
    node.data.symbol_mermaid,
    node.data.symbol_outline_xml,
    node.data.git_status?.title,
  ].filter(Boolean);

  const normalizedTerm = searchTerm.toLowerCase();
  return haystacks.some((value) => String(value).toLowerCase().includes(normalizedTerm));
}

export function filterTreeByGitStatus(nodes) {
  function visit(node) {
    const children = Array.isArray(node.children) ? node.children : [];
    const keptChildren = children.map(visit).filter(Boolean);
    const hasGitStatus = Boolean(node.git_status);

    if (!hasGitStatus && keptChildren.length === 0) {
      return null;
    }

    return {
      ...node,
      children: keptChildren,
    };
  }

  return nodes.map(visit).filter(Boolean);
}

export function collectInternalNodeDepths(nodes) {
  const idsByDepth = [];

  function walk(nodeList, depth) {
    for (const node of nodeList) {
      const children = Array.isArray(node.children) ? node.children : [];
      if (children.length === 0) {
        continue;
      }

      if (!idsByDepth[depth]) {
        idsByDepth[depth] = [];
      }
      idsByDepth[depth].push(node.id);
      walk(children, depth + 1);
    }
  }

  walk(nodes, 0);

  return {
    idsByDepth,
    maxExpandDepth: idsByDepth.length,
  };
}
