#![cfg(feature = "compiler")]
use computer_index::{Index, Root};
use deka_vm_experiment::{compiler, component::Component, HostValue};
use std::{
    cell::RefCell,
    rc::Rc,
    sync::{atomic::AtomicU64, mpsc, Arc},
};
use zega_native::model::{Event, Model, Request, Results};
fn text(node: &deka_native_ui::Node) -> String {
    let mut s = node.text.clone().unwrap_or_default();
    for child in &node.children {
        s.push_str(&text(child));
    }
    s
}
#[test]
fn real_index_to_dsx_input_results_keyboard_open_and_stale_replies() {
    let temp = std::env::temp_dir().join(format!("native-launcher-test-{}", std::process::id()));
    std::fs::create_dir_all(&temp).unwrap();
    let files = temp.join("files");
    std::fs::create_dir_all(&files).unwrap();
    std::fs::write(files.join("Orchid Notes.txt"), "notes").unwrap();
    std::fs::write(files.join("Orchid Plans.txt"), "plans").unwrap();
    let index = Index::open(&temp.join("index")).unwrap();
    index
        .reconcile(&[Root {
            path: files.clone(),
            apps: false,
        }])
        .unwrap();
    let (requests, rx) = mpsc::channel();
    let (events, event_rx) = async_channel::unbounded();
    let model = Model {
        state: Rc::new(RefCell::new(Results::default())),
        latest: Arc::new(AtomicU64::new(0)),
        requests,
        events,
    };
    let program =
        compiler::compile_entry(include_str!("../launcher.dsx"), &model.hosts(), "Launcher")
            .unwrap();
    let mut app = Component::new(program, model.hosts()).unwrap();
    app.call("opened", vec![]).unwrap();
    let old = match rx.recv().unwrap() {
        Request::Search(id, _) => id,
        _ => panic!("expected query"),
    };
    let frame = app.render().unwrap();
    assert_eq!(frame.inputs.len(), 1);
    app.event(
        frame.inputs[0].change,
        vec![HostValue::String("Orchid".into())],
    )
    .unwrap();
    let id = match rx.recv().unwrap() {
        Request::Search(id, q) => {
            assert_eq!(q, "Orchid");
            assert!(model.accept(id, index.search(&q)));
            id
        }
        _ => panic!("expected query"),
    };
    app.call("results", vec![]).unwrap();
    let frame = app.render().unwrap();
    assert_eq!(frame.inputs[0].value, "Orchid");
    assert!(text(&frame.root).contains("Orchid Notes.txt"));
    assert!(text(&frame.root).contains("Orchid Plans.txt"));
    assert!(!model.accept(old, Err("old response".into())));
    assert_eq!(model.state.borrow().generation, id);
    app.event(frame.inputs[0].key, vec![HostValue::String("down".into())])
        .unwrap();
    assert_eq!(app.call("selected", vec![]).unwrap(), HostValue::Number(1.));
    app.event(frame.inputs[0].key, vec![HostValue::String("enter".into())])
        .unwrap();
    match rx.recv().unwrap() {
        Request::Open(key) => {
            assert_eq!(key, model.state.borrow().rows[1].key);
            assert!(index
                .resolve(&key)
                .unwrap()
                .starts_with(files.to_str().unwrap()));
        }
        _ => panic!("expected open"),
    }
    app.event(
        frame.inputs[0].key,
        vec![HostValue::String("escape".into())],
    )
    .unwrap();
    assert!(matches!(event_rx.try_recv().unwrap(), Event::Hide));
    app.event(
        frame.inputs[0].change,
        vec![HostValue::String("café".into())],
    )
    .unwrap();
    assert_eq!(app.render().unwrap().inputs[0].value, "café");
    assert!(model.state.borrow().rows.is_empty());
    drop(index);
    std::fs::remove_dir_all(temp).unwrap();
}
