import { describe, expect, it } from "vitest";
import { canDismissDialog, dialogTabTargetIndex, shouldReturnDialogFocus } from "./Dialog";

describe("Dialog keyboard behavior", () => {
  it("wraps Tab and Shift+Tab at dialog boundaries", () => {
    expect(dialogTabTargetIndex(2, 3, false)).toBe(0);
    expect(dialogTabTargetIndex(0, 3, true)).toBe(2);
    expect(dialogTabTargetIndex(1, 3, false)).toBeNull();
    expect(dialogTabTargetIndex(-1, 0, false)).toBeNull();
  });

  it("moves focus into the dialog when focus starts outside", () => {
    expect(dialogTabTargetIndex(-1, 3, false)).toBe(0);
    expect(dialogTabTargetIndex(-1, 3, true)).toBe(2);
  });

  it("allows Escape dismissal only while the dialog is idle", () => {
    expect(canDismissDialog(false)).toBe(true);
    expect(canDismissDialog(true)).toBe(false);
  });

  it("returns focus only to a connected trigger when no other modal remains", () => {
    expect(shouldReturnDialogFocus(true, false)).toBe(true);
    expect(shouldReturnDialogFocus(false, false)).toBe(false);
    expect(shouldReturnDialogFocus(true, true)).toBe(false);
  });
});
