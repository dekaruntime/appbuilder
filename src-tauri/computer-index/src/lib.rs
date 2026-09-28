mod crawler;
mod gazetteer;
mod metadata;
mod search;
mod service;
use chrono::Datelike;
pub use crawler::{Record, Root};
use metadata::Media;
pub use search::SearchResult;
use serde::Serialize;
use serde_json::Value;
pub use service::Service;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex, RwLock,
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use zega::Zega;

pub const SCHEMA: &str = include_str!("../schema.zql");
pub type Result<T> = std::result::Result<T, String>;
const KINDS: [&str; 5] = ["File", "Folder", "App", "Photo", "Video"];
const REGISTERED_APP: &str = "registered-app:";

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub items_indexed: usize,
    pub last_scan: Option<u64>,
    pub scanning: bool,
    pub paused: bool,
    pub error: Option<String>,
    pub skipped: usize,
    pub warnings: Vec<String>,
}

pub struct Index {
    db: Zega,
    catalog: Mutex<HashMap<String, Record>>,
    dimensions: Mutex<HashSet<String>>,
    status: Mutex<Status>,
    pending: Mutex<Option<Vec<String>>>,
    scan_gate: Mutex<()>,
    vocabulary: RwLock<HashMap<String, Vec<(String, String)>>>,
    needs_repair: AtomicBool,
    pub(crate) paused: AtomicBool,
}

pub(crate) fn quote(s: &str) -> String {
    serde_json::to_string(s).expect("string serialization")
}
pub(crate) fn rows(value: Value) -> Vec<Value> {
    match value {
        Value::Array(a) => a,
        Value::Object(o) if !o.is_empty() => vec![Value::Object(o)],
        _ => vec![],
    }
}

impl Index {
    pub fn open(path: &Path) -> Result<Self> {
        fs::create_dir_all(path).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        let db = Zega::open(path.to_str().ok_or("Index path is not UTF-8")?)
            .build()
            .map_err(|e| e.to_string())?;
        let index = Self {
            db,
            catalog: Mutex::new(HashMap::new()),
            dimensions: Mutex::new(HashSet::new()),
            status: Mutex::new(Status::default()),
            pending: Mutex::new(None),
            scan_gate: Mutex::new(()),
            vocabulary: RwLock::new(HashMap::new()),
            needs_repair: AtomicBool::new(true),
            paused: AtomicBool::new(false),
        };
        index.reload_catalog()?;
        Ok(index)
    }

    fn reload_catalog(&self) -> Result<()> {
        self.catalog.lock().unwrap().clear();
        self.dimensions.lock().unwrap().clear();
        for kind in KINDS {
            for value in rows(self.zql(&format!("query {{ {kind} {{ key name path volume fileId fingerprint size mtime offline }} }}"))?) {
                let mut record: Record = serde_json::from_value(value).map_err(|e| e.to_string())?;
                record.kind = kind.to_owned();
                self.catalog.lock().unwrap().insert(record.key.clone(), record);
            }
        }
        for kind in [
            "Volume", "Place", "Camera", "Day", "Period", "Action", "Scan",
        ] {
            for value in rows(self.zql(&format!("query {{ {kind} {{ key }} }}"))?) {
                if let Some(key) = value["key"].as_str() {
                    self.dimensions
                        .lock()
                        .unwrap()
                        .insert(format!("{kind}:{key}"));
                }
            }
        }
        self.status.lock().unwrap().items_indexed = self
            .catalog
            .lock()
            .unwrap()
            .values()
            .filter(|r| r.kind != "Folder")
            .count();
        self.refresh_vocabulary();
        self.status.lock().unwrap().last_scan = rows(self.zql("query { Scan { completed } }")?)
            .first()
            .and_then(|v| v["completed"].as_u64());
        Ok(())
    }

