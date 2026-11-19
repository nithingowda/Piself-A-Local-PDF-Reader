"""Source-level regression checks for mobile Safari pinch handling.

These checks do not replace real-device gesture tests.
"""
from pathlib import Path
import unittest

APP = (Path(__file__).resolve().parents[1] / "static" / "app.js").read_text()


class MobilePinchRegressionTests(unittest.TestCase):
    def test_pinch_preserves_existing_canvas(self):
        finish = APP.split("function finishPinch(cancelled=false)", 1)[1].split(
            "$('page-area').addEventListener('touchstart'", 1
        )[0]
        self.assertNotIn("await rebuild()", finish)
        self.assertIn("style.zoom", finish)

    def test_pinch_does_not_let_scroll_override_page(self):
        self.assertIn("performance.now()<pinchScrollLockUntil", APP)
        self.assertIn("page=state.page", APP)

    def test_touch_hit_test_uses_both_coordinates(self):
        touch_start = APP.split(
            "$('page-area').addEventListener('touchstart'", 1
        )[1].split("$('page-area').addEventListener('touchmove'", 1)[0]
        self.assertIn("point.x>=r.left", touch_start)
        self.assertIn("point.y>=r.top", touch_start)


if __name__ == "__main__":
    unittest.main()
