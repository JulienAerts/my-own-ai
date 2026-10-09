import * as Comlink from 'comlink';
import type { EngineApi } from './engine.worker';
import { activeNative, nativeGenerate, nativeInterrupt } from '../native/backend';

let worker: Worker | null = null;
let remote: Comlink.Remote<EngineApi> | null = null;

function webllm(): Comlink.Remote<EngineApi> {
  if (!remote) {
    worker = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module', name: 'Chat model (WebLLM)' });
    remote = Comlink.wrap<EngineApi>(worker);
  }
  return remote;
}

/**
 * The inference engine: the WebLLM worker, or, while a desktop model runs on
 * llama.cpp, an object answering generate/interrupt/load from llama-server
 * (everything else, like download bookkeeping, still goes to the worker).
 */
/**
 * End-to-end tests (e2e/, dev server only): a stand-in engine the test puts on the page
 * before it loads, so the chat runs without a GPU or a model download.
 */
const testEngine = import.meta.env?.DEV ? (globalThis as { __E2E_ENGINE__?: Comlink.Remote<EngineApi> }).__E2E_ENGINE__ : undefined;

export function engine(): Comlink.Remote<EngineApi> {
  if (testEngine) return testEngine;
  const native = activeNative();
  if (!native) return webllm();
  const w = webllm();
  return new Proxy(w, {
    get(target, prop) {
      if (prop === 'generate') return nativeGenerate;
      if (prop === 'interrupt') return async () => nativeInterrupt();
      if (prop === 'load') return async () => ({ contextWindow: native.ctx });
      return Reflect.get(target, prop);
    },
  }) as Comlink.Remote<EngineApi>;
}

/**
 * Hard-stop the worker (used to pause a download). Completed shards are
 * already in the Cache API; pending calls on the old proxy never settle.
 */
export function terminateEngine(): void {
  worker?.terminate();
  worker = null;
  remote = null;
}

export { Comlink };
