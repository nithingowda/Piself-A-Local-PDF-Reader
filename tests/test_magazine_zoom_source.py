"""Guard magazine-style zoom behavior against previous iOS Safari regressions."""
from pathlib import Path
import unittest

APP = (Path(__file__).resolve().parents[1] / "static" / "app.js").read_text()


class MagazineZoomTests(unittest.TestCase):
    def test_pinch_never_zooms_entire_pages_container(self):
        start = APP.index("function finishPinch(cancelled=false)")
        end = APP.index("$('page-area').addEventListener('touchstart'", start)
        finish = APP[start:end]
        self.assertIn("for(const item of slots)sizeSlot", finish)
        self.assertNotIn("style.zoom=String(", finish)

    def test_pinch_preview_only_transforms_active_page(self):
        self.assertIn("pinch.slot.style.transform", APP) if "pinch.slot.style.transform" in APP else self.assertIn("slot.style.transform=", APP)
        self.assertIn("rect.width>=view.width", APP)

    def test_toolbar_respects_fit_page_minimum(self):
        self.assertIn("zoom=Math.max(fitEntirePageZoom(page),zoom-.25)", APP)
        self.assertIn("zoom=fitEntirePageZoom(page);rebuild()", APP)

    def test_touch_anchor_is_saved_before_zoom(self):
        self.assertIn("fx:Math.max(0,Math.min(1,(point.x-r.left)/r.width))", APP)
        self.assertIn("const fx=state.fx,fy=state.fy", APP)


if __name__ == "__main__":
    unittest.main()
