/**
 * Caret-insertion glue for text editing surfaces — DOM-touching, so it lives
 * here rather than in `packages/doc-model`'s DOM-free `richtext.ts`.
 */

/**
 * Inserts `char` at the focused element's current caret/selection, then
 * restores focus and moves the caret past what was inserted. `onChange` is
 * whatever the caller already uses to commit an edited value — an inserted
 * symbol becomes an ordinary edit to that value, so it composes with
 * rich-text reconciliation for free rather than needing its own commit path.
 */
export function insertAtCaret(
  el: HTMLTextAreaElement | HTMLInputElement,
  char: string,
  value: string,
  onChange: (next: string) => void,
): void {
  const start = el.selectionStart ?? value.length;
  const end = el.selectionEnd ?? value.length;
  onChange(value.slice(0, start) + char + value.slice(end));
  const caret = start + char.length;
  requestAnimationFrame(() => {
    el.focus();
    el.setSelectionRange(caret, caret);
  });
}
