import { fileTypeDescriptor } from "./fileType";

export function FileTypeBadge({ path, className = "" }: { path: string; className?: string }) {
  const descriptor = fileTypeDescriptor(path);
  const classes = ["file-type-badge", className].filter(Boolean).join(" ");

  return (
    <span
      className={classes}
      data-file-type={descriptor.label}
      data-file-tone={descriptor.tone}
      title={`${descriptor.label} 文件`}
      aria-hidden="true"
    >
      {descriptor.label}
    </span>
  );
}
