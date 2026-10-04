import type { PckDocument } from "../src/pck";

export type VehicleRole = "player" | "garage" | "opponent";
export type VehicleSlot = { role: VehicleRole; path: string; document: PckDocument };
export type VehicleSlots = Record<VehicleRole, VehicleSlot | null>;

export const roles: VehicleRole[] = ["player", "garage", "opponent"];
export const roleLabels: Record<VehicleRole, string> = { player: "Player", garage: "Garage", opponent: "Opponent" };

export function sizeLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
