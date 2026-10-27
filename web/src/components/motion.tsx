// Shared motion: page and step transitions, staggered lists, counting numbers. Everything respects
// prefers-reduced-motion through <MotionConfig reducedMotion="user"> in App.
import clsx from "clsx";
import { animate, motion, useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef, type ReactNode } from "react";

export { AnimatePresence, motion } from "motion/react";

export const EASE = [0.22, 1, 0.36, 1] as const;
export const spring = { type: "spring", stiffness: 420, damping: 34, mass: 0.8 } as const;

export function PageTransition({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div className={className} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28, ease: EASE }}>
      {children}
    </motion.div>
  );
}

/** Slides content in from the direction of travel (dir 1 = forward, -1 = back). */
export function StepTransition({ stepKey, dir, children, className }: { stepKey: string; dir: number; children: ReactNode; className?: string }) {
  return (
    <motion.div
      key={stepKey}
      className={className}
      initial={{ opacity: 0, x: dir * 28 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.32, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}

export function Stagger({ children, className, delay = 0, step = 0.04 }: { children: ReactNode; className?: string; delay?: number; step?: number }) {
  return (
    <motion.div className={className} initial="hidden" animate="show" variants={{ hidden: {}, show: { transition: { staggerChildren: step, delayChildren: delay } } }}>
      {children}
    </motion.div>
  );
}

export function StaggerItem({ children, className, layout }: { children: ReactNode; className?: string; layout?: boolean }) {
  return (
    <motion.div
      layout={layout}
      className={className}
      variants={{ hidden: { opacity: 0, y: 10, scale: 0.985 }, show: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.34, ease: EASE } } }}
    >
      {children}
    </motion.div>
  );
}

/** A number that counts to its new value. */
export function AnimatedNumber({ value, format = (n) => Math.round(n).toLocaleString("de-DE"), className }: { value: number; format?: (n: number) => string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const from = useRef(value);
  const reduce = useReducedMotion();
  const inView = useInView(ref, { once: true });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reduce || !inView) {
      el.textContent = format(value);
      from.current = value;
      return;
    }
    const controls = animate(from.current, value, {
      duration: 0.7,
      ease: EASE,
      onUpdate: (n) => (el.textContent = format(n)),
    });
    from.current = value;
    return () => controls.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, inView, reduce]);
  return (
    <span ref={ref} className={clsx("num", className)}>
      {format(value)}
    </span>
  );
}

/** Briefly highlights its child when `pulseKey` changes (e.g. a figure that just updated). */
export function Pulse({ pulseKey, children, className }: { pulseKey: unknown; children: ReactNode; className?: string }) {
  return (
    <motion.span
      key={String(pulseKey)}
      className={clsx("inline-block rounded", className)}
      initial={{ backgroundColor: "rgba(109,67,209,0.16)" }}
      animate={{ backgroundColor: "rgba(109,67,209,0)" }}
      transition={{ duration: 1.2 }}
    >
      {children}
    </motion.span>
  );
}
