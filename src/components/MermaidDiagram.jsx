import { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";

let mermaidInitialized = false;
let mermaidRenderId = 0;

function ensureMermaidInitialized() {
  if (mermaidInitialized) {
    return;
  }

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "loose",
    theme: "base",
    themeVariables: {
      textColor: "#d8e4ef",
      nodeTextColor: "#151b22",
      lineColor: "#86a2be",
      titleColor: "#d8e4ef",
      edgeLabelBackground: "#152130",
      tertiaryColor: "#182332",
      tertiaryTextColor: "#d8e4ef",
    },
    themeCSS: [
      ".symbol-title { font-weight: 700; }",
      ".symbol-doc { font-style: italic; }",
    ].join(" "),
    flowchart: {
      htmlLabels: true,
    },
  });
  mermaidInitialized = true;
}

function nextMermaidRenderId() {
  mermaidRenderId += 1;
  return `repo-symbol-tree-mermaid-${mermaidRenderId}`;
}

function parseFlowchartSymbolId(domId) {
  if (!domId) {
    return "";
  }

  const match = domId.match(/(?:^|-)flowchart-([A-Za-z0-9_]+)-\d+$/);
  return match?.[1] || "";
}

export default function MermaidDiagram({
  chart,
  interactiveSymbols = [],
  selectedSymbolId = "",
  isInteractive = false,
  onSymbolSelect,
}) {
  const containerRef = useRef(null);
  const [renderError, setRenderError] = useState("");
  const interactiveSymbolIdsRef = useRef(new Set());

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }

    const source = chart?.trim();
    container.innerHTML = "";
    setRenderError("");

    if (!source) {
      return undefined;
    }

    ensureMermaidInitialized();

    let cancelled = false;

    async function renderDiagram() {
      try {
        const { svg, bindFunctions } = await mermaid.render(nextMermaidRenderId(), source);
        if (cancelled || !containerRef.current) {
          return;
        }

        containerRef.current.innerHTML = svg;
        bindFunctions?.(containerRef.current);

        const symbolIds = new Set(interactiveSymbols.map((symbol) => symbol.id));
        interactiveSymbolIdsRef.current = symbolIds;

        for (const nodeElement of containerRef.current.querySelectorAll("g.node")) {
          const symbolId = parseFlowchartSymbolId(nodeElement.id);
          if (!symbolIds.has(symbolId)) {
            continue;
          }

          nodeElement.dataset.symbolId = symbolId;
          nodeElement.classList.add("interactive-symbol-node");
        }
      } catch (error) {
        if (!cancelled) {
          setRenderError(error instanceof Error ? error.message : String(error));
        }
      }
    }

    void renderDiagram();

    return () => {
      cancelled = true;
    };
  }, [chart, interactiveSymbols]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }

    function handleClick(event) {
      if (!isInteractive || typeof onSymbolSelect !== "function") {
        return;
      }

      const nodeElement = event.target instanceof Element
        ? event.target.closest("g.node")
        : null;

      if (!nodeElement || !container.contains(nodeElement)) {
        onSymbolSelect("");
        return;
      }

      const symbolId = nodeElement.dataset.symbolId || parseFlowchartSymbolId(nodeElement.id);
      if (!interactiveSymbolIdsRef.current.has(symbolId)) {
        onSymbolSelect("");
        return;
      }

      onSymbolSelect(symbolId);
    }

    container.addEventListener("click", handleClick);
    return () => {
      container.removeEventListener("click", handleClick);
    };
  }, [isInteractive, onSymbolSelect]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    for (const nodeElement of container.querySelectorAll("g.node")) {
      const isSelected = isInteractive
        && Boolean(selectedSymbolId)
        && nodeElement.dataset.symbolId === selectedSymbolId;
      nodeElement.classList.toggle("selected-symbol-node", isSelected);
      nodeElement.classList.toggle("interactive-symbol-disabled", !isInteractive);
    }
  }, [selectedSymbolId, isInteractive, chart]);

  if (renderError) {
    return (
      <div className="diagram-stage">
        <p className="status error diagram-error">{renderError}</p>
        <pre className="preview-block diagram-fallback">{chart}</pre>
      </div>
    );
  }

  return (
    <div className="diagram-stage">
      <div ref={containerRef} className="mermaid-diagram" />
    </div>
  );
}
