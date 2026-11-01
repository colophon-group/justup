import { createContext, useContext, useLayoutEffect, useRef } from "react";
import type { ReactNode } from "react";

// Suspension removes the native modal layer while preserving the caller's dialog intent.
export const DialogSuspension = createContext(false);
export const useDialogSuspended = () => useContext(DialogSuspension);

interface Props {
  open: boolean;
  onClose: () => void;
  labelledBy: string;
  describedBy?: string;
  id?: string;
  children: ReactNode;
}
export function Dialog({
  open,
  onClose,
  labelledBy,
  describedBy,
  id,
  children,
}: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const suspended = useDialogSuspended();
  const programmaticCloses = useRef(0);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (open && !suspended && !node.open) node.showModal();
    if ((!open || suspended) && node.open) { programmaticCloses.current++; node.close(); }
  }, [open, suspended]);
  useLayoutEffect(() => {
    const node = ref.current;
    return () => {
      if (node?.open) { programmaticCloses.current++; node.close(); }
    };
  }, []);
  return (
    <dialog
      ref={ref}
      id={id}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onCancel={(event) => {
        event.preventDefault();
        if (!suspended) onClose();
      }}
      onClose={() => {
        if (programmaticCloses.current) { programmaticCloses.current--; return; }
        if (open && !suspended && !ref.current?.open) onClose();
      }}
      onClick={(event) => {
        if (suspended || event.target !== event.currentTarget) return;
        const box = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < box.left ||
          event.clientX > box.right ||
          event.clientY < box.top ||
          event.clientY > box.bottom
        )
          onClose();
      }}
    >
      {children}
    </dialog>
  );
}
