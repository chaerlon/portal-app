"""Evidence validation and real child-process tests for the Mac smoke harness."""
import importlib.util
import os
from pathlib import Path
import plistlib
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "smoke-macos.py"
if SCRIPT.exists():
    SPEC = importlib.util.spec_from_file_location("smoke_macos", SCRIPT)
    smoke = importlib.util.module_from_spec(SPEC)
    SPEC.loader.exec_module(smoke)
else:
    smoke = None

PORTAL = "[portal] url=https://portal.caelonhq.com/auth/sign-in?error=account_not_linked trusted_hosts=[]\n"
LIFECYCLE = PORTAL + """[tray] self-test probe enabled (quit=true)
[tray-selftest] initial visible=true minimized=false
[tray-selftest] after hide visible=false minimized=false
[tray-selftest] after reveal visible=true minimized=false
[tray-selftest] result=ok (start=true hidden=true shown=true)
[tray-selftest] exercising quit
"""
NOTIFY = PORTAL + "[notify] self-test probe enabled\n"


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(smoke, "Mac smoke harness has not been implemented")

    def test_lifecycle_requires_real_transitions_and_clean_quit(self):
        self.assertEqual(smoke.validate_lifecycle(LIFECYCLE, "", 0, False)["status"], "passed")

    def test_reported_success_cannot_mask_wrong_visibility(self):
        bad = LIFECYCLE.replace("after hide visible=false", "after hide visible=true")
        self.assertEqual(smoke.validate_lifecycle(bad, "", 0, False)["status"], "failed")

    def test_reveal_must_restore_unminimized_window(self):
        bad = LIFECYCLE.replace("after reveal visible=true minimized=false", "after reveal visible=true minimized=true")
        self.assertEqual(smoke.validate_lifecycle(bad, "", 0, False)["status"], "failed")

    def test_missing_quit_evidence_is_failure(self):
        self.assertEqual(smoke.validate_lifecycle(LIFECYCLE.replace("[tray-selftest] exercising quit\n", ""), "", 0, False)["status"], "failed")

    def test_nonzero_exit_overrides_good_logs(self):
        for code in (1, -11):
            with self.subTest(code=code):
                self.assertEqual(smoke.validate_lifecycle(LIFECYCLE, "", code, False)["status"], "failed")

    def test_timeout_overrides_good_logs(self):
        self.assertEqual(smoke.validate_lifecycle(LIFECYCLE, "", 0, True)["status"], "failed")

    def test_reordered_lifecycle_is_failure(self):
        bad = LIFECYCLE.replace("initial visible=true minimized=false", "after reveal visible=true minimized=false").replace("after reveal visible=true minimized=false\n[tray-selftest] result", "initial visible=true minimized=false\n[tray-selftest] result")
        self.assertEqual(smoke.validate_lifecycle(bad, "", 0, False)["status"], "failed")

    def test_panic_cannot_pass_with_zero_exit(self):
        self.assertEqual(smoke.validate_lifecycle(LIFECYCLE, "thread 'main' panicked at initialization", 0, False)["status"], "failed")

    def test_notification_ok_only_proves_native_api_acceptance(self):
        log = NOTIFY + "[nav] allow https://portal.caelonhq.com/?caelon_selftest=ok\n"
        result = smoke.validate_notification(log, "", None, False)
        self.assertEqual(result["status"], "passed")
        self.assertTrue(result["native_ipc_accepted"])
        self.assertFalse(result["banner_delivery_verified"])

    def test_denied_permission_blocks_required_notification_path(self):
        log = NOTIFY + "[nav] allow https://portal.caelonhq.com/?caelon_selftest=denied&detail=denied\n"
        self.assertEqual(smoke.validate_notification(log, "", None, False)["status"], "blocked")

    def test_ipc_errors_are_application_failures(self):
        for status in ("no-ipc", "error", "unexpected"):
            with self.subTest(status=status):
                log = NOTIFY + "[nav] allow https://portal.caelonhq.com/?caelon_selftest=" + status + "&detail=bad%20IPC\n"
                result = smoke.validate_notification(log, "", None, False)
                self.assertEqual(result["status"], "failed")
                self.assertEqual(result["detail"], "bad IPC")

    def test_external_or_wrong_origin_sentinel_cannot_pass(self):
        for line in ("[nav] external https://portal.caelonhq.com/?caelon_selftest=ok", "[nav] allow https://auth.caelonhq.com/?caelon_selftest=ok", "[nav] allow http://portal.caelonhq.com/?caelon_selftest=ok"):
            with self.subTest(line=line):
                self.assertEqual(smoke.validate_notification(NOTIFY + line + "\n", "", None, False)["status"], "failed")

    def test_missing_or_conflicting_sentinels_never_pass(self):
        self.assertEqual(smoke.validate_notification(NOTIFY, "", None, True)["status"], "blocked")
        log = NOTIFY + "[nav] allow https://portal.caelonhq.com/?caelon_selftest=ok\n[nav] allow https://portal.caelonhq.com/?caelon_selftest=error\n"
        self.assertEqual(smoke.validate_notification(log, "", None, False)["status"], "failed")

    def test_notification_premature_exit_cannot_pass(self):
        log = NOTIFY + "[nav] allow https://portal.caelonhq.com/?caelon_selftest=ok\n"
        for code in (0, 1, -11):
            with self.subTest(code=code):
                self.assertEqual(smoke.validate_notification(log, "", code, False)["status"], "failed")

    def test_bundle_executable_comes_from_plist(self):
        with tempfile.TemporaryDirectory() as folder:
            app = Path(folder) / "Portal.app"
            (app / "Contents/MacOS").mkdir(parents=True)
            (app / "Contents/MacOS/actual-binary").write_text("binary")
            with (app / "Contents/Info.plist").open("wb") as handle:
                plistlib.dump({"CFBundleExecutable": "actual-binary"}, handle)
            self.assertEqual(smoke.bundle_executable(app), app / "Contents/MacOS/actual-binary")

    def test_plist_cannot_escape_bundle(self):
        with tempfile.TemporaryDirectory() as folder:
            app = Path(folder) / "Portal.app"
            (app / "Contents").mkdir(parents=True)
            with (app / "Contents/Info.plist").open("wb") as handle:
                plistlib.dump({"CFBundleExecutable": "../../../elsewhere"}, handle)
            with self.assertRaises(ValueError):
                smoke.bundle_executable(app)

    def test_process_timeout_is_bounded_and_reaped(self):
        with tempfile.TemporaryDirectory() as folder:
            result = smoke.run_process([sys.executable, "-c", "import time; print('launched', flush=True); time.sleep(30)"], {}, 0.15, Path(folder) / "out.log", Path(folder) / "err.log")
            self.assertTrue(result["timed_out"])
            self.assertIsNotNone(result["returncode"])
            self.assertLess(result["elapsed_seconds"], 7)
            self.assertIn("launched", (Path(folder) / "out.log").read_text())

    def test_notification_sentinel_stops_child_with_explicit_cleanup(self):
        with tempfile.TemporaryDirectory() as folder:
            result = smoke.run_process([sys.executable, "-c", "import time; print('sentinel', flush=True); time.sleep(30)"], {}, 5, Path(folder) / "out.log", Path(folder) / "err.log", stop_when=lambda log: "sentinel" in log)
            self.assertFalse(result["timed_out"])
            self.assertIsNone(result["returncode_before_cleanup"])
            self.assertIn(result["cleanup"], ("term", "kill"))
            self.assertLess(result["elapsed_seconds"], 7)

    def test_inherited_probe_flags_do_not_contaminate_independent_runs(self):
        previous = os.environ.get("CAELON_TRAY_SELFTEST")
        try:
            os.environ["CAELON_TRAY_SELFTEST"] = "quit"
            with tempfile.TemporaryDirectory() as folder:
                stdout_path = Path(folder) / "out.log"
                smoke.run_process([sys.executable, "-c", "import os; print(os.environ.get('CAELON_TRAY_SELFTEST', 'absent')); print(os.environ.get('CAELON_NOTIFY_SELFTEST', 'absent'))"], {"CAELON_NOTIFY_SELFTEST": "1"}, 5, stdout_path, Path(folder) / "err.log")
                self.assertEqual(stdout_path.read_text().splitlines(), ["absent", "1"])
        finally:
            if previous is None:
                os.environ.pop("CAELON_TRAY_SELFTEST", None)
            else:
                os.environ["CAELON_TRAY_SELFTEST"] = previous


if __name__ == "__main__":
    unittest.main()
