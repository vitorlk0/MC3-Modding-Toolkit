import type { MeshGeometry } from "../src/mesh";

/**
 * Triangle selection and hiding in the Meshes viewer.
 *
 * Both are view state, not edits: one flag per triangle of a piece, keyed by the piece's filename
 * and indexed like `MeshGeometry.indices` (triangle t = indices[3t..3t+2], the face index the
 * raycaster reports on the full index). Nothing here touches a PCK, so none of it marks a file dirty
 * or goes on the undo stack.
 *
 * A piece is re-parsed after every shader or ID edit, so its geometry object changes while its
 * triangles stay the same. Each entry records a signature of the geometry it was made for (a hash of
 * positions and indices) and is ignored once the piece's geometry really changes (Sync, Convert OBJs).
 */

type FlagEntry = { signature: number; flags: Uint8Array; count: number };
export type TriangleFlags = ReadonlyMap<string, FlagEntry>;
export const NO_TRIANGLES: TriangleFlags = new Map();

export type SelectMode = "replace" | "add" | "remove";
/** Where "Same shader" looks: the pieces that already have a selection, or every visible piece. */
export type SimilarScope = "part" | "all";
export type TriangleCommand =
  | { kind: "pick"; meshName: string; triangle: number; toggle: boolean }
  | { kind: "clear" }
  | { kind: "all" }
  | { kind: "invert" }
  | { kind: "linked"; meshName: string; triangle: number; deselect: boolean; delimitShader: boolean }
  | { kind: "grow"; delimitShader: boolean }
  | { kind: "shader"; shaderId: number; deselect: boolean }
  | { kind: "similar"; scope: SimilarScope }
  /** `stroke` numbers a brush stroke: its dabs are one step in the undo history. */
  | { kind: "box"; hits: Map<string, number[]>; mode: SelectMode; stroke?: number }
  | { kind: "hide" }
  | { kind: "isolate" }
  | { kind: "reveal" };
export type TriangleState = { selected: TriangleFlags; hidden: TriangleFlags };

export function triangleCount(mesh: MeshGeometry) { return Math.floor(mesh.indices.length / 3); }

const signatures = new WeakMap<MeshGeometry, number>();
function geometrySignature(mesh: MeshGeometry) {
  const cached = signatures.get(mesh);
  if (cached !== undefined) return cached;
  // FNV-1a over the raw bits of the positions, then the indices.
  let hash = 0x811c9dc5;
  const mix = (words: ArrayLike<number>) => { for (let i = 0; i < words.length; i += 1) { hash ^= words[i]; hash = Math.imul(hash, 0x01000193); } };
  mix(new Uint32Array(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.length));
  mix(mesh.indices);
  const signature = (hash ^ mesh.indices.length) >>> 0;
  signatures.set(mesh, signature);
  return signature;
}

/** The piece's flags while the entry still matches its geometry; null when there are none. */
export function flagsOf(state: TriangleFlags, mesh: MeshGeometry): Uint8Array | null {
  const entry = state.get(mesh.name);
  if (!entry || entry.flags.length !== triangleCount(mesh) || entry.signature !== geometrySignature(mesh)) return null;
  return entry.flags;
}

export function countOf(state: TriangleFlags, mesh: MeshGeometry) {
  return flagsOf(state, mesh) ? state.get(mesh.name)!.count : 0;
}

/** Runs `edit` on a copy of each piece's flags (zeros when it has none) and returns the new state.
 *  A piece whose flags come out unchanged keeps its old entry, so the viewer can tell it apart. */
function editFlags(state: TriangleFlags, meshes: MeshGeometry[], edit: (flags: Uint8Array, mesh: MeshGeometry) => void): TriangleFlags {
  let next: Map<string, FlagEntry> | null = null;
  for (const mesh of meshes) {
    const current = flagsOf(state, mesh);
    const flags = current ? current.slice() : new Uint8Array(triangleCount(mesh));
    edit(flags, mesh);
    let count = 0; let changed = !current && state.has(mesh.name);
    for (let i = 0; i < flags.length; i += 1) { count += flags[i]; if (!changed && flags[i] !== (current ? current[i] : 0)) changed = true; }
    if (!changed) continue;
    next ??= new Map(state);
    if (count) next.set(mesh.name, { signature: geometrySignature(mesh), flags, count });
    else next.delete(mesh.name);
  }
  return next ?? state;
}

