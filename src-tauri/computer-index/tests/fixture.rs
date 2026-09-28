use chrono::NaiveDate;
use computer_index::{Index, Root, Service};
use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::Arc,
    time::{Duration, Instant},
};

fn fixture(name: &str) -> (PathBuf, Vec<Root>) {
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();
    let base = repo.join(format!(".tmp/index-{name}-{}", std::process::id()));
    if base.exists() {
        fs::remove_dir_all(&base).unwrap();
    }
    fs::create_dir_all(&base).unwrap();
    let home = base.join("home");
    let output = Command::new("python3")
        .arg(repo.join("scripts/generate-test-home.py"))
        .arg("--root")
        .arg(&home)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    (
        base,
        vec![Root {
            path: home,
            apps: false,
        }],
    )
}

#[test]
fn fixture_counts_relationships_identity_offline_and_latency() {
    let (base, mut roots) = fixture("proof");
    roots.push(Root {
        path: roots[0].path.join("Applications"),
        apps: true,
    });
    let index = Index::open(&base.join("computer")).unwrap();
    let start = Instant::now();
    index.reconcile(&roots).unwrap();
    let scan = start.elapsed();
    let counts = index.counts().unwrap();
    for (kind, count) in [
        ("File", 2000),
        ("Photo", 50),
        ("Video", 5),
        ("App", 1),
        ("Folder", 17),
        ("Place", 1),
        ("Camera", 1),
        ("Day", 1),
        ("Period", 1),
        ("Volume", 1),
    ] {
        assert_eq!(counts[kind], count, "{kind}");
    }
    assert_eq!(index.search("lisbon photos").unwrap().len(), 30);
    assert_eq!(
        index
            .search("lisbn")
            .unwrap()
            .iter()
            .filter(|r| r.kind == "photos")
            .count(),
        30
    );
    assert_eq!(
        index
            .search_on(
                "videos last summer",
                NaiveDate::from_ymd_opt(2026, 9, 28).unwrap()
            )
            .unwrap()
            .len(),
        5
    );
    fn bytes(p: &std::path::Path) -> u64 {
        fs::read_dir(p)
            .unwrap()
            .map(|e| {
                let p = e.unwrap().path();
                if p.is_dir() {
                    bytes(&p)
                } else {
                    fs::metadata(p).unwrap().len()
                }
            })
            .sum()
    }
    index.checkpoint().unwrap();
    let fixture_bytes = bytes(&base.join("computer"));
    assert_eq!(
        index.search("lisbn").unwrap()[0].kind,
        "files",
        "keyboard order must agree with rendered groups"
    );
    let before = index
        .records()
        .into_iter()
        .find(|r| r.name == "notes-0000.txt")
        .unwrap();
    let node_id = index.node_id("File", &before.key).unwrap();
    let moved = roots[0].path.join("Downloads/moved, notes.txt");
    fs::rename(&before.path, &moved).unwrap();
    index.reconcile(&roots).unwrap();
    let after = index
        .records()
        .into_iter()
        .find(|r| r.path == moved.to_string_lossy())
        .unwrap();
    assert_eq!(
        after.key, before.key,
        "rename must keep volume/file ID/fingerprint identity"
    );
    assert_eq!(
        index.node_id("File", &after.key).unwrap(),
        node_id,
        "rename must keep engine node identity"
    );
    assert_eq!(index.search("moved").unwrap().len(), 1);
    // Mount provider reports the volume absent; do not touch a physical mount.
    index.reconcile_with_presence(&[], |_| false).unwrap();
    assert!(index.records().iter().all(|r| r.offline));
    assert_eq!(index.search("moved").unwrap().len(), 1);
    assert!(index.search("moved").unwrap()[0].offline);
    index.reconcile(&roots).unwrap();
    assert!(!index.search("moved").unwrap()[0].offline);
    fs::remove_file(&moved).unwrap();
    index.reconcile(&roots).unwrap();
    assert!(index.search("moved").unwrap().is_empty());
    let mut timings = Vec::new();
    for _ in 0..10 {
        for query in [
            "l",
            "li",
            "lis",
            "lisb",
            "lisbn",
            "lisbon photos",
            "videos last summer",
            "notes-012",
            "zzzz-no-match",
        ] {
            let start = Instant::now();
            index.search(query).unwrap();
            timings.push(start.elapsed());
        }
    }
    timings.sort();
    let p95 = timings[(timings.len() * 95 / 100).min(timings.len() - 1)];
    assert!(p95 <= Duration::from_millis(50), "p95={p95:?}");
    index.checkpoint().unwrap();
    println!(
        "PROOF scan_ms={:.2} search_p95_ms={:.3} graph_bytes={} counts={counts:?}",
        scan.as_secs_f64() * 1000.0,
        p95.as_secs_f64() * 1000.0,
        fixture_bytes
    );
    drop(index);
    let reopened = Index::open(&base.join("computer")).unwrap();
    assert_eq!(reopened.search("lisbon photos").unwrap().len(), 30);
    assert_eq!(reopened.counts().unwrap()["File"], 1999);
    assert!(reopened.status().last_scan.is_some());
    reopened.reconcile(&roots).unwrap();
    assert_eq!(reopened.search("lisbon photos").unwrap().len(), 30);
}

