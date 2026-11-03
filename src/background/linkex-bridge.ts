/**
 * Linkex Web版のページ内（MAIN world）で実行される関数。
 * chrome.scripting.executeScript で文字列化して送られるため、
 * この関数の外にある変数や関数は一切参照してはいけない。
 *
 * Web版ドライブ本体（/drive/assets/js/index-<hash>.js）を import() すると、
 * ページが使っているのと同じモジュールの実体が返る。その中から
 * get / post / instance を持つ「通信用の部品」を形で探して使う。
 * こうするとページと同じ署名・ログイン情報が自動で付く。
 */
export interface BridgeRequest {
  method: 'get' | 'post';
  path: string;
  params?: unknown;
  data?: unknown;
}

export type BridgeResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string; detail?: unknown; status?: number | null; loggedIn?: boolean | null };

export interface WalkedFile {
  id: string;
  name: string;
  size: number | null;
  hash: string | null;
  folders: string[];
}

export type WalkResult =
  | { ok: true; shareName: string; files: WalkedFile[]; requests: number }
  | { ok: false; error: string; detail?: unknown };

/**
 * 共有の中身をフォルダごとにたどり、ファイルを全部集める（ページ内で実行）。
 * ページとのやり取りを1回にまとめ、フォルダは数本ずつ並行して読む。
 * linkexBridgeCall と同じく、外の変数や関数を参照してはいけない。
 */
export async function linkexBridgeWalkShare(token: string, concurrency: number): Promise<WalkResult> {
  try {
    const w = window as unknown as { __linkexMotrixClient?: any };
    if (!w.__linkexMotrixClient) {
      const pattern = /\/drive\/assets\/js\/index-[^/]+\.js(\?.*)?$/;
      const src =
        Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]'))
          .map((s) => s.src)
          .find((s) => pattern.test(s)) ??
        performance.getEntriesByType('resource').map((e) => e.name).find((n) => pattern.test(n));
      if (!src) return { ok: false, error: 'index_not_found' };
      const mod: Record<string, unknown> = await import(/* @vite-ignore */ src);
      const client = Object.values(mod).find((v: any) =>
        v && typeof v === 'object' && typeof v.get === 'function' && typeof v.post === 'function' &&
        v.instance && typeof v.instance.request === 'function',
      );
      if (!client) return { ok: false, error: 'client_not_found' };
      w.__linkexMotrixClient = client;
    }
    const client = w.__linkexMotrixClient;
    const config = { skipGlobalMessage: true };
    let requests = 0;

    const get = async (path: string, params: unknown) => {
      requests++;
      const res = await client.get(path, params, config);
      if (res && typeof res === 'object' && 'code' in res && res.code !== 0) {
        throw new Error(`${path}: ${res.message} (code ${res.code})`);
      }
      return res?.data;
    };

    const info = await get('/api/drive/v1/share/get', { share_token: token });
    const shareName = String(info?.share?.name ?? info?.name ?? info?.title ?? token);

    const files: WalkedFile[] = [];
    const folderQueue: { id?: string; folders: string[]; depth: number }[] = [{ folders: [], depth: 0 }];
    let active = 0;
    let failure: unknown = null;

    const listFolder = async (job: { id?: string; folders: string[]; depth: number }) => {
      for (let page = 1; page <= 500; page++) {
        const data = await get('/api/drive/v1/share/get/content', {
          share_token: token,
          ...(job.id ? { parent_id: job.id } : {}),
          page,
          page_size: 100,
          need_parents: false,
        });
        const list: any[] = Array.isArray(data?.list) ? data.list : [];
        for (const item of list) {
          const f = item && typeof item === 'object' && item.file && typeof item.file === 'object' ? item.file : item;
          if (!f?.id) continue;
          const t = String(f.type ?? f.fileType ?? '').toLowerCase();
          const folder = t === 'folder' || t === 'dir' || f.isDir === true || f.isFolder === true;
          if (folder) {
            if (job.depth < 30) folderQueue.push({ id: String(f.id), folders: [...job.folders, String(f.name ?? '')], depth: job.depth + 1 });
          } else {
            const size = Number(f.size);
            const hash = f.hash?.vgroup ?? f.vgroup ?? null;
            files.push({
              id: String(f.id),
              name: String(f.name ?? f.id),
              size: Number.isFinite(size) ? size : null,
              hash: hash ? String(hash) : null,
              folders: job.folders,
            });
          }
        }
        const pg = data?.pagination;
        const hasNext = pg ? Boolean(pg.hasNext ?? (pg.totalPages && page < pg.totalPages)) : list.length >= 100;
        if (!hasNext || list.length === 0) break;
      }
    };

    // フォルダの待ち行列を concurrency 本ずつ並行して処理する
    await new Promise<void>((resolve) => {
      const pump = () => {
        if (failure) {
          if (active === 0) resolve();
          return;
        }
        while (active < concurrency && folderQueue.length > 0) {
          const job = folderQueue.shift()!;
          active++;
          listFolder(job)
            .catch((e) => {
              failure = e;
            })
            .finally(() => {
              active--;
              pump();
            });
        }
        if (active === 0 && folderQueue.length === 0) resolve();
      };
      pump();
    });
    if (failure) throw failure;

    return { ok: true, shareName, files, requests };
  } catch (e: any) {
    let detail: unknown = null;
    try {
      detail = JSON.parse(JSON.stringify(e?.data ?? e?.response?.data ?? null));
    } catch {
      detail = null;
    }
    return { ok: false, error: String(e?.message ?? e), detail };
  }
}

export async function linkexBridgeCall(req: BridgeRequest): Promise<BridgeResult> {
  const toPlain = (value: unknown): unknown => {
    try {
      return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    } catch {
      return String(value);
    }
  };

  try {
    const w = window as unknown as { __linkexMotrixClient?: any };
    if (!w.__linkexMotrixClient) {
      const pattern = /\/drive\/assets\/js\/index-[^/]+\.js(\?.*)?$/;
      const fromScripts = Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]'))
        .map((s) => s.src)
        .find((src) => pattern.test(src));
      const fromResources = performance
        .getEntriesByType('resource')
        .map((e) => e.name)
        .find((name) => pattern.test(name));
      const src = fromScripts ?? fromResources;
      if (!src) return { ok: false, error: 'index_not_found' };

      const mod: Record<string, unknown> = await import(/* @vite-ignore */ src);
      const client = Object.values(mod).find((v: any) =>
        v && typeof v === 'object' &&
        typeof v.get === 'function' &&
        typeof v.post === 'function' &&
        v.instance && typeof v.instance.request === 'function',
      );
      if (!client) return { ok: false, error: 'client_not_found' };
      w.__linkexMotrixClient = client;
    }

    const client = w.__linkexMotrixClient;
    // 画面にエラー表示を出さないよう skipGlobalMessage を付ける
    const config = { skipGlobalMessage: true };
    const res = req.method === 'get'
      ? await client.get(req.path, req.params, config)
      : await client.post(req.path, req.data, config);
    return { ok: true, data: toPlain(res) };
  } catch (e: any) {
    let loggedIn: boolean | null = null;
    try {
      // Web版はログイン情報をここに置いている。失敗の理由がログイン切れかを見分けるために使う
      loggedIn = Boolean(localStorage.getItem('linkex_credentials'));
    } catch {
      loggedIn = null;
    }
    return {
      ok: false,
      error: String(e?.message ?? e),
      detail: toPlain(e?.data ?? e?.response?.data ?? null),
      status: Number(e?.response?.status ?? e?.status) || null,
      loggedIn,
    };
  }
}
