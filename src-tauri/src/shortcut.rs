//! Carbon's exclusive registration suppresses Finder's shared ⌘⌥Space binding
//! only while zega owns the key. No system preference edits or event tap needed.
use std::{
    cell::{Cell, RefCell},
    ffi::c_void,
    ptr,
};
use tauri::AppHandle;

const KEYBOARD: u32 = u32::from_be_bytes(*b"keyb");
const SIGNATURE: u32 = u32::from_be_bytes(*b"zega");
const EXCLUSIVE: u32 = 1;
const NOT_HANDLED: i32 = -9874;

#[repr(C, packed(2))]
#[derive(Default)]
struct HotKeyId {
    signature: u32,
    id: u32,
}
#[repr(C, packed(2))]
struct EventType {
    class: u32,
    kind: u32,
}

type Handle = *mut c_void;
type Callback = unsafe extern "C" fn(Handle, Handle, Handle) -> i32;

#[link(name = "Carbon", kind = "framework")]
extern "C" {
    fn GetApplicationEventTarget() -> Handle;
    fn GetEventKind(event: Handle) -> u32;
    fn GetEventParameter(
        event: Handle,
        name: u32,
        kind: u32,
        actual: *mut u32,
        size: usize,
        actual_size: *mut usize,
        data: Handle,
    ) -> i32;
    fn InstallEventHandler(
        target: Handle,
        callback: Callback,
        count: usize,
        types: *const EventType,
        data: Handle,
        handler: *mut Handle,
    ) -> i32;
    fn RemoveEventHandler(handler: Handle) -> i32;
    fn RegisterEventHotKey(
        key: u32,
        modifiers: u32,
        id: HotKeyId,
        target: Handle,
        options: u32,
        registration: *mut Handle,
    ) -> i32;
    fn UnregisterEventHotKey(registration: Handle) -> i32;
}

struct Context {
    app: AppHandle,
    pressed: Cell<bool>,
}
struct Registration {
    key: Handle,
    handler: Handle,
    _context: Box<Context>,
}

impl Drop for Registration {
    fn drop(&mut self) {
        // Created and destroyed on the main thread. Remove the callback before
        // releasing its boxed context; Carbon does not retain that pointer.
        unsafe {
            UnregisterEventHotKey(self.key);
            RemoveEventHandler(self.handler);
        }
    }
}
thread_local! {
    static REGISTRATION: RefCell<Option<Registration>> = const { RefCell::new(None) };
}

pub fn install(app: &AppHandle) -> Result<(), String> {
    let _main =
        objc2::MainThreadMarker::new().ok_or("Shortcut setup must run on the main thread")?;
    let mut context = Box::new(Context {
        app: app.clone(),
        pressed: Cell::new(false),
    });
    let types = [
        EventType {
            class: KEYBOARD,
            kind: 5,
        },
        EventType {
            class: KEYBOARD,
            kind: 6,
        },
    ];
    let mut handler = ptr::null_mut();
    let mut key = ptr::null_mut();
    // The types and ABI follow CarbonEvents.h. Both handles remain on this
    // thread, and the callback context stays alive for the registration.
    unsafe {
        let target = GetApplicationEventTarget();
        let status = InstallEventHandler(
            target,
            on_hotkey,
            types.len(),
            types.as_ptr(),
            (&mut *context as *mut Context).cast(),
            &mut handler,
        );
        if status != 0 {
            return Err(format!("Cannot install shortcut handler ({status})"));
        }
        // kVK_Space, cmdKey | optionKey, kEventHotKeyExclusive.
        let status = RegisterEventHotKey(
            49,
            (1 << 8) | (1 << 11),
            HotKeyId {
                signature: SIGNATURE,
                id: 1,
            },
            target,
            EXCLUSIVE,
            &mut key,
        );
        if status != 0 {
            RemoveEventHandler(handler);
            return Err(format!("⌘⌥Space is owned by another app ({status}). Quit that app and restart zega; tray search is still available."));
        }
    }
    REGISTRATION.with(|slot| {
        *slot.borrow_mut() = Some(Registration {
            key,
            handler,
            _context: context,
        })
    });
    Ok(())
}

pub fn uninstall() {
    REGISTRATION.with(|slot| {
        slot.borrow_mut().take();
    });
}

unsafe extern "C" fn on_hotkey(_: Handle, event: Handle, context: Handle) -> i32 {
    let mut id = HotKeyId::default();
    let status = GetEventParameter(
        event,
        u32::from_be_bytes(*b"----"),
        u32::from_be_bytes(*b"hkid"),
        ptr::null_mut(),
        size_of::<HotKeyId>(),
        ptr::null_mut(),
        (&mut id as *mut HotKeyId).cast(),
    );
    if status != 0 || id.signature != SIGNATURE || id.id != 1 {
        return NOT_HANDLED;
    }
    let context = &*context.cast::<Context>();
    match GetEventKind(event) {
        5 if !context.pressed.replace(true) => {
            // Window operations are performed on the main thread.
            let app = context.app.clone();
            let _ = context
                .app
                .run_on_main_thread(move || crate::menu::toggle_search_window(&app));
        }
        6 => context.pressed.set(false),
        _ => {}
    }
    0
}
