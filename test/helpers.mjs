import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A throwaway data folder for one test. */
export function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), "channel-hub-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}
