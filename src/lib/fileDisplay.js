const LANGUAGE_BY_SUFFIX = {
  ".astro": "astro",
  ".bash": "shellscript",
  ".bat": "bat",
  ".c": "c",
  ".cc": "cpp",
  ".cjs": "javascript",
  ".cmake": "cmake",
  ".cpp": "cpp",
  ".css": "css",
  ".cts": "typescript",
  ".csv": "csv",
  ".diff": "diff",
  ".dockerfile": "dockerfile",
  ".fish": "fish",
  ".go": "go",
  ".gql": "graphql",
  ".graphql": "graphql",
  ".h": "c",
  ".hcl": "hcl",
  ".hh": "cpp",
  ".hpp": "cpp",
  ".htm": "html",
  ".html": "html",
  ".ini": "ini",
  ".java": "java",
  ".js": "javascript",
  ".json": "json",
  ".json5": "json5",
  ".jsonc": "jsonc",
  ".jsx": "jsx",
  ".less": "less",
  ".log": "log",
  ".md": "markdown",
  ".mdx": "mdx",
  ".mermaid": "mermaid",
  ".mjs": "javascript",
  ".mmd": "mermaid",
  ".mts": "typescript",
  ".php": "php",
  ".properties": "properties",
  ".proto": "proto",
  ".ps1": "powershell",
  ".py": "python",
  ".rb": "ruby",
  ".rs": "rust",
  ".rst": "rst",
  ".sass": "sass",
  ".scss": "scss",
  ".sh": "shellscript",
  ".sql": "sql",
  ".svg": "xml",
  ".svelte": "svelte",
  ".styl": "stylus",
  ".tf": "terraform",
  ".tfvars": "terraform",
  ".toml": "toml",
  ".ts": "typescript",
  ".tsv": "tsv",
  ".tsx": "tsx",
  ".vue": "vue",
  ".xml": "xml",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".zsh": "shellscript",
};

const LANGUAGE_BY_SPECIAL_FILENAME = {
  ".bash_profile": "shellscript",
  ".bashrc": "shellscript",
  ".editorconfig": "ini",
  ".envrc": "shellscript",
  ".gitmodules": "ini",
  ".npmrc": "ini",
  ".profile": "shellscript",
  ".zshrc": "shellscript",
  "cmakelists.txt": "cmake",
  "codeowners": "codeowners",
  "containerfile": "dockerfile",
  "dockerfile": "dockerfile",
  "gnumakefile": "makefile",
  "jenkinsfile": "groovy",
  "justfile": "just",
  "makefile": "makefile",
  "procfile": "shellscript",
};

const OBVIOUS_BINARY_SUFFIXES = new Set([
  ".7z",
  ".a",
  ".avi",
  ".bin",
  ".bmp",
  ".bz2",
  ".class",
  ".dll",
  ".dylib",
  ".eot",
  ".exe",
  ".fbx",
  ".flac",
  ".gif",
  ".glb",
  ".gltf",
  ".gz",
  ".ico",
  ".jpeg",
  ".jpg",
  ".m4a",
  ".mkv",
  ".mov",
  ".mp3",
  ".mp4",
  ".npy",
  ".npz",
  ".obj",
  ".o",
  ".onnx",
  ".otf",
  ".pdf",
  ".png",
  ".pth",
  ".pt",
  ".pyc",
  ".so",
  ".stl",
  ".tar",
  ".tgz",
  ".ttf",
  ".usda",
  ".usdc",
  ".usd",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".xz",
  ".zip",
]);

export function isPythonPath(path) {
  return String(path || "").toLowerCase().endsWith(".py");
}

export function isObviouslyBinaryPath(path) {
  if (!path) {
    return false;
  }

  const normalizedPath = String(path).trim().toLowerCase();
  if (!normalizedPath) {
    return false;
  }

  const fileName = normalizedPath.split("/").at(-1) || "";
  const suffixMatch = /\.[^./]+$/.exec(fileName);
  const suffix = suffixMatch?.[0] || "";
  return OBVIOUS_BINARY_SUFFIXES.has(suffix);
}

export function resolveCodeLanguageFromPath(path) {
  if (!path) {
    return null;
  }

  const normalizedPath = String(path).trim();
  if (!normalizedPath) {
    return null;
  }

  const fileName = normalizedPath.split("/").at(-1)?.toLowerCase() || "";
  if (LANGUAGE_BY_SPECIAL_FILENAME[fileName]) {
    return LANGUAGE_BY_SPECIAL_FILENAME[fileName];
  }
  if (fileName.startsWith(".env")) {
    return "dotenv";
  }

  const suffixMatch = /\.[^./]+$/.exec(fileName);
  const suffix = suffixMatch?.[0] || "";
  return LANGUAGE_BY_SUFFIX[suffix] || null;
}
