import { scanCandidates, scanFlashTextures, type Candidate, type ScanOptions } from "./ps2-texture";

/**
 * Runs the Smart Scan off the UI thread. Stopping is done by terminating the worker, so the scan
 * itself never has to check for it. Flash records are tried first; a file that has them is a
 * Flash/UI PCK and the car heuristic is skipped, as in the precedent tool.
 */

type Request = { data: Uint8Array; options: ScanOptions; flash: boolean };
export type ScanMessage = { kind: "progress"; fraction: number; text: string } | { kind: "done"; candidates: Candidate[]; flash: boolean } | { kind: "error"; message: string };

const post = (message: ScanMessage) => (globalThis as unknown as { postMessage(message: ScanMessage): void }).postMessage(message);

globalThis.addEventListener("message", (event: Event) => {
  const { data, options, flash } = (event as MessageEvent<Request>).data;
  try {
    const flashCandidates = flash ? scanFlashTextures(data) : [];
    if (flashCandidates.length || (!options.nonRemix && !options.remix)) { post({ kind: "done", candidates: flashCandidates, flash: true }); return; }
    let last = 0;
    const candidates = scanCandidates(data, options, (fraction, text) => {
      const now = Date.now();
      if (now - last > 60 || fraction >= 1) { last = now; post({ kind: "progress", fraction, text }); }
    });
    post({ kind: "done", candidates, flash: false });
  } catch (error) {
    post({ kind: "error", message: error instanceof Error ? error.message : String(error) });
  }
});
