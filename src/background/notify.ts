import { loadSettings } from '../shared/settings';

/**
 * Windowsの通知を出す。設定で切っていれば何もしない。
 * 同じ id の通知は上書きされるので、同じ種類の知らせが積み重ならない。
 */
export async function notify(id: string, title: string, message: string): Promise<void> {
  const { notifications } = await loadSettings();
  if (!notifications) return;
  try {
    await chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
      title,
      message,
      priority: 1,
    });
  } catch {
    // 通知が出せなくても処理は続ける
  }
}

/** 通知を押したら専用ページを開く */
export function setupNotificationClick(openDashboard: () => Promise<unknown>): void {
  chrome.notifications.onClicked.addListener((id) => {
    void openDashboard();
    void chrome.notifications.clear(id);
  });
}
