// Electron check for the side-by-side translation window: original immediately,
// Translating… while pending, then the translation or the error. Panes scroll apart.
const { app, BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const outDir = process.env.MORROW_UX_EVIDENCE_DIR || "/opt/cursor/artifacts";
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-translate-window-"));
app.setPath("userData", path.join(temp, "profile"));
app.disableHardwareAcceleration();

const translateWindows = require("../host/translate-window");
const original = Array.from({ length: 80 }, (_, index) => "Original line " + index).join("\n") + "\nTAIL";
const translated = Array.from({ length: 80 }, (_, index) => "譯文 " + index).join("\n") + "\n尾";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run(win, code) {
  try {
    return await win.webContents.executeJavaScript(code, true);
  } catch (error) {
    throw new Error(code.slice(0, 140) + " :: " + error.message);
  }
}

async function waitFor(win, code) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await run(win, code)) return;
    await sleep(100);
  }
  throw new Error("UI condition timed out: " + code);
}

async function shot(win, name) {
  fs.mkdirSync(outDir, { recursive: true });
  await sleep(200);
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, name + ".png"), image.toPNG());
}

app.whenReady().then(async () => {
  ipcMain.handle("config:getTheme", () => "light");
  ipcMain.handle("morrow:configGetAccent", () => "#193C34");
  const host = translateWindows.createTranslateHost({
    getParent: () => null,
    preloadFile: path.join(root, "renderer/preload.js"),
    mode: () => "bundled",
    htmlFile: path.join(root, "renderer/index.html"),
    backgroundColor: "#e7f0e4",
  });
  host.register();
  const opened = host.open({
    reqId: "shot-loading",
    subject: "Quarterly update",
    language: "Traditional Chinese (繁體中文)",
    original: original,
    nodeIds: ["n0"],
  });
  assert.equal(opened.ok, true);
  const win = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed() && item.webContents.id === opened.id);
  assert.ok(win, "translation window opened");
  win.setSize(1100, 760);
  await waitFor(win, `document.documentElement.dataset.window === "translate"`);
  await waitFor(win, `document.querySelector("[data-role='translate-state']") && document.querySelector("[data-role='translate-state']").textContent.includes("Translating")`);
  await waitFor(win, `document.querySelector("[data-role='original']").textContent.includes("TAIL")`);
  const layout = await run(win, `({
    direction: getComputedStyle(document.querySelector(".translate-columns")).flexDirection,
    state: document.querySelector("[data-role='translate-state']").textContent,
    original: document.querySelector("[data-role='original']").textContent.includes("TAIL"),
    translated: document.querySelector("[data-role='translated']").textContent,
    close: [...document.querySelectorAll("button")].some((node) => node.textContent === "Close"),
    busy: document.querySelector("#reader").getAttribute("aria-busy")
  })`);
  assert.equal(layout.direction, "row");
  assert.match(layout.state, /Translating/);
  assert.equal(layout.original, true);
  assert.equal(layout.translated, "");
  assert.equal(layout.close, true);
  assert.equal(layout.busy, "true");
  const scroll = await run(win, `(() => {
    const left = document.querySelector("[data-role='original']").parentElement;
    const right = document.querySelector("[data-role='translated']").parentElement;
    left.scrollTop = 180;
    const rightBefore = right.scrollTop;
    left.scrollTop = 320;
    return { left: left.scrollTop, right: right.scrollTop, rightBefore: rightBefore, leftCan: left.scrollHeight > left.clientHeight };
  })()`);
  assert.equal(scroll.leftCan, true);
  assert.ok(scroll.left > 100);
  assert.equal(scroll.right, scroll.rightBefore);
  await shot(win, "translate-loading");

  translateWindows.note({ reqId: "shot-loading", type: "progress", current: 1, total: 4 });
  translateWindows.note({
    reqId: "shot-loading",
    type: "node",
    nodeId: "n0",
    translatedText: translated,
    status: "success",
  });
  translateWindows.note({ reqId: "shot-loading", type: "done" });
  await waitFor(win, `document.querySelector("[data-role='translated']").textContent.includes("尾")`);
  await waitFor(win, `document.querySelector("[data-role='translate-state']").hidden === true`);
  const done = await run(win, `({
    pending: document.querySelector("#reader").getAttribute("aria-busy"),
    errorHidden: document.querySelector("[data-role='translate-error']").hidden,
    original: document.querySelector("[data-role='original']").textContent.includes("TAIL")
  })`);
  assert.equal(done.pending, null);
  assert.equal(done.errorHidden, true);
  assert.equal(done.original, true);
  const apart = await run(win, `(() => {
    const left = document.querySelector("[data-role='original']").parentElement;
    const right = document.querySelector("[data-role='translated']").parentElement;
    left.scrollTop = 40;
    right.scrollTop = 220;
    const rightAt = right.scrollTop;
    left.scrollTop = 260;
    return { left: left.scrollTop, right: right.scrollTop, rightAt: rightAt };
  })()`);
  assert.ok(apart.left > apart.rightAt - 5 || apart.left !== apart.right);
  assert.equal(apart.right, apart.rightAt);
  await shot(win, "translate-success");

  const failed = host.open({
    reqId: "shot-error",
    subject: "Quarterly update",
    language: "Traditional Chinese (繁體中文)",
    original: original,
    nodeIds: ["n0"],
  });
  const errorWin = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed() && item.webContents.id === failed.id);
  assert.ok(errorWin);
  errorWin.setSize(1100, 760);
  await waitFor(errorWin, `document.querySelector("[data-role='original']") && document.querySelector("[data-role='original']").textContent.includes("TAIL")`);
  translateWindows.note({
    reqId: "shot-error",
    type: "error",
    message: "Add an API key in Morrow Mail → AI Setup.",
  });
  await waitFor(errorWin, `document.querySelector("[data-role='translate-error']").textContent.includes("API key")`);
  const failure = await run(errorWin, `({
    error: document.querySelector("[data-role='translate-error']").textContent,
    hidden: document.querySelector("[data-role='translate-error']").hidden,
    stateHidden: document.querySelector("[data-role='translate-state']").hidden,
    original: document.querySelector("[data-role='original']").textContent.includes("TAIL")
  })`);
  assert.match(failure.error, /API key/);
  assert.equal(failure.hidden, false);
  assert.equal(failure.stateHidden, true);
  assert.equal(failure.original, true);
  assert.equal(errorWin.isDestroyed(), false);
  await shot(errorWin, "translate-error");
  console.log("translate-window-ok");
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
