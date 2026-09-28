//! Headless fixture/IPC harness. It never starts a desktop or opens user files.
use computer_index::{Index, Root};
use serde_json::{json, Value};
use std::{
    io::{self, BufRead, Write},
    path::PathBuf,
    time::Instant,
};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.get(1).is_some_and(|s| s == "--network-control") {
        let _ = std::net::TcpStream::connect("127.0.0.1:9");
        return Ok(());
    }
    let home = PathBuf::from(args.get(1).ok_or("home argument required")?);
    let data = PathBuf::from(args.get(2).ok_or("data argument required")?);
    let roots = vec![
        Root {
            path: home.clone(),
            apps: false,
        },
        Root {
            path: home.join("Applications"),
            apps: true,
        },
    ];
    let index = Index::open(&data)?;
    let start = Instant::now();
    index.reconcile(&roots)?;
    index.set_actions(&[("Index settings".into(), "fixture.settings".into())])?;
    println!(
        "{}",
        json!({"ready":true,"scanMs":start.elapsed().as_secs_f64()*1000.0,"counts":index.counts()?})
    );
    io::stdout().flush()?;
    for line in io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line?)?;
        let command = request["command"].as_str().unwrap_or_default();
        let args = &request["args"];
        let answer: Result<Value, String> = match command {
            "index_search" => index
                .search_on(
                    args["query"].as_str().unwrap_or_default(),
                    chrono::NaiveDate::from_ymd_opt(2026, 9, 28).unwrap(),
                )
                .map(|r| json!(r)),
            "index_status" => Ok(json!(index.status())),
            "index_pause" => {
                index.pause(args["paused"].as_bool().unwrap_or(false));
                Ok(Value::Null)
            }
            "index_rebuild" => index.rebuild(&roots).map(|_| Value::Null),
            "index_open_result" => index
                .resolve(args["key"].as_str().unwrap_or_default())
                .map(|p| json!(p)),
            _ => Err(format!("Unknown probe command: {command}")),
        };
        println!(
            "{}",
            match answer {
                Ok(value) => json!({"value":value}),
                Err(error) => json!({"error":error}),
            }
        );
        io::stdout().flush()?;
    }
    index.checkpoint()?;
    Ok(())
}
