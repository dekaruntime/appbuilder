use crate::{
    config,
    model::{Event, Request},
};
use computer_index::{Index, Root, Service};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc,
    },
};
pub fn start(
    directory: PathBuf,
    roots: Vec<config::Root>,
    latest: Arc<AtomicU64>,
    rx: mpsc::Receiver<Request>,
    events: async_channel::Sender<Event>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let result = (|| -> Result<(), String> {
            let index = Arc::new(Index::open(&directory)?);
            let roots: Vec<_> = roots
                .into_iter()
                .map(|r| Root {
                    path: r.path,
                    apps: r.apps,
                })
                .collect();
            index.reconcile(&roots)?;
            let _service = Service::start(index.clone(), roots)?;
            let _ = events.send_blocking(Event::Ready);
            while let Ok(request) = rx.recv() {
                match request {
                    Request::Stop => break,
                    Request::Search(id, query) => {
                        if id != latest.load(Ordering::Relaxed) {
                            continue;
                        }
                        let results = index.search(&query);
                        if events.send_blocking(Event::Results(id, results)).is_err() {
                            break;
                        }
                    }
                    Request::Open(key) => {
                        let result = index.resolve(&key).and_then(|path| {
                            std::process::Command::new("/usr/bin/open")
                                .arg(path)
                                .status()
                                .map_err(|e| e.to_string())
                                .and_then(|s| {
                                    if s.success() {
                                        Ok(())
                                    } else {
                                        Err("macOS could not open this result".into())
                                    }
                                })
                        });
                        if events.send_blocking(Event::Opened(result)).is_err() {
                            break;
                        }
                    }
                }
            }
            Ok(())
        })();
        if let Err(error) = result {
            let _ = events.send_blocking(Event::BackendError(error));
        }
    })
}
