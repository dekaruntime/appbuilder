use crate::{quote, rows, Index, Result};
use chrono::Datelike;
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub id: u64,
    pub key: String,
    pub kind: String,
    pub name: String,
    pub path: String,
    pub offline: bool,
    pub detail: String,
}

fn close(a: &str, b: &str) -> bool {
    b.contains(a) || (a.chars().count() >= 4 && b.split_whitespace().any(|w| typo(a, w)))
}
// Bounded optimal-string-alignment distance: insertion, deletion, substitution
// and adjacent transposition. Stop once no row can reach the small edit budget.
fn typo(a: &str, b: &str) -> bool {
    let limit = if a.chars().count() > 6 { 2 } else { 1 };
    let a: Vec<_> = a.chars().collect();
    let b: Vec<_> = b.chars().collect();
    if a.len().abs_diff(b.len()) > limit {
        return false;
    }
    let mut previous: Vec<usize> = (0..=b.len()).collect();
    let mut before = previous.clone();
    let mut current = vec![0; b.len() + 1];
    for i in 1..=a.len() {
        current[0] = i;
        for j in 1..=b.len() {
            current[j] = (previous[j] + 1)
                .min(current[j - 1] + 1)
                .min(previous[j - 1] + usize::from(a[i - 1] != b[j - 1]));
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                current[j] = current[j].min(before[j - 2] + 1);
            }
        }
        if *current.iter().min().unwrap() > limit {
            return false;
        }
        std::mem::swap(&mut before, &mut previous);
        std::mem::swap(&mut previous, &mut current);
    }
    previous[b.len()] <= limit
}

impl Index {
    pub fn search(&self, text: &str) -> Result<Vec<SearchResult>> {
        self.search_on(text, chrono::Local::now().date_naive())
    }
    pub fn search_on(&self, text: &str, today: chrono::NaiveDate) -> Result<Vec<SearchResult>> {
        let text = text.trim().to_lowercase();
        if text.len() > 512 {
            return Err("Search is limited to 512 bytes".into());
        }
        let words: Vec<_> = text.split_whitespace().collect();
        let photo = words
            .iter()
            .any(|w| matches!(*w, "photo" | "photos" | "picture" | "pictures"));
        let video = words
            .iter()
            .any(|w| matches!(*w, "video" | "videos" | "movie" | "movies"));
        let summer = text.contains("last summer");
        let terms: Vec<_> = words
            .into_iter()
            .filter(|w| {
                !(matches!(
                    *w,
                    "photo"
                        | "photos"
                        | "picture"
                        | "pictures"
                        | "video"
                        | "videos"
                        | "movie"
                        | "movies"
                ) || summer && matches!(*w, "last" | "summer"))
            })
            .collect();
        let places = rows(self.zql("query { Place { key name } }")?);
        let mut place_keys = Vec::new();
        let mut remaining = Vec::new();
        for term in &terms {
            let matched: Vec<_> = places
                .iter()
                .filter(|p| close(term, &p["name"].as_str().unwrap_or_default().to_lowercase()))
                .filter_map(|p| p["key"].as_str())
                .collect();
            if matched.is_empty() {
                remaining.push(*term);
            } else {
                place_keys.extend(matched);
            }
        }
        let kinds: Vec<_> = if photo {
            vec!["Photo"]
        } else if video {
            vec!["Video"]
        } else if summer || !place_keys.is_empty() {
            vec!["Photo", "Video"]
        } else {
            vec!["Action", "App", "File", "Video", "Photo"]
        };
        let mut results = Vec::new();
        for kind in kinds {
            let mut filters = Vec::new();
            if !place_keys.is_empty() {
                filters.push(format!(
                    "has takenAt({})",
                    place_keys
                        .iter()
                        .map(|key| format!("key = {}", quote(key)))
                        .collect::<Vec<_>>()
                        .join(" || ")
                ));
            }
            if summer {
                let year = if today.month() > 8 {
                    today.year()
                } else {
                    today.year() - 1
                };
                filters.push(format!(
                    "has takenOn in inPeriod(key = {})",
                    quote(&format!("summer-{year}"))
                ));
            }
            filters.extend(
                remaining
                    .iter()
                    .map(|term| format!("search findExact {}", quote(term))),
            );
            let fields = if kind == "Action" {
                "@id key name target"
            } else {
                "@id key name path offline"
            };
            let query = |filters: &[String]| {
                format!(
                    "query {{ {kind}{} {} limit 30 {{ {fields} }} }}",
                    if filters.is_empty() {
                        String::new()
                    } else {
                        format!("({})", filters.join(" && "))
                    },
                    if kind == "Action" || !text.is_empty() {
                        ""
                    } else {
                        "order by mtime desc"
                    }
                )
            };
            let mut found = rows(self.zql(&query(&filters))?);
            if found.is_empty() && remaining.iter().any(|term| term.chars().count() >= 4) {
                // The spelling dictionary supplies possible names only;
                // the current graph decides whether each result still exists.
                let vocabulary = self.vocabulary.read().unwrap();
                let fuzzy: Vec<_> = vocabulary
                    .get(kind)
                    .into_iter()
                    .flatten()
                    .filter(|(_, folded)| remaining.iter().all(|term| close(term, folded)))
                    .take(30)
                    .map(|(name, _)| format!("name = {}", quote(name)))
                    .collect();
                drop(vocabulary);
                if !fuzzy.is_empty() {
                    filters.truncate(filters.len() - remaining.len());
                    filters.push(format!("({})", fuzzy.join(" || ")));
                    found = rows(self.zql(&query(&filters))?);
                }
            }
            for row in found {
                results.push(SearchResult {
                    id: row["id"].as_u64().unwrap_or_default(),
                    key: row["key"].as_str().unwrap_or_default().into(),
                    kind: match kind {
                        "Action" => "actions",
                        "App" => "apps",
                        "Photo" => "photos",
                        _ => "files",
                    }
                    .into(),
                    name: row["name"].as_str().unwrap_or_default().into(),
                    path: row[if kind == "Action" { "target" } else { "path" }]
                        .as_str()
                        .unwrap_or_default()
                        .into(),
                    offline: row["offline"].as_bool().unwrap_or(false),
                    detail: if kind == "Video" {
                        "Video".into()
                    } else {
                        kind.into()
                    },
                });
            }
        }
        results.sort_by_key(|row| match row.kind.as_str() {
            "actions" => 0,
            "apps" => 1,
            "files" => 2,
            _ => 3,
        });
        Ok(results)
    }
}
