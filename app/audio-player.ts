/** One-voice playback of rendered previews through Web Audio: starting a sound stops the last. */
let context: AudioContext | null = null;
let current: AudioBufferSourceNode | null = null;

export function playPcm(pcm: Int16Array, rate: number, onEnd: () => void) {
  stopPlayback();
  context ??= new AudioContext();
  void context.resume();
  const buffer = context.createBuffer(1, Math.max(1, pcm.length), rate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < pcm.length; i += 1) channel[i] = pcm[i] / 32768;
  const source = context.createBufferSource();
  source.buffer = buffer; source.connect(context.destination);
  source.onended = () => { if (current === source) { current = null; onEnd(); } };
  current = source; source.start();
  return performance.now();
}

export function stopPlayback() {
  const source = current; current = null;
  if (source) { source.onended = null; try { source.stop(); } catch { /* already stopped */ } }
}
