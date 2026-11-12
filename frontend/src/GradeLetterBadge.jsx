import { useLayoutEffect, useRef } from "react";

const GRADE_DROP_CHANCE = 0.1;
const EDIT_IDLE_MS = 1000;
const FADE_MS = 120;

function badgeFace(className, letter = "") {
  const face = document.createElement("span");
  face.className = `${className} grade-letter-face`;
  face.textContent = letter;
  face.setAttribute("aria-hidden", "true");
  return face;
}

function playGradeRipple(badge, previousClass, nextClass) {
  const outgoing = badgeFace(previousClass);
  const incoming = badgeFace(nextClass);
  badge.prepend(outgoing, incoming);
  badge.classList.add("grade-letter-rippling");

  const timing = { duration: 300, easing: "ease-out", fill: "both" };
  const outgoingMotion = outgoing.animate([
    { opacity: 1 },
    { opacity: 0 },
  ], timing);
  const incomingMotion = incoming.animate([
    { clipPath: "circle(0% at 50% 50%)" },
    { clipPath: "circle(72% at 50% 50%)" },
  ], timing);

  let finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    outgoingMotion.cancel();
    incomingMotion.cancel();
    outgoing.remove();
    incoming.remove();
    badge.classList.remove("grade-letter-rippling");
  }

  incomingMotion.onfinish = finish;
  return { finish };
}

function gradePosition(x, y, turns = 0) {
  return `translate(${x}px, ${y}px) rotate(${turns}turn)`;
}

function playGradeDrop(badge, tile, previous, onFinish) {
  const slot = badge.getBoundingClientRect();
  const panel = tile?.getBoundingClientRect();
  if (!panel || !slot.width || !slot.height || slot.top < 0
      || slot.bottom > panel.top || panel.top >= window.innerHeight) return null;

  const radius = slot.height / 2;
  const centerX = slot.left + slot.width / 2;
  const contactY = panel.top - slot.bottom;
  const edgeX = panel.right - slot.width / 2 - centerX;
  const exitX = window.innerWidth + slot.width / 2 + 12 - centerX;
  const exitY = Math.min(window.innerHeight - slot.top + 12, contactY + slot.height * 5);
  const circumference = Math.PI * slot.height;
  const rollingPosition = (x, y) => gradePosition(x, y, x / circumference);
  if (centerX < panel.left || edgeX <= 0 || panel.right >= window.innerWidth) return null;

  const layer = document.createElement("div");
  layer.className = "grade-letter-motion-layer";
  layer.setAttribute("aria-hidden", "true");

  function movingBadge(letter, className) {
    const copy = document.createElement("span");
    copy.className = `${className} grade-letter-motion-copy`;
    copy.textContent = letter;
    Object.assign(copy.style, {
      left: `${slot.left}px`,
      top: `${slot.top}px`,
      width: `${slot.width}px`,
      height: `${slot.height}px`,
    });
    layer.append(copy);
    return copy;
  }

  const outgoing = movingBadge(previous.letter, previous.className);
  document.body.append(layer);
  badge.classList.add("grade-letter-in-motion");

  let incomingMotion;
  let fadeMotion;
  let finished = false;
  const rollStart = 565;
  const rollEnd = rollStart + 1880;
  const leapStart = rollEnd + 685;
  const leapDuration = 530;
  const duration = leapStart + leapDuration;
  const at = (time) => time / duration;
  const bounceDistance = Math.min(25, edgeX / 2);
  const rollDistance = edgeX - bounceDistance;
  // Keep each keyframe interval within a quarter turn. Translation and
  // rotation use the same progress so the badge rolls without slipping.
  const rollSteps = Math.max(1, Math.ceil(4 * rollDistance / circumference));
  const rollFrames = Array.from({ length: rollSteps + 1 }, (_, index) => {
    const progress = index / rollSteps;
    const x = bounceDistance + rollDistance * progress;
    return {
      transform: rollingPosition(x, contactY),
      offset: at(rollStart + (rollEnd - rollStart) * progress),
      easing: "linear",
    };
  });
  const edgeRotation = edgeX / circumference;
  const leapHeight = radius * 0.45;
  const rise = Math.sqrt(leapHeight);
  const descent = Math.sqrt(exitY - contactY + leapHeight);
  const leapFrames = Array.from({ length: 33 }, (_, index) => {
    const progress = index / 32;
    const x = edgeX + (exitX - edgeX) * (1 - (1 - progress) ** 2);
    const y = contactY - leapHeight + (progress * (rise + descent) - rise) ** 2;
    return {
      transform: gradePosition(x, y, edgeRotation),
      offset: at(leapStart + leapDuration * progress),
      easing: "linear",
    };
  });
  const outgoingMotion = outgoing.animate([
    { transform: gradePosition(0, 0), easing: "ease-in" },
    { transform: gradePosition(0, contactY), offset: at(332), easing: "ease-out" },
    { transform: rollingPosition(bounceDistance / 2, contactY - 9), offset: at(448), easing: "ease-in" },
    ...rollFrames,
    ...leapFrames,
  ], { duration, fill: "both" });

  function finish() {
    if (finished) return;
    finished = true;
    outgoingMotion.cancel();
    incomingMotion?.cancel();
    fadeMotion?.cancel();
    layer.remove();
    badge.classList.remove("grade-letter-in-motion");
    onFinish();
  }

  outgoingMotion.onfinish = () => {
    outgoing.remove();
    const incoming = movingBadge(badge.textContent, badge.className);
    incoming.classList.remove("grade-letter-in-motion");
    incomingMotion = incoming.animate([
      { transform: gradePosition(0, -slot.bottom - 12), easing: "ease-in" },
      { transform: gradePosition(0, contactY), offset: 0.57, easing: "ease-out" },
      { transform: gradePosition(0, -7), offset: 0.83, easing: "ease-in-out" },
      { transform: gradePosition(0, 0) },
    ], { duration: 750, fill: "both" });
    incomingMotion.onfinish = finish;
  };

  return {
    finish,
    fade() {
      if (finished || fadeMotion) return;
      outgoingMotion.onfinish = null;
      outgoingMotion.pause();
      incomingMotion?.pause();
      if (incomingMotion) incomingMotion.onfinish = null;
      badge.classList.remove("grade-letter-in-motion");
      fadeMotion = layer.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, fill: "both" });
      fadeMotion.onfinish = finish;
    },
  };
}

