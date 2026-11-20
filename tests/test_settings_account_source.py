"""Ensure account actions are organized in Settings rather than a floating overlay."""
from pathlib import Path
import unittest
ROOT=Path(__file__).resolve().parents[1]
HTML=(ROOT/'static/index.html').read_text()
JS=(ROOT/'static/app.js').read_text()
class SettingsAccountTests(unittest.TestCase):
    def test_account_actions_are_in_settings_dialog(self):
        start=HTML.index('<dialog id="settings"')
        end=HTML.index('</dialog>',start)
        settings=HTML[start:end]
        for control in ('account-identity','account-role','account-manage-users','account-change-password','account-logout'):
            self.assertIn('id="'+control+'"',settings)
    def test_no_floating_account_controls(self):
        self.assertNotIn("position:fixed;bottom:12px;right:12px",JS)
        self.assertIn("signedInUser.role!=='admin'",JS)
    def test_password_dialog_has_confirmation(self):
        self.assertIn("New passwords do not match.",JS)
        self.assertIn("current_password:current.value,new_password:next.value",JS)
if __name__=='__main__':
    unittest.main()
