"""Live GNOME Wayland protocol check; pass a cargo command (or wrapper) as arguments.

Checks the compositor placement request and absence of GTK input modality.
Physical centering still requires a desktop observation: Wayland hides coordinates.
"""
import os
import re
import subprocess
import sys

command = sys.argv[1:] or ["cargo"]
result = subprocess.run(
    command + [
        "test", "--manifest-path", "src-tauri/Cargo.toml", "--locked", "--lib",
        "window_placement::linux::native_dialog_hint_does_not_grab_application_input",
        "--", "--ignored", "--nocapture",
    ],
    env={**os.environ, "WAYLAND_DEBUG": "client"},
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=180,
)
assert result.returncode == 0, f"Native placement probe exited {result.returncode}"
assert re.search(r"gtk_surface1@\d+\.set_modal\(\)", result.stdout), "GNOME received no dialog placement hint"
print("PASS: GNOME receives a dialog placement hint; GTK does not grab application input")
