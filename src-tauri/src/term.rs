//! A shell on a PTY, opened in the app project's folder. Copied from cqx
//! desktop's terminal (cqxai/desktop src-tauri/src/term.rs) without its
//! agent-usage reader. Bytes are forwarded, never logged or interpreted.
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{ipc::Channel, Manager};

#[derive(Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum Output {
    Data(Vec<u8>),
    End,
    Error(String),
}

fn size(rows: u16, cols: u16) -> Result<PtySize, String> {
    if rows == 0 || cols == 0 {
        return Err("terminal dimensions must be positive".into());
    }
    Ok(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })
}

struct Session {
    owner: String,
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Box<dyn Child + Send + Sync>,
    reader: Option<JoinHandle<()>>,
    #[cfg(unix)]
    wake: std::os::unix::net::UnixStream,
}

impl Session {
    fn open(
        owner: String,
        root: &Path,
        command: CommandBuilder,
        dimensions: PtySize,
        emit: impl Fn(Output) -> bool + Send + 'static,
    ) -> Result<Self, String> {
        if !root.is_dir() {
            return Err(format!("{} is not a directory", root.display()));
        }
        let pair = native_pty_system()
            .openpty(dimensions)
            .map_err(|e| e.to_string())?;
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        #[cfg(unix)]
        let (wake, wake_reader) =
            std::os::unix::net::UnixStream::pair().map_err(|e| e.to_string())?;
        #[cfg(unix)]
        let fd = pair
            .master
            .as_raw_fd()
            .ok_or("PTY has no file descriptor")?;
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|e| e.to_string())?;
        // Keeping our copy of the slave would keep the reader alive after exit.
        drop(pair.slave);
        let mut session = Self {
            owner,
            master: pair.master,
            writer: Arc::new(Mutex::new(writer)),
            child,
            reader: None,
            #[cfg(unix)]
            wake,
        };
        session.reader = Some(
            thread::Builder::new()
                .name("terminal-reader".into())
                .spawn(move || {
                    let mut bytes = [0; 16 * 1024];
                    loop {
                        // A blocking OS wait, woken by output OR close. A descendant
                        // holding the slave open cannot strand the join on shutdown.
                        #[cfg(unix)]
                        if !readable(fd, &wake_reader) {
                            break;
                        }
                        match reader.read(&mut bytes) {
                            Ok(0) => break,
                            Ok(n) => {
                                if !emit(Output::Data(bytes[..n].to_vec())) {
                                    break;
                                }
                            }
                            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                            // Linux reports EIO when the last slave closes.
                            #[cfg(unix)]
                            Err(e) if e.raw_os_error() == Some(libc::EIO) => break,
                            Err(e) => {
                                emit(Output::Error(e.to_string()));
                                break;
                            }
                        }
                    }
                    emit(Output::End);
                })
                .map_err(|e| e.to_string())?,
        );
        Ok(session)
    }

    #[cfg(test)]
    fn write(&mut self, bytes: &[u8]) -> Result<(), String> {
        write_bytes(&self.writer, bytes)
    }

    fn close(&mut self) -> Result<(), String> {
        #[cfg(unix)]
        let jobs = match self.child.try_wait() {
            Ok(Some(_)) => Ok(()),
            _ => self.child.process_id().map_or(Ok(()), end_session_jobs),
        };
        #[cfg(unix)]
        {
            // Job control gives the foreground program a different group
            // from the shell. End it too, including children in that group.
            if let Some(group) = self.master.process_group_leader().filter(|g| *g > 0) {
                if self.child.process_id() != Some(group as u32) {
                    // SAFETY: this is the foreground group of our own PTY.
                    unsafe {
                        libc::kill(-group, libc::SIGKILL);
                    }
                }
            }
        }
        let killed = match self.child.try_wait() {
            Ok(Some(_)) => Ok(()),
            _ => self.child.kill(),
        };
        let waited = killed.and_then(|()| self.child.wait().map(|_| ()));
        // Keep draining while the child exits: macOS can wait for the tty's
        // output queue during exit. Then wake a read held open by descendants.
        #[cfg(unix)]
        let _ = self.wake.write_all(&[1]);
        let joined = self.reader.take().map(|r| r.join()).transpose();
        waited.map_err(|e| e.to_string())?;
        joined.map_err(|_| "terminal reader panicked".to_string())?;
        #[cfg(unix)]
        jobs?;
        Ok(())
    }
}

