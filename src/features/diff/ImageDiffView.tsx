import type { ImageDiff, ImagePreview } from "../../platform/desktop";

export function ImageDiffView({ diff }: { diff: ImageDiff }) {
  const sides = [
    { key: "old", label: "旧版本", preview: diff.old },
    { key: "new", label: "新版本", preview: diff.new },
  ].filter((side) => side.preview) as Array<{
    key: string;
    label: string;
    preview: ImagePreview;
  }>;

  if (sides.length === 0) {
    return (
      <p className="panel-message">
        {diff.unsupportedReason ?? "该图片超过预览限制或格式暂不支持。"}
      </p>
    );
  }

  return (
    <div className={`image-diff-view sides-${sides.length}`}>
      {sides.map(({ key, label, preview }) => (
        <figure className="image-diff-side" key={key}>
          <figcaption>
            <span>{label}</span>
            <small>
              {preview.mimeType} · {(preview.byteLength / 1024).toFixed(1)} KiB
            </small>
          </figcaption>
          <div className="image-diff-canvas">
            <img src={preview.dataUrl} alt={`${label}图片预览`} loading="lazy" />
          </div>
        </figure>
      ))}
    </div>
  );
}
