use crate::{
    config::Config,
    input::{self, InputEvent, TextInput},
    model::{Event, Model, Request},
    painter, shortcut,
};
use deka_native_ui::scene::{Renderer, Scene};
use deka_vm_experiment::{
    component::{Component, ComponentFrame},
    HostValue, Program,
};
use gpui::{prelude::*, *};
use std::{cell::RefCell, collections::HashMap, rc::Rc, sync::Arc};
use tray_icon::{
    menu::{Menu, MenuEvent, MenuItem},
    MouseButton as TrayButton, MouseButtonState, TrayIconBuilder, TrayIconEvent,
};

struct View {
    component: Component,
    state: Rc<RefCell<crate::model::Results>>,
    frame: ComponentFrame,
    input: Entity<TextInput>,
    scene: Scene,
    renderer: Renderer,
    images: HashMap<String, Arc<RenderImage>>,
    error: Option<String>,
    _subscription: Subscription,
}
impl View {
    fn refresh(&mut self, cx: &mut Context<Self>) {
        match self.component.render() {
            Ok(frame) => {
                if let Some(spec) = frame.inputs.first() {
                    self.input.update(cx, |input, cx| {
                        input.sync(&spec.value, &spec.placeholder, self.state.borrow().dark, cx)
                    });
                }
                self.frame = frame;
            }
            Err(error) => self.error = Some(error),
        }
        cx.notify();
    }
    fn input_event(&mut self, event: &InputEvent, cx: &mut Context<Self>) {
        if let Some(spec) = self.frame.inputs.first() {
            let (handler, value) = match event {
                InputEvent::Change(value) => (spec.change, value),
                InputEvent::Key(value) => (spec.key, value),
            };
            if let Err(error) = self
                .component
                .event(handler, vec![HostValue::String(value.clone())])
            {
                self.error = Some(error);
            }
            self.refresh(cx);
        }
    }
}
impl Render for View {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let size = window.viewport_size();
        self.scene = self.renderer.render_at(
            &self.frame.root,
            size.width.into(),
            size.height.into(),
            window.scale_factor(),
            0.,
            true,
        );
        let input_rect = self
            .frame
            .inputs
            .first()
            .and_then(|spec| {
                self.scene
                    .targets
                    .iter()
                    .find(|target| target.handler == spec.target)
            })
            .map(|t| t.rect);
        let scene = self.scene.clone();
        let entity = cx.entity();
        div()
            .size_full()
            .relative()
            .overflow_hidden()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|view, event: &MouseDownEvent, window, cx| {
                    window.focus(&view.input.focus_handle(cx));
                    if let Some(target) = view
                        .scene
                        .hit(event.position.x.into(), event.position.y.into())
                    {
                        if !view
                            .frame
                            .inputs
                            .iter()
                            .any(|input| input.target == target.handler)
                        {
                            if let Err(error) = view.component.event(target.handler, vec![]) {
                                view.error = Some(error);
                            }
                            view.refresh(cx);
                        }
                    }
                }),
            )
            .child(
                canvas(
                    move |_, _, _| scene,
                    move |bounds, scene, window, cx| {
                        entity.update(cx, |view, _| {
                            painter::paint_scene(bounds, &scene, window, &mut view.images)
                        });
                    },
                )
                .size_full(),
            )
            .when_some(input_rect, |root, r| {
                root.child(
                    div()
                        .absolute()
                        .left(px(r.x))
                        .top(px(r.y + 4.))
                        .w(px(r.width))
                        .h(px(r.height))
                        .child(self.input.clone()),
                )
            })
            .when_some(self.error.clone(), |root, error| {
                root.child(
                    div()
                        .absolute()
                        .bottom_0()
                        .left_0()
                        .bg(rgb(0xffeeee))
                        .text_color(rgb(0x990000))
                        .child(error),
                )
            })
    }
}

