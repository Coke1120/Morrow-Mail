// Native editing menu; suggestions come from Electron's configured spellchecker.
// No AI, renderer IPC channel, mail logging or automatic dictionary changes.
const { pathToFileURL } = require('node:url');

function composePage(url, htmlFile) {
  try {
    const value = new URL(url);
    if (value.searchParams.get('role') !== 'compose' || value.username || value.password) return false;
    return (value.protocol === 'morrow:' && value.host === 'local' && value.pathname === '/index.html')
      || (value.protocol === 'file:' && value.host === '' && value.origin === 'null' && value.pathname === new URL(pathToFileURL(htmlFile)).pathname);
  } catch { return false; }
}

// Keep field contents inside the renderer. Only a boolean crosses the boundary.
function captureTarget(sequence, keyboard, x, y) {
  const hit = keyboard ? document.activeElement : document.elementFromPoint(x, y);
  const node = hit?.closest?.('#compose-editor, input, textarea');
  const allowed = new Set(['compose-editor', 'compose-subject', 'compose-to', 'compose-cc', 'compose-bcc', 'ai-prompt']);
  if (!node || !allowed.has(node.id) || !node.closest('#compose')?.open || node.disabled || node.readOnly
      || (node.id === 'compose-editor' && !node.isContentEditable) || document.activeElement !== node) return false;
  const compose = typeof state === 'object' && state !== null ? state : null;
  if (compose?.composePending || compose?.composeQueued || compose?.composeInitializing || compose?.draftWrite?.pending) return false;
  const context = JSON.stringify([compose?.composeSession, compose?.composeMeta?.accountId, compose?.composeMeta?.fromAddress, compose?.draftId]);
  const key = Symbol.for('morrow.compose.editing-target');
  clearTimeout(globalThis[key]?.timer);
  const value = { sequence, node, context, text: node.isContentEditable ? node.innerHTML : node.value };
  globalThis[key] = value;
  value.timer = setTimeout(() => { if (globalThis[key] === value) delete globalThis[key]; }, 60000);
  return true;
}
function targetCurrent(sequence) {
  const key = Symbol.for('morrow.compose.editing-target'), value = globalThis[key], node = value?.node;
  const compose = typeof state === 'object' && state !== null ? state : null;
  if (compose?.composePending || compose?.composeQueued || compose?.composeInitializing || compose?.draftWrite?.pending) return false;
  const context = JSON.stringify([compose?.composeSession, compose?.composeMeta?.accountId, compose?.composeMeta?.fromAddress, compose?.draftId]);
  return value?.sequence === sequence && node?.isConnected && node.closest('#compose')?.open && document.activeElement === node
    && !node.disabled && !node.readOnly && (node.id !== 'compose-editor' || node.isContentEditable)
    && value.context === context && value.text === (node.isContentEditable ? node.innerHTML : node.value);
}

function installComposeEditingMenu(win, { Menu, htmlFile }) {
  const contents = win.webContents;
  if (!Menu?.buildFromTemplate || !contents?.on) return;
  let serial = 0;
  contents.on('did-start-navigation', () => { serial++; });
  contents.on('destroyed', () => { serial++; });
  contents.on('context-menu', async (event, params) => {
    if (!params?.isEditable || params.formControlType === 'input-password' || params.frame !== contents.mainFrame
        || !composePage(contents.getURL(), htmlFile)) return;
    const owner = ++serial, frame = params.frame, url = contents.getURL();
    const alive = () => !win.isDestroyed() && !contents.isDestroyed() && owner === serial && frame === contents.mainFrame && contents.getURL() === url;
    event.preventDefault();
    try {
      const keyboard = params.menuSourceType === 'keyboard';
      const x = Number.isFinite(params.x) ? params.x : -1, y = Number.isFinite(params.y) ? params.y : -1;
      const captured = await contents.executeJavaScript(`(${captureTarget})(${owner},${keyboard},${x},${y})`);
      if (!captured || !alive()) return;
      const run = work => async () => {
        try {
          if (!alive() || !await contents.executeJavaScript(`(${targetCurrent})(${owner})`) || !alive()) return;
          work(); serial++;
        } catch { /* A closed or changed editor cannot receive a stale correction. */ }
      };
      const items = [];
      if (params.spellcheckEnabled && params.misspelledWord && typeof contents.replaceMisspelling === 'function') {
        const words = [...new Set((Array.isArray(params.dictionarySuggestions) ? params.dictionarySuggestions : []).filter(word => typeof word === 'string' && word.length > 0 && word.length <= 120 && !/[\x00-\x1f\x7f]/.test(word)))].slice(0, 8);
        if (words.length) for (const word of words) items.push({ label: word.replace(/&/g, '&&'), click: run(() => contents.replaceMisspelling(word)) });
        else items.push({ label: 'No spelling suggestions', enabled: false });
        items.push({ type: 'separator' });
      }
      const editing = [
        ['Undo', 'undo', 'canUndo', 'CmdOrCtrl+Z'], ['Redo', 'redo', 'canRedo', 'CmdOrCtrl+Shift+Z'],
        ['Cut', 'cut', 'canCut', 'CmdOrCtrl+X'], ['Copy', 'copy', 'canCopy', 'CmdOrCtrl+C'],
        ['Paste', 'paste', 'canPaste', 'CmdOrCtrl+V'], ['Paste and match style', 'pasteAndMatchStyle', 'canPaste'],
        ['Select all', 'selectAll', 'canSelectAll', 'CmdOrCtrl+A'],
      ];
      for (const [label, method, flag, accelerator] of editing) if (typeof contents[method] === 'function') items.push({ label, accelerator,
        enabled: params.editFlags?.[flag] === true, click: run(() => contents[method]()) });
      if (alive()) Menu.buildFromTemplate(items).popup({ window: win, sourceType: params.menuSourceType });
    } catch { /* Native capability or a changing window can make a menu unavailable. */ }
  });
}
module.exports = { composePage, installComposeEditingMenu };
