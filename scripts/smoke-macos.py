#!/usr/bin/env python3
"""Launch the packaged ARM64 app and retain bounded native diagnostic evidence.

Notification success means the existing plugin IPC accepted/enqueued a request.
The desktop plugin does not report actual OS delivery or system permission state.
No credentials, Portal mutations, WebDriver, or additional IPC grants are used.
"""
import argparse
import datetime
import json
import math
import os
from pathlib import Path
import platform
import plistlib
import re
import signal
import subprocess
import time
from urllib.parse import parse_qs, urlsplit


def result(status, reason, **evidence):
    return {"status": status, "reason": reason, **evidence}


def crashed(stdout, stderr):
    return bool(re.search(r"panicked at|fatal error:|segmentation fault|abort trap", stdout + "\n" + stderr, re.IGNORECASE))


def validate_lifecycle(stdout, stderr, returncode, timed_out):
    if timed_out:
        return result("failed", "Lifecycle timed out; clean Quit was not verified.")
    if returncode != 0 or crashed(stdout, stderr):
        return result("failed", "App exited abnormally or reported a crash.", returncode=returncode)
    if "[portal] url=" not in stdout or "[tray] self-test probe enabled (quit=true)" not in stdout:
        return result("failed", "Missing packaged app launch/probe evidence.")
    events = re.findall(r"\[tray-selftest\] (initial|after hide|after reveal) visible=(true|false) minimized=(true|false)", stdout)
    if len(events) != 3 or [event[:2] for event in events] != [("initial", "true"), ("after hide", "false"), ("after reveal", "true")] or events[-1][2] != "false":
        return result("failed", "Window visibility/reveal transitions were missing, invalid, or out of order.", transitions=events)
    verdicts = re.findall(r"\[tray-selftest\] result=(\w+) \(start=(\w+) hidden=(\w+) shown=(\w+)\)", stdout)
    if verdicts != [("ok", "true", "true", "true")]:
        return result("failed", "Lifecycle probe did not report a consistent success.")
    reveal_position = stdout.find("[tray-selftest] after reveal")
    verdict_position = stdout.find("[tray-selftest] result=ok")
    quit_position = stdout.find("[tray-selftest] exercising quit")
    if not reveal_position < verdict_position < quit_position:
        return result("failed", "Missing or out-of-order Quit evidence.")
    return result("passed", "Packaged app launched, hid, revealed, and exited cleanly through the Quit helper.", transitions=events, returncode=returncode, menu_clicks_verified=False, close_event_verified=False)


def notification_markers(stdout):
    markers = []
    for action, raw_url in re.findall(r"^\[nav\] (allow|external|block) (\S+)\s*$", stdout, re.MULTILINE):
        parsed = urlsplit(raw_url)
        query = parse_qs(parsed.query, keep_blank_values=True)
        if "caelon_selftest" in query:
            markers.append({"action": action, "url": raw_url, "origin": (parsed.scheme, parsed.netloc), "path": parsed.path, "statuses": query["caelon_selftest"], "detail": query.get("detail", [""])[0]})
    return markers


def validate_notification(stdout, stderr, returncode_before_cleanup, timed_out):
    base = {"native_ipc_accepted": False, "banner_delivery_verified": False, "os_delivery_verified": False, "system_permission_verified": False}
    if returncode_before_cleanup is not None or crashed(stdout, stderr):
        return result("failed", "Notification app exited before harness cleanup or reported a crash.", returncode=returncode_before_cleanup, **base)
    markers = notification_markers(stdout)
    if not markers:
        return result("blocked", "No notification sentinel was observed; page/network, permission UI, or desktop availability remains unresolved.", timed_out=timed_out, **base)
    portal_urls = re.findall(r"^\[portal\] url=(\S+) trusted_hosts=", stdout, re.MULTILINE)
    if len(portal_urls) != 1 or "[notify] self-test probe enabled" not in stdout:
        return result("failed", "Missing launch/probe evidence for notification sentinel.", **base)
    portal = urlsplit(portal_urls[0])
    if len(markers) != 1:
        return result("failed", "Multiple notification sentinels make the outcome ambiguous.", markers=markers, **base)
    marker = markers[0]
    detail = marker["detail"]
    if marker["action"] != "allow" or marker["origin"] != (portal.scheme, portal.netloc) or marker["path"] != "/" or len(marker["statuses"]) != 1:
        return result("failed", "Notification sentinel was not an allowed same-origin probe result.", detail=detail, **base)
    status = marker["statuses"][0]
    if status == "ok" and not timed_out:
        base["native_ipc_accepted"] = True
        return result("passed", "Notification plugin IPC accepted/enqueued the request; OS delivery and system permission are unverified.", probe_status=status, detail=detail, **base)
    if status == "denied":
        return result("blocked", "Notification probe reported denied permission; required IPC notification path is unverified.", probe_status=status, detail=detail, **base)
    return result("failed", "Notification probe failed or returned an invalid result.", probe_status=status, detail=detail, **base)


