// Image generation on the desktop (src-tauri/src/sdcpp.rs): Z-Image-Turbo with
// stable-diffusion.cpp, 8 steps. The first use asks before a one-time 6.7 GB
// download. When the chat model leaves too little GPU memory, it is unloaded
// for the few seconds the image takes, then loaded again.
import type { ToolContext, ToolDef, ToolOutput } from '../agent/tools';
import { desktopOS, isDesktopApp } from '../native';
import { trackDownload } from '../net/netlog';
import { activeNative, bestGpu, estimatedFreeMB, llamaStatus, startNative, stopNative } from './backend';
import { num, t } from '../i18n/i18n';

const FILES = [
  { url: 'https://huggingface.co/leejet/Z-Image-Turbo-GGUF/resolve/main/z_image_turbo-Q4_K.gguf', file: 'z_image_turbo-Q4_K.gguf', bytes: 3_860_000_000, label: t('image model') },
  { url: 'https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf', file: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf', bytes: 2_497_281_120, label: t('text encoder') },
  { url: 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors', file: 'z_image_ae.safetensors', bytes: 335_304_388, label: t('image decoder') },
] as const;
const TOTAL_GB = (FILES.reduce((n, f) => n + f.bytes, 0) / 1e9).toFixed(1);
/** GPU memory the render needs (model, text encoder, activations at 1024 px). */
const NEEDS_MB = 7500;

const SIZES: Record<string, [number, number]> = { square: [1024, 1024], portrait: [832, 1216], landscape: [1216, 832] };

async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

async function installed(): Promise<boolean> {
  const [engine, status] = await Promise.all([invoke<boolean>('sd_installed').catch(() => false), llamaStatus().catch(() => null)]);
  return engine && FILES.every((f) => (status?.models.find((m) => m.file === f.file)?.bytes ?? 0) >= f.bytes * 0.99);
}

async function install(onStatus?: (s: string) => void): Promise<void> {
  const { Channel } = await import('@tauri-apps/api/core');
  let got = 0;
  const ch = (label: string) => {
    got = 0;
    const c = new Channel<{ received: number; total: number }>();
    c.onmessage = (p) => {
      got = p.received;
      onStatus?.(t('Downloading the {what} · {done} of {total} GB', { what: label, done: num(p.received / 1e9, 1), total: num((p.total || 0) / 1e9, 1) }));
    };
    return c;
  };
  const size = () => got || undefined;
  if (!(await invoke<boolean>('sd_installed'))) {
    await trackDownload('https://github.com/leejet/stable-diffusion.cpp/releases', t('Image engine'), () => invoke('install_sd', { onProgress: ch(t('image engine')) }), size);
  }
  for (const f of FILES) await trackDownload(f.url, t('Image model: {what}', { what: f.label }), () => invoke('download_model', { url: f.url, file: f.file, onProgress: ch(f.label) }), size);
}

async function generate({ prompt, size }: Record<string, string>, ctx?: ToolContext): Promise<ToolOutput> {
  if (!prompt?.trim()) throw new Error('Describe the image to generate.');
  if (!(await installed())) {
    const answer = ctx?.confirm
      ? await ctx.confirm({ server: t('Images'), tool: t('Download the image model ({size} GB, once)', { size: TOTAL_GB }), args: { model: 'Z-Image-Turbo (stable-diffusion.cpp)' }, everyTime: true })
      : 'deny';
    if (answer === 'deny') return { text: 'The user declined the image model download.', error: true };
    await install(ctx?.onStatus);
  }
  const [width, height] = SIZES[(size ?? '').trim().toLowerCase()] ?? SIZES.square;

  // Not enough free GPU memory next to the chat model: unload it while the image renders.
  const chat = activeNative();
  // nvidia-smi reports free memory; on AMD and Intel it's estimated from the chat model's size.
  let free = await invoke<number | null>('gpu_free_mb').catch(() => null);
  if (free === null) {
    const gpu = await bestGpu();
    free = gpu ? estimatedFreeMB(gpu, chat) : null;
  }
  const unload = !!chat && free !== null && free < NEEDS_MB;
  if (unload) {
    ctx?.onStatus?.(t('Making room on the GPU…'));
    await stopNative();
  }
  try {
    ctx?.onStatus?.(t('Painting the image…'));
    const png = await invoke<ArrayBuffer>('generate_image', {
      diffusion: FILES[0].file, llm: FILES[1].file, vae: FILES[2].file,
      prompt: prompt.trim(), width, height, steps: 8, seed: Math.floor(Math.random() * 2 ** 31),
    });
    const b64 = btoa(Array.from(new Uint8Array(png), (b) => String.fromCharCode(b)).join(''));
    return { text: `(The image is shown to the user: ${width}×${height}, "${prompt.trim().slice(0, 120)}".)`, images: [`data:image/png;base64,${b64}`] };
  } finally {
    if (unload && chat) {
      ctx?.onStatus?.(t('Reloading {model}…', { model: chat.model.displayName }));
      await startNative(chat.model, chat.ctx, () => {});
    }
  }
}

/** The image tool: desktop app with an NVIDIA GPU of 8 GB or more. */
export function imageTools(gpuMB: number | undefined): ToolDef[] {
  // stable-diffusion.cpp's pinned release is a Windows build.
  if (!isDesktopApp || desktopOS !== 'windows' || !gpuMB || gpuMB < 8000) return [];
  return [{
    name: 'generate_image',
    label: t('Create images'),
    summary: t('Generate pictures from a description, on your GPU.'),
    description: 'Generate an image from a text description, when the user asks for a picture, drawing, illustration or photo.',
    params: {
      prompt: { description: 'A detailed description in English: subject, setting, style, lighting, colours', example: 'A cozy reading nook by a rainy window, warm lamp light, watercolor' },
      size: { description: '"square", "portrait" or "landscape"', example: 'square' },
    },
    run: generate,
  }];
}
