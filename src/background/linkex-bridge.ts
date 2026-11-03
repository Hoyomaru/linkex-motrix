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
    // ドライブのページでも共有ページでも動く。共有の中身はログインなしで読めるので、
    // 共有ページ（/landing/assets/js/index-*.js）の通信用の部品でもよい
    const w = window as unknown as { __linkexMotrixWalkClient?: any };
    if (!w.__linkexMotrixWalkClient) {
      const sources = [
        ...Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')).map((s) => s.src),
        ...performance.getEntriesByType('resource').map((e) => e.name),
      ];
      const src =
        sources.find((s) => /\/drive\/assets\/js\/index-[^/]+\.js(\?.*)?$/.test(s)) ??
        sources.find((s) => /\/landing\/assets\/js\/index-[^/]+\.js(\?.*)?$/.test(s));
      if (!src) return { ok: false, error: 'index_not_found' };
      const mod: Record<string, unknown> = await import(/* @vite-ignore */ src);
      const client = Object.values(mod).find((v: any) =>
        v && typeof v === 'object' && typeof v.get === 'function' && typeof v.post === 'function' &&
        v.instance && typeof v.instance.request === 'function',
      );
      if (!client) return { ok: false, error: 'client_not_found' };
      w.__linkexMotrixWalkClient = client;
    }
    const client = w.__linkexMotrixWalkClient;
    const config = { skipGlobalMessage: true };
    let requests = 0;

    // 途中経過。Service Worker が少しずつ読みに来て、画面に件数を出す
    const progressStore = ((window as any).__linkexMotrixWalkProgress ??= {}) as Record<string, any>;
    const progress = { files: 0, bytes: 0, folders: 0, requests: 0, done: false };
    progressStore[token] = progress;

    // すべての通信をまとめて concurrency 本までに抑える
    let running = 0;
    const waiters: (() => void)[] = [];
    const limit = async <T>(fn: () => Promise<T>): Promise<T> => {
      while (running >= concurrency) await new Promise<void>((r) => waiters.push(r));
      running++;
      try {
        return await fn();
      } finally {
        running--;
        waiters.shift()?.();
      }
    };
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

    /** 1回の取得。一時的な失敗（速度制限など）は少し待って2回までやり直す */
    const get = (path: string, params: unknown) =>
      limit(async () => {
        for (let attempt = 0; ; attempt++) {
          try {
            requests++;
            progress.requests = requests;
            const res = await client.get(path, params, config);
            if (res && typeof res === 'object' && 'code' in res && res.code !== 0) {
              throw new Error(`${path}: ${res.message} (code ${res.code})`);
            }
            return res?.data;
          } catch (e: any) {
            // やり直すのは速度制限・サーバー側の失敗・通信の失敗だけ（「見つからない」などはすぐ返す）
            const status = Number(e?.code ?? e?.status ?? e?.response?.status) || 0;
            const temporary = status === 0 || status === 429 || status >= 500;
            if (!temporary || attempt >= 2) throw e;
            await wait(800 * (attempt + 1));
          }
        }
      });

    const info = await get('/api/drive/v1/share/get', { share_token: token });
    const shareName = String(info?.share?.name ?? info?.name ?? info?.title ?? token);

    const PAGE_SIZE = 100;
    type Job = { id?: string; folders: string[]; depth: number };
    const fetchPage = (job: Job, page: number) =>
      get('/api/drive/v1/share/get/content', {
        share_token: token,
        ...(job.id ? { parent_id: job.id } : {}),
        page,
        page_size: PAGE_SIZE,
        need_parents: false,
      });

    /** 1ページ分を、そのフォルダのファイルとサブフォルダに分ける */
    const split = (job: Job, data: any) => {
      const list: any[] = Array.isArray(data?.list) ? data.list : [];
      const own: WalkedFile[] = [];
      const subs: Job[] = [];
      for (const item of list) {
        const f = item && typeof item === 'object' && item.file && typeof item.file === 'object' ? item.file : item;
        if (!f?.id) continue;
        const t = String(f.type ?? f.fileType ?? '').toLowerCase();
        const folder = t === 'folder' || t === 'dir' || f.isDir === true || f.isFolder === true;
        if (folder) {
          if (job.depth < 30) subs.push({ id: String(f.id), folders: [...job.folders, String(f.name ?? '')], depth: job.depth + 1 });
        } else {
          // 一覧の size は実際の中身とずれていることがある。サムネイルのURL（…/<md5>/<実サイズ>）に
          // 本当のサイズと中身のハッシュが入っているので、取れればそちらを使う
          const pool = /\/pool\/pub\/(?:[0-9a-f]{2}\/){3}([0-9a-f]{32})\/(\d+)/.exec(String(f.cover ?? ''));
          const size = pool ? Number(pool[2]) : Number(f.size);
          const hash = f.hash?.vgroup ?? f.vgroup ?? (pool ? `${pool[1]}_${pool[2]}` : null);
          own.push({
            id: String(f.id),
            name: String(f.name ?? f.id),
            size: Number.isFinite(size) ? size : null,
            hash: hash ? String(hash) : null,
            folders: job.folders,
          });
          progress.files++;
          if (Number.isFinite(size)) progress.bytes += size;
        }
      }
      return { own, subs, count: list.length };
    };

    /**
     * フォルダを読む。2ページ目以降は総ページ数が分かれば並行して読み、
     * サブフォルダも並行して読む。結果は共有の中の並びどおりにそろえて返す。
     */
    const walk = async (job: Job): Promise<WalkedFile[]> => {
      progress.folders++;
      const first = await fetchPage(job, 1);
      const pages = [split(job, first)];
      const pg = first?.pagination;
      // 総ページ数の見込み。分かれば2ページ目以降をまとめて並行に読む
      const guess = Math.min(
        500,
        Number(pg?.totalPages) || (Number(pg?.total) ? Math.ceil(Number(pg.total) / PAGE_SIZE) : 1),
      );
      let lastData = first;
      if (guess > 1) {
        const rest = await Promise.all(
          Array.from({ length: guess - 1 }, (_, i) => fetchPage(job, i + 2)),
        );
        for (const data of rest) pages.push(split(job, data));
        lastData = rest[rest.length - 1];
      }
      // 見込みが外れていても取りこぼさないよう、次があるあいだは1ページずつ続ける
      for (let page = pages.length + 1; page <= 500; page++) {
        const last = pages[pages.length - 1];
        const hasNext = lastData?.pagination?.hasNext ?? last.count >= PAGE_SIZE;
        if (!hasNext || last.count === 0) break;
        lastData = await fetchPage(job, page);
        pages.push(split(job, lastData));
      }
      const subs = pages.flatMap((p) => p.subs);
      const children = await Promise.all(subs.map(walk));
      return [...pages.flatMap((p) => p.own), ...children.flat()];
    };

    let files: WalkedFile[];
    try {
      files = await walk({ folders: [], depth: 0 });
    } finally {
      progress.done = true;
    }

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
