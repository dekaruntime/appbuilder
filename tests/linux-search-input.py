"""Native WebKit font/control check: python3 tests/linux-search-input.py <PID>."""
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
search = next(node for node in descendants(app) if node.get_role() == Atspi.Role.FRAME and node.get_name() == "zega Search")
entry = next(node for node in descendants(search) if node.get_role() == Atspi.Role.ENTRY)
size = entry.get_text_iface().get_default_attributes().get("size")
assert size == "15pt", f"Expected 20 CSS px / 15pt, received {size}"
assert not any(node.get_name() == "Open selected result" for node in descendants(search)), "Submit arrow remains in the native popup"
assert entry.get_state_set().contains(Atspi.StateType.FOCUSED), "Search input is not focused"
print("PASS: native search input is 20 CSS px / 15pt, focused, with no submit arrow")
