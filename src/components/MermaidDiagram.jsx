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
  const viewportRef = useRef(null);
  const containerRef = useRef(null);
  const panStateRef = useRef({ startX: 0, startY: 0, originX: 0, originY: 0 });
  const [renderError, setRenderError] = useState("");
  const [selectedOverlayRect, setSelectedOverlayRect] = useState(null);
  const [isPanning, setIsPanning] = useState(false);
  const [viewTransform, setViewTransform] = useState({ scale: 1, x: 0, y: 0 });
  const interactiveSymbolIdsRef = useRef(new Set());

  useEffect(() => {
    setViewTransform({ scale: 1, x: 0, y: 0 });
    setIsPanning(false);
  }, [chart]);

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

    const hasActiveSelection = isInteractive && Boolean(selectedSymbolId);
    for (const nodeElement of container.querySelectorAll("g.node")) {
      const isSelected = isInteractive
        && Boolean(selectedSymbolId)
        && nodeElement.dataset.symbolId === selectedSymbolId;
      nodeElement.classList.toggle("selected-symbol-node", isSelected);
      nodeElement.classList.toggle(
        "interactive-symbol-faded",
        hasActiveSelection
          && Boolean(nodeElement.dataset.symbolId)
          && nodeElement.dataset.symbolId !== selectedSymbolId,
      );
      nodeElement.classList.toggle("interactive-symbol-disabled", !isInteractive);
    }
  }, [selectedSymbolId, isInteractive, chart]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !isInteractive || !selectedSymbolId) {
      setSelectedOverlayRect(null);
      return undefined;
    }

    let animationFrameId = 0;
    const resizeObserver = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => {
          if (animationFrameId) {
            window.cancelAnimationFrame(animationFrameId);
          }
          animationFrameId = window.requestAnimationFrame(updateSelectedOverlay);
        })
      : null;

    function updateSelectedOverlay() {
      const selectedNode = container.querySelector(`g.node[data-symbol-id="${selectedSymbolId}"]`);
      if (!selectedNode) {
        setSelectedOverlayRect(null);
        return;
      }

      const viewportRect = viewportRef.current?.getBoundingClientRect();
      if (!viewportRect) {
        setSelectedOverlayRect(null);
        return;
      }

      const nodeRect = selectedNode.getBoundingClientRect();
      const padX = 10;
      const padY = 8;

      setSelectedOverlayRect({
        left: nodeRect.left - viewportRect.left - padX,
        top: nodeRect.top - viewportRect.top - padY,
        width: nodeRect.width + padX * 2,
        height: nodeRect.height + padY * 2,
      });
    }

    updateSelectedOverlay();

    const svgElement = container.querySelector("svg");
    if (resizeObserver) {
      resizeObserver.observe(container);
      if (svgElement) {
        resizeObserver.observe(svgElement);
      }
    }
    window.addEventListener("resize", updateSelectedOverlay);

    return () => {
      if (animationFrameId) {
        window.cancelAnimationFrame(animationFrameId);
      }
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateSelectedOverlay);
    };
  }, [chart, isInteractive, selectedSymbolId, viewTransform]);

  useEffect(() => {
    if (!isPanning) {
      return undefined;
    }

    function handlePointerMove(event) {
      const deltaX = event.clientX - panStateRef.current.startX;
      const deltaY = event.clientY - panStateRef.current.startY;
      setViewTransform((current) => ({
        ...current,
        x: panStateRef.current.originX + deltaX,
        y: panStateRef.current.originY + deltaY,
      }));
    }

    function handlePointerUp() {
      setIsPanning(false);
    }

    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [isPanning]);

  function handleViewportWheel(event) {
    if (!viewportRef.current || !containerRef.current) {
      return;
    }

    event.preventDefault();

    const viewportRect = viewportRef.current.getBoundingClientRect();
    const pointerX = event.clientX - viewportRect.left;
    const pointerY = event.clientY - viewportRect.top;

    setViewTransform((current) => {
      const zoomFactor = Math.exp(-event.deltaY * 0.0015);
      const nextScale = Math.min(4.5, Math.max(0.35, current.scale * zoomFactor));
      if (Math.abs(nextScale - current.scale) < 0.0001) {
        return current;
      }

      const contentX = (pointerX - current.x) / current.scale;
      const contentY = (pointerY - current.y) / current.scale;
      return {
        scale: nextScale,
        x: pointerX - (contentX * nextScale),
        y: pointerY - (contentY * nextScale),
      };
    });
  }

  function handleViewportPointerDown(event) {
    if (event.button !== 1) {
      return;
    }

    event.preventDefault();
    panStateRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      originX: viewTransform.x,
      originY: viewTransform.y,
    };
    setIsPanning(true);
  }

  if (renderError) {
    return (
      <div className="diagram-stage">
        <p className="status error diagram-error">{renderError}</p>
        <pre className="preview-block diagram-fallback">{chart}</pre>
      </div>
    );
  }

  return (
    <div
      ref={viewportRef}
      className={`diagram-stage ${isPanning ? "is-panning" : ""}`}
      onWheel={handleViewportWheel}
      onPointerDown={handleViewportPointerDown}
      onMouseDown={(event) => {
        if (event.button === 1) {
          event.preventDefault();
        }
      }}
      onAuxClick={(event) => {
        if (event.button === 1) {
          event.preventDefault();
        }
      }}
    >
      <div
        className="mermaid-diagram-shell"
        style={{
          transform: `translate(${viewTransform.x}px, ${viewTransform.y}px) scale(${viewTransform.scale})`,
        }}
      >
        <div ref={containerRef} className="mermaid-diagram" />
      </div>
        {selectedOverlayRect ? (
          <div
            className="mermaid-selection-overlay"
            style={{
              left: `${selectedOverlayRect.left}px`,
              top: `${selectedOverlayRect.top}px`,
              width: `${selectedOverlayRect.width}px`,
              height: `${selectedOverlayRect.height}px`,
            }}
          />
        ) : null}
    </div>
  );
}