#[cfg(unix)]
fn end_session_jobs(shell: u32) -> Result<(), String> {
    let shell = shell as libc::pid_t;
    // portable-pty starts the shell with setsid(). Job control puts background
    // jobs in other process groups, but they still belong to this session.
    // Do this before ending/reaping the shell: a slow/stopped shell may never
    // forward SIGHUP before portable-pty falls back to killing it.
    let processes = std::process::Command::new("/bin/ps")
        .args(["-axo", "pid="])
        .output()
        .map_err(|e| format!("Could not enumerate terminal jobs: {e}"))?;
    if !processes.status.success() {
        return Err("Could not enumerate terminal jobs".into());
    }
    let mut targets = HashMap::<libc::pid_t, Vec<libc::pid_t>>::new();
    for pid in String::from_utf8_lossy(&processes.stdout).split_whitespace() {
        let Ok(pid) = pid.parse::<libc::pid_t>() else {
            continue;
        };
        // SAFETY: these calls only inspect an existing process. The unreaped
        // shell owns the session id, so another terminal cannot share it.
        if pid <= 0 || pid == shell || unsafe { libc::getsid(pid) } != shell {
            continue;
        }
        // SAFETY: query the process group of a member of our PTY session.
        let group = unsafe { libc::getpgid(pid) };
        if group > 1 {
            // Kill whole job groups, including children forked since the ps
            // snapshot. Preserve the shell itself to let it reap/save history.
            targets
                .entry(if group == shell { pid } else { -group })
                .or_default()
                .push(pid);
        }
    }
    for (target, members) in targets {
        let group = if target > 0 { shell } else { -target };
        // A job may have exited since enumeration. Recheck session and group
        // membership before signalling, instead of trusting a stale ps row.
        if !members.iter().any(|pid| {
            // SAFETY: these calls only inspect the candidate process.
            unsafe { libc::getsid(*pid) == shell && libc::getpgid(*pid) == group }
        }) {
            continue;
        }
        // SAFETY: only this PTY's job groups or its non-shell members qualify;
        // neither zero nor -1 can be a target.
        if unsafe { libc::kill(target, libc::SIGKILL) } != 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(format!("Could not end terminal job: {error}"));
            }
        }
    }
    Ok(())
}

fn write_bytes(writer: &Mutex<Box<dyn Write + Send>>, bytes: &[u8]) -> Result<(), String> {
    let mut writer = writer.lock().map_err(|e| e.to_string())?;
    writer
        .write_all(bytes)
        .and_then(|()| writer.flush())
        .map_err(|e| e.to_string())
}

impl Drop for Session {
    fn drop(&mut self) {
        if let Err(e) = self.close() {
            log::warn!("Could not close terminal: {e}");
        }
    }
}

#[cfg(unix)]
fn readable(fd: std::os::fd::RawFd, wake: &std::os::unix::net::UnixStream) -> bool {
    use std::os::fd::AsRawFd;
    let mut fds = [
        libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        },
        libc::pollfd {
            fd: wake.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        },
    ];
    loop {
        // SAFETY: both descriptors outlive the reader and the array has two entries.
        let result = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as _, -1) };
        if result >= 0 {
            return fds[1].revents == 0;
        }
        if std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
            return false;
        }
    }
}

fn is_agent_session_marker(name: &str) -> bool {
    matches!(name, "CLAUDECODE" | "CLAUDE_PID" | "CLAUDE_EFFORT")
        || name.starts_with("CLAUDE_CODE_")
        || matches!(name, "CODEX_SESSION_ID" | "CODEX_THREAD_ID")
}

fn shell(root: &Path) -> Result<CommandBuilder, String> {
    let shell = std::env::var_os("SHELL")
        .filter(|s| !s.is_empty())
        .ok_or("SHELL is not set")?;
    // CommandBuilder starts with the entire inherited environment. Login +
    // interactive loads the user's PATH and rc files; no integration injection.
    let mut command = CommandBuilder::new(shell);
    for (name, _) in std::env::vars_os() {
        if name.to_str().is_some_and(is_agent_session_marker) {
            command.env_remove(name);
        }
    }
    command.args(["-l", "-i"]);
    command.cwd(root);
    command.env("TERM", "xterm-256color");
    Ok(command)
}

