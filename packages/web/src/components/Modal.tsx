import { useEffect, useId, useRef, type ReactNode } from "react";

export interface ModalProps {
  title: string;
  onClose?: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** When false the backdrop and Escape do not close (blocking prompts). */
  dismissable?: boolean;
}

export function Modal({ title, onClose, children, footer, wide, dismissable = true }: ModalProps) {
  const dialog=useRef<HTMLDivElement>(null),titleId=useId();
  const focusable=()=>[...(dialog.current?.querySelectorAll<HTMLElement>('button,a[href],input,select,textarea,[tabindex]')??[])].filter(element=>element.tabIndex>=0&&!element.matches(':disabled')&&element.getAttribute('aria-disabled')!=='true'&&element.getClientRects().length>0&&getComputedStyle(element).visibility!=='hidden');
  useEffect(()=>{const opener=document.activeElement instanceof HTMLElement?document.activeElement:null;(focusable()[0]??dialog.current)?.focus();return()=>{if(opener?.isConnected)opener.focus();};},[]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const current=dialog.current,dialogs=document.querySelectorAll('[role="dialog"]');
      if(!current||dialogs[dialogs.length-1]!==current||e.defaultPrevented)return;
      if (e.key === "Escape" && dismissable){e.preventDefault();onClose?.();}
      if(e.key==='Tab'){
        const items=focusable(),active=document.activeElement,index=items.indexOf(active as HTMLElement);
        if(!items.length){e.preventDefault();current.focus();}
        else if(index<0||!e.shiftKey&&index===items.length-1||e.shiftKey&&index===0){e.preventDefault();items[e.shiftKey?items.length-1:0].focus();}
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, dismissable]);
  return (
    <div className="modal-backdrop" onMouseDown={() => dismissable && onClose?.()}>
      <div className={`modal ${wide ? "modal-wide" : ""}`} ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 id={titleId}>{title}</h3>
          {dismissable && onClose && (
            <button className="btn btn-icon" onClick={onClose} aria-label="Close">
              ×
            </button>
          )}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
