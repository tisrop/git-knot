import { describe, expect, it } from "vitest";
import type { UpdateProgressEvent } from "../../platform/desktop";
import { formatUpdateBytes, updateProgressPercent } from "./progress";

describe("update progress presentation", () => {
  it("handles the JSON number payload emitted by Tauri", () => {
    const progress = JSON.parse(
      '{"requestId":"request-1","downloaded":512,"total":2048,"phase":"downloading"}',
    ) as UpdateProgressEvent;

    expect(() => updateProgressPercent(progress)).not.toThrow();
    expect(updateProgressPercent(progress)).toBe(25);
    expect(formatUpdateBytes(progress.downloaded)).toBe("512 B");
  });

  it("handles unknown totals and caps completed downloads", () => {
    expect(updateProgressPercent({ downloaded: 512, total: null })).toBeNull();
    expect(updateProgressPercent({ downloaded: 4096, total: 2048 })).toBe(100);
  });
});
