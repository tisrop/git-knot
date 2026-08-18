import { useEffect, useRef, type FormEventHandler, type ReactNode } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function dialogTabTargetIndex(activeIndex: number, count: number, backwards: boolean) {
  if (count <= 0) return null;
  if (activeIndex < 0) return backwards ? count - 1 : 0;
  if (backwards && activeIndex === 0) return count - 1;
  if (!backwards && activeIndex === count - 1) return 0;
  return null;
}

export function canDismissDialog(busy: boolean) {
  return !busy;
}

export function shouldReturnDialogFocus(targetConnected: boolean, hasRemainingModal: boolean) {
  return targetConnected && !hasRemainingModal;
}

function focusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => {
      const style = window.getComputedStyle(element);
      return element.tabIndex >= 0 && style.display !== "none" && style.visibility !== "hidden";
    },
  );
}

interface DialogProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className: string;
  ariaLabelledBy: string;
  ariaDescribedBy?: string;
  role?: "dialog" | "alertdialog";
  busy?: boolean;
  as?: "section" | "form";
  onSubmit?: FormEventHandler<HTMLFormElement>;
  backdropClassName?: string;
  closeOnBackdrop?: boolean;
  returnFocusElement?: HTMLElement | null;
  fallbackFocusElement?: HTMLElement | null;
}

export function Dialog({
  open,
  onClose,
  children,
  className,
  ariaLabelledBy,
  ariaDescribedBy,
  role = "dialog",
  busy = false,
  as = "section",
  onSubmit,
  backdropClassName = "confirmation-backdrop",
  closeOnBackdrop = false,
  returnFocusElement = null,
  fallbackFocusElement = null,
}: DialogProps) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const fallbackFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(busy);
  onCloseRef.current = onClose;
  busyRef.current = busy;

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current =
      returnFocusElement ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    fallbackFocusRef.current = fallbackFocusElement;

    const dialog = dialogRef.current;
    const backdrop = dialog?.parentElement ?? null;
    const backgroundElements = Array.from(document.body.children)
      .filter(
        (element): element is HTMLElement => element instanceof HTMLElement && element !== backdrop,
      )
      .map((element) => ({
        element,
        inert: element.inert,
        ariaHidden: element.getAttribute("aria-hidden"),
      }));
    for (const { element } of backgroundElements) {
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    }

    const focusInitial = () => {
      const currentDialog = dialogRef.current;
      if (!currentDialog) return;
      if (
        document.activeElement instanceof HTMLElement &&
        currentDialog.contains(document.activeElement)
      ) {
        return;
      }
      const initial =
        currentDialog.querySelector<HTMLElement>("[data-dialog-initial-focus='true']") ??
        currentDialog.querySelector<HTMLElement>("[autofocus]") ??
        focusableElements(currentDialog)[0] ??
        currentDialog;
      initial.focus();
    };

    const frame = window.requestAnimationFrame(focusInitial);
    const handleKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (event.key === "Escape" && !event.isComposing) {
        if (!canDismissDialog(busyRef.current)) return;
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const elements = focusableElements(dialog);
      if (elements.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const activeIndex = elements.indexOf(document.activeElement as HTMLElement);
      const targetIndex = dialogTabTargetIndex(activeIndex, elements.length, event.shiftKey);
      if (targetIndex === null) return;
      event.preventDefault();
      (elements[targetIndex] ?? dialog).focus();
    };
    const handleFocusIn = (event: FocusEvent) => {
      const dialog = dialogRef.current;
      if (!dialog || dialog.contains(event.target as Node)) return;
      (focusableElements(dialog)[0] ?? dialog).focus();
    };

    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("focusin", handleFocusIn, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("focusin", handleFocusIn, true);
      for (const { element, inert, ariaHidden } of backgroundElements) {
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", ariaHidden);
      }
      const returnTarget = returnFocusRef.current;
      const fallbackTarget = fallbackFocusRef.current;
      window.requestAnimationFrame(() => {
        const remainingModal = Array.from(document.querySelectorAll('[aria-modal="true"]')).find(
          (element) => element !== dialog,
        );
        if (remainingModal) return;
        const focusTarget = returnTarget?.isConnected ? returnTarget : fallbackTarget;
        if (shouldReturnDialogFocus(Boolean(focusTarget?.isConnected), false)) focusTarget?.focus();
      });
    };
  }, [open]);

  if (!open) return null;

  const setDialogRef = (node: HTMLElement | null) => {
    dialogRef.current = node;
  };
  const commonProps = {
    className,
    role,
    "aria-modal": true,
    "aria-labelledby": ariaLabelledBy,
    "aria-describedby": ariaDescribedBy,
    "aria-busy": busy || undefined,
    tabIndex: -1,
    onMouseDown: (event: React.MouseEvent) => event.stopPropagation(),
  } as const;
  const content =
    as === "form" ? (
      <form {...commonProps} ref={setDialogRef} onSubmit={onSubmit}>
        {children}
      </form>
    ) : (
      <section {...commonProps} ref={setDialogRef}>
        {children}
      </section>
    );

  return createPortal(
    <div
      className={backdropClassName}
      role="presentation"
      onMouseDown={(event) => {
        if (
          event.target === event.currentTarget &&
          closeOnBackdrop &&
          canDismissDialog(busyRef.current)
        ) {
          onCloseRef.current();
        }
      }}
    >
      {content}
    </div>,
    document.body,
  );
}