// By shader ID, not material group: two groups of a piece can share a shader, and across pieces
// the shader is the only thing two triangles can have in common.
function triangleShader(mesh: MeshGeometry, triangle: number) { return mesh.vertexShaderIds[mesh.indices[triangle * 3]]; }

// The packets store triangle strips, so neighbouring triangles don't share vertex indices: each
// strip (and each 40-vertex block) repeats its vertices. Connectivity comes from welding vertices
// with bit-identical positions, then listing the triangles that touch each welded vertex.
type Adjacency = { triangleVertices: Uint32Array; offsets: Uint32Array; triangles: Uint32Array };
const adjacencyCache = new WeakMap<MeshGeometry, Adjacency>();
function adjacency(mesh: MeshGeometry): Adjacency {
  const cached = adjacencyCache.get(mesh);
  if (cached) return cached;
  const bits = new Uint32Array(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.length);
  const weldIds = new Map<string, number>();
  const weldOf = new Uint32Array(mesh.positions.length / 3);
  // -0 and +0 are the same point.
  const word = (value: number) => (value === 0x80000000 ? 0 : value);
  for (let v = 0; v < weldOf.length; v += 1) {
    const key = `${word(bits[v * 3])},${word(bits[v * 3 + 1])},${word(bits[v * 3 + 2])}`;
    let id = weldIds.get(key);
    if (id === undefined) { id = weldIds.size; weldIds.set(key, id); }
    weldOf[v] = id;
  }
  const count = triangleCount(mesh);
  const triangleVertices = new Uint32Array(count * 3);
  const offsets = new Uint32Array(weldIds.size + 1);
  for (let i = 0; i < count * 3; i += 1) { triangleVertices[i] = weldOf[mesh.indices[i]]; offsets[triangleVertices[i] + 1] += 1; }
  for (let i = 1; i < offsets.length; i += 1) offsets[i] += offsets[i - 1];
  const fill = offsets.slice(0, -1);
  const triangles = new Uint32Array(count * 3);
  for (let i = 0; i < count * 3; i += 1) triangles[fill[triangleVertices[i]]++] = Math.floor(i / 3);
  const result = { triangleVertices, offsets, triangles };
  adjacencyCache.set(mesh, result);
  return result;
}

/** Flags every triangle connected to the seeds through shared vertices, skipping hidden ones and,
 *  with `delimitShader`, never crossing into a triangle of another shader. */
function linkedFlags(mesh: MeshGeometry, seeds: Iterable<number>, hidden: Uint8Array | null, delimitShader: boolean) {
  const { triangleVertices, offsets, triangles } = adjacency(mesh);
  const flags = new Uint8Array(triangleCount(mesh));
  const queue: number[] = [];
  for (const seed of seeds) if (!flags[seed] && !hidden?.[seed]) { flags[seed] = 1; queue.push(seed); }
  while (queue.length) {
    const triangle = queue.pop()!;
    const shader = triangleShader(mesh, triangle);
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = triangleVertices[triangle * 3 + corner];
      for (let i = offsets[vertex]; i < offsets[vertex + 1]; i += 1) {
        const next = triangles[i];
        if (flags[next] || hidden?.[next]) continue;
        if (delimitShader && triangleShader(mesh, next) !== shader) continue;
        flags[next] = 1; queue.push(next);
      }
    }
  }
  return flags;
}

/** Applies one viewer command. `visible` is the pieces shown in the viewer: selecting, inverting and
 *  isolating only reach those, while clearing and revealing reach every piece. */
