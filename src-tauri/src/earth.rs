//! zega.earth results for the earth and hockey graphs on the rail.
//!
//! `GET https://zega.earth/api/search` ranks with the same code as the site's
//! own results page (zegadb/earth#42). Only the words typed while an earth
//! graph is selected are sent; the computer graph never calls this.

use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri_plugin_opener::OpenerExt;

pub const EARTH_ORIGIN: &str = "https://zega.earth";
const MAX_QUERY: usize = 200;

type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
pub struct EarthHit {
    pub zid: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub url: String,
    pub snippet: String,
    pub why: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EarthResults {
    pub results: Vec<EarthHit>,
    pub total: u64,
    /// The server's own ranking time.
    pub took_ms: f64,
}

/// Only zega.earth pages are opened from these results.
fn earth_page(url: &str) -> bool {
    url.strip_prefix(EARTH_ORIGIN).is_some_and(|rest| rest.starts_with('/'))
}

fn parse(body: &str) -> Result<EarthResults> {
    let mut found: EarthResults =
        serde_json::from_str(body).map_err(|_| "zega.earth returned results this app can't read.".to_string())?;
    found.results.retain(|hit| earth_page(&hit.url));
    Ok(found)
}

pub struct EarthState {
    client: reqwest::blocking::Client,
}

impl EarthState {
    pub fn new() -> Result<Self> {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|_| "Could not start the zega.earth client.".to_string())?;
        Ok(Self { client })
    }

    fn search(&self, query: &str) -> Result<EarthResults> {
        let query = query.trim();
        if query.is_empty() || query.len() > MAX_QUERY {
            return Ok(EarthResults { results: Vec::new(), total: 0, took_ms: 0.0 });
        }
        let response = self
            .client
            .get(format!("{EARTH_ORIGIN}/api/search"))
            .query(&[("q", query), ("limit", "10")])
            .send()
            .map_err(|_| "Could not reach zega.earth. Check your connection.".to_string())?;
        if !response.status().is_success() {
            return Err("zega.earth search is unavailable right now.".into());
        }
        parse(&response.text().map_err(|_| "zega.earth search was interrupted.".to_string())?)
    }
}

#[tauri::command]
pub async fn earth_search(state: tauri::State<'_, std::sync::Arc<EarthState>>, query: String) -> Result<EarthResults> {
    let state = std::sync::Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.search(&query))
        .await
        .map_err(|_| "zega.earth search was interrupted.".to_string())?
}

#[tauri::command]
pub fn earth_open(app: tauri::AppHandle, url: String) -> Result<()> {
    if !earth_page(&url) {
        return Err("Only zega.earth pages open from here.".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|_| "Could not open your browser.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_search_api_and_keeps_only_zega_earth_pages() {
        let body = r#"{"query":"oilers","graph":"hockey","total":2,"page":1,"pages":1,"tookMs":1.4,"results":[
            {"zid":"Z13","name":"Edmonton Oilers","type":"team","path":"/hockey/Z13-Edmonton-Oilers","url":"https://zega.earth/hockey/Z13-Edmonton-Oilers","snippet":"NHL team","why":["Your search matches this entity’s name"],"steps":[]},
            {"zid":"Z9","name":"Elsewhere","type":"team","path":"/x","url":"https://zega.earth.evil.example/x","snippet":"","why":[],"steps":[]}]}"#;
        let found = parse(body).unwrap();
        assert_eq!(found.total, 2);
        assert_eq!(found.results.len(), 1);
        assert_eq!(found.results[0].name, "Edmonton Oilers");
        assert_eq!(found.results[0].kind, "team");
    }

    #[test]
    fn only_zega_earth_pages_open() {
        assert!(earth_page("https://zega.earth/hockey/Z13-Edmonton-Oilers"));
        assert!(!earth_page("https://zega.earth.evil.example/"));
        assert!(!earth_page("https://zega.earthx/"));
        assert!(!earth_page("http://zega.earth/"));
        assert!(!earth_page("https://zega.earth"));
    }
}
