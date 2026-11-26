import shutil
import tempfile
import unittest
from pathlib import Path

import fitz
from upload_ocr import recognize


@unittest.skipUnless(shutil.which("ocrmypdf"), "requires OCRmyPDF and Kannada/English data")
class ScanOCRTests(unittest.TestCase):
    def test_mixed_pdf(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "mixed.pdf"
            out = Path(folder) / "ocr.pdf"
            with fitz.open() as source:
                page = source.new_page()
                page.insert_text((50, 90), "Printed magazine article", fontsize=24)
                image = page.get_pixmap(matrix=fitz.Matrix(2, 2)).tobytes("png")
                page = source.new_page()
                page.insert_image(page.rect, stream=image)
                source.save(path)
            self.assertEqual(recognize(path, out), "converted")
            with fitz.open(out) as pdf:
                for page in pdf:
                    self.assertIn("magazine", page.get_text().lower())
            self.assertEqual(recognize(out, Path(folder) / "unused.pdf"), "ready")
