// Shared keyboard containment for the existing modal and pickup overlay.
export function containDialogFocus(dialog: HTMLElement): () => void {
  const previous = document.activeElement as HTMLElement | null;
  const controls = () => [...dialog.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,[tabindex]')]
    .filter(el => !el.hasAttribute('disabled') && el.tabIndex >= 0 && el.getClientRects().length > 0);
  const focus = () => (controls()[0] || dialog).focus();
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Tab') return;
    const items = controls(), first = items[0], last = items[items.length - 1];
    if (!first) { event.preventDefault(); dialog.focus(); return; }
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
      event.preventDefault(); first.focus();
    }
  };
  focus();
  document.addEventListener('keydown', onKey);
  return () => {
    document.removeEventListener('keydown', onKey);
    if (previous?.isConnected) previous.focus({ preventScroll: true });
  };
}
