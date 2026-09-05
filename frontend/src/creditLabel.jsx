import { createContext, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { resolveCreditTerms } from "./theme";
import TooltipIcon from "./Tooltip.svg";

const CreditLabelContext = createContext(resolveCreditTerms());
const GpaBasisContext = createContext("credits");
const ShowScoreContext = createContext(true);
const TooltipsContext = createContext(true);

export function CreditLabelProvider({ appearance, gpaBasis, children }) {
  const resolvedGpaBasis = gpaBasis || appearance?.gpaBasis || "credits";
  return (
    <CreditLabelContext.Provider value={resolveCreditTerms(appearance)}>
      <GpaBasisContext.Provider value={resolvedGpaBasis}>
        <ShowScoreContext.Provider value={appearance?.showScore !== false}>
          <TooltipsContext.Provider value={appearance?.tooltips !== false}>
            {children}
          </TooltipsContext.Provider>
        </ShowScoreContext.Provider>
      </GpaBasisContext.Provider>
    </CreditLabelContext.Provider>
  );
}

export function useCreditTerms() {
  return useContext(CreditLabelContext);
}

export function useGpaBasis() {
  return useContext(GpaBasisContext);
}

export function useShowScore() {
  return useContext(ShowScoreContext);
}

export function useTooltips() {
  return useContext(TooltipsContext);
}

export function Tooltip({ text, side = "auto", children = null, anchor = "parent" }) {
  const enabled = useTooltips();
  const anchorRef = useRef(null);
  const popupRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState(null);

  useEffect(() => {
    if (!enabled || !text || !open || !anchorRef.current || !popupRef.current) return undefined;
    const lineAnchor = !children && side !== "right" && anchor !== "icon" ? anchorRef.current.parentElement : null;
    const anchorRect = (lineAnchor || anchorRef.current).getBoundingClientRect();
    const popup = popupRef.current.getBoundingClientRect();
    const margin = 12;
    const rightAlignedLeft = anchorRect.right + 8;
    const centeredLeft = anchorRect.left + (anchorRect.width - popup.width) / 2;
    const left = side === "right"
      ? Math.min(Math.max(rightAlignedLeft, margin), window.innerWidth - popup.width - margin)
      : Math.min(Math.max(centeredLeft, margin), window.innerWidth - popup.width - margin);
    const centeredTop = anchorRect.top + (anchorRect.height - popup.height) / 2;
    const below = anchorRect.bottom + 8;
    const above = anchorRect.top - popup.height - 8;
    const top = side === "right"
      ? Math.min(Math.max(centeredTop, margin), window.innerHeight - popup.height - margin)
      : below + popup.height <= window.innerHeight - margin
        ? below
        : above >= margin
          ? above
          : Math.min(Math.max(below, margin), window.innerHeight - popup.height - margin);
    setPosition({ left, top });
    return undefined;
  }, [enabled, open, side, text]);

  if (!enabled || !text) return children || null;

  const popup = open ? createPortal(
    <span
      ref={popupRef}
      className="info-tooltip-popup is-open"
      role="tooltip"
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        zIndex: 1200,
        opacity: position ? 1 : 0,
        transform: position ? "translateY(0)" : "translateY(-3px)",
      }}
    >
      {text}
    </span>,
    document.body
  ) : null;

  return (
    <span
      ref={anchorRef}
      className={`info-tooltip ${children ? "info-tooltip-with-content" : ""} ${side === "right" ? "info-tooltip-right" : ""} ${open ? "is-open" : ""}`.trim()}
      tabIndex={children ? -1 : 0}
      aria-label="Information"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children || <span className="info-tooltip-icon" style={{ "--info-tooltip-icon-url": `url("${TooltipIcon}")` }} aria-hidden="true" />}
      {popup}
    </span>
  );
}
