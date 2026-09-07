import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const DEFAULT_REPO = "WinstonBaker/grade-calculator";

export default function FeedbackBubble({ repo }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const panelRef = useRef(null);
  const bubbleRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(event) {
      if (
        panelRef.current
        && !panelRef.current.contains(event.target)
        && !bubbleRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    }
    function onKeyDown(event) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function submit(event) {
    event.preventDefault();
    const text = message.trim();
    if (!text) return;
    const who = name.trim() || "Anonymous";
    const title = text.length > 72 ? `${text.slice(0, 69)}…` : text;
    const body = [
      text,
      "",
      `— ${who}`,
      "",
      "_Sent from Grade Calculator feedback_",
    ].join("\n");
    const targetRepo = (repo || DEFAULT_REPO).replace(/^https?:\/\/github\.com\//, "");
    const url = `https://github.com/${targetRepo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
    window.open(url, "_blank", "noopener,noreferrer");
    setMessage("");
    setOpen(false);
  }

  const panel = open ? createPortal(
        <form className="feedback-panel" onSubmit={submit}>
          <div className="feedback-panel-head">
            <strong>Send feedback</strong>
            <button className="btn small" type="button" onClick={() => setOpen(false)} aria-label="Close feedback">
              ×
            </button>
          </div>
          <p className="muted feedback-note">
            Opens a GitHub issue so it is saved for the project. A free GitHub account is needed to submit.
          </p>
          <label className="muted">
            Name (optional)
            <input
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Anonymous"
            />
          </label>
          <label className="muted">
            Message
            <textarea
              className="input feedback-message"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              rows={4}
              required
              placeholder="Report a bug, idea, or class grading structure that can't be implemented"
            />
          </label>
          <button className="btn small primary" type="submit" disabled={!message.trim()}>
            Continue on GitHub
          </button>
        </form>
      , document.body) : null;

  return (
    <div className="feedback-bubble" ref={bubbleRef}>
      {panel}
      <button
        className={`feedback-fab ${open ? "active" : ""}`}
        type="button"
        aria-label="Send feedback"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8A2.5 2.5 0 0 1 17.5 16H10l-4.2 3.15c-.7.52-1.7.03-1.7-.82V5.5Z"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  );
}
