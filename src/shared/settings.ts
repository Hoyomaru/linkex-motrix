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
  /** すべて終わったとき・止まったときにWindowsの通知を出す */
  notifications: boolean;
  /** 右クリックやページ内のリンク収集で追加したら、すぐ開始する */
  autoStartOnAdd: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  rpcUrl: 'http://127.0.0.1:16800/jsonrpc',
  rpcSecret: '',
  downloadDir: '',
  apiIntervalMs: 300,
  pauseOnTrafficLimit: true,
  maxDownloads: 3,
  notifications: true,
  autoStartOnAdd: true,
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
