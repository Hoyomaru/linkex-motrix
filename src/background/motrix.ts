import { loadSettings } from '../shared/settings';

let nextId = 1;

/** Motrix に内蔵された aria2 の JSON-RPC を呼ぶ */
export async function aria2<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const { rpcUrl, rpcSecret } = await loadSettings();
  const body = {
    jsonrpc: '2.0',
    id: String(nextId++),
    method: `aria2.${method}`,
    params: rpcSecret ? [`token:${rpcSecret}`, ...params] : params,
  };

  let res: Response;
  try {
    res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('Motrixに接続できません。Motrixが起動しているか、接続先の設定を確認してください');
  }

  const json = (await res.json().catch(() => null)) as
    | { result?: T; error?: { code: number; message: string } }
    | null;
  if (!json) throw new Error(`Motrixから不正な応答がありました（HTTP ${res.status}）`);
  if (json.error) {
    const hint = /unauthorized/i.test(json.error.message) ? '（RPCシークレットが違う可能性があります）' : '';
    throw new Error(`Motrixのエラー: ${json.error.message}${hint}`);
  }
  return json.result as T;
}

export async function getVersion(): Promise<{ version: string }> {
  return aria2('getVersion');
}

/**
 * ダウンロードを追加して GID を返す。
 * dir は基準フォルダからの相対パスを受け取り、設定の基準フォルダとつなげる。
 */
export async function addDownload(url: string, opts: { dir?: string; out?: string } = {}): Promise<string> {
  const { downloadDir } = await loadSettings();
  const options: Record<string, string> = {};
  const dir = joinDir(downloadDir, opts.dir ?? '');
  if (dir) options.dir = dir;
  if (opts.out) options.out = opts.out;
  return aria2<string>('addUri', [[url], options]);
}

export interface Aria2Status {
  gid: string;
  status: 'active' | 'waiting' | 'paused' | 'error' | 'complete' | 'removed';
  totalLength: string;
  completedLength: string;
  downloadSpeed: string;
  errorCode?: string;
  errorMessage?: string;
}

export async function tellStatus(gid: string): Promise<Aria2Status> {
  return aria2<Aria2Status>('tellStatus', [gid, STATUS_KEYS]);
}

const STATUS_KEYS = ['gid', 'status', 'totalLength', 'completedLength', 'downloadSpeed', 'errorCode', 'errorMessage'];

/** 終了済み（完了・失敗・取り消し）の一覧。Motrixが履歴を消していなければここに残る */
export async function tellStopped(limit = 1000): Promise<Aria2Status[]> {
  return aria2<Aria2Status[]>('tellStopped', [0, limit, STATUS_KEYS]);
}

function joinDir(base: string, rel: string): string {
  const parts = [base, rel].map((p) => p.replace(/[\\/]+$/, '')).filter(Boolean);
  if (parts.length === 0) return '';
  return parts.join('\\').replace(/\//g, '\\');
}
