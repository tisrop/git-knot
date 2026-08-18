import { describe, expect, it } from "vitest";
import { shouldDismissThemedSelect } from "./ThemedSelect";

describe("ThemedSelect keyboard behavior", () => {
  it("dismisses an open listbox on Escape regardless of focused option", () => {
    expect(shouldDismissThemedSelect("Escape", false)).toBe(true);
    expect(shouldDismissThemedSelect("Enter", false)).toBe(false);
  });

  it("does not dismiss while an IME composition is active", () => {
    expect(shouldDismissThemedSelect("Escape", true)).toBe(false);
  });
});
