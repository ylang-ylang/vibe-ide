const SHIKI_THEME = "dark-plus";
const DEFAULT_LANGUAGE = null;
const LANGUAGE_MODULES = import.meta.glob("../../node_modules/@shikijs/langs/dist/*.mjs");

let highlighterPromise = null;
const loadedLanguages = new Set();

function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = Promise.all([
      import("@shikijs/core"),
      import("@shikijs/engine-javascript"),
      import("@shikijs/themes/dark-plus"),
    ]).then(([
      { createHighlighterCore },
      { createJavaScriptRegexEngine },
      { default: darkPlusTheme },
    ]) => createHighlighterCore({
      engine: createJavaScriptRegexEngine(),
      themes: [darkPlusTheme],
      langs: [],
    })).catch((error) => {
      highlighterPromise = null;
      throw error;
    });
  }

  return highlighterPromise;
}

async function ensureLanguageLoaded(highlighter, language) {
  const resolvedLanguage = normalizeLanguage(language);
  const loadLanguage = resolvedLanguage
    ? LANGUAGE_MODULES[`../../node_modules/@shikijs/langs/dist/${resolvedLanguage}.mjs`]
    : null;
  if (loadedLanguages.has(resolvedLanguage)) {
    return resolvedLanguage;
  }

  if (!resolvedLanguage || !loadLanguage) {
    return null;
  }

  const languageDefinition = (await loadLanguage()).default;
  await highlighter.loadLanguage(languageDefinition);
  loadedLanguages.add(resolvedLanguage);
  return resolvedLanguage;
}

function normalizeLanguage(language) {
  if (!language) {
    return null;
  }

  const normalizedLanguage = String(language).trim().toLowerCase();
  return normalizedLanguage || null;
}

function buildTokenStyle(token) {
  const style = {};
  const fontStyle = token.fontStyle || 0;

  if (token.color) {
    style.color = token.color;
  }
  if (fontStyle & 1) {
    style.fontStyle = "italic";
  }
  if (fontStyle & 2) {
    style.fontWeight = "700";
  }

  const textDecorations = [];
  if (fontStyle & 4) {
    textDecorations.push("underline");
  }
  if (fontStyle & 8) {
    textDecorations.push("line-through");
  }
  if (textDecorations.length > 0) {
    style.textDecoration = textDecorations.join(" ");
  }

  return style;
}

function buildPlainTokens(text, rowId) {
  return [{ id: `${rowId}-token-0`, content: text || " ", style: null }];
}

export async function highlightCodeRows(rows, language = DEFAULT_LANGUAGE) {
  if (!rows.length) {
    return [];
  }

  const highlighter = await getHighlighter();
  const resolvedLanguage = await ensureLanguageLoaded(highlighter, language);
  if (!resolvedLanguage) {
    return buildPlainHighlightedRows(rows);
  }

  const code = rows.map((row) => row.text || "").join("\n");
  const highlighted = highlighter.codeToTokens(code, {
    lang: resolvedLanguage,
    theme: SHIKI_THEME,
  });

  return rows.map((row, index) => {
    const lineTokens = highlighted.tokens[index] || [];
    return {
      ...row,
      tokens: lineTokens.length > 0
        ? lineTokens.map((token, tokenIndex) => ({
            id: `${row.id}-token-${tokenIndex}`,
            content: token.content || " ",
            style: buildTokenStyle(token),
          }))
        : buildPlainTokens(row.text, row.id),
    };
  });
}

export function buildPlainHighlightedRows(rows) {
  return rows.map((row) => ({
    ...row,
    tokens: buildPlainTokens(row.text, row.id),
  }));
}
