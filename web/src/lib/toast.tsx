import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

interface ToastSpec {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  ms?: number;
}

const Ctx = createContext<(t: ToastSpec) => void>(() => {});
export const useToast = () => useContext(Ctx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<(ToastSpec & { n: number }) | null>(null);
  const counter = useRef(0);
  const timer = useRef<number | undefined>(undefined);

  const show = useCallback((t: ToastSpec) => {
    counter.current += 1;
    setToast({ ...t, n: counter.current });
  }, []);

  useEffect(() => {
    if (!toast) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), toast.ms ?? 6000);
    return () => window.clearTimeout(timer.current);
  }, [toast]);

  return (
    <Ctx.Provider value={show}>
      {children}
      <div className="toast-region" role="status" aria-live="polite">
        {toast && (
          <div className="toast" key={toast.n}>
            <span>{toast.message}</span>
            {toast.actionLabel && (
              <button type="button" className="btn btn-quiet toast-action" onClick={() => { toast.onAction?.(); setToast(null); }}>
                {toast.actionLabel}
              </button>
            )}
          </div>
        )}
      </div>
    </Ctx.Provider>
  );
}
