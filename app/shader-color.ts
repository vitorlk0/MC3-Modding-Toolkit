// Deterministic color per shader ID so the same shader always reads as the same color, on any
// piece, anywhere on the car. The golden-angle hue step keeps small consecutive IDs (0, 1, 2…,
// the common case) visually far apart instead of clustering like a linear step would.
const GOLDEN_ANGLE = 137.508;
export const SHADER_SATURATION = 0.62;
export const SHADER_LIGHTNESS = 0.56;

export function shaderHue(shaderId: number) {
  return (shaderId * GOLDEN_ANGLE) % 360;
}

export function hslToRgb(hueDegrees: number, saturation: number, lightness: number): [number, number, number] {
  const hue = ((hueDegrees % 360) + 360) % 360 / 360;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const huePrime = hue * 6;
  const x = chroma * (1 - Math.abs((huePrime % 2) - 1));
  let [r, g, b] = [0, 0, 0];
  if (huePrime < 1) [r, g, b] = [chroma, x, 0];
  else if (huePrime < 2) [r, g, b] = [x, chroma, 0];
  else if (huePrime < 3) [r, g, b] = [0, chroma, x];
  else if (huePrime < 4) [r, g, b] = [0, x, chroma];
  else if (huePrime < 5) [r, g, b] = [x, 0, chroma];
  else [r, g, b] = [chroma, 0, x];
  const m = lightness - chroma / 2;
  return [r + m, g + m, b + m];
}

export function shaderColorRgb(shaderId: number): [number, number, number] {
  return hslToRgb(shaderHue(shaderId), SHADER_SATURATION, SHADER_LIGHTNESS);
}

export function rgbToHex([r, g, b]: [number, number, number]) {
  const channel = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 255).toString(16).padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

export function hexToRgb(hex: string): [number, number, number] {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!match) return [1, 1, 1];
  return [parseInt(match[1], 16) / 255, parseInt(match[2], 16) / 255, parseInt(match[3], 16) / 255];
}
