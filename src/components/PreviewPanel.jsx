import { useEffect, useRef, useState } from "react";

import CodeBlockView from "./CodeBlockView";
import MermaidDiagram from "./MermaidDiagram";

function CopyStatus({ copyStatus }) {
  if (!copyStatus) {
    return <span className="status muted">click one file to preview source; `.py` also shows Mermaid + XML outline</span>;
  }

  return <span className={`status ${copyStatus.kind}`}>{copyStatus.message}</span>;
}

function getTranslateButtonLabel({ isTranslating, isShowingTranslated, translationModel }) {
  if (isTranslating) {
    return "translating...";
  }
  if (isShowingTranslated) {
    return "show original";
  }
  if (translationModel) {
    return "show translated";
  }
  return "translate";
}

function getTranslationStatus({ isTranslating, isShowingTranslated, translationError, translationModel }) {
  if (translationError) {
    return "translation failed";
  }
  if (isTranslating) {
    return "translating current Mermaid through the local proxy";
  }
  if (isShowingTranslated && translationModel) {
    return `translated Mermaid via ${translationModel}`;
  }
  if (translationModel) {
    return `original Mermaid · cached translation via ${translationModel}`;
  }
  return "click translate to replace this Mermaid with the translated version";
}

export default function PreviewPanel({
  previewText,
  displayedPreviewText,
  previewPath,
  previewSourceLanguage,
  previewContentKind,
  rawSourceCodeRows,
  selectedSymbolCodeRows,
  previewSymbols,
  copyStatus,
  translationError,
  translationModel,
  isTranslating,
  isShowingTranslated,
  isLoadingPythonSymbols,
  mermaidDirection,
  selectedSymbol,
  isMermaidInteractive,
  onMermaidDirectionChange,
  onSymbolSelect,
  onTranslate,
}) {
  const previewSplitRef = useRef(null);
  const previewResizeStateRef = useRef({ startY: 0, startRatio: 0.5 });
  const previousShowCodePanelRef = useRef(false);
  const previousPreviewPathRef = useRef("");
  const [diagramSplitRatio, setDiagramSplitRatio] = useState(0.5);
  const [isResizingPreviewPanels, setIsResizingPreviewPanels] = useState(false);
  const buttonLabel = getTranslateButtonLabel({
    isTranslating,
    isShowingTranslated,
    translationModel,
  });
  const translationStatus = getTranslationStatus({
    isTranslating,
    isShowingTranslated,
    translationError,
    translationModel,
  });
  const showSelectedCodePanel = Boolean(selectedSymbol && selectedSymbolCodeRows.length > 0);
  const showMermaidPanel = Boolean(displayedPreviewText);
  const showRawSourcePanel = previewContentKind === "text" && rawSourceCodeRows.length > 0;
  const showBinaryPlaceholder = previewContentKind === "binary";
  const useSplitPreview = showMermaidPanel && showSelectedCodePanel;

  useEffect(() => {
    if (!useSplitPreview) {
      previousShowCodePanelRef.current = false;
      previousPreviewPathRef.current = previewPath || "";
      return;
    }

    if (!previousShowCodePanelRef.current || previousPreviewPathRef.current !== (previewPath || "")) {
      setDiagramSplitRatio(0.5);
    }
    previousShowCodePanelRef.current = true;
    previousPreviewPathRef.current = previewPath || "";
  }, [useSplitPreview, previewPath]);

  useEffect(() => {
    if (!isResizingPreviewPanels) {
      return undefined;
    }

    function handlePointerMove(event) {
      const previewElement = previewSplitRef.current;
      if (!previewElement) {
        return;
      }

      const { height } = previewElement.getBoundingClientRect();
      if (height <= 0) {
        return;
      }

      const deltaY = event.clientY - previewResizeStateRef.current.startY;
      const nextRatio = previewResizeStateRef.current.startRatio + (deltaY / height);
      const clampedRatio = Math.min(0.8, Math.max(0.2, nextRatio));
      setDiagramSplitRatio(clampedRatio);
    }

    function handlePointerUp() {
      setIsResizingPreviewPanels(false);
    }

    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [isResizingPreviewPanels]);

  function handlePreviewDividerPointerDown(event) {
    if (!useSplitPreview) {
      return;
    }

    previewResizeStateRef.current = {
      startY: event.clientY,
      startRatio: diagramSplitRatio,
    };
    setIsResizingPreviewPanels(true);
  }

  const previewWorkspaceStyle = useSplitPreview
    ? {
        gridTemplateRows: `minmax(0, ${diagramSplitRatio}fr) 10px minmax(0, ${1 - diagramSplitRatio}fr)`,
      }
    : undefined;

  return (
    <section className="panel preview-panel">
      <div className="strip">
        <div className="strip-left">
          <strong>preview</strong>
          {previewPath ? <span className="preview-path">{previewPath}</span> : null}
        </div>
        <div className="panel-actions">
          <CopyStatus copyStatus={copyStatus} />
          <div className="action-button-group" role="group" aria-label="mermaid direction">
            <button
              type="button"
              className={`action-button ${mermaidDirection === "LR" ? "is-active" : ""}`}
              onClick={() => onMermaidDirectionChange("LR")}
              disabled={!showMermaidPanel}
            >
              LR
            </button>
            <button
              type="button"
              className={`action-button ${mermaidDirection === "TD" ? "is-active" : ""}`}
              onClick={() => onMermaidDirectionChange("TD")}
              disabled={!showMermaidPanel}
            >
              TD
            </button>
          </div>
          <button
            type="button"
            className="action-button"
            onClick={onTranslate}
            disabled={!showMermaidPanel || isTranslating}
          >
            {buttonLabel}
          </button>
        </div>
      </div>

      <div className="preview-content">
        {useSplitPreview ? (
          <div
            ref={previewSplitRef}
            className={`preview-workspace has-code-panel ${isResizingPreviewPanels ? "is-resizing" : ""}`}
            style={previewWorkspaceStyle}
          >
            <section className="preview-section">
              <div className="preview-section-strip">
                <strong>module flowchart</strong>
                <span className={`status ${translationError ? "error" : "muted"}`}>
                  {translationStatus}
                </span>
              </div>

              {translationError ? <div className="error-banner">{translationError}</div> : null}

              <MermaidDiagram
                chart={displayedPreviewText}
                interactiveSymbols={isMermaidInteractive ? previewSymbols : []}
                selectedSymbolId={isMermaidInteractive ? selectedSymbol?.id || "" : ""}
                isInteractive={isMermaidInteractive}
                onSymbolSelect={onSymbolSelect}
              />
            </section>

            <div
              className="preview-divider"
              role="separator"
              aria-orientation="horizontal"
              aria-label="resize preview panels"
              onPointerDown={handlePreviewDividerPointerDown}
            />

            <section className="preview-section">
              <div className="preview-section-strip">
                <div className="strip-left">
                  <strong>selected source</strong>
                  <span className={`symbol-kind-badge symbol-kind-${selectedSymbol.kind}`}>{selectedSymbol.kind}</span>
                  <span className="preview-path">{selectedSymbol.title}</span>
                </div>
                <span className="status muted">
                  lines {selectedSymbol.line}-{selectedSymbol.line_end || selectedSymbol.line}
                </span>
              </div>

              <div className="symbol-detail-card">
                <span className="status muted">{selectedSymbol.summary || "No summary."}</span>
              </div>

              <div className="preview-block symbol-source-block">
                <CodeBlockView rows={selectedSymbolCodeRows} language={previewSourceLanguage} />
              </div>
            </section>
          </div>
        ) : showSelectedCodePanel ? (
          <section className="preview-section preview-section-full">
            <div className="preview-section-strip">
              <div className="strip-left">
                <strong>source preview</strong>
                <span className={`symbol-kind-badge symbol-kind-${selectedSymbol.kind}`}>{selectedSymbol.kind}</span>
                <span className="preview-path">{selectedSymbol.title}</span>
              </div>
              <span className="status muted">
                lines {selectedSymbol.line}-{selectedSymbol.line_end || selectedSymbol.line}
              </span>
            </div>

            <div className="symbol-detail-card">
              <span className="status muted">{selectedSymbol.summary || "No summary."}</span>
            </div>

            <div className="preview-block symbol-source-block">
              <CodeBlockView rows={selectedSymbolCodeRows} language={previewSourceLanguage} />
            </div>
          </section>
        ) : showMermaidPanel ? (
          <section className="preview-section preview-section-full">
            <div className="preview-section-strip">
              <strong>module flowchart</strong>
              <span className={`status ${translationError ? "error" : "muted"}`}>
                {translationStatus}
              </span>
            </div>

            {translationError ? <div className="error-banner">{translationError}</div> : null}

            <div className="symbol-detail-card">
              <span className="status muted">
                {isMermaidInteractive
                  ? "click a Mermaid node to inspect its full source range"
                  : "symbol click inspection is available on the original Mermaid view"}
              </span>
            </div>

            <MermaidDiagram
              chart={displayedPreviewText}
              interactiveSymbols={isMermaidInteractive ? previewSymbols : []}
              selectedSymbolId={isMermaidInteractive ? selectedSymbol?.id || "" : ""}
              isInteractive={isMermaidInteractive}
              onSymbolSelect={onSymbolSelect}
            />
          </section>
        ) : showRawSourcePanel ? (
          <section className="preview-section preview-section-full">
            <div className="preview-section-strip">
              <div className="strip-left">
                <strong>source preview</strong>
                <span className="symbol-kind-badge symbol-kind-file">file</span>
                {previewPath ? <span className="preview-path">{previewPath}</span> : null}
              </div>
              <span className="status muted">
                {isLoadingPythonSymbols ? "loading python symbol preview..." : "raw file content"}
              </span>
            </div>

            <div className="symbol-detail-card">
              <span className="status muted">
                {isLoadingPythonSymbols
                  ? "python source is loaded. semantic preview is being fetched separately."
                  : "frontend-owned source rendering for non-symbol preview."}
              </span>
            </div>

            <div className="preview-block symbol-source-block">
              <CodeBlockView rows={rawSourceCodeRows} language={previewSourceLanguage} />
            </div>
          </section>
        ) : showBinaryPlaceholder ? (
          <section className="preview-section preview-section-full">
            <div className="preview-section-strip">
              <div className="strip-left">
                <strong>preview unavailable</strong>
                <span className="symbol-kind-badge symbol-kind-file">binary</span>
                {previewPath ? <span className="preview-path">{previewPath}</span> : null}
              </div>
            </div>

            <div className="symbol-detail-card">
              <span className="status muted">
                binary / unsupported preview. frontend keeps the UI decision here and does not render file bytes inline.
              </span>
            </div>
          </section>
        ) : (
          <pre className="preview-block">
            click one file node to preview source; `.py` also renders Mermaid
          </pre>
        )}
      </div>
    </section>
  );
}
