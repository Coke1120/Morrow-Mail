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

function fadePane(el, axis) {
  if (!el || reduced() || el.hidden) return;
  const value = token(el);
  const from = axis === "x" ? { opacity: [0, 1], x: [-10, 0] } : { opacity: [0, 1], y: [8, 0] };
  finish(el, value, animate(el, from, { duration: 0.16 }));
}

function sections(nodes) {
  const list = Array.prototype.slice.call(nodes || [], 0, 8).filter((el) => el && !el.hidden);
  if (!list.length || reduced()) return;
  try {
    const animation = animate(list, { opacity: [0, 1], y: [8, 0] }, { duration: 0.2, delay: stagger(0.04) });
    animation.finished.then(() => {
      for (const el of list) if (el.isConnected) clearStyles(el);
    }).catch(() => {
      for (const el of list) clearStyles(el);
    });
  } catch {
    for (const el of list) clearStyles(el);
  }
}

function fold(body, open) {
  if (!body) return Promise.resolve();
  if (reduced()) {
    body.hidden = !open;
    body.style.height = "";
    body.style.opacity = "";
    body.style.overflow = "";
    return Promise.resolve();
  }
  const value = token(body);
  const settle = (hide) => {
    if (body.dataset.motion !== value) return;
    body.hidden = hide;
    clearStyles(body);
    delete body.dataset.motion;
  };
  body.hidden = false;
  body.style.overflow = "hidden";
  body.style.height = "auto";
  const full = body.scrollHeight;
  let animation;
  try {
    if (open) {
      body.style.height = "0px";
      body.style.opacity = "0";
      animation = animate(body, { height: [0, full], opacity: [0, 1] }, { duration: 0.22, ease: "easeOut" });
    } else {
      body.style.height = full + "px";
      animation = animate(body, { height: [full, 0], opacity: [1, 0] }, { duration: 0.16, ease: "easeOut" });
    }
  } catch {
    settle(!open);
    return Promise.resolve();
  }
  return Promise.resolve(animation.finished).catch(() => {}).finally(() => settle(!open));
}

function bindChrome(root) {
  const targets = root.querySelectorAll("header button.primary, .rail-btn, dialog button.primary, #compose-quote-toggle, #compose-quote-collapse, .fold-toggle, .section-nav button");
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

window.morrowMotion = {
  rows,
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
