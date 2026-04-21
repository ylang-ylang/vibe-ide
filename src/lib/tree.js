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
  ].filter(Boolean);

  const normalizedTerm = searchTerm.toLowerCase();
  return haystacks.some((value) => String(value).toLowerCase().includes(normalizedTerm));
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
