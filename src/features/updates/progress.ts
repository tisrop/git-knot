import type { UpdateProgressEvent } from "../../platform/desktop";

export function updateProgressPercent(
  progress: Pick<UpdateProgressEvent, "downloaded" | "total"> | null,
) {
  if (!progress?.total || progress.total <= 0) return null;
  return Math.min(100, Math.floor((progress.downloaded * 100) / progress.total));
}

export function formatUpdateBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
