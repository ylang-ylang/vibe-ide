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

export default function MermaidDiagram({ chart }) {
  const containerRef = useRef(null);
  const [renderError, setRenderError] = useState("");

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
  }, [chart]);

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
