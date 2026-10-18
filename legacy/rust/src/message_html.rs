use crate::content::clean_style;

const MAX_BYTES: usize = 512 * 1024;
const ALLOWED: &str = "p div span br hr b strong em i u s a table tbody thead tfoot tr td th ul ol li h1 h2 h3 h4 h5 h6 blockquote pre code img";
const BLOCKED: &str = "script style head title base link meta form input button textarea select option iframe frame frameset object embed applet svg math template noscript noembed noframes plaintext xmp audio video source track portal";

fn safe_url(value: &str, image: bool) -> bool {
    let decoded = percent_encoding::percent_decode_str(value).decode_utf8_lossy();
    if value
        .chars()
        .any(|c| c <= ' ' || c.is_control() || c == '\u{fffd}' || c == '\\')
        || decoded.chars().any(char::is_control)
        || value.as_bytes().iter().enumerate().any(|(i, c)| {
            *c == b'%'
                && value
                    .as_bytes()
                    .get(i + 1..i + 3)
                    .is_none_or(|pair| !pair.iter().all(u8::is_ascii_hexdigit))
        })
    {
        return false;
    }
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let lower = value.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        if !url.has_host()
            || value
                .split('/')
                .nth(2)
                .is_none_or(|host| host.contains('@'))
        {
            return false;
        }
        if !image {
            return true;
        }
        let Ok(path) = percent_encoding::percent_decode_str(url.path()).decode_utf8() else {
            return false;
        };
        let path = path.to_ascii_lowercase();
        return url.scheme() == "https"
            && !path
                .split('/')
                .any(|part| part.ends_with(".svg") || part.ends_with(".svgz"));
    }
    !image
        && ["mailto", "tel"].contains(&url.scheme())
        && value
            .split_once(':')
            .is_some_and(|(_, address)| !address.is_empty() && !address.starts_with('/'))
}

fn dimension(value: &str, max: u32) -> bool {
    !value.starts_with('0')
        && !value.is_empty()
        && value.len() <= 4
        && value.bytes().all(|c| c.is_ascii_digit())
        && value.parse::<u32>().is_ok_and(|v| v <= max)
}

fn message_style(value: &str) -> String {
    let mut parts = vec![clean_style(value)];
    for entry in value.split(';') {
        let Some((key, size)) = entry.split_once(':') else {
            continue;
        };
        let key = key.trim().to_ascii_lowercase();
        let size = size.trim().to_ascii_lowercase();
        if !["width", "max-width"].contains(&key.as_str()) {
            continue;
        }
        let bounded = size.strip_suffix("px").is_some_and(|v| dimension(v, 2048))
            || size.strip_suffix('%').is_some_and(|v| dimension(v, 100));
        if bounded {
            parts.push(format!("{key}:{size}"));
        }
    }
    parts
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(";")
}

fn bounded(html: &str) -> bool {
    let Ok(dom) = html2text::config::plain().parse_html(html.as_bytes()) else {
        return false;
    };
    let mut stack = vec![(dom.document.clone(), 0)];
    let mut nodes = 0;
    while let Some((node, parent_depth)) = stack.pop() {
        let mut depth = parent_depth;
        let wrapper = match &node.data {
            html2text::Document => true,
            html2text::Element {
                name,
                template_contents,
                ..
            } => {
                let wrapper = ["html", "head", "body"].contains(&name.local.as_ref());
                if !wrapper {
                    depth += 1;
                }
                if let Some(contents) = template_contents.borrow().as_ref() {
                    stack.push((contents.clone(), depth));
                }
                wrapper
            }
            _ => false,
        };
        if !wrapper {
            nodes += 1;
        }
        if nodes > 12000 || depth > 60 {
            return false;
        }
        for child in node.children.borrow().iter() {
            stack.push((child.clone(), depth));
        }
    }
    true
}

/// Reader HTML only; retain plain body for AI/fallback. Clients must use img-src
/// 'none' until explicit per-message consent to load the retained HTTPS images.
pub fn sanitize(input: &str) -> String {
    if input.len() > MAX_BYTES {
        return String::new();
    }
    // ponytail: conservatively count tag-like text too; use a tokenizer budget
    // if compatibility requires it. DOM traversal still enforces depth/nodes.
    if input
        .as_bytes()
        .windows(2)
        .filter(|pair| pair[0] == b'<' && pair[1].is_ascii_alphabetic())
        .take(12001)
        .count()
        > 12000
    {
        return String::new();
    }
    if !bounded(input) {
        return String::new();
    }
    let clean = ammonia::Builder::new()
        .tags(ALLOWED.split(' ').collect())
        .clean_content_tags(BLOCKED.split(' ').collect())
        .generic_attributes(["style"].into_iter().collect())
        .tag_attributes(
            [
                ("a", ["href"].into_iter().collect()),
                (
                    "img",
                    ["src", "alt", "width", "height"].into_iter().collect(),
                ),
                ("table", ["width"].into_iter().collect()),
                ("td", ["width", "colspan", "rowspan"].into_iter().collect()),
                ("th", ["width", "colspan", "rowspan"].into_iter().collect()),
            ]
            .into_iter()
            .collect(),
        )
        .link_rel(Some("noreferrer noopener"))
        .set_tag_attribute_value("a", "target", "_blank")
        .url_schemes(
            ["http", "https", "mailto", "tel", "cid"]
                .into_iter()
                .collect(),
        )
        .url_relative(ammonia::UrlRelative::Deny)
        .attribute_filter(|tag, key, value| match key {
            "style" => {
                let clean = message_style(value);
                (!clean.is_empty()).then(|| clean.into())
            }
            "href" if safe_url(value, false) => Some(value.into()),
            "src" if safe_url(value, true) => Some(value.into()),
            "src"
                if tag == "img"
                    && value.starts_with("cid:")
                    && value.len() <= 516
                    && !value
                        .chars()
                        .any(|c| c.is_control() || matches!(c, '<' | '>' | '"' | '\'')) =>
            {
                Some(value.into())
            }
            "alt" => Some(value.into()),
            "width" | "height" if dimension(value, 2048) => Some(value.into()),
            "colspan" | "rowspan" if dimension(value, 100) => Some(value.into()),
            "rel" if tag == "a" => Some("noreferrer noopener".into()),
            "target" if tag == "a" => Some("_blank".into()),
            _ => None,
        })
        .clean(input)
        .to_string();
    if clean.len() > MAX_BYTES || !bounded(&clean) {
        String::new()
    } else {
        clean
    }
}
