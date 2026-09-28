pub fn python() -> std::ffi::OsString {
    std::env::var_os("PYTHON")
        .unwrap_or_else(|| if cfg!(windows) { "python" } else { "python3" }.into())
}