pub fn run(
    program: Program,
    model: Model,
    events: async_channel::Receiver<Event>,
    config: Config,
    smoke: Option<String>,
) -> Result<(), String> {
    let mut component = Component::new(program, model.hosts())?;
    component.call("opened", vec![])?;
    let frame = component.render()?;
    if frame.inputs.len() != 1 {
        return Err("launcher must declare exactly one input".into());
    }
    gpui::Application::new().run(move |cx| {
        input::bind(cx);
        if let Some(main) = objc2::MainThreadMarker::new() {
            objc2_app_kit::NSApplication::sharedApplication(main)
                .setActivationPolicy(objc2_app_kit::NSApplicationActivationPolicy::Accessory);
        }
        let tx = model.events.clone();
        let menu = Menu::new();
        for item in &config.native.menu {
            if !matches!(item.id.as_str(), "search" | "quit") {
                eprintln!("Unknown native menu action {}", item.id);
                continue;
            }
            menu.append(&MenuItem::with_id(&item.id, &item.label, true, None))
                .expect("append tray menu");
        }
        let hint = MenuItem::new(
            format!("Shortcut: {}", config.native.shortcut.label()),
            false,
            None,
        );
        menu.append(&hint).expect("append shortcut hint");
        MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
            let _ = tx.try_send(if event.id.as_ref() == "quit" {
                Event::Quit
            } else {
                Event::Toggle
            });
        }));
        let tx = model.events.clone();
        TrayIconEvent::set_event_handler(Some(move |event: TrayIconEvent| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: TrayButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                let _ = tx.try_send(Event::Toggle);
            }
        }));
        let mut pixels = vec![0u8; 32 * 32 * 4];
        for y in 4..28 {
            for x in 4..28 {
                let d = ((x as f32 - 15.5).powi(2) + (y as f32 - 15.5).powi(2)).sqrt();
                if (d - 10.).abs() < 1.5 || (x == 15 && y > 6 && y < 25) {
                    pixels[(y * 32 + x) * 4 + 3] = 255;
                }
            }
        }
        let tray = TrayIconBuilder::new()
            .with_tooltip(&config.desktop.product_name)
            .with_icon(tray_icon::Icon::from_rgba(pixels, 32, 32).unwrap())
            .with_icon_as_template(true)
            .with_menu(Box::new(menu))
            .with_menu_on_left_click(false)
            .build()
            .expect("create native menu bar item");
        let tx = model.events.clone();
        let shortcut_error = shortcut::install(
            move || {
                let _ = tx.try_send(Event::Toggle);
            },
            &config.native.shortcut,
        )
        .err();
        let visible = Rc::new(RefCell::new(true));
        let close_visible = visible.clone();
        let handle = cx
            .open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                        None,
                        size(px(680.), px(640.)),
                        cx,
                    ))),
                    titlebar: None,
                    kind: WindowKind::PopUp,
                    is_resizable: false,
                    is_minimizable: false,
                    app_id: Some("dev.zega.native-search-experiment".into()),
                    ..Default::default()
                },
                |window, cx| {
                    window.on_window_should_close(cx, move |_, cx| {
                        *close_visible.borrow_mut() = false;
                        cx.hide();
                        false
                    });
                    model.state.borrow_mut().dark = matches!(
                        window.appearance(),
                        WindowAppearance::Dark | WindowAppearance::VibrantDark
                    );
                    let input = cx.new(TextInput::new);
                    window.focus(&input.focus_handle(cx));
                    cx.new(|cx| {
                        let subscription = cx.subscribe(&input, |view: &mut View, _, event, cx| {
                            view.input_event(event, cx)
                        });
                        cx.observe_window_appearance(window, |view: &mut View, window, cx| {
                            view.state.borrow_mut().dark = matches!(
                                window.appearance(),
                                WindowAppearance::Dark | WindowAppearance::VibrantDark
                            );
                            view.refresh(cx);
                        })
                        .detach();
                        let mut view = View {
                            state: model.state.clone(),
                            component,
                            frame,
                            input,
                            renderer: Renderer::new(),
                            scene: Scene::default(),
                            images: HashMap::new(),
                            error: shortcut_error,
                            _subscription: subscription,
                        };
                        view.refresh(cx);
                        view
                    })
                },
            )
            .expect("create search window");
        cx.activate(true);
        if let Some(query) = smoke {
            cx.spawn(async move |cx| {
                cx.background_executor().timer(std::time::Duration::from_millis(200)).await;
                let _ = handle.update(cx, |view,window,cx| {
                    view.input.update(cx, |input,cx| input.replace_text_in_range(None,&query,window,cx));
                });
                for _ in 0..100 {
                    cx.background_executor().timer(std::time::Duration::from_millis(200)).await;
                    let done = handle.update(cx, |view,_,cx| {
                        let state=view.state.borrow();
                        if state.rows.is_empty() || view.frame.inputs[0].value != query {return false;}
                        let result = if view.error.is_some() {Err(format!("UI error: {:?}",view.error))}
                            else if view.scene.targets.len()<2 {Err("results never reached native renderer".into())}
                            else if !state.rows.iter().any(|row|row.name.to_lowercase().contains(&query.to_lowercase())) {Err("wrong search results".into())}
                            else {Ok(())};
                        println!("Native smoke: input={:?}, rows={}, rendered targets={}, result={:?}",view.frame.inputs[0].value,state.rows.len(),view.scene.targets.len(),result);
                        shortcut::uninstall();
                        // NSApplication termination exits with zero before run() returns.
                        // Explicitly fail the smoke process instead of hiding an assertion.
                        if result.is_err() { std::process::exit(1); }
                        cx.quit();true
                    }).unwrap_or(true);
                    if done {return;}
                }
                eprintln!("Native smoke timed out before matching results reached the renderer");
                std::process::exit(1);
            }).detach();
        }
        cx.spawn(async move |cx| {
            let _tray = tray;
            while let Ok(event) = events.recv().await {
                let result = handle.update(cx, |view, window, cx| match event {
                    Event::Quit => {
                        let _ = model.requests.send(Request::Stop);
                        shortcut::uninstall();
                        cx.quit();
                    }
                    Event::Hide => {
                        *visible.borrow_mut() = false;
                        cx.hide();
                    }
                    Event::Toggle => {
                        if *visible.borrow() {
                            *visible.borrow_mut() = false;
                            cx.hide();
                        } else {
                            *visible.borrow_mut() = true;
                            cx.activate(true);
                            window.activate_window();
                            window.focus(&view.input.focus_handle(cx));
                            if let Err(error) = view.component.call("opened", vec![]) {
                                view.error = Some(error);
                            }
                            view.refresh(cx);
                        }
                    }
                    Event::Ready => {}
                    Event::BackendError(error) => {
                        let mut state = model.state.borrow_mut();
                        state.rows.clear(); state.status = error;
                        drop(state);
                        if let Err(error) = view.component.call("results", vec![]) {view.error=Some(error);}
                        view.refresh(cx);
                    }
                    Event::Results(id, result) => {
                        if model.accept(id, result) {
                            if let Err(error) = view.component.call("results", vec![]) {
                                view.error = Some(error);
                            }
                            view.refresh(cx);
                        }
                    }
                    Event::Opened(Ok(())) => {
                        *visible.borrow_mut() = false;
                        cx.hide();
                    }
                    Event::Opened(Err(error)) => {
                        model.state.borrow_mut().status = error;
                        view.refresh(cx);
                    }
                });
                if result.is_err() {
                    break;
                }
            }
        })
        .detach();
    });
    Ok(())
}
