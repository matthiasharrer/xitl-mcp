// Toast state shared across views (copied from haushalts-todos, minus undo).
export type Toast = { id: number; text: string; error?: boolean };

export const shared = $state<{ toast: Toast | null }>({ toast: null });

let seq = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

export function showToast(text: string, opts: { error?: boolean } = {}) {
  clearTimeout(timer);
  shared.toast = { id: ++seq, text, ...opts };
  timer = setTimeout(() => (shared.toast = null), 6000);
}