#[test]
fn watcher_indexes_new_file_within_five_seconds() {
    let (base, mut roots) = fixture("watch");
    roots.push(Root {
        path: roots[0].path.join("Applications"),
        apps: true,
    });
    let index = Arc::new(Index::open(&base.join("computer")).unwrap());
    index.reconcile(&roots).unwrap();
    let service = Service::start(index.clone(), roots.clone()).unwrap();
    let start = Instant::now();
    fs::write(
        roots[0].path.join("Downloads/brand-new-searchable.txt"),
        "live update",
    )
    .unwrap();
    loop {
        if !index.search("brand-new-searchable").unwrap().is_empty() {
            break;
        }
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "new file did not become searchable"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    println!("PROOF watcher_new_file_ms={}", start.elapsed().as_millis());
    drop(service);
}

fn small(name: &str) -> (PathBuf, Root, Index) {
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();
    let base = repo.join(format!(".tmp/small-{name}-{}", std::process::id()));
    if base.exists() {
        fs::remove_dir_all(&base).unwrap();
    }
    let home = base.join("home");
    fs::create_dir_all(home.join("folder")).unwrap();
    fs::write(home.join("original.txt"), "identity fixture").unwrap();
    let root = Root {
        path: home.clone(),
        apps: false,
    };
    let index = Index::open(&base.join("graph")).unwrap();
    index.reconcile(std::slice::from_ref(&root)).unwrap();
    (home, root, index)
}

#[test]
fn rename_preserves_engine_identity() {
    let (home, root, index) = small("rename");
    let before = index.search("original").unwrap().remove(0);
    fs::rename(home.join("original.txt"), home.join("folder/renamed.txt")).unwrap();
    index.reconcile(&[root]).unwrap();
    let after = index.search("renamed").unwrap().remove(0);
    assert_eq!(
        before.key, after.key,
        "rename must preserve the identity key"
    );
    assert_eq!(
        before.id, after.id,
        "rename must preserve the stored engine node"
    );
    assert!(index.search("original").unwrap().is_empty());
}

#[test]
fn unmounted_volume_is_offline_not_deleted() {
    let (_, root, index) = small("offline");
    let before = index.search("original").unwrap().remove(0);
    index.reconcile_with_presence(&[], |_| false).unwrap();
    let offline = index.search("original").unwrap();
    assert_eq!(offline.len(), 1, "unmount must retain the node");
    assert_eq!(offline[0].id, before.id);
    assert!(offline[0].offline, "unmount must mark the node offline");
    index.rebuild(&[]).unwrap();
    assert_eq!(
        index.search("original").unwrap().len(),
        1,
        "rebuild must retain offline metadata"
    );
    index.reconcile(&[root]).unwrap();
    assert!(!index.search("original").unwrap()[0].offline);
}

#[test]
fn escaped_names_and_updates_are_safe_and_searchable() {
    let (home, root, index) = small("escaping");
    let name = if cfg!(windows) {
        "comma, bracket[ file.txt"
    } else {
        "comma, quote\" slash\\ file.txt"
    };
    fs::write(home.join(name), "first").unwrap();
    index.reconcile(std::slice::from_ref(&root)).unwrap();
    let needle = if cfg!(windows) { "bracket[" } else { "quote\"" };
    assert_eq!(index.search(needle).unwrap().len(), 1);
    if cfg!(unix) {
        assert_eq!(index.search("slash\\").unwrap().len(), 1);
    }
    let before = index.search("original").unwrap()[0].key.clone();
    fs::write(home.join("original.txt"), "new content and length").unwrap();
    index.reconcile(&[root]).unwrap();
    assert_ne!(index.search("original").unwrap()[0].key, before);
    assert!(index
        .search("\") { @id } mutation { delete File(key != \"\")")
        .unwrap()
        .is_empty());
    assert_eq!(index.counts().unwrap()["File"], 2);
}
