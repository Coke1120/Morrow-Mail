use morrow_search::message_html::sanitize;
use std::process::Command;

#[test]
fn active_content_and_unsafe_attributes_are_removed() {
    let input = r#"<!doctype html><html><head><base href="https://evil.invalid"><style>@import url(https://evil.invalid)</style></head><body><div id="location" class="overlay" onclick="bad()"><script>secret()</script><iframe srcdoc="bad">hidden</iframe><object>hidden</object><embed src="https://evil.invalid"><form><input><button>hidden</button></form><svg><foreignObject><p>hidden</p></foreignObject></svg><math><mtext>hidden</mtext></math><template><img src="https://evil.invalid"></template><audio src="https://evil.invalid"></audio><video poster="https://evil.invalid"></video><p style="color:red;position:fixed;background:url(https://evil.invalid);width:expression(bad());constructor:bad">Readable</p></div></body></html>"#;
    let output = sanitize(input);
    assert!(output.contains("Readable"), "{output}");
    for unsafe_part in [
        "hidden",
        "secret()",
        "evil.invalid",
        "id=",
        "class=",
        "onclick",
        "srcdoc",
        "expression",
        "url(",
        "<script",
        "<svg",
        "<math",
        "<form",
    ] {
        assert!(!output.contains(unsafe_part), "{unsafe_part}: {output}");
    }
    assert_eq!(sanitize(&output), output);
    for malformed in [
        r#"<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=bad()>"></table></mtext></math>"#,
        r#"<svg><style><a title="</style><img src=x onerror=bad()>">"#,
        r#"<math><annotation-xml encoding="text/html"><img src=x onerror=bad()></annotation-xml></math>"#,
        r#"<noscript><img src=x onerror=bad()></noscript><p>OK</p>"#,
        r#"<p><b>broken</p></b><img src=x onerror=bad()>"#,
    ] {
        let output = sanitize(malformed);
        for forbidden in ["<script", "<style", "<svg", "<math", "onerror=", "src=x"] {
            assert!(!output.contains(forbidden), "{malformed}: {output}");
        }
        assert_eq!(sanitize(&output), output);
    }
}

#[test]
fn size_and_complexity_fail_closed() {
    let max = 512 * 1024;
    assert_eq!(sanitize(&"x".repeat(max)).len(), max);
    assert_eq!(sanitize(&"<br>".repeat(12000)), "<br>".repeat(12000));
    let at_depth = format!("{}ok{}", "<div>".repeat(60), "</div>".repeat(60));
    assert_eq!(sanitize(&at_depth), at_depth);
    for input in [
        "x".repeat(max + 1),
        "中".repeat(max / 3 + 1),
        "&".repeat(110000),
        "<br>".repeat(12001),
        format!("{}deep{}", "<div>".repeat(61), "</div>".repeat(61)),
        format!("<template>{}</template>", "<br>".repeat(12001)),
        "<!--x-->".repeat(12001),
        "<div>".repeat(20000),
    ] {
        assert_eq!(
            sanitize(&input),
            "",
            "oversize/complex input length {}",
            input.len()
        );
    }
}