def bundle_executable(app):
    app = Path(app)
    with (app / "Contents/Info.plist").open("rb") as handle:
        name = plistlib.load(handle).get("CFBundleExecutable")
    if not isinstance(name, str) or not name or name in (".", "..") or Path(name).name != name or "/" in name or "\\" in name:
        raise ValueError("CFBundleExecutable must name a binary directly in Contents/MacOS")
    binary = app / "Contents/MacOS" / name
    if not binary.is_file() or not binary.resolve().is_relative_to(app.resolve()):
        raise ValueError("CFBundleExecutable is missing or escapes the app bundle")
    return binary


def capture_screen(path):
    try:
        completed = subprocess.run(["/usr/sbin/screencapture", "-x", str(path)], capture_output=True, text=True, timeout=10)
        if completed.returncode == 0 and path.is_file() and path.stat().st_size:
            return result("captured", "Screen image retained as supporting evidence; image contents were not automatically verified.", path=str(path), delivery_verified=False)
        return result("failed", "Screen capture failed; this does not establish notification delivery or app failure.", returncode=completed.returncode, stderr=completed.stderr, delivery_verified=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        return result("failed", str(error), delivery_verified=False)


def cleanup_process(process):
    if process.poll() is not None:
        return "already-exited"
    try:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGTERM)
        else:
            process.terminate()
        process.wait(timeout=3)
        return "term"
    except subprocess.TimeoutExpired:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGKILL)
        else:
            process.kill()
        process.wait(timeout=3)
        return "kill"
    except ProcessLookupError:
        process.wait(timeout=3)
        return "already-exited"


def run_process(command, env, timeout, stdout_path, stderr_path, stop_when=None, screenshot_path=None):
    started = time.monotonic()
    timed_out = False
    screenshot = result("not-attempted", "No screen capture requested.", delivery_verified=False)
    cleanup = "not-needed"
    before_cleanup = None
    child_env = {key: value for key, value in os.environ.items() if key not in ("CAELON_TRAY_SELFTEST", "CAELON_NOTIFY_SELFTEST")}
    child_env.update(env)
    with stdout_path.open("wb") as stdout_handle, stderr_path.open("wb") as stderr_handle:
        process = subprocess.Popen(command, env=child_env, stdout=stdout_handle, stderr=stderr_handle, start_new_session=(os.name == "posix"))
        try:
            while True:
                code = process.poll()
                if code is not None:
                    before_cleanup = code
                    break
                log = stdout_path.read_text(errors="replace")
                if stop_when is not None and stop_when(log):
                    # The plugin schedules OS work asynchronously. Keep the app alive
                    # briefly before capturing; images still prove no delivery.
                    if screenshot_path is not None:
                        until = time.monotonic() + 1
                        while time.monotonic() < until and process.poll() is None:
                            time.sleep(0.1)
                        screenshot = capture_screen(screenshot_path)
                        until = time.monotonic() + 3
                        while time.monotonic() < until and process.poll() is None:
                            time.sleep(0.1)
                        screenshot["later_capture"] = capture_screen(screenshot_path.with_name(screenshot_path.stem + ".later.png"))
                    before_cleanup = process.poll()
                    break
                if screenshot_path is not None and stop_when is None and screenshot["status"] == "not-attempted" and time.monotonic() - started >= 1:
                    screenshot = capture_screen(screenshot_path)
                if time.monotonic() - started >= timeout:
                    timed_out = True
                    before_cleanup = process.poll()
                    if screenshot_path is not None and screenshot["status"] == "not-attempted":
                        screenshot = capture_screen(screenshot_path)
                    break
                time.sleep(0.05)
        finally:
            cleanup = cleanup_process(process)
            if before_cleanup is None and cleanup == "already-exited":
                before_cleanup = process.returncode
    if screenshot_path is not None and screenshot["status"] == "not-attempted":
        screenshot = capture_screen(screenshot_path)
    return {"returncode": process.returncode, "returncode_before_cleanup": before_cleanup, "timed_out": timed_out, "cleanup": cleanup, "elapsed_seconds": round(time.monotonic() - started, 3), "stdout_log": str(stdout_path), "stderr_log": str(stderr_path), "screenshot": screenshot}


