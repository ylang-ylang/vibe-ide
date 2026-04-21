import MermaidDiagram from "./MermaidDiagram";

function CopyStatus({ copyStatus }) {
  if (!copyStatus) {
    return <span className="status muted">click one `.py` to preview Mermaid + copy XML outline</span>;
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
  copyStatus,
  translationError,
  translationModel,
  isTranslating,
  isShowingTranslated,
  onTranslate,
}) {
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

  return (
    <section className="panel preview-panel">
      <div className="strip">
        <div className="strip-left">
          <strong>module summary</strong>
          {previewPath ? <span className="preview-path">{previewPath}</span> : null}
        </div>
        <div className="panel-actions">
          <CopyStatus copyStatus={copyStatus} />
          <button
            type="button"
            className="action-button"
            onClick={onTranslate}
            disabled={!previewText || isTranslating}
          >
            {buttonLabel}
          </button>
        </div>
      </div>

      <div className="preview-content">
        <section className="preview-section">
          <div className="preview-section-strip">
            <strong>module flowchart</strong>
            <span className={`status ${translationError ? "error" : "muted"}`}>
              {translationStatus}
            </span>
          </div>

          {translationError ? <div className="error-banner">{translationError}</div> : null}

          {displayedPreviewText ? (
            <MermaidDiagram chart={displayedPreviewText} />
          ) : (
            <pre className="preview-block">
              click one Python module node to render its Mermaid flowchart here
            </pre>
          )}
        </section>
      </div>
    </section>
  );
}
