const active = new WeakMap();
export const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

export function stopMotion(node) {
  const animation = active.get(node);
  active.delete(node);
  animation?.cancel();
}

// A cancelled exit must never remove a surface that has already reopened.
export async function playMotion(node, frames, duration = 220) {
  stopMotion(node);
  if (reducedMotion() || !node.animate) return true;
  const animation = node.animate(frames, { duration, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'both' });
  active.set(node, animation);
  try {
    await animation.finished;
    if (active.get(node) !== animation) return false;
    active.delete(node); animation.cancel(); return true;
  } catch { if (active.get(node) === animation) active.delete(node); return false; }
}