export function applyTriangleCommand(state: TriangleState, command: TriangleCommand, visible: MeshGeometry[]): TriangleState {
  const { selected, hidden } = state;
  const byName = (name: string) => visible.find((mesh) => mesh.name === name);
  const isHidden = (mesh: MeshGeometry) => flagsOf(hidden, mesh);
  switch (command.kind) {
    case "pick": {
      const mesh = byName(command.meshName); if (!mesh) return state;
      return { selected: editFlags(command.toggle ? selected : NO_TRIANGLES, [mesh], (flags) => { flags[command.triangle] ^= 1; }), hidden };
    }
    case "clear": return { selected: NO_TRIANGLES, hidden };
    case "all": return { selected: editFlags(selected, visible, (flags, mesh) => { const off = isHidden(mesh); for (let i = 0; i < flags.length; i += 1) flags[i] = off?.[i] ? 0 : 1; }), hidden };
    case "invert": return { selected: editFlags(selected, visible, (flags, mesh) => { const off = isHidden(mesh); for (let i = 0; i < flags.length; i += 1) flags[i] = off?.[i] ? 0 : flags[i] ^ 1; }), hidden };
    case "linked": {
      const mesh = byName(command.meshName); if (!mesh) return state;
      const island = linkedFlags(mesh, [command.triangle], isHidden(mesh), command.delimitShader);
      return { selected: editFlags(selected, [mesh], (flags) => { for (let i = 0; i < flags.length; i += 1) if (island[i]) flags[i] = command.deselect ? 0 : 1; }), hidden };
    }
    case "grow": return { selected: editFlags(selected, visible, (flags, mesh) => {
      const seeds: number[] = [];
      for (let i = 0; i < flags.length; i += 1) if (flags[i]) seeds.push(i);
      if (!seeds.length) return;
      const island = linkedFlags(mesh, seeds, isHidden(mesh), command.delimitShader);
      for (let i = 0; i < flags.length; i += 1) flags[i] |= island[i];
    }), hidden };
    case "shader": return { selected: editFlags(selected, visible, (flags, mesh) => {
      const off = isHidden(mesh);
      for (let i = 0; i < flags.length; i += 1) if (!off?.[i] && triangleShader(mesh, i) === command.shaderId) flags[i] = command.deselect ? 0 : 1;
    }), hidden };
    case "similar": {
      // Every triangle, connected or not, whose shader is one of the selected triangles' shaders.
      const shaders = new Set<number>();
      const withSelection = visible.filter((mesh) => flagsOf(selected, mesh));
      for (const mesh of withSelection) { const picked = flagsOf(selected, mesh)!; for (let i = 0; i < picked.length; i += 1) if (picked[i]) shaders.add(triangleShader(mesh, i)); }
      if (!shaders.size) return state;
      return { selected: editFlags(selected, command.scope === "part" ? withSelection : visible, (flags, mesh) => {
        const off = isHidden(mesh);
        for (let i = 0; i < flags.length; i += 1) if (!off?.[i] && shaders.has(triangleShader(mesh, i))) flags[i] = 1;
      }), hidden };
    }
    case "box": {
      const base = command.mode === "replace" ? NO_TRIANGLES : selected;
      const touched = visible.filter((mesh) => command.hits.has(mesh.name));
      return { selected: editFlags(base, touched, (flags, mesh) => { for (const triangle of command.hits.get(mesh.name)!) flags[triangle] = command.mode === "remove" ? 0 : 1; }), hidden };
    }
    case "hide": {
      const withSelection = visible.filter((mesh) => flagsOf(selected, mesh));
      if (!withSelection.length) return state;
      const nextHidden = editFlags(hidden, withSelection, (flags, mesh) => { const picked = flagsOf(selected, mesh)!; for (let i = 0; i < flags.length; i += 1) flags[i] |= picked[i]; });
      return { selected: editFlags(selected, withSelection, (flags) => flags.fill(0)), hidden: nextHidden };
    }
    case "isolate": {
      if (!visible.some((mesh) => flagsOf(selected, mesh))) return state;
      return { selected, hidden: editFlags(hidden, visible, (flags, mesh) => { const picked = flagsOf(selected, mesh); for (let i = 0; i < flags.length; i += 1) if (!picked?.[i]) flags[i] = 1; }) };
    }
    case "reveal": return { selected, hidden: NO_TRIANGLES };
  }
}
