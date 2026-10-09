// The desktop app's native HTTP client (Tauri's plugin, in Rust), recorded in
// the network activity like the page's own fetch.
import { track } from './netlog';

export async function tauriFetch(url: string, init?: RequestInit, source?: string): Promise<Response> {
  const { fetch } = await import('@tauri-apps/plugin-http');
  const done = track(url, init?.method ?? 'GET', source);
  try {
    const res = await fetch(url, init);
    const n = Number(res.headers.get('content-length'));
    done({ status: res.status, bytes: n > 0 ? n : undefined });
    return res;
  } catch (e) {
    done({ status: 'error' });
    throw e;
  }
}
