mod config;
mod desktop;
mod input;
mod painter;
mod shortcut;
#[path = "../../src-tauri/src/shortcut_config.rs"]
mod shortcut_config;
mod worker;
use fs2::FileExt;
use model::{Model, Request, Results};
use std::{
    cell::RefCell,
    path::PathBuf,
    rc::Rc,
    sync::{atomic::AtomicU64, mpsc, Arc},
};
use zega_native::model;
fn main() {
    if let Err(error) = run() {
        eprintln!("zega-native: {error}");
        std::process::exit(1);
    }
}
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let bundle = std::env::current_exe()?
        .parent()
        .ok_or("no executable directory")?
        .join("../Resources");
    let (manifest,program_path,compile,smoke)=match args.as_slice(){
        []=>(bundle.join("deka.json"),bundle.join("app.dvm.json"),false,None),
        [mode,config,out] if mode=="--compile"=>(PathBuf::from(config),PathBuf::from(out),true,None),
        [flag,config,program,path] if flag=="--config" && program=="--program"=>(PathBuf::from(config),PathBuf::from(path),false,None),
        [flag,config,program,path,smoke,query] if flag=="--config" && program=="--program" && smoke=="--smoke"=>(PathBuf::from(config),PathBuf::from(path),false,Some(query.clone())),
        _=>return Err("usage: zega-native [--config deka.json --program app.dvm.json] | --compile deka.json output.dvm.json".into()),
    };
    let manifest = std::fs::canonicalize(manifest)?;
    let base = manifest.parent().ok_or("no manifest directory")?;
    let mut config: config::Config = serde_json::from_slice(&std::fs::read(&manifest)?)?;
    config.native.shortcut.validate()?;
    if config
        .native
        .menu
        .iter()
        .any(|item| !matches!(item.id.as_str(), "search" | "quit"))
    {
        return Err("unknown native menu action".into());
    }
    config.native.index_directory = base.join(&config.native.index_directory);
    for root in &mut config.native.roots {
        root.path = base.join(&root.path);
    }
    let (requests, rx) = mpsc::channel();
    let (events, event_rx) = async_channel::unbounded();
    let latest = Arc::new(AtomicU64::new(0));
    let model = Model {
        state: Rc::new(RefCell::new(Results {
            status: "Opening local index…".into(),
            ..Default::default()
        })),
        latest: latest.clone(),
        requests: requests.clone(),
        events: events.clone(),
    };
    if compile {
        #[cfg(feature = "compiler")]
        {
            let source = std::fs::read_to_string(base.join(&config.desktop.entry))?;
            let program = deka_vm_experiment::compiler::compile_entry(
                &source,
                &model.hosts(),
                &config.desktop.entry_function,
            )?;
            std::fs::write(program_path, serde_json::to_vec(&program)?)?;
            return Ok(());
        }
        #[cfg(not(feature = "compiler"))]
        return Err("compile with the compiler feature enabled".into());
    }
    let program = serde_json::from_slice(&std::fs::read(program_path)?)?;
    std::fs::create_dir_all(&config.native.index_directory)?;
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(config.native.index_directory.join("native.lock"))?;
    lock.try_lock_exclusive()
        .map_err(|_| "native launcher already uses this index directory")?;
    let roots = std::mem::take(&mut config.native.roots);
    let worker = worker::start(
        config.native.index_directory.clone(),
        roots,
        latest,
        rx,
        events,
    );
    let result = desktop::run(program, model, event_rx, config, smoke);
    let _ = requests.send(Request::Stop);
    let _ = worker.join();
    result.map_err(Into::into)
}
