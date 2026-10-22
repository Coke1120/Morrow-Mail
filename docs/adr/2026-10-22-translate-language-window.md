# Translate opens beside the original

A long message with reply history failed in one chat completion. The host sent every paragraph together and cut each segment to 2,000 characters. The model JSON was truncated, so the parser rejected the whole request, or a single huge paragraph (quoted history on single newlines, or HTML the reader shows when `textBody` is only the latest reply) translated only the first 2,000 characters. The result was also painted under the message, and the independent reader window had no Translate control.

Translate now opens a side-by-side window on click, before the API returns. The left pane is the text that was sent. The right pane says Translating…, then the translation, or the error if the request fails. The host splits long text and translates it in batches, then joins the pieces back onto the original nodes.

The toolbar is Translate only. The target language is `translateTargetLanguage` in `settings.json`, read and written with `morrow:configGetTranslateTargetLanguage` and `morrow:configSetTranslateTargetLanguage`. The default is `zh-Hant` (Traditional Chinese / 繁體中文). Simplified Chinese aliases store `zh-Hant`.
