export type FileTypeTone = "code" | "config" | "document" | "git" | "image" | "web";

export interface FileTypeDescriptor {
  label: string;
  tone: FileTypeTone;
}

const SPECIAL_FILE_TYPES: Record<string, FileTypeDescriptor> = {
  ".gitattributes": { label: "GIT", tone: "git" },
  ".gitignore": { label: "GIT", tone: "git" },
  ".gitmodules": { label: "GIT", tone: "git" },
  dockerfile: { label: "DKR", tone: "config" },
  license: { label: "TXT", tone: "document" },
  makefile: { label: "MK", tone: "config" },
};

const TYPE_GROUPS: Array<[extensions: string[], descriptor: FileTypeDescriptor]> = [
  [["png", "apng"], { label: "PNG", tone: "image" }],
  [["jpg", "jpeg"], { label: "JPG", tone: "image" }],
  [["gif"], { label: "GIF", tone: "image" }],
  [["webp"], { label: "WEBP", tone: "image" }],
  [["svg"], { label: "SVG", tone: "image" }],
  [["ico", "icns"], { label: "ICO", tone: "image" }],
  [["json", "jsonc"], { label: "JSN", tone: "config" }],
  [["yaml", "yml"], { label: "YML", tone: "config" }],
  [["toml"], { label: "TML", tone: "config" }],
  [["xml"], { label: "XML", tone: "config" }],
  [["ini", "conf", "cfg"], { label: "CFG", tone: "config" }],
  [["md", "mdx"], { label: "MD", tone: "document" }],
  [["txt", "log"], { label: "TXT", tone: "document" }],
  [["pdf"], { label: "PDF", tone: "document" }],
  [["html", "htm"], { label: "HTM", tone: "web" }],
  [["css"], { label: "CSS", tone: "web" }],
  [["scss", "sass"], { label: "SCS", tone: "web" }],
  [["less"], { label: "LES", tone: "web" }],
  [["js", "jsx"], { label: "JS", tone: "code" }],
  [["mjs"], { label: "MJS", tone: "code" }],
  [["cjs"], { label: "CJS", tone: "code" }],
  [["ts", "tsx"], { label: "TS", tone: "code" }],
  [["rs"], { label: "RS", tone: "code" }],
  [["vue"], { label: "VUE", tone: "code" }],
  [["py"], { label: "PY", tone: "code" }],
  [["go"], { label: "GO", tone: "code" }],
  [["java"], { label: "JAV", tone: "code" }],
  [["kt", "kts"], { label: "KT", tone: "code" }],
  [["swift"], { label: "SWT", tone: "code" }],
  [["rb"], { label: "RB", tone: "code" }],
  [["php"], { label: "PHP", tone: "code" }],
  [["c", "h"], { label: "C", tone: "code" }],
  [["cc", "cpp", "cxx", "hpp"], { label: "CPP", tone: "code" }],
  [["cs"], { label: "CS", tone: "code" }],
  [["sh", "bash", "zsh", "fish"], { label: "SH", tone: "code" }],
];

const EXTENSION_TYPES = new Map(
  TYPE_GROUPS.flatMap(([extensions, descriptor]) =>
    extensions.map((extension) => [extension, descriptor] as const),
  ),
);

export function fileTypeDescriptor(path: string): FileTypeDescriptor {
  const fileName = path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
  const normalizedName = fileName.toLowerCase();
  const special = SPECIAL_FILE_TYPES[normalizedName];
  if (special) return special;

  const extensionSeparator = fileName.lastIndexOf(".");
  if (extensionSeparator <= 0 || extensionSeparator === fileName.length - 1) {
    return { label: "FILE", tone: "document" };
  }

  const extension = fileName.slice(extensionSeparator + 1).toLowerCase();
  return (
    EXTENSION_TYPES.get(extension) ?? {
      label: extension.toUpperCase().slice(0, 4),
      tone: "document",
    }
  );
}
