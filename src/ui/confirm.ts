/**
 * 2回押して確定するボタン（共通の決まりごと: 取り消せない操作・まとめて消す操作）。
 * 1回目でボタンの文字が確認の文に変わり、4秒以内にもう一度押すと true を返す。
 * 時間が切れると元に戻る。
 */
const ARM_MS = 4000;
const timers = new WeakMap<HTMLButtonElement, ReturnType<typeof setTimeout>>();

function disarm(button: HTMLButtonElement) {
  clearTimeout(timers.get(button));
  timers.delete(button);
  if (button.dataset.label !== undefined) button.textContent = button.dataset.label;
  delete button.dataset.label;
  button.classList.remove('armed');
}

/** クリックの最初に呼ぶ。実行してよければ true（2回目）、確認待ちにしただけなら false */
export function secondPress(button: HTMLButtonElement, confirmLabel: string): boolean {
  if (timers.has(button)) {
    disarm(button);
    return true;
  }
  button.dataset.label = button.textContent ?? '';
  button.textContent = confirmLabel;
  button.classList.add('armed');
  timers.set(button, setTimeout(() => disarm(button), ARM_MS));
  return false;
}

/**
 * 描き直しで作り直されるボタン用。確認待ちの状態をキーで覚えておく。
 * armed(key) が true の間は、描くときに確認の文を出す。
 */
export class ArmedKeys {
  private until = new Map<string, number>();
  constructor(private onChange: () => void) {}

  armed(key: string): boolean {
    return (this.until.get(key) ?? 0) > Date.now();
  }

  /** 2回目なら true。1回目なら確認待ちにして描き直しを頼み、false */
  press(key: string): boolean {
    if (this.armed(key)) {
      this.until.delete(key);
      this.onChange();
      return true;
    }
    this.until.set(key, Date.now() + ARM_MS);
    this.onChange();
    setTimeout(() => this.onChange(), ARM_MS + 50);
    return false;
  }
}
