//! The same pinned OpenCC hk2s dictionaries and segmentation order as opencc-js.
use regex::Regex;
use serde::Deserialize;
use std::{collections::HashMap, sync::LazyLock};
use unicode_normalization::UnicodeNormalization;

#[derive(Default)]
struct Trie {
    children: HashMap<char, Trie>,
    value: Option<String>,
}
impl Trie {
    fn new(entries: Vec<(String, String)>) -> Self {
        let mut root = Self::default();
        for (key, value) in entries {
            let mut node = &mut root;
            for ch in key.chars() {
                node = node.children.entry(ch).or_default();
            }
            node.value = Some(value);
        }
        root
    }
    fn prefix<'a>(&'a self, text: &str) -> Option<(usize, &'a str)> {
        let mut node = self;
        let mut matched = None;
        for (offset, ch) in text.char_indices() {
            let Some(next) = node.children.get(&ch) else {
                break;
            };
            node = next;
            if let Some(value) = &node.value {
                matched = Some((offset + ch.len_utf8(), value.as_str()));
            }
        }
        matched
    }
    fn convert(&self, text: &str) -> String {
        let mut out = String::with_capacity(text.len());
        let mut offset = 0;
        while offset < text.len() {
            if let Some((length, value)) = self.prefix(&text[offset..]) {
                out.push_str(value);
                offset += length;
            } else {
                let length = unmatched(&text[offset..]);
                out.push_str(&text[offset..offset + length]);
                offset += length;
            }
        }
        out
    }
    fn segments<'a>(&self, text: &'a str) -> Vec<&'a str> {
        let mut parts = Vec::new();
        let mut offset = 0;
        let mut start = 0;
        while offset < text.len() {
            if let Some((length, _)) = self.prefix(&text[offset..]) {
                if start < offset {
                    parts.push(&text[start..offset]);
                }
                parts.push(&text[offset..offset + length]);
                offset += length;
                start = offset;
            } else {
                offset += unmatched(&text[offset..]);
            }
        }
        if start < offset {
            parts.push(&text[start..]);
        }
        parts
    }
}
// Preserve complete ideographic description sequences, without recursive user-input parsing.
fn unmatched(text: &str) -> usize {
    let first = text.chars().next().expect("nonempty input");
    if !('\u{2ff0}'..='\u{2fff}').contains(&first) {
        return first.len_utf8();
    }
    let mut remaining = 1usize;
    for (offset, ch) in text.char_indices() {
        remaining -= 1;
        remaining += match ch {
            '\u{2ff2}' | '\u{2ff3}' => 3,
            '\u{2ff0}'..='\u{2fff}' => 2,
            _ => 0,
        };
        if remaining == 0 {
            return offset + ch.len_utf8();
        }
    }
    first.len_utf8()
}
#[derive(Deserialize)]
struct Dictionaries {
    normalization: Vec<Vec<(String, String)>>,
    segmentation: Vec<(String, String)>,
    conversion: Vec<Vec<(String, String)>>,
}
struct Converter {
    normalization: Vec<Trie>,
    segmentation: Trie,
    conversion: Vec<Trie>,
}
static CONVERTER: LazyLock<Converter> = LazyLock::new(|| {
    let data: Dictionaries = serde_json::from_str(include_str!("../resources/opencc.json"))
        .expect("bundled OpenCC dictionaries");
    Converter {
        normalization: data.normalization.into_iter().map(Trie::new).collect(),
        segmentation: Trie::new(data.segmentation),
        conversion: data.conversion.into_iter().map(Trie::new).collect(),
    }
});
static MARKS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\p{M}").unwrap());
static SPACE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+",
    )
    .unwrap()
});
static WORDS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\p{L}\p{N}]+").unwrap());
static PARTS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\p{Script=Han}+|[^\p{Script=Han}]+").unwrap());
static HAN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\p{Script=Han}").unwrap());
pub fn normalize(value: &str) -> String {
    let mut text: String = value.nfkc().collect();
    for trie in &CONVERTER.normalization {
        text = trie.convert(&text);
    }
    let text: String = CONVERTER
        .segmentation
        .segments(&text)
        .into_iter()
        .map(|part| {
            CONVERTER
                .conversion
                .iter()
                .fold(part.to_owned(), |text, trie| trie.convert(&text))
        })
        .collect();
    let text: String = text.to_lowercase().nfd().collect();
    SPACE
        .replace_all(&MARKS.replace_all(&text, ""), " ")
        .trim_matches(' ')
        .to_owned()
}
pub fn tokens(value: &str) -> String {
    let text = normalize(value);
    let mut result = Vec::new();
    for word in WORDS.find_iter(&text) {
        for part in PARTS.find_iter(word.as_str()) {
            if HAN.is_match(part.as_str()) {
                let chars: Vec<char> = part.as_str().chars().collect();
                for (i, ch) in chars.iter().enumerate() {
                    result.push(ch.to_string());
                    if let Some(next) = chars.get(i + 1) {
                        result.push(format!("{ch}{next}"));
                    }
                }
            } else {
                result.push(part.as_str().to_owned());
            }
        }
    }
    result.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn existing_chinese_and_unicode_contract() {
        assert_eq!(
            normalize("  發票\u{feff}CAFÉ  ＩＮＶ-１２ "),
            "发票 cafe inv-12"
        );
        assert_eq!(tokens("發票 INV-12"), "发 发票 票 inv 12");
        assert_eq!(normalize("⿰木發"), "⿰木發");
    }
}
