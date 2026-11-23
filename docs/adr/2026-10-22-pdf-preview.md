# PDF preview draws pages in the dialog

The attachment dialog used Chromium's built-in PDF viewer in an iframe. That viewer has its own scrollbar, and inside this dialog a normal page was scaled so only a thin strip was visible.

PDF.js 4.10 (`pdfjs-dist`, bundled on install) now paints each page onto a canvas in `#attachment-preview-stage`. The stage scrolls with the same thin scrollbar as the message list. The default scale fits the page width, so one A4 page is a normal vertical scroll, and later pages follow it.

The worker runs on the main thread. On a `file://` origin PDF.js would otherwise wrap the module worker in a blob URL, which `script-src 'self'` does not allow. CMaps and the standard fonts ship under `renderer/vendor/pdfjs/` and load with `connect-src 'self'`. Glyphs are drawn as paths (`disableFontFace` and `isEvalSupported: false`), so the preview does not need `unsafe-eval` or inline styles.

Text selection, in-preview links, and the browser print toolbar are not in this view. Save and Open still hand the file to the system. Password-protected files ask you to Save or Open them.

## Comparing quotations from two messages

Each separate message reader owns its PDF, scroll position and mail sender label. A user who opens two readers on the same display can place them side by side from a PDF preview. Closing either preview returns to its message. Each reader continues to fetch and release its own attachment in the normal way.

The host identifies the pair from its open reader windows and the invoking reader. The arrangement request carries no message data or coordinates. Comparison placement is temporary so the next ordinary reader can open at the user's saved size and position.
