use serde::Deserialize;
use std::path::PathBuf;
#[derive(Deserialize)]
pub struct Config {
    pub desktop: Desktop,
    pub native: Native,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Desktop {
    pub product_name: String,
    #[cfg(feature = "compiler")]
    pub entry: String,
    #[cfg(feature = "compiler")]
    pub entry_function: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Native {
    pub shortcut: crate::shortcut_config::Binding,
    pub index_directory: PathBuf,
    pub roots: Vec<Root>,
    pub menu: Vec<MenuItem>,
}
#[derive(Deserialize)]
pub struct Root {
    pub path: PathBuf,
    pub apps: bool,
}
#[derive(Deserialize)]
pub struct MenuItem {
    pub id: String,
    pub label: String,
}
