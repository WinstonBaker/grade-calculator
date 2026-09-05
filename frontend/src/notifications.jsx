import { createContext, useCallback, useContext, useMemo, useState } from "react";
import snoozeIcon from "./assets/Snooze.svg";

const ToastContext = createContext(null);

let toastSeq = 0;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback((toast) => {
    const id = toast.id || `toast-${Date.now()}-${++toastSeq}`;
    setToasts((current) => {
      const withoutDup = toast.id ? current.filter((item) => item.id !== toast.id) : current;
      return [{ ...toast, id }, ...withoutDup];
    });
    return id;
  }, []);

  const warning = useCallback(
    (message, options = {}) =>
      push({
        type: "timed",
        tone: "warning",
        message,
        durationMs: options.durationMs ?? 5000,
        ...options,
      }),
    [push]
  );

  const value = useMemo(() => ({ toasts, push, dismiss, warning }), [toasts, push, dismiss, warning]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastHost toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToasts() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToasts must be used within ToastProvider");
  return ctx;
}

function ToastHost({ toasts, onDismiss }) {
  return (
    <div className="toast-host" aria-live="polite" aria-relevant="additions">
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastCard({ toast, onDismiss }) {
  const timed = toast.type === "timed";
  const durationMs = toast.durationMs ?? 5000;

  return (
    <div className={`toast toast-${toast.tone || toast.type || "info"}`} role="status">
      <div className="toast-body">
        <div className="toast-content">
          {toast.title ? <strong className="toast-title">{toast.title}</strong> : null}
          <p className="toast-message">{toast.message}</p>
          {toast.body ? <div className="toast-extra">{toast.body}</div> : null}
        </div>
        <div className="toast-actions">
          {toast.onConfirm ? (
            <button
              type="button"
              className="toast-action toast-confirm"
              aria-label={toast.confirmLabel || "Confirm"}
              onClick={() => {
                toast.onConfirm?.();
                if (toast.dismissOnConfirm !== false) onDismiss(toast.id);
              }}
            >
              ✓
            </button>
          ) : null}
          {(toast.type === "persistent" || toast.onDismissAction || toast.onConfirm) && (
            <button
              type="button"
              className="toast-action toast-dismiss"
              aria-label={toast.dismissLabel || "Dismiss"}
              onClick={() => {
                toast.onDismissAction?.();
                onDismiss(toast.id);
              }}
            >
              {toast.dismissIcon === "zzz" ? (
                <img className="toast-snooze-icon" src={snoozeIcon} alt="" aria-hidden="true" />
              ) : (
                toast.dismissIcon || "×"
              )}
            </button>
          )}
        </div>
      </div>
      {timed ? (
        <div className="toast-timer" aria-hidden="true">
          <span
            className="toast-timer-bar"
            style={{ animationDuration: `${durationMs}ms` }}
            onAnimationEnd={() => onDismiss(toast.id)}
          />
        </div>
      ) : null}
    </div>
  );
}
