import { send, type LinkexEnvelope } from './messages';

/** 画面側から Linkex API を呼ぶための薄いラッパー。応答のキーは camelCase */
async function call<T>(method: 'get' | 'post', path: string, payload?: unknown): Promise<T> {
  const res = await send<LinkexEnvelope<T>>({
    type: 'linkex.call',
    method,
    path,
    ...(method === 'get' ? { params: payload } : { data: payload }),
  });
  if (!res.ok) throw new Error(res.error);
  const env = res.data;
  if (env && typeof env === 'object' && 'code' in env && env.code !== 0) {
    throw new Error(`Linkex: ${env.message} (code ${env.code})`);
  }
  return (env as LinkexEnvelope<T>).data;
}

export interface Usage { totalSpace: number; usedSpace: number }
export interface Traffic { usedTraffic: number; totalTraffic: number; resetTime: number }

export const linkexApi = {
  usage: () => call<Usage>('get', '/api/drive/v1/usage'),
  traffic: () => call<Traffic>('get', '/api/drive/v1/traffic'),

  share: (shareToken: string) => call<any>('get', '/api/drive/v1/share/get', { share_token: shareToken }),
  shareContent: (shareToken: string, parentId?: string, page = 1) =>
    call<any>('get', '/api/drive/v1/share/get/content', {
      share_token: shareToken,
      ...(parentId ? { parent_id: parentId } : {}),
      page,
      page_size: 100,
      need_parents: true,
    }),

  /** 共有のファイルを自分のストレージに保存する（非同期タスク） */
  copyFromShare: (shareToken: string, fileId: string) =>
    call<any>('post', '/api/drive/v1/file/copy', {
      share_token: shareToken,
      collection: { select_all: false, file_ids: [fileId] },
      async: true,
    }),
  task: (taskId: string) => call<any>('get', '/api/drive/v1/task/get', { task_id: taskId }),

  myFiles: (parentId?: string, page = 1) =>
    call<any>('get', '/api/drive/v1/file/list', {
      keyword: '',
      page,
      page_size: 100,
      order: 'name',
      desc: false,
      need_parents: true,
      ...(parentId ? { parent_id: parentId } : {}),
    }),
  fileGet: (fileId: string) => call<any>('get', '/api/drive/v1/file/get', { file_id: fileId }),

  /** ゴミ箱へ移動（容量はまだ空かない） */
  moveToTrash: (fileId: string) =>
    call<any>('post', '/api/drive/v1/file/delete', { collection: { select_all: false, file_ids: [fileId] } }),
  trashList: (page = 1) => call<any>('get', '/api/drive/v1/file/trash/list', { page, page_size: 100 }),
  restore: (fileId: string) => call<any>('post', '/api/drive/v1/file/trash/restore', { file_ids: [fileId] }),
  /** ゴミ箱から完全削除（取り消せない）。引数の形は段階0で確認する */
  deleteForever: (fileId: string) => call<any>('post', '/api/drive/v1/file/trash/delete', { file_ids: [fileId] }),
};

export { unwrapFile, isFolder, formatBytes } from './files';
