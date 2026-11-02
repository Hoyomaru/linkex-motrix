import type { Settings } from './settings';

/** 画面（専用ページ・ポップアップ）から Service Worker へ送るメッセージ */
export type Request =
  | { type: 'linkex.call'; method: 'get' | 'post'; path: string; params?: unknown; data?: unknown }
  | { type: 'linkex.openTab' }
  | { type: 'motrix.version' }
  | { type: 'motrix.add'; url: string; dir?: string; out?: string }
  | { type: 'motrix.status'; gid: string }
  | { type: 'cdn.probe'; url: string }
  | { type: 'queue.add'; text: string }
  | { type: 'share.walk'; token: string }
  | {
      type: 'queue.addFiles';
      token: string;
      shareName: string;
      files: { id: string; name: string; size: number | null; hash: string | null; folders: string[] }[];
    }
  | { type: 'dashboard.open' }
  | { type: 'events.clear' }
  | { type: 'queue.start' }
  | { type: 'queue.pause' }
  | { type: 'queue.retry'; id: string }
  | { type: 'queue.remove'; id: string }
  | { type: 'queue.clearFinished' }
  | { type: 'settings.get' }
  | { type: 'settings.set'; patch: Partial<Settings> };

export type Response<T = unknown> = { ok: true; data: T } | { ok: false; error: string; detail?: unknown };

export async function send<T = unknown>(request: Request): Promise<Response<T>> {
  try {
    const res = (await chrome.runtime.sendMessage(request)) as Response<T> | undefined;
    return res ?? { ok: false, error: 'no_response' };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

/** Linkex APIの共通応答。code 0 が成功 */
export interface LinkexEnvelope<T> {
  code: number;
  message: string;
  data: T;
}