#[test]
fn deep_input_returns_empty_without_process_abort() {
    const CHILD: &str = "MORROW_MESSAGE_HTML_DEPTH_PROBE";
    if std::env::var(CHILD).as_deref() == Ok("1") {
        // Exactly 12,000 opening tags bypass the cheap token cap, so these
        // exercise HTML parsing, the depth guard and disposal of the deep DOM.
        let open = "<div>".repeat(12000);
        assert_eq!(sanitize(&open), "");
        assert_eq!(sanitize(&format!("{open}{}", "</div>".repeat(12000))), "");
        return;
    }
    // An overflow abort must fail this test without killing the test runner.
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "deep_input_returns_empty_without_process_abort",
            "--nocapture",
        ])
        .env(CHILD, "1")
        .env("RUST_MIN_STACK", "2097152")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "child status {}: {}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn safe_formatting_and_url_contracts() {
    // Retain the sanitizer corpus as native contracts after the Node oracle retires.
    let mut samples = vec![
        "<h1>中文 &amp; team</h1><blockquote><pre><code>&lt;b&gt;</code></pre></blockquote><h2>Two</h2><h3>Three</h3><h4>Four</h4><h5>Five</h5><h6>Six</h6>".to_owned(),
        "<table width=600 style=\"border-collapse:collapse;width:100%;max-width:600px\"><thead><tr><th colspan=2>Title</th></tr></thead><tbody><tr><td rowspan=2 style=\"color:#225533;font-weight:bold;padding:8px;text-align:right\">Hello<br><b>B</b><strong>S</strong><em>E</em><i>I</i><u>U</u><s>S</s></td></tr></tbody><tfoot><tr><td>Footer</td></tr></tfoot></table><ul><li>One</li></ul><ol><li>Two</li></ol><hr>".to_owned(),
        "<p style=\"color:red;position:fixed;background:url(x);width:expression(x);font-size:12px;max-width:101%;width:2049px\">Safe</p>".to_owned(),
        "<p>&amp;lt;script&amp;gt; &lt;script&gt; \" '</p>".to_owned(),
        "<div class=x id=y onclick=bad()><script>secret()</script><style>bad</style><iframe>hidden</iframe><svg><a>hidden</a></svg><math><mtext>hidden</mtext></math><form><button>hidden</button></form><p>Safe</p></div>".to_owned(),
        "<a href=\"javascript:bad()\" href=\"https://example.test\">x</a>".to_owned(),
        "<img alt=\"&quot;&gt;&lt;script&gt;\" width=2048 height=2049>".to_owned(),
        "<img src=\"https://example.test/a.png\" alt=\"A &amp; B\" width=640 height=480 srcset=\"https://evil.invalid/x 2x\" onerror=bad()>".to_owned(),
        "<a href=\"https://example.test/%E6%96%87\">文</a><img src=\"https://example.test/%E6%96%87.png\" alt=\"文\">".to_owned(),
        "<a href=\"https://example.test/\u{85}\">bad</a><a href=\"https://example.test/%C2%85\">bad</a><img src=\"https://example.test/%ff\" alt=\"bad\"><img src=\"https://example.test/%\" alt=\"bad\">".to_owned(),
    ];
    for href in [
        "https://example.test/?a=1&amp;b=2",
        "http://example.test",
        "mailto:person@example.test",
        "tel:+85212345678",
        "javascript:bad()",
        "jav&#97;script:bad()",
        "java&#10;script:bad()",
        "data:text/html,bad",
        "file:///etc/passwd",
        "ftp://example.test",
        "//example.test",
        "/relative",
        "#fragment",
        "https://u:p@example.test",
        "https://@example.test",
        "https:example.test",
        "https:/example.test",
        "https:\\example.test",
        " https://example.test",
        "https://example.test/&#0;",
        "https://example.test/&#x85;",
        "https://example.test/%0a",
        "mailto:person@example.test?body=%0d%0a",
        "tel:",
        "mailto://host",
    ] {
        let input = format!(
            "<a href=\"{href}\" target=_self rel=opener ping=\"https://evil.invalid\">Go</a>"
        );
        let output = sanitize(&input);
        let allowed = [
            "https://example.test/?a=1&amp;b=2",
            "http://example.test",
            "mailto:person@example.test",
            "tel:+85212345678",
            // HTML5 decodes numeric C1 reference 0x85 to U+2026 (ellipsis).
            "https://example.test/&#x85;",
        ]
        .contains(&href);
        assert_eq!(output.contains("href="), allowed, "{input}: {output}");
        assert!(output.contains("target=\"_blank\"") && output.contains("noreferrer noopener"));
        assert!(!output.contains("ping="));
        samples.push(input);
    }
    for src in [
        "http://example.test/a.png",
        "//example.test/a.png",
        "/a.png",
        "cid:attachment",
        "data:image/svg+xml,bad",
        "file:///a.png",
        "https://u:p@example.test/a.png",
        "https://example.test/a.svg",
        "https://example.test/a.SVGZ?x=1",
        "https://example.test/a.%73vg",
        "https://example.test/%00.png",
    ] {
        let input = format!("<img src=\"{src}\" alt=Fallback width=99999 height=-1>");
        let output = sanitize(&input);
        assert!(
            !output.contains("src=") && !output.contains("width=") && !output.contains("height="),
            "{input}: {output}"
        );
        assert!(output.contains("Fallback"));
        samples.push(input);
    }
    assert_eq!(sanitize(&samples[0]), samples[0]);
    let table = sanitize(&samples[1]);
    for safe in [
        "<table",
        "<thead>",
        "<tbody>",
        "<tfoot>",
        "<ul>",
        "<ol>",
        "colspan=\"2\"",
        "rowspan=\"2\"",
        "color:#225533",
        "font-weight:bold",
        "width:100%",
    ] {
        assert!(table.contains(safe), "{safe}: {table}");
    }
    let image = sanitize(&samples[7]);
    assert!(
        image.contains("src=\"https://example.test/a.png\"")
            && image.contains("width=\"640\"")
            && image.contains("height=\"480\"")
    );
    for input in samples {
        let output = sanitize(&input);
        for forbidden in [
            "<script",
            "<iframe",
            "<svg",
            "<math",
            "<form",
            "onclick=",
            "onerror=",
            "srcset=",
            "position:",
            "expression(",
            "background:",
        ] {
            assert!(!output.contains(forbidden), "{input}: {output}");
        }
    }
}
