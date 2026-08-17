import { useEffect, useRef, useState } from "react";

function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/**
 * Eases toward `target` for counter-style stats.
 * The final frame is the exact target, so displayed precision never drifts.
 */
export function useAnimatedNumber(target, duration = 600) {
  const [value, setValue] = useState(target);
  const fromRef = useRef(Number(target) || 0);
  const frameRef = useRef(0);

  useEffect(() => {
    const to = Number(target);
    if (target == null || Number.isNaN(to) || prefersReducedMotion()) {
      setValue(target);
      fromRef.current = Number.isNaN(to) ? 0 : to;
      return undefined;
    }

    const from = fromRef.current;
    if (from === to) {
      setValue(to);
      return undefined;
    }

    const start = performance.now();
    const step = (now) => {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - progress) ** 3;
      if (progress < 1) {
        setValue(from + (to - from) * eased);
        frameRef.current = requestAnimationFrame(step);
      } else {
        setValue(to);
        fromRef.current = to;
      }
    };

    frameRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frameRef.current);
  }, [target, duration]);

  return value;
}