#[derive(Default, Clone)]
pub struct TermState(Arc<Mutex<HashMap<String, Session>>>);

impl TermState {
    pub fn close_all(&self, owner: Option<&str>) {
        let mut held = self.0.lock().unwrap_or_else(|e| e.into_inner());
        held.retain(|_, session| owner.is_some_and(|o| o != session.owner));
    }
}

#[tauri::command]
pub async fn term_open(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, TermState>,
    id: String,
    path: String,
    rows: u16,
    cols: u16,
    output: Channel<Output>,
) -> Result<(), String> {
    let state = state.inner().clone();
    let owner = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let mut held = state.0.lock().map_err(|e| e.to_string())?;
        if !held.is_empty() {
            return Err("a terminal session is already open".into());
        }
        let root = Path::new(&path);
        let session = Session::open(owner, root, shell(root)?, size(rows, cols)?, move |data| {
            output.send(data).is_ok()
        })?;
        held.insert(id, session);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn term_write(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, TermState>,
    id: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    let state = state.inner().clone();
    let owner = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let writer = {
            let held = state.0.lock().map_err(|e| e.to_string())?;
            held.get(&id)
                .filter(|s| s.owner == owner)
                .ok_or("terminal session has closed")?
                .writer
                .clone()
        };
        // A large paste may block. Do not hold the session table hostage:
        // close must still be able to kill the child and unblock this write.
        write_bytes(&writer, &bytes)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn term_resize(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, TermState>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let held = state.0.lock().map_err(|e| e.to_string())?;
    let session = held
        .get(&id)
        .filter(|s| s.owner == window.label())
        .ok_or("terminal session has closed")?;
    session
        .master
        .resize(size(rows, cols)?)
        .map_err(|e| e.to_string())
}

/// A read-only sample of this window's PTY, polled while its session is alive.
#[tauri::command]
pub async fn term_close(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, TermState>,
    id: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    let owner = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let mut held = state.0.lock().map_err(|e| e.to_string())?;
        if held.get(&id).is_some_and(|s| s.owner == owner) {
            if let Some(mut session) = held.remove(&id) {
                session.close()?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn window_closed(window: &tauri::Window, event: &tauri::WindowEvent) {
    if matches!(event, tauri::WindowEvent::Destroyed) {
        window.state::<TermState>().close_all(Some(window.label()));
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::mpsc::{self, Receiver};
    use std::time::{Duration, Instant};

    struct EnvRestore {
        name: &'static str,
        value: Option<std::ffi::OsString>,
    }

    impl EnvRestore {
        fn set(name: &'static str, value: &str) -> Self {
            let previous = std::env::var_os(name);
            std::env::set_var(name, value);
            Self {
                name,
                value: previous,
            }
        }
    }

    impl Drop for EnvRestore {
        fn drop(&mut self) {
            if let Some(value) = &self.value {
                std::env::set_var(self.name, value);
            } else {
                std::env::remove_var(self.name);
            }
        }
    }

    fn start() -> (Session, Receiver<Output>, tempfile::TempDir) {
        let root = tempfile::tempdir().unwrap();
        // Only the test shell gets fixture startup files. Production inherits
        // ZDOTDIR unchanged, including when the user deliberately set it.
        std::fs::write(
            root.path().join(".zprofile"),
            "export CQX_PROFILE=profile\n",
        )
        .unwrap();
        std::fs::write(
            root.path().join(".zshrc"),
            "export CQX_RC=rc\nPROMPT='test> '\n",
        )
        .unwrap();
        let mut command = shell(root.path()).unwrap();
        command.env("ZDOTDIR", root.path());
        let (tx, rx) = mpsc::channel();
        let session = Session::open(
            "test".into(),
            root.path(),
            command,
            size(24, 80).unwrap(),
            move |out| tx.send(out).is_ok(),
        )
        .unwrap();
        (session, rx, root)
    }

    fn until(rx: &Receiver<Output>, marker: &str) -> String {
        let deadline = Instant::now() + Duration::from_secs(8);
        let mut output = Vec::new();
        while Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(Output::Data(bytes)) => output.extend(bytes),
                Ok(Output::Error(e)) => panic!("PTY read: {e}"),
                Ok(Output::End) => break,
                Err(_) => continue,
            }
            if String::from_utf8_lossy(&output).contains(marker) {
                return String::from_utf8_lossy(&output).into_owned();
            }
        }
        panic!(
            "missing {marker:?} in {:?}",
            String::from_utf8_lossy(&output)
        );
    }

    #[test]
    fn agent_session_marker_names_are_narrowly_matched() {
        for name in [
            "CLAUDECODE",
            "CLAUDE_PID",
            "CLAUDE_EFFORT",
            "CLAUDE_CODE_CHILD_SESSION",
            "CLAUDE_CODE_FUTURE_THING",
            "CODEX_SESSION_ID",
            "CODEX_THREAD_ID",
        ] {
            assert!(is_agent_session_marker(name), "{name} should be removed");
        }
        for name in [
            "PATH",
            "HOME",
            "ANTHROPIC_API_KEY",
            "CLAUDE_CONFIG_DIR",
            "CODEX_HOME",
            "CODEX_VERSION",
        ] {
            assert!(!is_agent_session_marker(name), "{name} should be kept");
        }
    }

    #[test]
    fn spawned_shell_does_not_inherit_agent_session_markers() {
        let _child_session = EnvRestore::set("CLAUDE_CODE_CHILD_SESSION", "1");
        let _claude_code = EnvRestore::set("CLAUDECODE", "1");
        let (mut session, rx, _root) = start();
        session
            .write(b"env | sort; printf '\\nENV_DONE\\n'\r")
            .unwrap();
        let output = until(&rx, "\r\nENV_DONE\r\n");
        assert!(!output.contains("CLAUDE_CODE_CHILD_SESSION=1"));
        assert!(!output.contains("CLAUDECODE=1"));
        assert!(output.lines().any(|line| line.starts_with("PATH=")));
        session.close().unwrap();
    }

    fn absent(pid: u32) -> bool {
        // SAFETY: signal zero only checks whether the test child exists.
        unsafe {
            libc::kill(pid as i32, 0) == -1
                && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
        }
    }

    #[test]
    fn login_interactive_environment_cwd_and_resize() {
        let (mut session, rx, root) = start();
        session.write(b"[[ -o login && -o interactive && -t 0 && -t 1 && -t 2 ]] && printf '\\nFLAGS%d\\n' $((20+22))\r").unwrap();
        until(&rx, "\r\nFLAGS42\r\n");
        session
            .write(b"printf '\\nSTART:%s:%s:%s\\n' $CQX_PROFILE $CQX_RC \"$HOME\"\r")
            .unwrap();
        until(
            &rx,
            &format!(
                "\r\nSTART:profile:rc:{}\r\n",
                std::env::var("HOME").unwrap()
            ),
        );
        session.write(b"pwd\r").unwrap();
        until(
            &rx,
            &format!("\r\n{}\r\n", root.path().canonicalize().unwrap().display()),
        );
        session.master.resize(size(13, 47).unwrap()).unwrap();
        session.write(b"stty size\r").unwrap();
        until(&rx, "\r\n13 47\r\n");
        session.close().unwrap();
    }

    // Even a deliberately reverted cleanup must not leave the test's shell.
    struct ReapOnFailure(u32);
    impl Drop for ReapOnFailure {
        fn drop(&mut self) {
            if !absent(self.0) {
                // SAFETY: this pid is the still-owned test child, never reaped
                // before absent() succeeds. Kill and reap it if the test fails.
                unsafe {
                    libc::kill(self.0 as i32, libc::SIGKILL);
                    libc::waitpid(self.0 as i32, std::ptr::null_mut(), 0);
                }
            }
        }
    }

    #[test]
    fn close_kills_child_and_joins_blocking_reader() {
        let (mut session, rx, _root) = start();
        session
            .write(b"printf '\\nREADY%d\\n' $((20+22))\r")
            .unwrap();
        until(&rx, "\r\nREADY42\r\n");
        let pid = session.child.process_id().unwrap();
        let _cleanup = ReapOnFailure(pid);
        assert!(!absent(pid));
        let began = Instant::now();
        session.close().unwrap();
        assert!(
            began.elapsed() < Duration::from_secs(3),
            "close stranded the reader"
        );
        assert!(absent(pid), "shell {pid} is still alive after close");
        assert!(session.reader.is_none(), "close did not join the reader");
        session.close().unwrap();
    }

    #[test]
    fn foreground_interrupt_and_close_leave_no_child() {
        let (mut session, rx, root) = start();
        session.write(b"sleep 300\r").unwrap();
        // Ask the kernel who owns the tty instead of guessing from a delay.
        let deadline = Instant::now() + Duration::from_secs(5);
        let shell_pid = session.child.process_id().unwrap();
        while session.master.process_group_leader() == Some(shell_pid as i32)
            && Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(10));
        }
        session
            .write(b"\x03printf '\\nINTERRUPTED%d\\n' $((20+22))\r")
            .unwrap();
        until(&rx, "\r\nINTERRUPTED42\r\n");
        session
            .write(b"sh -c 'echo $$ > foreground.pid; exec sleep 300'\r")
            .unwrap();
        let file = root.path().join("foreground.pid");
        // The shell creates the file before it writes into it, so waiting for
        // the path to exist can hand us an empty string. Wait for a pid.
        let deadline = Instant::now() + Duration::from_secs(5);
        let pid: u32 = loop {
            if let Ok(parsed) = std::fs::read_to_string(&file)
                .unwrap_or_default()
                .trim()
                .parse()
            {
                break parsed;
            }
            assert!(Instant::now() < deadline, "the foreground child never reported its pid");
            thread::sleep(Duration::from_millis(10));
        };
        session.close().unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while !absent(pid) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(absent(pid), "foreground child {pid} survived close");
        assert!(absent(shell_pid), "shell survived close");
    }

    #[test]
    fn close_also_ends_background_jobs() {
        background_job_is_closed(false);
    }

    #[test]
    fn close_ends_background_jobs_even_when_the_shell_is_stopped() {
        let mut unrelated = std::process::Command::new("/bin/sleep")
            .arg("300")
            .spawn()
            .unwrap();
        let _cleanup = ReapOnFailure(unrelated.id());
        background_job_is_closed(true);
        assert!(
            unrelated.try_wait().unwrap().is_none(),
            "close killed a process outside its PTY session"
        );
        unrelated.kill().unwrap();
        unrelated.wait().unwrap();
    }

    fn background_job_is_closed(stop_shell: bool) {
        let (mut session, rx, root) = start();
        session
            .write(b"sleep 300 & echo $! > background.pid; printf '\\nJOB%d\\n' $((20+22))\r")
            .unwrap();
        until(&rx, "\r\nJOB42\r\n");
        let pid: u32 = std::fs::read_to_string(root.path().join("background.pid"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let _cleanup = ReapOnFailure(pid);
        if stop_shell {
            // Model a shell that cannot run its SIGHUP handler. Close must
            // terminate the job without depending on the shell's schedule.
            let shell_pid = session.child.process_id().unwrap() as i32;
            // SAFETY: this is the live shell owned by this test's session.
            assert_eq!(unsafe { libc::kill(shell_pid, libc::SIGSTOP) }, 0);
            let mut status = 0;
            // SAFETY: wait only for our child's stop; do not reap its exit.
            assert_eq!(
                unsafe { libc::waitpid(shell_pid, &mut status, libc::WUNTRACED) },
                shell_pid
            );
            assert!(libc::WIFSTOPPED(status));
        }
        session.close().unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while !absent(pid) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        if !absent(pid) {
            let status = std::process::Command::new("ps")
                .args(["-o", "pid=,ppid=,pgid=,state=,comm=", "-p", &pid.to_string()])
                .output()
                .expect("inspect the test background job");
            panic!(
                "background job {pid} survived close: {}",
                String::from_utf8_lossy(&status.stdout)
            );
        }
    }

    #[test]
    fn window_cleanup_drops_sessions() {
        let (session, rx, _root) = start();
        let pid = session.child.process_id().unwrap();
        let state = TermState::default();
        state.0.lock().unwrap().insert("one".into(), session);
        state.close_all(Some("another-window"));
        assert!(!absent(pid));
        state.close_all(Some("test"));
        assert!(absent(pid), "window cleanup left shell {pid}");
        drop(rx);
    }
}
