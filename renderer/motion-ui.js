import { animate, hover, press, stagger } from "motion";

const media = window.matchMedia("(prefers-reduced-motion: reduce)");
const boundChrome = new WeakSet();
let sequence = 0;

function reduced() {
  return media.matches;
}

function token(el) {
  const value = String(++sequence);
  el.dataset.motion = value;
  return value;
}

function clearStyles(el) {
  if (el.getAnimations) {
    for (const animation of el.getAnimations()) animation.cancel();
  }
  el.style.opacity = "";
  el.style.transform = "";
  el.style.transformOrigin = "";
  el.style.scale = "";
}

function reset(el) {
  if (!el) return;
  delete el.dataset.motion;
  clearStyles(el);
  if (el.classList.contains("fold-panel") || el.classList.contains("agent-tools-body")) {
    el.style.height = "";
    el.style.overflow = "";
  }
}

function run(el, keyframes, options) {
  reset(el);
  if (!el || reduced()) return Promise.resolve();
  const value = token(el);
  try { return finish(el, value, animate(el, keyframes, options)); }
  catch { reset(el); return Promise.resolve(); }
}

media.addEventListener("change", () => {
  if (reduced()) document.querySelectorAll("[data-motion]").forEach(reset);
});

function finish(el, value, animation) {
  return Promise.resolve(animation && animation.finished)
    .catch(() => {})
    .finally(() => {
      if (el.dataset.motion !== value) return;
      clearStyles(el);
      delete el.dataset.motion;
    });
}

// Only the first screen enters; cache refreshes and selection retain their rows.
function rows(nodes) {
  const list = Array.prototype.slice.call(nodes || [], 0, 12);
  if (!list.length || reduced()) return;
  const delay = stagger(0.004);
  list.forEach((el, i) => run(el, { opacity: [0, 1], y: [3, 0] }, { duration: 0.12, delay: delay(i, list.length) }));
}

function prepare(el) {
  if (!el || reduced()) return;
  el.style.opacity = "0";
}

function enter(el) {
  if (!el) return;
  if (reduced()) {
    clearStyles(el);
    return;
  }
  const value = token(el);
  finish(el, value, animate(el, { opacity: [0, 1], y: [8, 0] }, { duration: 0.16 }));
}

function dialogIn(dialog) {
  if (!dialog) return;
  if (reduced()) {
    clearStyles(dialog);
    return;
  }
  const value = token(dialog);
  finish(dialog, value, animate(dialog, { opacity: [0, 1], y: [8, 0] }, { duration: 0.16 }));
}

function whenDone(animation, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    Promise.resolve(animation && animation.finished).then(() => {
      clearTimeout(timer);
      resolve();
    }, () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function dialogOut(dialog) {
  if (!dialog || reduced()) return Promise.resolve();
  // New token so the open animation does not clear styles before close.
  token(dialog);
  try {
    return whenDone(animate(dialog, { opacity: 0, y: 6 }, { duration: 0.12 }), 240);
  } catch {
    return Promise.resolve();
  }
}

function wantsCloseMotion() {
  return !reduced();
}

function fadePane(el, axis) {
  if (!el || reduced() || el.hidden) return;
  const value = token(el);
  const from = axis === "x" ? { opacity: [0, 1], x: [-10, 0] } : { opacity: [0, 1], y: [8, 0] };
  finish(el, value, animate(el, from, { duration: 0.16 }));
}

function sections(nodes) {
  const list = Array.prototype.slice.call(nodes || [], 0, 8).filter((el) => el && !el.hidden);
  if (!list.length || reduced()) return;
  // A short shared transition avoids hiding later sections for half a second.
  list.forEach((el) => run(el, { opacity: [0.65, 1], y: [4, 0] }, { duration: 0.12 }));
}

function fold(body, open) {
  if (!body) return Promise.resolve();
  reset(body);
  body.style.height = "";
  body.style.overflow = "";
  // Commit layout once. Animating height forces layout on every frame, and a
  // measured pixel height clips content that arrives later over IPC.
  body.hidden = !open;
  if (!open || reduced()) return Promise.resolve();
  return run(body, { opacity: [0.65, 1], y: [3, 0] }, { duration: 0.12 });
}

function bindChrome(root) {
  const targets = root.querySelectorAll("header button.primary, .rail-btn, dialog button.primary, #compose-quote-toggle, #compose-quote-collapse, .fold-toggle, .section-nav button");
  targets.forEach((el) => {
    if (boundChrome.has(el)) return;
    boundChrome.add(el);
    hover(el, () => {
      if (reduced()) return;
      run(el, { scale: 1.02 }, { duration: 0.1 });
      return () => {
        if (reduced()) {
          clearStyles(el);
          return;
        }
        run(el, { scale: 1 }, { duration: 0.08 });
      };
    });
    press(el, () => {
      if (reduced()) return;
      run(el, { scale: 0.98 }, { duration: 0.06 });
      return () => {
        run(el, { scale: 1 }, { duration: 0.08 });
      };
    });
  });
}

window.morrowMotion = {
  rows,
  reset,
  prepare,
  enter,
  dialogIn,
  dialogOut,
  wantsCloseMotion,
  bindChrome,
  fadePane,
  sections,
  fold,
  reduced,
};
