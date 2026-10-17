const { app, BrowserWindow } = require("electron");
const path = require("path");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function restTransform(value) {
  return value === "none" || value === "matrix(1, 0, 0, 1, 0, 0)";
}

async function sample(win) {
  return win.webContents.executeJavaScript(`(async () => {
    const motion = window.genmailMotion;
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const rowHost = document.getElementById("messages");
    const row = document.createElement("button");
    row.className = "message";
    row.textContent = "Motion row";
    rowHost.appendChild(row);
    motion.rows([row]);
    await sleep(40);
    const rowEarly = Number(getComputedStyle(row).opacity);
    await sleep(360);
    const rowLate = Number(getComputedStyle(row).opacity);
    const rowTransform = getComputedStyle(row).transform;
    wire();
    const rail = document.querySelector(".rail-btn");
    const beforeHover = getComputedStyle(rail).transform;
    rail.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true, pointerType: "mouse", isPrimary: true }));
    await sleep(80);
    const hoverTransform = getComputedStyle(rail).transform;
    const hoverScale = getComputedStyle(rail).scale;
    rail.dispatchEvent(new PointerEvent("pointerleave", { bubbles: true, pointerType: "mouse", isPrimary: true }));
    openDialog("settings");
    const dialog = document.getElementById("settings");
    await sleep(40);
    const openOpacity = Number(getComputedStyle(dialog).opacity);
    const openBox = dialog.getBoundingClientRect();
    await sleep(280);
    const settledOpacity = Number(getComputedStyle(dialog).opacity);
    const settledBox = dialog.getBoundingClientRect();
    const closeStarted = performance.now();
    closeDialog("settings");
    await sleep(80);
    const closingOpacity = Number(getComputedStyle(dialog).opacity);
    await sleep(280);
    showAgent();
    const agent = document.getElementById("agent-panel");
    await sleep(40);
    const agentOpacity = Number(getComputedStyle(agent).opacity);
    return {
      reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
      rowEarly,
      rowLate,
      rowTransform,
      rowInline: row.style.transform,
      beforeHover,
      hoverTransform,
      hoverScale,
      openOpacity,
      settledOpacity,
      openCenter: openBox.left + openBox.width / 2,
      settledCenter: settledBox.left + settledBox.width / 2,
      viewMid: window.innerWidth / 2,
      closingOpacity,
      closeMs: performance.now() - closeStarted,
      closed: !dialog.open,
      agentOpacity,
      agentHidden: agent.hidden,
      shellHidden: document.getElementById("shell").hidden,
    };
  })()`, true);
}

function checkNormal(data) {
  assert(data.reduced === false, "expected motion allowed");
  assert(data.rowEarly < 0.95, `row did not enter, opacity ${data.rowEarly}`);
  assert(data.rowLate > 0.95, `row did not finish, opacity ${data.rowLate}`);
  assert(restTransform(data.rowTransform), `row transform left set: ${data.rowTransform} inline ${data.rowInline}`);
  assert(data.hoverTransform !== "none" || (data.hoverScale && data.hoverScale !== "none"), `rail hover did not scale (${data.hoverTransform} / ${data.hoverScale})`);
  assert(data.openOpacity < 0.95, `dialog did not enter, opacity ${data.openOpacity}`);
  assert(data.settledOpacity > 0.95, `dialog did not finish, opacity ${data.settledOpacity}`);
  assert(Math.abs(data.openCenter - data.viewMid) < 3, `dialog off center while opening (${data.openCenter} vs ${data.viewMid})`);
  assert(Math.abs(data.settledCenter - data.viewMid) < 3, `dialog off center when open (${data.settledCenter} vs ${data.viewMid})`);
  assert(data.closingOpacity < 0.95, `dialog did not leave, opacity ${data.closingOpacity}`);
  assert(data.closed === true, "dialog did not close");
  assert(data.agentHidden === false, "agent panel stayed hidden");
  assert(data.shellHidden === true, "mail shell stayed visible on agent");
  assert(data.agentOpacity < 0.98, `agent panel did not enter, opacity ${data.agentOpacity}`);
}

function checkReduced(data) {
  assert(data.reduced === true, "expected reduced motion");
  assert(data.rowEarly === 1 && data.rowLate === 1, `reduced row opacity ${data.rowEarly} ${data.rowLate}`);
  assert(data.openOpacity === 1 && data.settledOpacity === 1, `reduced dialog opacity ${data.openOpacity}`);
  assert(Math.abs(data.settledCenter - data.viewMid) < 3, `reduced dialog off center (${data.settledCenter} vs ${data.viewMid})`);
  assert(data.closed === true, "reduced dialog did not close");
  assert(data.hoverTransform === "none" || data.hoverTransform === data.beforeHover, `reduced hover changed transform (${data.hoverTransform})`);
  assert(data.agentHidden === false && data.agentOpacity === 1, `reduced agent opacity ${data.agentOpacity}`);
}

async function openWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: true,
    webPreferences: { contextIsolation: true, sandbox: false },
  });
  await win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  return win;
}

app.whenReady().then(async () => {
  try {
    const normalWin = await openWindow();
    const normal = await sample(normalWin);
    console.log(JSON.stringify(normal));
    checkNormal(normal);
    const reducedWin = await openWindow();
    reducedWin.webContents.debugger.attach("1.3");
    await reducedWin.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    await reducedWin.webContents.reload();
    const reduced = await sample(reducedWin);
    console.log(JSON.stringify(reduced));
    checkReduced(reduced);
    console.log("MOTION_CHECK_OK");
    app.exit(0);
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    app.exit(1);
  }
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
