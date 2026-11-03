import { loadSettings } from '../shared/settings';
import { extractShareUrls } from '../shared/share-url';
import { start } from './engine';
import { enqueueShares } from './enqueue';
import { readEngine } from './store';
import { notify } from './notify';

const LINK_PATTERNS = [
  'https://www.linkex.io/f/*',
  'https://linkex.io/f/*',
  'https://www.linkex.io/s/*',
  'https://linkex.io/s/*',
  'https://l2e.click/d/*',
  'https://www.l2e.click/d/*',
];

/** 右クリックメニューを作る（インストール・更新のたびに作り直す） */
export function createMenus(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'add-link',
      title: 'Linkex Motrix のキューに追加',
      contexts: ['link'],
      targetUrlPatterns: LINK_PATTERNS,
    });
    chrome.contextMenus.create({
      id: 'add-selection',
      title: '選んだ文字の中のLinkexリンクをキューに追加',
      contexts: ['selection'],
    });
  });
}

export function setupMenuClicks(): void {
  chrome.contextMenus.onClicked.addListener((info) => {
    const text = info.menuItemId === 'add-link' ? info.linkUrl ?? '' : info.selectionText ?? '';
    void addFromMenu(text);
  });
}

async function addFromMenu(text: string): Promise<void> {
  const urls = extractShareUrls(text);
  if (urls.length === 0) {
    await notify('menu-add', 'Linkexのリンクが見つかりません', '選んだ部分に共有リンクが含まれていませんでした');
    return;
  }
  try {
    const r = await enqueueShares(urls.join('\n'));
    const parts = [`${r.added}件を追加しました`];
    if (r.alreadyQueued) parts.push(`すでにあった ${r.alreadyQueued}件`);
    if (r.failed.length) parts.push(`開けなかった共有 ${r.failed.length}件`);
    const { autoStartOnAdd } = await loadSettings();
    if (r.added > 0 && autoStartOnAdd && (await readEngine()).paused) {
      await start();
      parts.push('処理を開始しました');
    }
    await notify('menu-add', `リンク ${urls.length}件をキューへ`, parts.join('・'));
  } catch (e) {
    await notify('menu-add', 'キューに追加できませんでした', String((e as Error)?.message ?? e));
  }
}
