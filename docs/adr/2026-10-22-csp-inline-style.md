# Mail styles stay on style-src 'self'

The shell CSP is the meta tag in `renderer/index.html`: `default-src 'none'; style-src 'self'; script-src 'self'`. `host/main.js` forwards response headers and does not add a policy.

Chromium logs `Refused to apply inline style` when the HTML parser sees a `style` attribute. The hash in that line is the attribute value. The note about `'unsafe-hashes'` means the violation is a style attribute, not a `<style>` element. `element.style.setProperty` does not take that path.

HTML mail is parsed with `template.innerHTML` in `appendSafeMailHtml`. That is the call that feeds message, paste, and signature markup to the parser. Before that assignment, `style` attributes are renamed to `data-mail-style`. The filtered declarations still go through `mailApplyCss`. `script-src` is unchanged.

`'unsafe-inline'` and `'unsafe-hashes'` stay off the policy. A hash would only allow one static snippet, and mail styles are not one snippet.
