import type { DesktopApi } from "./contract";
import { tauriBridge } from "./tauriBridge";

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function resolveDesktopApi(): Promise<DesktopApi> {
  if (import.meta.env.DEV && !isTauriRuntime()) {
    return (await import("./webMockBridge")).webMockBridge;
  }
  return tauriBridge;
}

export const desktopApi: DesktopApi = await resolveDesktopApi();
export type * from "./contract";
