const stage = document.getElementById("stage");
const pages = document.getElementById("pages");
const save = document.getElementById("save");
const close = document.getElementById("cancel");
const status = document.getElementById("status");
const preview = new AbortController();
const api = window.receiptPdf;

close.addEventListener("click", () => { void api.cancel(); });
window.addEventListener("keydown", event => {
  if (event.key === "Escape" && !event.defaultPrevented) void api.cancel();
});
window.addEventListener("pagehide", () => preview.abort(), { once: true });

save.addEventListener("click", async () => {
  save.disabled = true;
  status.textContent = "";
  try {
    const result = await api.save();
    if (result?.error) status.textContent = result.error;
  } catch {
    status.textContent = "The PDF could not be saved. Try again.";
  } finally {
    save.disabled = false;
  }
});

async function render() {
  try {
    const data = await api.bytes();
    if (!data?.byteLength) throw new Error("No PDF bytes");
    let firstPage = false;
    await window.morrowPdf.render({
      data, pages, stage, signal: preview.signal, onFirstPage() { firstPage = true; },
    });
    if (preview.signal.aborted) return;
    if (!firstPage || !await api.ready()) throw new Error("No PDF preview");
    status.textContent = "";
    save.disabled = false;
  } catch {
    if (!preview.signal.aborted) status.textContent = "The PDF could not be previewed. Close this window and try again.";
  }
}
void render();
