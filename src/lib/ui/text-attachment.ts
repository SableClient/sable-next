export const MAX_TEXT_ATTACHMENT_BYTES = 2_000_000;

const MIME_LANGUAGES: Record<string, string> = {
  'application/ecmascript': 'javascript',
  'application/javascript': 'javascript',
  'application/json': 'json',
  'application/x-sh': 'bash',
  'application/xhtml+xml': 'html',
  'application/xml': 'xml',
  'text/css': 'css',
  'text/html': 'html',
  'text/javascript': 'javascript',
  'text/markdown': 'markdown',
  'text/x-c': 'c',
  'text/x-java-source': 'java',
  'text/yaml': 'yaml',
};

const EXTENSION_LANGUAGES: Record<string, string> = {
  bash: 'bash',
  c: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  dart: 'dart',
  diff: 'diff',
  ex: 'elixir',
  exs: 'elixir',
  fish: 'fish',
  go: 'go',
  graphql: 'graphql',
  h: 'c',
  hpp: 'cpp',
  hs: 'haskell',
  html: 'html',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsonc: 'json',
  jsx: 'jsx',
  kt: 'kotlin',
  lua: 'lua',
  md: 'markdown',
  mjs: 'javascript',
  nix: 'nix',
  patch: 'diff',
  php: 'php',
  proto: 'proto',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  scala: 'scala',
  scss: 'scss',
  sh: 'bash',
  sql: 'sql',
  svelte: 'svelte',
  swift: 'swift',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'tsx',
  vue: 'vue',
  xhtml: 'html',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zig: 'zig',
  zsh: 'bash',
};

const PLAIN_EXTENSIONS = new Set([
  'cfg',
  'cnf',
  'conf',
  'csv',
  'env',
  'ini',
  'log',
  'me',
  'text',
  'tsv',
  'txt',
]);

function normalizeMime(mime: string | null): string | null {
  if (!mime) return null;
  const type = mime.split(';')[0].trim().toLowerCase();
  return type || null;
}

function extensionOf(body: string): string | null {
  const name = body.split(/[\\/]/).pop() ?? body;
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

export function isTextAttachment(mime: string | null, body: string): boolean {
  const type = normalizeMime(mime);
  if (type === 'application/pdf') return false;
  if (type !== null && (type.startsWith('text/') || type in MIME_LANGUAGES)) return true;

  const extension = extensionOf(body);
  if (extension === null) return false;
  return extension in EXTENSION_LANGUAGES || PLAIN_EXTENSIONS.has(extension);
}

export function textAttachmentLanguage(mime: string | null, body: string): string | null {
  const extension = extensionOf(body);
  if (extension !== null && extension in EXTENSION_LANGUAGES) {
    return EXTENSION_LANGUAGES[extension];
  }
  if (extension !== null && PLAIN_EXTENSIONS.has(extension)) return null;

  const type = normalizeMime(mime);
  if (type === null) return null;
  return MIME_LANGUAGES[type] ?? null;
}
