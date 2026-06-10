/**
 * Animation presets (ADR-0044) — the one source of truth for springs,
 * easings, and shared variants. Components import from here so the motion
 * language stays consistent (and tweakable in one place).
 *
 * House rules:
 * - Canvas nodes animate on MOUNT ONLY (scale/opacity). React Flow owns
 *   x/y; never animate position or use `layout` on a canvas node.
 * - Exits stay <= 120ms so AnimatePresence never holds stale editors open.
 * - `MotionConfig reducedMotion="user"` in App.tsx disables transforms
 *   globally when the OS asks for reduced motion.
 */
import type { Transition, Variants } from "motion/react";

export const SPRING_SNAPPY: Transition = {
  type: "spring",
  stiffness: 420,
  damping: 32,
};

export const EASE_OUT = [0.22, 1, 0.36, 1] as const;

/** Pane orchestration: parent staggers, children rise in. */
export const paneStagger: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05, delayChildren: 0.02 } },
};
export const paneItem: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.45, ease: EASE_OUT } },
};

/** Canvas node mount pop. */
export const popIn: Variants = {
  hidden: { opacity: 0, scale: 0.85 },
  show: { opacity: 1, scale: 1, transition: SPRING_SNAPPY },
};

/** Inspector form swap on selection change. */
export const formSwap: Variants = {
  hidden: { opacity: 0, y: 4 },
  show: { opacity: 1, y: 0, transition: { duration: 0.16, ease: EASE_OUT } },
  exit: { opacity: 0, y: -4, transition: { duration: 0.1, ease: "easeIn" } },
};

/** Validation finding rows: drain away as they're fixed. */
export const findingItem: Variants = {
  hidden: { opacity: 0, x: -6 },
  show: { opacity: 1, x: 0, transition: { duration: 0.18, ease: EASE_OUT } },
  exit: { opacity: 0, x: 6, transition: { duration: 0.12, ease: "easeIn" } },
};

/** Whole-page swap (landing ↔ workbench) — opacity only. */
export const pageFade: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.25, ease: EASE_OUT } },
  exit: { opacity: 0, transition: { duration: 0.12, ease: "easeIn" } },
};

/** Banner / dropdown reveal (height collapses via an overflow-hidden wrap). */
export const reveal: Variants = {
  hidden: { height: 0, opacity: 0 },
  show: {
    height: "auto",
    opacity: 1,
    transition: { duration: 0.22, ease: EASE_OUT },
  },
  exit: { height: 0, opacity: 0, transition: { duration: 0.12, ease: "easeIn" } },
};
