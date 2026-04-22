function resolveTranslateApiBaseUrl() {
  const override = import.meta.env.VITE_TRANSLATE_API_BASE_URL;
  if (override) {
    return override.replace(/\/$/, "");
  }

  return "/translate-api";
}

export const TRANSLATE_API_BASE_URL = resolveTranslateApiBaseUrl();

export function logClient(event, payload = {}) {
  console.info(`[repo-symbol-tree] ${event}`, payload);
}

export async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the legacy copy path below
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  textarea.style.left = "-1000px";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  try {
    return document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }
}

export async function fetchJson(path, options = undefined) {
  const method = options?.method || "GET";
  logClient("http.request", { method, path });

  let response;
  try {
    response = await fetch(path, options);
  } catch (error) {
    if (typeof path === "string" && path.startsWith(TRANSLATE_API_BASE_URL)) {
      throw new Error(
        "cannot reach local translator through the same-origin proxy. restart the frontend server and check the translator process.",
      );
    }
    throw error instanceof Error ? error : new Error(String(error));
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  logClient("http.response", {
    method,
    path,
    status: response.status,
    ok: response.ok,
  });

  if (!response.ok) {
    const errorMessage = payload?.error || `${response.status} ${response.statusText}`;
    throw new Error(errorMessage);
  }

  return payload;
}
