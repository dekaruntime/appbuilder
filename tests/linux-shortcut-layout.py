"""Native AT-SPI check: python3 tests/linux-shortcut-layout.py <zega PID>."""
import sys
import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi


def descendants(node):
    yield node
    for index in range(node.get_child_count()):
        child = node.get_child_at_index(index)
        if child:
            yield from descendants(child)


pid = int(sys.argv[1])
desktop = Atspi.get_desktop(0)
app = next(
    desktop.get_child_at_index(index)
    for index in range(desktop.get_child_count())
    if desktop.get_child_at_index(index).get_process_id() == pid
)
showing = lambda node: node.get_state_set().contains(Atspi.StateType.SHOWING)
frames = [node for node in descendants(app) if node.get_role() == Atspi.Role.FRAME and showing(node)]
assert not any(frame.get_name() == "zega" for frame in frames), "Main window must stay hidden"
setup = next(frame for frame in frames if frame.get_name() == "zega · Search shortcut")
document = next(node for node in descendants(setup) if node.get_role() == Atspi.Role.DOCUMENT_WEB)
area = document.get_component_iface().get_extents(Atspi.CoordType.SCREEN)
assert 480 <= area.width <= 520 and 400 <= area.height <= 440, (area.width, area.height)
buttons = [node for node in descendants(document) if node.get_role() in (Atspi.Role.PUSH_BUTTON, Atspi.Role.TOGGLE_BUTTON) and showing(node)]
names = [button.get_name() for button in buttons]
assert "Help" in names and "Open search" in names and "Change" in names, names
for button in buttons:
    rect = button.get_component_iface().get_extents(Atspi.CoordType.SCREEN)
    assert rect.width > 0 and rect.height > 0, button.get_name()
    assert area.x <= rect.x and area.y <= rect.y, button.get_name()
    assert rect.x + rect.width <= area.x + area.width and rect.y + rect.height <= area.y + area.height, f"Clipped control: {button.get_name()}"
print(f"PASS: native setup {area.width}×{area.height}; all {len(buttons)} buttons inside the webview; main hidden")
