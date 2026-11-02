export interface Settings {
  /** Motrix（aria2）のRPC接続先 */
  rpcUrl: string;
  /** Motrixの「RPCシークレット」 */
  rpcSecret: string;
  /** ダウンロード先の基準フォルダ（空ならMotrixの既定フォルダ） */
  downloadDir: string;
  /** Linkex APIを呼ぶ間隔（ミリ秒）。一時的な速度制限を避けるため */
  apiIntervalMs: number;
  /** 公式Web版と同じく、転送量の上限に達したら一時停止する */
  pauseOnTrafficLimit: boolean;
  /** 同時ダウンロード数 */
  maxDownloads: number;
}

export const DEFAULT_SETTINGS: Settings = {
  rpcUrl: 'http://127.0.0.1:16800/jsonrpc',
  rpcSecret: '',
  downloadDir: '',
  apiIntervalMs: 300,
  pauseOnTrafficLimit: true,
  maxDownloads: 3,
};

const KEY = 'settings';

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[KEY] as Partial<Settings> | undefined) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}
