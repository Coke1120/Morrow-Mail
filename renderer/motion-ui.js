import { animate, hover, press, stagger } from "motion";

const media = window.matchMedia("(prefers-reduced-motion: reduce)");

function reduced() {
  return media.matches;
}

function token(el) {
  const value = `${Date.now()}-${Math.random()}`;
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
}

function finish(el, value, animation) {
  return Promise.resolve(animation && animation.finished)
    .catch(() => {})
    .finally(() => {
      if (el.dataset.motion !== value) return;
      clearStyles(el);
      delete el.dataset.motion;
    });
}

// First screen of rows only, so a long folder does not wait on the last one.
function rows(nodes) {
  const list = Array.prototype.slice.call(nodes || [], 0, 12);
  if (!list.length || reduced()) return;
  const animation = animate(list, { opacity: [0, 1], y: [4, 0] }, { duration: 0.14, delay: stagger(0.012) });
  animation.finished.then(() => {
    for (const el of list) {
      if (el.isConnected) clearStyles(el);
    }
  }).catch(() => {});
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

function bindChrome(root) {
  const targets = root.querySelectorAll("header button.primary, .rail-btn, dialog button.primary");
  targets.forEach((el) => {
    hover(el, () => {
      if (reduced()) return;
      animate(el, { scale: 1.02 }, { duration: 0.12 });
      return () => {
        if (reduced()) {
          clearStyles(el);
          return;
        }
        const back = animate(el, { scale: 1 }, { duration: 0.1 });
        back.finished.then(() => clearStyles(el)).catch(() => clearStyles(el));
      };
    });
    press(el, () => {
      if (reduced()) return;
      animate(el, { scale: 0.98 }, { duration: 0.06 });
      return () => {
        const back = animate(el, { scale: 1 }, { duration: 0.08 });
        back.finished.then(() => clearStyles(el)).catch(() => clearStyles(el));
      };
    });
  });
}

window.genmailMotion = {
  rows,
  prepare,
  enter,
  dialogIn,
  dialogOut,
  wantsCloseMotion,
  bindChrome,
};
