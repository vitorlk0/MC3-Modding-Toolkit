import { PckDocument, scanMeshRelocs, type LodLevel } from "./pck";
import { matchLodEntries } from "./mesh";

/**
 * Bulk embedding of loose mesh.pck files into one car PCK — the Mod Toolkit's replacement for
 * `mc3_append_mesh_into_car_pck.py`.
 *
 * Nothing here touches bytes directly. Each piece is matched to its HLOD/MLOD/LLOD rows by name
 * and handed to `PckDocument.replaceEmbeddedMesh`, the same call the Mesh Editor's embed uses;
 * dead copies are then reclaimed with `compactToolBlocks`, as the vehicle set's Save does. The
 * precedent script's step-1 CSV is not needed: every slot offset, ID and pointer it carried is read
 * straight from the target PCK's own LOD tables.
 *
 * The same function builds the preview and the bytes that are saved, so what the review shows is
 * exactly what gets written.
 */

export type InjectPiece = { name: string; bytes: Uint8Array };

export type InjectEntry = {
  lod: LodLevel;
  index: number;
  /** The ID this row ends up with — the table's own, or 0 when "force shell ID to zero" applies. */
  meshId: number;
  originalId: number;
  /** insert: the row streamed the piece from the loose file (PTR_Mesh was 0). replace: the row
   *  already had an embedded copy. current: the embedded copy already is this exact piece. */
  action: "insert" | "replace" | "current";
};

export type InjectRow = {
  name: string;
  size: number;
  shell: boolean;
  entries: InjectEntry[];
  /** Why this piece can't be embedded; such rows are never included. */
  problem: string | null;
  /** The problem is that no LOD row carries this name, rather than a malformed piece. */
  noSlot: boolean;
  included: boolean;
};

export type InjectPlan = {
  rows: InjectRow[];
  bytes: Uint8Array;
  sizeBefore: number;
  sizeAfter: number;
  /** Space held by dead copies from earlier embeds, reclaimed on the way. */
  reclaimed: number;
  changed: boolean;
};

/** The precedent tool's rule for which pieces "force shell ID to zero" applies to. */
export const isShellPiece = (name: string) => name.toLowerCase().includes("shell");

function sameRange(a: Uint8Array, b: Uint8Array, offset: number, length: number) {
  if (offset + length > a.length || offset + length > b.length) return false;
  for (let i = offset; i < offset + length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

export function openCarPck(name: string, bytes: Uint8Array) {
  const document = new PckDocument(name, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  if (document.format !== "pck") throw new Error(`${name} is a PSP PCK. Embedding pieces is only supported for PS2 car PCKs.`);
  if (!document.lodMeshes.length) throw new Error(`${name} has no HLOD/MLOD/LLOD tables, so there are no slots to embed pieces into.`);
  return document;
}

/**
 * Embeds `pieces` into a fresh copy of the target. `include` names the pieces to embed (by lower-
 * case name); pieces left out are still matched and validated so the review can list them, but
 * their rows are not written.
 */
export function planInjection(targetName: string, targetBytes: Uint8Array, pieces: InjectPiece[], include: Set<string>, forceShellZero: boolean): InjectPlan {
  const document = openCarPck(targetName, targetBytes);
  const original = document.bytes.slice();
  const rows: InjectRow[] = [];

  for (const piece of pieces) {
    const shell = isShellPiece(piece.name);
    const entries = matchLodEntries(piece.name, document);
    const row: InjectRow = { name: piece.name, size: piece.bytes.byteLength, shell, entries: [], problem: null, noSlot: false, included: false };
    rows.push(row);
    if (!entries.length) { row.problem = "No HLOD/MLOD/LLOD row has this name, so the car has no slot for it."; row.noSlot = true; continue; }
    try { scanMeshRelocs(piece.bytes); }
    catch (error) { row.problem = error instanceof Error ? error.message : "Not a valid standalone mesh.pck."; continue; }

    const zero = forceShellZero && shell;
    const originalIds = entries.map((entry) => entry.meshId);
    if (!include.has(piece.name.toLowerCase())) {
      row.entries = entries.map((entry, i) => ({ lod: entry.lod, index: entry.index, meshId: zero ? 0 : entry.meshId, originalId: originalIds[i], action: entry.meshBlockOffset === null ? "insert" : "replace" }));
      continue;
    }

    try {
      if (zero) document.setLodMeshId(entries, 0, false);
      row.entries = entries.map((entry, i) => {
        const inserting = entry.meshBlockOffset === null;
        const result = document.replaceEmbeddedMesh(entry, piece.bytes, false);
        const unchanged = result.placement === "in-place" && entry.meshId === originalIds[i] && sameRange(original, document.bytes, result.blockOffset, result.reservedSize);
        return { lod: entry.lod, index: entry.index, meshId: entry.meshId, originalId: originalIds[i], action: unchanged ? "current" : inserting ? "insert" : "replace" };
      });
      row.included = true;
    } catch (error) {
      row.problem = error instanceof Error ? error.message : "The piece could not be embedded.";
      row.entries = [];
    }
  }

  const compaction = document.compactToolBlocks();
  const bytes = document.bytes;
  const changed = bytes.length !== original.length || !sameRange(original, bytes, 0, bytes.length);
  return { rows, bytes, sizeBefore: original.length, sizeAfter: bytes.length, reclaimed: compaction?.reclaimedBytes ?? 0, changed };
}
