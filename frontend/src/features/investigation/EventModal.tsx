import { X } from "lucide-react";
import { useEffect, useRef, type MouseEvent, type ReactNode, type SyntheticEvent } from "react";
import { makeT, type Language } from "../../shared/i18n";

type EventModalProps = {
  language: Language;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
};

/**
 * Native modal dialog: showModal() traps focus, Esc closes it, and it renders in the top layer above Leaflet.
 * Focus returns to the element that opened it when the dialog closes.
 */
export default function EventModal({ language, open, onClose, children }: EventModalProps) {
  const t = makeT(language);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const returnFocusRef = useRef<Element | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      returnFocusRef.current = document.activeElement;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    if (open) return;
    const target = returnFocusRef.current;
    if (target instanceof HTMLElement && target.isConnected) target.focus({ preventScroll: true });
  }, [open]);

  // Esc: let React state close the dialog so `open` stays the single source of truth.
  const cancel = (event: SyntheticEvent<HTMLDialogElement>) => {
    event.preventDefault();
    onClose();
  };
  // A click on the dialog element itself (not its content) is a click on the backdrop.
  const clickBackdrop = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target === dialogRef.current) onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      className="investigation-modal"
      aria-label={t("Детали события", "Event details")}
      onCancel={cancel}
      onClick={clickBackdrop}
    >
      <div className="investigation-modal-body">
        <button
          type="button"
          className="investigation-modal-close"
          aria-label={t("Закрыть", "Close")}
          onClick={onClose}
        >
          <X size={16} />
        </button>
        {children}
      </div>
    </dialog>
  );
}