def bounded_command(command):
    completed = subprocess.run(command, capture_output=True, text=True, timeout=10, check=True)
    return completed.stdout.strip()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", required=True, type=Path, help="Built .app bundle")
    parser.add_argument("--output-dir", required=True, type=Path, help="Directory for results.json, logs, and screen captures")
    parser.add_argument("--timeout", type=float, default=60, help="Per-probe polling timeout in seconds (default: 60)")
    args = parser.parse_args(argv)
    if not math.isfinite(args.timeout) or args.timeout <= 0:
        parser.error("--timeout must be a positive finite number")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report = {"schema_version": 1, "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "app": str(args.app.resolve()), "host": {"system": platform.system(), "machine": platform.machine()}, "provenance": {key: os.environ[key] for key in ("GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT") if key in os.environ}, "limitations": ["Lifecycle probe invokes the existing helpers; actual menu clicks, close events, and Dock reopen events are unverified.", "Notification IPC success means accepted/enqueued only; actual OS delivery, banner appearance, hidden-window delivery, and system permission state are unverified.", "Screen captures are supporting evidence and are not automatically inspected."], "checks": {}}
    exit_code = 1
    try:
        if platform.system() != "Darwin" or platform.machine() != "arm64":
            report["checks"]["preflight"] = result("blocked", "Run natively on Darwin arm64; native Mac checks cannot run on this host.")
        else:
            binary = bundle_executable(args.app)
            architectures = bounded_command(["/usr/bin/lipo", "-archs", str(binary)])
            if architectures != "arm64":
                report["checks"]["preflight"] = result("failed", "Expected a native ARM64 packaged executable.", architectures=architectures)
            else:
                console_user = bounded_command(["/usr/bin/stat", "-f", "%Su", "/dev/console"])
                if console_user in ("root", "loginwindow", ""):
                    report["checks"]["preflight"] = result("blocked", "No logged-in macOS desktop session was detected.", console_user=console_user)
                else:
                    report["checks"]["preflight"] = result("passed", "Native ARM64 packaged executable and desktop session verified.", executable=str(binary), architectures=architectures, console_user=console_user)
                    for kind, extra_env in (("lifecycle", {"CAELON_TRAY_SELFTEST": "quit"}), ("notification", {"CAELON_NOTIFY_SELFTEST": "1"})):
                        prefix = args.output_dir / kind
                        stdout_path = prefix.with_suffix(".stdout.log")
                        stderr_path = prefix.with_suffix(".stderr.log")
                        observation = run_process([str(binary)], extra_env, args.timeout, stdout_path, stderr_path, stop_when=(lambda log: bool(notification_markers(log))) if kind == "notification" else None, screenshot_path=prefix.with_suffix(".png"))
                        stdout = stdout_path.read_text(errors="replace")
                        stderr = stderr_path.read_text(errors="replace")
                        if kind == "lifecycle":
                            check = validate_lifecycle(stdout, stderr, observation["returncode"], observation["timed_out"])
                        else:
                            check = validate_notification(stdout, stderr, observation["returncode_before_cleanup"], observation["timed_out"])
                        report["checks"][kind] = {**check, "process": observation}
                        print(f"{kind}: {check['status']}: {check['reason']}", flush=True)
    except (OSError, ValueError, plistlib.InvalidFileException, subprocess.SubprocessError) as error:
        report["checks"]["harness"] = result("failed", str(error))
    finally:
        checks = report["checks"]
        if set(checks) == {"preflight", "lifecycle", "notification"} and all(check["status"] == "passed" for check in checks.values()):
            report["status"] = "passed"
            exit_code = 0
        else:
            report["status"] = "failed" if any(check["status"] == "failed" for check in checks.values()) else "blocked"
            exit_code = 1 if report["status"] == "failed" else 2
        report["finished_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        destination = args.output_dir / "results.json"
        destination.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(f"Mac smoke: {report['status']}; evidence: {destination}", flush=True)
        if report["status"] == "passed":
            print("Required diagnostic paths passed. OS notification delivery/banner and system permission remain unverified.", flush=True)
        else:
            for name, check in checks.items():
                if check["status"] != "passed":
                    print(f"{name}: {check['status']}: {check['reason']}", flush=True)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