    fn refresh_vocabulary(&self) {
        // A small spelling vocabulary, not a second result store. It is built
        // only from committed records, and every candidate is rechecked in ZQL.
        let catalog = self.catalog.lock().unwrap();
        let mut vocabulary = self.vocabulary.write().unwrap();
        vocabulary.retain(|kind, _| kind == "Action");
        for r in catalog.values() {
            vocabulary
                .entry(r.kind.clone())
                .or_default()
                .push((r.name.clone(), r.name.to_lowercase()));
        }
        for names in vocabulary.values_mut() {
            names.sort();
            names.dedup();
        }
    }

    // Only internal, generated statements reach this entry point. No user ZQL,
    // load/import statements, URLs, or network-capable engine features.
    pub(crate) fn zql(&self, query: &str) -> Result<Value> {
        self.db.run_lang(SCHEMA, query).map_err(|e| e.to_string())
    }
    fn write(&self, query: &str) -> Result<Value> {
        if query.starts_with("mutation { delete ") {
            self.flush()?;
            return self.zql(query);
        }
        let mut pending = self.pending.lock().unwrap();
        if let Some(batch) = pending.as_mut() {
            batch.push(query.to_owned());
            if batch.len() >= 96 {
                self.flush_batch(batch)?;
            }
            Ok(Value::Null)
        } else {
            self.zql(query)
        }
    }
    fn flush_batch(&self, batch: &mut Vec<String>) -> Result<()> {
        use std::sync::OnceLock;
        static LITERALS: OnceLock<regex::Regex> = OnceLock::new();
        let literals = LITERALS.get_or_init(|| {
            regex::Regex::new(
                r#""(?:[^"\\]|\\.)*"|\b\d{4}-\d{2}-\d{2}\b|-?\b\d+(?:\.\d+)?\b|\b(?:true|false|null)\b"#,
            )
            .unwrap()
        });
        let mut groups: Vec<(String, Vec<Value>)> = Vec::new();
        for query in batch.iter() {
            let mut values = serde_json::Map::new();
            let mut n = 0;
            let template = literals
                .replace_all(query, |captures: &regex::Captures<'_>| {
                    let raw = &captures[0];
                    // ZQL dates are typed literals, not scalar import bindings.
                    if raw.len() == 10 && raw.as_bytes()[4] == b'-' && raw.as_bytes()[7] == b'-' {
                        return raw.to_owned();
                    }
                    let key = format!("v{n}");
                    n += 1;
                    let value = serde_json::from_str(raw).expect("generated ZQL scalar");
                    values.insert(key.clone(), value);
                    format!("${key}")
                })
                .replacen("mutation", "mutation json [\"desktop-batch\"]", 1);
            if let Some((_, records)) = groups.iter_mut().find(|(q, _)| q == &template) {
                records.push(Value::Object(values));
            } else {
                groups.push((template, vec![Value::Object(values)]));
            }
        }
        groups.sort_by_key(|(query, _)| {
            if query.contains("delete ") {
                4
            } else if query.contains(" -> link ") {
                3
            } else if query.contains(" -> unlink ") {
                2
            } else if query.contains(" set ") {
                1
            } else {
                0
            }
        });
        for (query, records) in groups {
            let sources = HashMap::from([(
                "desktop-batch".to_owned(),
                serde_json::to_string(&records).unwrap(),
            )]);
            self.db
                .run_lang_with_sources(SCHEMA, &query, &sources)
                .map_err(|e| e.to_string())?;
        }
        batch.clear();
        Ok(())
    }
    fn flush(&self) -> Result<()> {
        let mut pending = self.pending.lock().unwrap();
        if let Some(batch) = pending.as_mut() {
            self.flush_batch(batch)?;
        }
        Ok(())
    }
    pub fn status(&self) -> Status {
        let mut s = self.status.lock().unwrap().clone();
        s.paused = self.paused.load(Ordering::Relaxed);
        s
    }
    pub fn pause(&self, value: bool) {
        self.paused.store(value, Ordering::Relaxed);
    }
    pub fn checkpoint(&self) -> Result<()> {
        self.db.snapshot().map_err(|e| e.to_string())
    }
    pub fn counts(&self) -> Result<HashMap<String, usize>> {
        KINDS
            .into_iter()
            .chain(["Place", "Day", "Camera", "Volume", "Period", "Action"])
            .map(|kind| {
                Ok((
                    kind.to_owned(),
                    rows(self.zql(&format!("query {{ {kind} {{ key }} }}"))?).len(),
                ))
            })
            .collect()
    }
    pub fn resolve(&self, key: &str) -> Result<String> {
        if key.len() > 1024 {
            return Err("Invalid result identity".into());
        }
        // Opening an already indexed result must not wait for the crawler's
        // whole-home catalog lock. Read the committed node directly instead.
        for kind in KINDS {
            let values = rows(self.zql(&format!(
                "query {{ {kind}(key = {}) {{ path offline }} }}",
                quote(key)
            ))?);
            let Some(row) = values.first() else { continue };
            if row["offline"].as_bool().unwrap_or(true) {
                return Err("This volume is offline".into());
            }
            let path = row["path"].as_str().ok_or("Missing indexed path")?;
            if kind == "App" && key == format!("{REGISTERED_APP}{path}") {
                return Ok(path.to_owned());
            }
            let (current, _) =
                crawler::record(Path::new(path), kind == "App").map_err(|e| e.to_string())?;
            if current.key != key {
                return Err("This file has changed; wait for indexing".into());
            }
            return Ok(path.to_owned());
        }
        Err("This result is no longer indexed".into())
    }
    pub fn records(&self) -> Vec<Record> {
        self.catalog.lock().unwrap().values().cloned().collect()
    }

    /// Synchronize launch entries supplied by the native OS app catalogue.
    /// These are registered apps, not filesystem executables discovered by crawling.
    pub fn set_registered_apps(&self, apps: &[(String, String)]) -> Result<()> {
        let _scan = self.scan_gate.lock().unwrap();
        let mut catalog = self.catalog.lock().unwrap();
        let mut seen = HashSet::new();
        for (name, target) in apps {
            let key = format!("{REGISTERED_APP}{target}");
            let record = Record {
                key: key.clone(),
                name: name.clone(),
                path: target.clone(),
                volume: "Registered applications".into(),
                file_id: target.clone(),
                fingerprint: target.clone(),
                size: 0,
                mtime: 0,
                offline: false,
                kind: "App".into(),
            };
            self.upsert(&record, &Media::default(), None, catalog.get(&key))?;
            catalog.insert(key.clone(), record);
            seen.insert(key);
        }
        let removed: Vec<_> = catalog
            .keys()
            .filter(|key| key.starts_with(REGISTERED_APP) && !seen.contains(*key))
            .cloned()
            .collect();
        for key in removed {
            self.write(&format!(
                "mutation {{ delete App(key = {}) {{ @detach }} }}",
                quote(&key)
            ))?;
            catalog.remove(&key);
        }
        self.flush()?;
        drop(catalog);
        self.refresh_vocabulary();
        Ok(())
    }
    pub fn node_id(&self, kind: &str, key: &str) -> Result<u64> {
        if !KINDS.contains(&kind) {
            return Err("Unknown file type".into());
        }
        rows(self.zql(&format!(
            "query {{ {kind}(key = {}) {{ @id }} }}",
            quote(key)
        ))?)
        .first()
        .and_then(|v| v["id"].as_u64())
        .ok_or("Missing node".into())
    }

    fn dimension(&self, kind: &str, key: &str, fields: &str) -> Result<()> {
        let cache_key = format!("{kind}:{key}");
        let mut known = self.dimensions.lock().unwrap();
        if !known.contains(&cache_key) {
            self.write(&format!(
                "mutation {{ {kind}(key: {} {fields}) }}",
                quote(key)
            ))?;
            known.insert(cache_key);
        }
        Ok(())
    }

    pub fn set_actions(&self, actions: &[(String, String)]) -> Result<()> {
        self.write("mutation { delete Action(key != \"\") { @detach } }")?;
        for (name, target) in actions {
            self.write(&format!(
                "mutation {{ Action(key: {} && name: {} && target: {} && search: {}) }}",
                quote(target),
                quote(name),
                quote(target),
                quote(&name.to_lowercase())
            ))?;
        }
        self.vocabulary.write().unwrap().insert(
            "Action".into(),
            actions
                .iter()
                .map(|(name, _)| (name.clone(), name.to_lowercase()))
                .collect(),
        );
        Ok(())
    }

    fn upsert(
        &self,
        r: &Record,
        media: &Media,
        parent: Option<&Record>,
        old: Option<&Record>,
    ) -> Result<()> {
        let searchable = if r.key.starts_with(REGISTERED_APP) {
            r.name.to_lowercase()
        } else {
            format!("{} {}", r.name, r.path).to_lowercase()
        };
        self.dimension(
            "Volume",
            &r.volume,
            &format!("&& name: {} && offline: false", quote(&r.volume)),
        )?;
        let props = format!(
            "name: {}, path: {}, size: {}, mtime: {}, offline: false, search: {}",
            quote(&r.name),
            quote(&r.path),
            r.size,
            r.mtime,
            quote(&searchable)
        );
        if let Some(old) = old {
            if old.path == r.path
                && old.name == r.name
                && old.mtime == r.mtime
                && !old.offline
                && !self.needs_repair.load(Ordering::Relaxed)
            {
                return Ok(());
            }
            self.write(&format!(
                "mutation {{ {}(key = {}) set {props} }}",
                r.kind,
                quote(&r.key)
            ))?;
        } else {
            self.write(&format!(
                "mutation {{ {}(key: {} && volume: {} && fileId: {} && fingerprint: {} && {}) }}",
                r.kind,
                quote(&r.key),
                quote(&r.volume),
                quote(&r.file_id),
                quote(&r.fingerprint),
                format_args!(
                    "name: {} && path: {} && size: {} && mtime: {} && offline: false && search: {}",
                    quote(&r.name),
                    quote(&r.path),
                    r.size,
                    r.mtime,
                    quote(&searchable)
                )
            ))?;
        }
        // Query before changing a relationship: single-target links reject
        // duplicates, even when both endpoints are the same node.
        for (edge, kind, target) in [
            ("onVolume", "Volume", Some(r.volume.as_str())),
            ("inFolder", "Folder", parent.map(|p| p.key.as_str())),
        ] {
            let Some(target) = target else { continue };
            let previous = if old.is_some() {
                rows(self.zql(&format!(
                    "query {{ {}(key = {}) {{ {edge} -> {kind} {{ key }} }} }}",
                    r.kind,
                    quote(&r.key)
                ))?)
                .first()
                .and_then(|v| v[edge]["key"].as_str())
                .map(str::to_owned)
            } else {
                None
            };
            if previous.as_deref() != Some(target) {
                if let Some(key) = previous {
                    self.write(&format!(
                        "mutation {{ {}(key = {}) {{ {edge} -> unlink {kind}(key = {}) }} }}",
                        r.kind,
                        quote(&r.key),
                        quote(&key)
                    ))?;
                }
                self.link(r, edge, kind, target)?;
            }
        }
        if old.is_some_and(|old| old.mtime == r.mtime) && !self.needs_repair.load(Ordering::Relaxed)
        {
            return Ok(());
        }
        if matches!(r.kind.as_str(), "Photo" | "Video") {
            if old.is_some() {
                for (edge, kind) in [
                    ("takenOn", "Day"),
                    ("takenAt", "Place"),
                    ("shotWith", "Camera"),
                ] {
                    let previous = rows(self.zql(&format!(
                        "query {{ {}(key = {}) {{ {edge} -> {kind} {{ key }} }} }}",
                        r.kind,
                        quote(&r.key)
                    ))?);
                    if let Some(key) = previous.first().and_then(|v| v[edge]["key"].as_str()) {
                        self.write(&format!(
                            "mutation {{ {}(key = {}) {{ {edge} -> unlink {kind}(key = {}) }} }}",
                            r.kind,
                            quote(&r.key),
                            quote(key)
                        ))?;
                    }
                }
            }
            if old.is_some() {
                // Supplied-source loads omit null cells; use a literal update
                // to clear metadata removed by an editor.
                self.flush()?;
                self.zql(&format!("mutation {{ {}(key = {}) set captured: null, lat: null, lon: null, width: null, height: null, duration: null }}", r.kind, quote(&r.key)))?;
            }
            let mut fields = vec![];
            if let Some(captured) = &media.captured {
                fields.push(format!("captured: {}", quote(captured)));
                if let Some(day) = captured
                    .get(..10)
                    .filter(|s| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok())
                {
                    self.dimension("Day", day, &format!("&& date: {day}"))?;
                    self.link(r, "takenOn", "Day", day)?;
                    self.period(day)?;
                }
            }
            if let (Some(lat), Some(lon)) = (media.lat, media.lon) {
                fields.push(format!("lat: {lat}, lon: {lon}"));
                if let Some(city) = gazetteer::nearest(lat, lon) {
                    self.dimension(
                        "Place",
                        city.id,
                        &format!(
                            "&& name: {} && lat: {} && lon: {}",
                            quote(city.ascii),
                            city.lat,
                            city.lon
                        ),
                    )?;
                    self.link(r, "takenAt", "Place", city.id)?;
                }
            }
            if let Some(camera) = &media.camera {
                self.dimension("Camera", camera, &format!("&& name: {}", quote(camera)))?;
                self.link(r, "shotWith", "Camera", camera)?;
            }
            if let Some(n) = media.width {
                fields.push(format!("width: {n}"));
            }
            if let Some(n) = media.height {
                fields.push(format!("height: {n}"));
            }
            if let Some(n) = media.duration {
                fields.push(format!("duration: {n}"));
            }
            if !fields.is_empty() {
                self.write(&format!(
                    "mutation {{ {}(key = {}) set {} }}",
                    r.kind,
                    quote(&r.key),
                    fields.join(", ")
                ))?;
            }
        }
        Ok(())
    }
    fn link(&self, r: &Record, edge: &str, kind: &str, key: &str) -> Result<()> {
        self.write(&format!(
            "mutation {{ {}(key = {}) {{ {edge} -> link {kind}(key = {}) }} }}",
            r.kind,
            quote(&r.key),
            quote(key)
        ))
        .map(|_| ())
    }
    fn period(&self, day: &str) -> Result<()> {
        let date = chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d").map_err(|e| e.to_string())?;
        let y = date.year();
        let (name, starts, ends) = match date.month() {
            3..=5 => ("spring", format!("{y}-03-01"), format!("{y}-05-31")),
            6..=8 => ("summer", format!("{y}-06-01"), format!("{y}-08-31")),
            9..=11 => ("autumn", format!("{y}-09-01"), format!("{y}-11-30")),
            _ => {
                let y = if date.month() < 3 { y - 1 } else { y };
                let last = chrono::NaiveDate::from_ymd_opt(y + 1, 3, 1)
                    .unwrap()
                    .pred_opt()
                    .unwrap();
                ("winter", format!("{y}-12-01"), last.to_string())
            }
        };
        let key = format!("{name}-{}", &starts[..4]);
        self.dimension(
            "Period",
            &key,
            &format!(
                "&& name: {} && starts: {starts} && ends: {ends}",
                quote(&key)
            ),
        )?;
        let marker = format!("DayPeriod:{day}:{key}");
        if self.dimensions.lock().unwrap().contains(&marker) {
            return Ok(());
        }
        let existing = rows(self.zql(&format!(
            "query {{ Day(key = {}) {{ inPeriod -> Period {{ key }} }} }}",
            quote(day)
        ))?);
        if existing
            .first()
            .and_then(|v| v["inPeriod"].as_array())
            .is_some_and(|periods| periods.iter().any(|p| p["key"].as_str() == Some(&key)))
        {
            self.dimensions.lock().unwrap().insert(marker);
            return Ok(());
        }
        self.write(&format!(
            "mutation {{ Day(key = {}) {{ inPeriod -> link Period(key = {}) }} }}",
            quote(day),
            quote(&key)
        ))?;
        self.dimensions.lock().unwrap().insert(marker);
        Ok(())
    }

    pub fn reconcile(&self, roots: &[Root]) -> Result<()> {
        self.reconcile_with_presence(roots, crawler::volume_present)
    }
    /// The mount provider is injectable so removal can be tested without
    /// unmounting anyone's physical disk. Production probes volume identities.
    pub fn reconcile_with_presence(
        &self,
        roots: &[Root],
        present: impl Fn(&Record) -> bool,
    ) -> Result<()> {
        let _guard = self.scan_gate.lock().unwrap();
        if self.paused.load(Ordering::Relaxed) {
            return Ok(());
        }
        {
            let mut s = self.status.lock().unwrap();
            s.scanning = true;
            s.error = None;
            s.skipped = 0;
        }
        *self.pending.lock().unwrap() = Some(Vec::new());
        let result = self.scan(roots, present).and_then(|()| self.flush());
        *self.pending.lock().unwrap() = None;
        let result = result.and_then(|()| {
            self.refresh_vocabulary();
            if !self.paused.load(Ordering::Relaxed) {
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                self.dimension("Scan", "latest", "&& completed: 0")?;
                self.zql(&format!(
                    "mutation {{ Scan(key = \"latest\") set completed: {now} }}"
                ))?;
                self.status.lock().unwrap().last_scan = Some(now);
                self.needs_repair.store(false, Ordering::Relaxed);
            }
            Ok(())
        });
        if result.is_err() {
            self.needs_repair.store(true, Ordering::Relaxed);
            let _ = self.reload_catalog();
        }
        let mut s = self.status.lock().unwrap();
        s.scanning = false;
        if let Err(e) = &result {
            s.error = Some(e.clone());
        }
        result
    }
    fn scan(&self, roots: &[Root], present: impl Fn(&Record) -> bool) -> Result<()> {
        let mut catalog = self.catalog.lock().unwrap();
        // Apply scope changes before crawling: old app roots must stop appearing
        // even when scanning the user's home takes a while.
        let out_of_scope: Vec<_> = catalog
            .values()
            .filter(|r| {
                !r.offline
                    && !r.key.starts_with(REGISTERED_APP)
                    && !roots
                        .iter()
                        .any(|root| Path::new(&r.path).starts_with(&root.path))
                    && present(r)
            })
            .cloned()
            .collect();
        for kind in KINDS {
            let records: Vec<_> = out_of_scope.iter().filter(|r| r.kind == kind).collect();
            for batch in records.chunks(96) {
                let condition = batch
                    .iter()
                    .map(|r| format!("key = {}", quote(&r.key)))
                    .collect::<Vec<_>>()
                    .join(" || ");
                self.write(&format!(
                    "mutation {{ delete {kind}({condition}) {{ @detach }} }}"
                ))?;
                for record in batch {
                    catalog.remove(&record.key);
                }
            }
        }
        self.flush()?;
        let by_path: HashMap<_, _> = catalog
            .values()
            .map(|r| (r.path.clone(), r.clone()))
            .collect();
        let mut indexed_items = catalog.values().filter(|r| r.kind != "Folder").count();
        let repairing = self.needs_repair.load(Ordering::Relaxed);
        let mut seen = HashSet::new();
        let mut seen_paths = HashSet::new();
        let mut failed = Vec::<PathBuf>::new();
        let mut stack: Vec<_> = roots
            .iter()
            .map(|r| (r.path.clone(), r.apps, None::<Record>))
            .collect();
        let mut visited = HashSet::new();
        // Scope volume IDs to this scan so a remount is observed next time.
        let mut volumes = HashMap::new();
        while let Some((path, apps, parent)) = stack.pop() {
            if self.paused.load(Ordering::Relaxed) {
                return Ok(());
            }
            if !visited.insert(path.clone()) {
                continue;
            }
            let (mut r, mut media) = match crawler::record_cached(
                &path,
                apps,
                &mut volumes,
                if repairing {
                    None
                } else {
                    by_path.get(path.to_string_lossy().as_ref())
                },
            ) {
                Ok(r) => r,
                Err(e) => {
                    if e.kind() != std::io::ErrorKind::NotFound {
                        failed.push(path);
                        self.status.lock().unwrap().skipped += 1;
                    }
                    continue;
                }
            };
            if let Some(old) = catalog.get(&r.key) {
                if old.kind != r.kind {
                    media = match old.kind.as_str() {
                        "Photo" => metadata::photo(&path),
                        "Video" => metadata::video(&path).unwrap_or_default(),
                        _ => Media::default(),
                    };
                    r.kind = old.kind.clone();
                }
            }
            self.upsert(&r, &media, parent.as_ref(), catalog.get(&r.key))?;
            seen.insert(r.key.clone());
            seen_paths.insert(r.path.clone());
            if catalog.insert(r.key.clone(), r.clone()).is_none() && r.kind != "Folder" {
                indexed_items += 1;
            }
            if r.kind == "Folder" {
                match fs::read_dir(&path) {
                    Ok(entries) => {
                        for entry in entries {
                            match entry {
                                Ok(entry) if crawler::visible(&entry.path()) => {
                                    stack.push((entry.path(), apps, Some(r.clone())))
                                }
                                Ok(_) => {}
                                Err(_) => {
                                    failed.push(path.clone());
                                    self.status.lock().unwrap().skipped += 1;
                                }
                            }
                        }
                    }
                    Err(_) => {
                        failed.push(path);
                        self.status.lock().unwrap().skipped += 1;
                    }
                }
            }
            if seen.len() % 32 == 0 {
                std::thread::sleep(Duration::from_millis(1));
            }
            self.status.lock().unwrap().items_indexed = indexed_items;
        }
        let missing: Vec<_> = catalog
            .values()
            .filter(|r| !seen.contains(&r.key) && !r.key.starts_with(REGISTERED_APP))
            .cloned()
            .collect();
        for r in missing {
            if !present(&r) {
                if !r.offline {
                    self.write(&format!(
                        "mutation {{ {}(key = {}) set offline: true }}",
                        r.kind,
                        quote(&r.key)
                    ))?;
                    catalog.get_mut(&r.key).unwrap().offline = true;
                }
            } else if !failed.iter().any(|p| Path::new(&r.path).starts_with(p))
                && (!Path::new(&r.path).exists() || seen_paths.contains(&r.path))
            {
                self.write(&format!(
                    "mutation {{ delete {}(key = {}) {{ @detach }} }}",
                    r.kind,
                    quote(&r.key)
                ))?;
                catalog.remove(&r.key);
            }
        }
        self.flush()?;
        for volume in rows(self.zql("query { Volume { key } }")?) {
            let key = volume["key"].as_str().unwrap_or_default();
            let offline = catalog
                .values()
                .filter(|r| r.volume == key)
                .all(|r| r.offline);
            self.write(&format!(
                "mutation {{ Volume(key = {}) set offline: {offline} }}",
                quote(key)
            ))?;
        }
        self.status.lock().unwrap().items_indexed =
            catalog.values().filter(|r| r.kind != "Folder").count();
        Ok(())
    }

    pub fn rebuild(&self, roots: &[Root]) -> Result<()> {
        // Re-extract online files. Preserve metadata for disconnected drives.
        let mut catalog = self.catalog.lock().unwrap();
        let registered: Vec<_> = catalog
            .values()
            .filter(|r| r.key.starts_with(REGISTERED_APP))
            .cloned()
            .collect();
        for kind in KINDS {
            self.write(&format!(
                "mutation {{ delete {kind}(offline = false) {{ @detach }} }}"
            ))?;
        }
        catalog.retain(|_, r| r.offline);
        for record in registered {
            self.upsert(&record, &Media::default(), None, None)?;
            catalog.insert(record.key.clone(), record);
        }
        drop(catalog);
        self.reconcile(roots)?;
        self.checkpoint()
    }
}
