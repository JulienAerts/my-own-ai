/**
 * WebLLM's sampler occasionally emits an out-of-range token id, which the
 * grammar matcher then rejects (mlc-ai/web-llm#766, mlc-ai/xgrammar#611). It's
 * random per token and unrelated to the prompt, and the engine resets the
 * matcher on the next request, so generating again is safe and the loaded
 * model must not be discarded. The error crosses the worker as a plain message.
 */
export function isSamplerGlitch(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes('Grammar matcher rejected') || msg.includes('failed to sample a valid token');
}

/**
 * Errors that mean the GPU (or the engine on it) is gone, so the model must
 * be reloaded. Anything else (bad input, unsupported request, a WebLLM
 * validation error) leaves the loaded model usable and is shown as is.
 */
export function isGpuFailure(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  // Desktop llama.cpp: only a server that is gone needs a restart. Its other errors
  // (a refused request, a bad grammar) must be shown, not hidden behind a reload.
  if (/llama-server/i.test(msg)) return /llama-server (stopped|is not running)/i.test(msg);
  return /mapAsync|device (was |is )?lost|DeviceLost|GPUBuffer|GPUDevice|WebGPU|out of memory|OperationError|Vulkan|DXGI|D3D12|Metal|unmapped|No model loaded|engine/i.test(msg);
}