export default function GradeLetterBadge({ letter, className, rank, settingsTileRef, animateChanges }) {
  const badgeRef = useRef(null);
  const updateMotion = useRef(null);

  useLayoutEffect(() => {
    const badge = badgeRef.current;
    if (!animateChanges || typeof badge.animate !== "function") return undefined;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let previous;
    let pending;
    let heldFace;
    let idleTimer;
    let activeDrop;
    let ripple;

    function clearPendingDrop() {
      clearTimeout(idleTimer);
      const outgoing = pending;
      pending = null;
      heldFace?.remove();
      heldFace = null;
      badge.classList.remove("grade-letter-awaiting-drop");
      return outgoing;
    }

    function waitForIdle() {
      clearTimeout(idleTimer);
      if (!pending) return;
      idleTimer = setTimeout(() => {
        const outgoing = clearPendingDrop();
        if (reducedMotion.matches) return;
        activeDrop = playGradeDrop(badge, settingsTileRef.current, outgoing, () => { activeDrop = null; });
        if (!activeDrop) ripple = playGradeRipple(badge, outgoing.className, previous.className);
      }, EDIT_IDLE_MS);
    }

    updateMotion.current = (next) => {
      const outgoing = previous;
      previous = next;
      if (!outgoing || outgoing.letter === next.letter) {
        if (pending) badge.classList.add("grade-letter-awaiting-drop");
        if (outgoing?.className !== next.className) ripple?.finish();
        return;
      }
      const visibleGrade = clearPendingDrop() ?? outgoing;
      const interrupted = Boolean(activeDrop);
      activeDrop?.fade();
      ripple?.finish();
      if (interrupted || reducedMotion.matches) return;

      if (outgoing.rank != null && next.rank != null && next.rank < outgoing.rank
          && Math.random() < GRADE_DROP_CHANCE) {
        pending = visibleGrade;
        heldFace = badgeFace(visibleGrade.className, visibleGrade.letter);
        badge.prepend(heldFace);
        badge.classList.add("grade-letter-awaiting-drop");
        waitForIdle();
      } else if (visibleGrade.letter !== next.letter) {
        ripple = playGradeRipple(badge, visibleGrade.className, next.className);
      }
    };

    function editActivity(event) {
      if (!pending && !activeDrop) return;
      if (!(event.target instanceof Element)) return;
      const editable = event.target.closest("input, textarea, select, [contenteditable='true']");
      const control = event.target.closest("button, [role='button'], [role='menuitem']");
      if (!editable && !(event.type === "click" && control)) return;
      activeDrop?.fade();
      waitForIdle();
    }

    function onLayoutChange() {
      activeDrop?.fade();
    }

    function onMotionPreferenceChange() {
      if (!reducedMotion.matches) return;
      clearPendingDrop();
      ripple?.finish();
      activeDrop?.finish();
    }

    const editEvents = ["input", "change", "keydown", "pointerdown", "click"];
    editEvents.forEach((type) => document.addEventListener(type, editActivity, true));
    document.addEventListener("scroll", onLayoutChange, true);
    window.addEventListener("resize", onLayoutChange);
    reducedMotion.addEventListener("change", onMotionPreferenceChange);
    return () => {
      clearPendingDrop();
      ripple?.finish();
      activeDrop?.finish();
      editEvents.forEach((type) => document.removeEventListener(type, editActivity, true));
      document.removeEventListener("scroll", onLayoutChange, true);
      window.removeEventListener("resize", onLayoutChange);
      reducedMotion.removeEventListener("change", onMotionPreferenceChange);
      updateMotion.current = null;
    };
  }, [animateChanges, settingsTileRef]);

  useLayoutEffect(() => {
    updateMotion.current?.({ letter, rank, className });
  }, [animateChanges, letter, rank, className]);

  return (
    <span ref={badgeRef} className={`${className} grade-letter-badge`}>
      <span className="grade-letter-text">{letter || "—"}</span>
    </span>
  );
}
