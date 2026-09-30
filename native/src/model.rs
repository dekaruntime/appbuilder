use computer_index::SearchResult;
use deka_vm_experiment::{HostOp, HostReply, HostType, HostValue, Hosts};
use std::{
    cell::RefCell,
    rc::Rc,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc,
    },
};

pub enum Request {
    Search(u64, String),
    Open(String),
    Stop,
}
pub enum Event {
    Results(u64, Result<Vec<SearchResult>, String>),
    Opened(Result<(), String>),
    BackendError(String),
    Ready,
    Toggle,
    Hide,
    Quit,
}
#[derive(Default)]
pub struct Results {
    pub rows: Vec<SearchResult>,
    pub status: String,
    pub generation: u64,
    pub dark: bool,
}
pub struct Model {
    pub state: Rc<RefCell<Results>>,
    pub latest: Arc<AtomicU64>,
    pub requests: mpsc::Sender<Request>,
    pub events: async_channel::Sender<Event>,
}
impl Model {
    pub fn hosts(&self) -> Hosts {
        let mut hosts = Hosts::default();
        let state = self.state.clone();
        let tx = self.requests.clone();
        let latest = self.latest.clone();
        hosts
            .register(HostOp::new(
                "search",
                vec![HostType::String],
                HostType::Unit,
                false,
                None,
                move |args| {
                    let HostValue::String(query) = &args[0] else {
                        unreachable!()
                    };
                    let generation = latest.fetch_add(1, Ordering::Relaxed) + 1;
                    let mut state = state.borrow_mut();
                    state.generation = generation;
                    state.rows.clear();
                    state.status = "Searching…".into();
                    HostReply::Ready(
                        tx.send(Request::Search(generation, query.clone()))
                            .map(|_| HostValue::Unit)
                            .map_err(|e| e.to_string()),
                    )
                },
            ))
            .unwrap();
        let state = self.state.clone();
        hosts
            .register(HostOp::new(
                "result_keys",
                vec![],
                HostType::Strings,
                false,
                None,
                move |_| {
                    HostReply::Ready(Ok(HostValue::Strings(
                        state.borrow().rows.iter().map(|r| r.key.clone()).collect(),
                    )))
                },
            ))
            .unwrap();
        for name in ["result_name", "result_detail"] {
            let state = self.state.clone();
            hosts
                .register(HostOp::new(
                    name,
                    vec![HostType::String],
                    HostType::String,
                    false,
                    None,
                    move |args| {
                        let HostValue::String(key) = &args[0] else {
                            unreachable!()
                        };
                        let value = state
                            .borrow()
                            .rows
                            .iter()
                            .find(|r| &r.key == key)
                            .map(|r| {
                                if name == "result_name" {
                                    r.name.clone()
                                } else if r.offline {
                                    format!("Offline · {}", r.path)
                                } else {
                                    r.path.clone()
                                }
                            })
                            .ok_or("unknown result".into());
                        HostReply::Ready(value.map(HostValue::String))
                    },
                ))
                .unwrap();
        }
        let state = self.state.clone();
        let tx = self.requests.clone();
        hosts
            .register(HostOp::new(
                "open_result",
                vec![HostType::String],
                HostType::Unit,
                false,
                None,
                move |args| {
                    let HostValue::String(key) = &args[0] else {
                        unreachable!()
                    };
                    let result = (|| -> Result<(), String> {
                        let state = state.borrow();
                        let row = state
                            .rows
                            .iter()
                            .find(|r| &r.key == key)
                            .ok_or("unknown result")?;
                        if row.offline {
                            return Err("This result is offline".into());
                        }
                        tx.send(Request::Open(row.key.clone()))
                            .map_err(|e| e.to_string())
                    })();
                    // Opening errors are visible state, not a crashed input handler.
                    if let Err(e) = result {
                        state.borrow_mut().status = e;
                    }
                    HostReply::Ready(Ok(HostValue::Unit))
                },
            ))
            .unwrap();
        let state = self.state.clone();
        hosts
            .register(HostOp::new(
                "dark_mode",
                vec![],
                HostType::Bool,
                false,
                None,
                move |_| HostReply::Ready(Ok(HostValue::Bool(state.borrow().dark))),
            ))
            .unwrap();
        let state = self.state.clone();
        hosts
            .register(HostOp::new(
                "status_text",
                vec![],
                HostType::String,
                false,
                None,
                move |_| HostReply::Ready(Ok(HostValue::String(state.borrow().status.clone()))),
            ))
            .unwrap();
        let events = self.events.clone();
        hosts
            .register(HostOp::new(
                "hide_window",
                vec![],
                HostType::Unit,
                false,
                None,
                move |_| {
                    HostReply::Ready(
                        events
                            .try_send(Event::Hide)
                            .map(|_| HostValue::Unit)
                            .map_err(|e| e.to_string()),
                    )
                },
            ))
            .unwrap();
        hosts
    }
    pub fn accept(&self, generation: u64, result: Result<Vec<SearchResult>, String>) -> bool {
        let mut state = self.state.borrow_mut();
        if generation != state.generation {
            return false;
        }
        match result {
            Ok(mut rows) => {
                rows.truncate(6);
                state.status = if rows.is_empty() {
                    "No local matches".into()
                } else {
                    format!("{} results · local index", rows.len())
                };
                state.rows = rows;
            }
            Err(error) => {
                state.rows.clear();
                state.status = error;
            }
        }
        true
    }
}
