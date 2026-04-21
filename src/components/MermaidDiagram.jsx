import { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";

let mermaidInitialized = false;
let mermaidRenderId = 0;
const MIN_VIEW_SCALE = 0.1;
const MAX_VIEW_SCALE = 12;
const PAN_CLICK_SUPPRESS_DISTANCE = 4;
const RIGHT_CLEAR_DOUBLE_CLICK_WINDOW_MS = 360;
const RIGHT_CLEAR_DOUBLE_CLICK_DISTANCE = 12;

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

function getViewportContentWidth(viewportElement) {
  if (!viewportElement) {
    return 0;
  }

  const styles = window.getComputedStyle(viewportElement);
  const horizontalPadding = Number.parseFloat(styles.paddingLeft || "0")
    + Number.parseFloat(styles.paddingRight || "0");
  return Math.max(0, viewportElement.clientWidth - horizontalPadding);
}

function getDiagramContentSize(containerElement) {
  if (!containerElement) {
    return null;
  }

  const layoutWidth = Math.max(
    containerElement.scrollWidth || 0,
    containerElement.clientWidth || 0,
    containerElement.offsetWidth || 0,
  );
  const layoutHeight = Math.max(
    containerElement.scrollHeight || 0,
    containerElement.clientHeight || 0,
    containerElement.offsetHeight || 0,
  );
  if (layoutWidth > 0 && layoutHeight > 0) {
    return { width: layoutWidth, height: layoutHeight };
  }

  const svgElement = containerElement.querySelector("svg");
  if (!svgElement) {
    return null;
  }

  const viewBox = svgElement.viewBox?.baseVal;
  if (viewBox && viewBox.width > 0 && viewBox.height > 0) {
    return { width: viewBox.width, height: viewBox.height };
  }

  const bounds = typeof svgElement.getBBox === "function" ? svgElement.getBBox() : null;
  if (bounds && bounds.width > 0 && bounds.height > 0) {
    return { width: bounds.width, height: bounds.height };
  }

  const widthAttr = Number.parseFloat(svgElement.getAttribute("width") || "0");
  const heightAttr = Number.parseFloat(svgElement.getAttribute("height") || "0");
  if (widthAttr > 0 && heightAttr > 0) {
    return { width: widthAttr, height: heightAttr };
  }

  return null;
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
  const panStateRef = useRef({
    startX: 0,
    startY: 0,
    originX: 0,
    originY: 0,
    hasMoved: false,
  });
  const hasUserAdjustedViewRef = useRef(false);
  const suppressNextClickRef = useRef(false);
  const rightClickClearStateRef = useRef({ at: 0, x: 0, y: 0 });
  const [renderError, setRenderError] = useState("");
  const [selectedOverlayRect, setSelectedOverlayRect] = useState(null);
  const [isPanning, setIsPanning] = useState(false);
  const [viewTransform, setViewTransform] = useState({ scale: 1, x: 0, y: 0 });
  const interactiveSymbolIdsRef = useRef(new Set());

  function resetRightClickClearState() {
    rightClickClearStateRef.current = { at: 0, x: 0, y: 0 };
  }

  useEffect(() => {
    hasUserAdjustedViewRef.current = false;
    setViewTransform({ scale: 1, x: 0, y: 0 });
    setIsPanning(false);
  }, [chart]);

  useEffect(() => {
    const viewportElement = viewportRef.current;
    const container = containerRef.current;
    if (!viewportElement || !container) {
      return undefined;
    }

    let animationFrameId = 0;
    const resizeObserver = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => {
          if (hasUserAdjustedViewRef.current) {
            return;
          }
          if (animationFrameId) {
            window.cancelAnimationFrame(animationFrameId);
          }
          animationFrameId = window.requestAnimationFrame(applyFitWidthTransform);
        })
      : null;

    function applyFitWidthTransform() {
      const nextViewport = viewportRef.current;
      const nextContainer = containerRef.current;
      if (!nextViewport || !nextContainer || hasUserAdjustedViewRef.current) {
        return;
      }

      const viewportWidth = getViewportContentWidth(nextViewport);
      const contentSize = getDiagramContentSize(nextContainer);
      if (!contentSize || viewportWidth <= 0 || contentSize.width <= 0) {
        return;
      }

      const nextTransform = {
        scale: viewportWidth / contentSize.width,
        x: 0,
        y: 0,
      };

      setViewTransform((current) => {
        const scaleUnchanged = Math.abs(current.scale - nextTransform.scale) < 0.0001;
        const xUnchanged = Math.abs(current.x - nextTransform.x) < 0.5;
        const yUnchanged = Math.abs(current.y - nextTransform.y) < 0.5;
        return scaleUnchanged && xUnchanged && yUnchanged ? current : nextTransform;
      });
    }

    resizeObserver?.observe(viewportElement);
    resizeObserver?.observe(container);
    window.addEventListener("resize", applyFitWidthTransform);

    applyFitWidthTransform();

    return () => {
      if (animationFrameId) {
        window.cancelAnimationFrame(animationFrameId);
      }
      resizeObserver?.disconnect();
      window.removeEventListener("resize", applyFitWidthTransform);
    };
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
        window.requestAnimationFrame(() => {
          if (!cancelled && !hasUserAdjustedViewRef.current) {
            const viewportWidth = getViewportContentWidth(viewportRef.current);
            const contentSize = getDiagramContentSize(containerRef.current);
            if (viewportWidth > 0 && contentSize?.width > 0) {
              setViewTransform({
                scale: viewportWidth / contentSize.width,
                x: 0,
                y: 0,
              });
            }
          }
        });

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

      if (suppressNextClickRef.current) {
        suppressNextClickRef.current = false;
        return;
      }

      const nodeElement = event.target instanceof Element
        ? event.target.closest("g.node")
        : null;

      if (!nodeElement || !container.contains(nodeElement)) {
        return;
      }

      const symbolId = nodeElement.dataset.symbolId || parseFlowchartSymbolId(nodeElement.id);
      if (!interactiveSymbolIdsRef.current.has(symbolId)) {
        return;
      }

      resetRightClickClearState();
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
      if (
        !panStateRef.current.hasMoved
        && Math.hypot(deltaX, deltaY) >= PAN_CLICK_SUPPRESS_DISTANCE
      ) {
        panStateRef.current.hasMoved = true;
      }
      setViewTransform((current) => ({
        ...current,
        x: panStateRef.current.originX + deltaX,
        y: panStateRef.current.originY + deltaY,
      }));
    }

    function handlePointerUp() {
      if (panStateRef.current.hasMoved) {
        suppressNextClickRef.current = true;
      }
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
    hasUserAdjustedViewRef.current = true;

    const viewportRect = viewportRef.current.getBoundingClientRect();
    const pointerX = event.clientX - viewportRect.left;
    const pointerY = event.clientY - viewportRect.top;

    setViewTransform((current) => {
      const zoomFactor = Math.exp(-event.deltaY * 0.0015);
      const nextScale = Math.min(MAX_VIEW_SCALE, Math.max(MIN_VIEW_SCALE, current.scale * zoomFactor));
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
    if (event.button === 2) {
      if (!isInteractive || typeof onSymbolSelect !== "function") {
        return;
      }

      const container = containerRef.current;
      const nodeElement = event.target instanceof Element
        ? event.target.closest("g.node")
        : null;

      if (nodeElement && container?.contains(nodeElement)) {
        resetRightClickClearState();
        return;
      }

      event.preventDefault();

      const previous = rightClickClearStateRef.current;
      const deltaTime = event.timeStamp - previous.at;
      const deltaDistance = Math.hypot(event.clientX - previous.x, event.clientY - previous.y);
      const isRightDoubleClick = previous.at > 0
        && deltaTime <= RIGHT_CLEAR_DOUBLE_CLICK_WINDOW_MS
        && deltaDistance <= RIGHT_CLEAR_DOUBLE_CLICK_DISTANCE;

      if (isRightDoubleClick) {
        resetRightClickClearState();
        onSymbolSelect("");
        return;
      }

      rightClickClearStateRef.current = {
        at: event.timeStamp,
        x: event.clientX,
        y: event.clientY,
      };
      return;
    }

    if (event.button !== 0) {
      return;
    }

    hasUserAdjustedViewRef.current = true;
    panStateRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      originX: viewTransform.x,
      originY: viewTransform.y,
      hasMoved: false,
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
      onContextMenu={(event) => {
        event.preventDefault();
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
