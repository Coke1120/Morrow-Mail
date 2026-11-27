"use strict";

// Offline desktop regression: ./node_modules/.bin/electron scripts/check-pdf-preview-size.cjs
const { app, BrowserWindow, ipcMain, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "morrow-pdf-size-")));
app.disableHardwareAcceleration();

function a4Fixture() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << >> /Contents 4 0 R >>",
    "<< /Length 0 >>\nstream\nendstream",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((object, i) => {
    const offset = pdf.length;
    pdf += (i + 1) + " 0 obj\n" + object + "\nendobj\n";
    return offset;
  });
  return Buffer.from(pdf + "xref\n0 5\n0000000000 65535 f \n" +
    offsets.map(offset => String(offset).padStart(10, "0") + " 00000 n \n").join("") +
    "trailer\n<< /Root 1 0 R /Size 5 >>\nstartxref\n" + pdf.length + "\n%%EOF\n");
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_request, done) => done({ cancel: true }));
  const preload = path.join(app.getPath("userData"), "fixture.cjs");
  fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require("electron");
    contextBridge.exposeInMainWorld("morrow",{invoke:(channel,payload)=>ipcRenderer.invoke("fixture",channel,payload),on:()=>{}});`);
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNb8AAAAASUVORK5CYII=", "base64");
  const requests = [];
  const startupBarrier = new Promise(() => {});
  ipcMain.handle("fixture", (_event, channel, payload) => {
    if (channel === "app:getVersion") return startupBarrier;
    if (channel === "mail:fetchAttachmentBytes") {
      const id = payload.attachmentId;
      requests.push(id);
      return { success: true, data: id === "image" ? image : a4Fixture() };
    }
    return { success: true, data: [] };
  });
  const win = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: true, backgroundThrottling: false } });
  await win.loadFile(path.resolve(__dirname, "../renderer/index.html"));
  const run = code => win.webContents.executeJavaScript(code);
  win.webContents.debugger.attach("1.3");
  const cdp = (method, params) => win.webContents.debugger.sendCommand(method, params);
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const viewport = (width, height) => cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await viewport(1280, 1380);
  await run(`
    state.accounts = [{ id:"fixture", email:"reader@example.invalid", platform:"imap", folders:{primary:[],more:[]} }];
    state.accountId = "fixture";
    state.email = { id:"mail", accountId:"fixture", subject:"Fixture", from:"sender@example.invalid", to:"reader@example.invalid",
      bodyComplete:true, textBody:"Two attachments", attachments:[{id:"pdf",filename:"a4.pdf",size:500},{id:"image",filename:"pixel.png",size:68}] };
    state.thread = [state.email];
    renderReader(false);
    document.querySelector("#reader .attachment-toggle").click();
    document.querySelector('#reader .attachment-actions [aria-label="Preview a4.pdf"]').click();
  `);
  const until = async code => {
    for (let i = 0; i < 200; i++) {
      if (await run(code)) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw Error("Timed out: " + code + "; " + await run(`$("attachment-preview-status").textContent`));
  };
  await until(`$("attachment-preview").open && !$("attachment-preview-pages").hidden && $("attachment-preview-status").hidden`);
  const measure = () => run(`(() => {
    const {width,height,top,left,bottom,right} = $("attachment-preview").getBoundingClientRect();
    const stage = $("attachment-preview-stage"), page = stage.querySelector("canvas");
    const close = $("attachment-preview-close").getBoundingClientRect();
    return {width,height,top,left,bottom,right,innerWidth,innerHeight,
      closeInside:close.right<=right && close.bottom<=bottom, clientHeight:stage.clientHeight, scrollHeight:stage.scrollHeight,
      page:page && {width:page.clientWidth,height:page.clientHeight}};
  })()`);
  const large = await measure();
  assert.ok(Math.abs(large.width - (210 * 96 / 25.4 + 84)) < 1, JSON.stringify(large));
  assert.ok(Math.abs(large.height - (297 * 96 / 25.4 + 136)) < 1, JSON.stringify(large));
  assert.ok(Math.abs(large.page.width - 210 * 96 / 25.4) < 20 && large.scrollHeight <= large.clientHeight + 2, JSON.stringify(large));
  await viewport(540, 620);
  const small = await measure();
  assert.ok(small.left >= 11 && small.right <= small.innerWidth - 11 && small.top >= 15 && small.bottom <= small.innerHeight - 15, JSON.stringify(small));
  assert.ok(small.closeInside && small.clientHeight > 100 && small.scrollHeight > small.clientHeight, JSON.stringify(small));
  await run(`$("attachment-preview-close").click()`);
  await until(`!$("attachment-preview").open && !$("attachment-preview-stage").classList.contains("is-pdf")`);
  await viewport(1280, 1380);
  await run(`document.querySelector('#reader .attachment-actions [aria-label="Preview pixel.png"]').click()`);
  await until(`$("attachment-preview").open && !$("attachment-preview-image").hidden`);
  const picture = await measure();
  assert.deepEqual([picture.width, picture.height], [960, 760]);
  assert.deepEqual(requests, ["pdf", "image"]);
  console.log("PDF_PREVIEW_SIZE_OK", JSON.stringify({large, small, image: [picture.width, picture.height]}));
  app.exit(0);
}).catch(error => { console.error(error.stack || error); app.exit(1); });
