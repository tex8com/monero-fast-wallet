#!/usr/bin/env python3
"""Small ADB/UI-Automator driver for repeatable Android wallet acceptance.

The driver never reads application-private storage. It operates only on the
public Android accessibility tree, screenshots, window/process diagnostics and
privacy-filtered logcat output emitted by a deliberate diagnostics build.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET


PACKAGE = os.environ.get("MONERO_WALLET_ANDROID_PACKAGE", "com.tex8.monerowallet")
ACTIVITY = os.environ.get(
    "MONERO_WALLET_ANDROID_ACTIVITY",
    "com.monerowallet.MainActivity",
)
BOUNDS = re.compile(r"^\[(\d+),(\d+)]\[(\d+),(\d+)]$")


class DriverError(RuntimeError):
    pass


@contextmanager
def exclusive_ui_automator(serial: str):
    """Serialize hierarchy dumps for one device across driver processes.

    `adb` only terminates its local client on timeout. Without this lock, a
    timed-out remote UI-Automator process can overlap the next invocation and
    make later diagnostics unreliable.
    """

    safe_serial = re.sub(r"[^0-9A-Za-z_.-]+", "-", serial)
    lock_path = Path(tempfile.gettempdir()) / (
        f"monero-fast-wallet-ui-automator-{safe_serial}.lock"
    )
    with lock_path.open("a+", encoding="utf-8") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def terminate_stale_ui_automator(serial: str) -> None:
    """Best-effort cleanup after a dump timeout without masking its error."""

    command = ["adb", "-s", serial, "shell", "sh", "-c"]
    command.append(
        "pkill -f '[c]om.android.commands.uiautomator' "
        ">/dev/null 2>&1 || true"
    )
    try:
        subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=3.0,
        )
    except subprocess.TimeoutExpired:
        pass


def adb(
    serial: str | None,
    *args: str,
    binary: bool = False,
    timeout_seconds: float = 15.0,
):
    command = ["adb"]
    if serial:
        command.extend(["-s", serial])
    command.extend(args)
    try:
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=not binary,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired as error:
        raise DriverError(
            f"ADB timed out after {timeout_seconds:.1f}s: "
            f"{' '.join(command)}"
        ) from error
    if result.returncode != 0:
        stderr = (
            result.stderr.decode("utf-8", "replace")
            if binary
            else result.stderr
        )
        raise DriverError(
            f"ADB failed ({result.returncode}): {' '.join(command)}: "
            f"{stderr.strip()}"
        )
    return result.stdout


def connected_serial(requested: str | None) -> str:
    if requested:
        state = adb(requested, "get-state").strip()
        if state != "device":
            raise DriverError(f"Device {requested} is not ready: {state}")
        return requested

    lines = str(adb(None, "devices")).splitlines()[1:]
    devices = [
        line.split()[0]
        for line in lines
        if len(line.split()) >= 2 and line.split()[1] == "device"
    ]
    if len(devices) != 1:
        raise DriverError(
            "Specify --serial when zero or multiple ADB devices are attached"
        )
    return devices[0]


def dump_ui(serial: str) -> str:
    # `/data/local/tmp` avoids depending on emulated-storage/FUSE health while
    # the simulator is under load.
    remote = f"/data/local/tmp/mfw-ui-driver-{os.getpid()}.xml"
    with exclusive_ui_automator(serial):
        terminate_stale_ui_automator(serial)
        last_error = "UI-Automator returned no accessibility hierarchy"
        for attempt in range(3):
            adb(serial, "shell", "rm", "-f", remote)
            try:
                dump_output = str(
                    adb(
                        serial,
                        "shell",
                        "uiautomator",
                        "dump",
                        "--compressed",
                        remote,
                        timeout_seconds=5.0,
                    )
                ).strip()
                xml = str(adb(serial, "shell", "cat", remote))
                if "<hierarchy" in xml and "</hierarchy>" in xml:
                    return xml
                last_error = dump_output or last_error
            except DriverError as error:
                last_error = str(error)
                terminate_stale_ui_automator(serial)
            finally:
                # Accessibility dumps may contain sensitive on-screen data.
                # Never leave the hierarchy on the device and never accept a
                # stale dump from a previous command.
                try:
                    adb(serial, "shell", "rm", "-f", remote)
                except DriverError:
                    pass
            if attempt < 2:
                time.sleep(0.2)
        raise DriverError(last_error)


def matching_node(
    xml: str,
    query: str,
    contains: bool,
    occurrence: int,
    require_clickable: bool = True,
) -> tuple[ET.Element, ET.Element]:
    root = ET.fromstring(xml)
    parents = {child: parent for parent in root.iter() for child in parent}

    def matches(value: str) -> bool:
        if contains:
            return query.casefold() in value.casefold()
        return query.casefold() == value.casefold()

    candidates: list[ET.Element] = []
    for node in root.iter("node"):
        values = (
            node.attrib.get("text", ""),
            node.attrib.get("content-desc", ""),
            node.attrib.get("hint", ""),
        )
        if any(value and matches(value) for value in values):
            candidates.append(node)
    if occurrence < 0 or occurrence >= len(candidates):
        raise DriverError(
            f"UI element {query!r} occurrence {occurrence} not found "
            f"({len(candidates)} matches)"
        )

    matched = candidates[occurrence]
    if not require_clickable:
        return matched, matched
    clickable = matched
    while (
        clickable.attrib.get("clickable") != "true"
        and clickable in parents
    ):
        clickable = parents[clickable]
    if clickable.attrib.get("clickable") != "true":
        raise DriverError(f"UI element {query!r} has no clickable ancestor")
    return matched, clickable


def center(node: ET.Element) -> tuple[int, int]:
    match = BOUNDS.match(node.attrib.get("bounds", ""))
    if not match:
        raise DriverError("Selected UI node has invalid bounds")
    left, top, right, bottom = (int(value) for value in match.groups())
    if right <= left or bottom <= top:
        raise DriverError("Selected UI node has empty bounds")
    return ((left + right) // 2, (top + bottom) // 2)


def command_status(serial: str, _: argparse.Namespace) -> None:
    focus = str(adb(serial, "shell", "dumpsys", "window"))
    focus_lines = [
        line.strip()
        for line in focus.splitlines()
        if "mCurrentFocus" in line or "mFocusedApp" in line
    ]
    package = str(adb(serial, "shell", "dumpsys", "package", PACKAGE))
    version_lines = [
        line.strip()
        for line in package.splitlines()
        if "versionName=" in line or "versionCode=" in line
    ][:2]
    print(
        json.dumps(
            {
                "serial": serial,
                "focus": focus_lines,
                "package": PACKAGE,
                "version": version_lines,
            },
            indent=2,
        )
    )


def command_launch(serial: str, _: argparse.Namespace) -> None:
    output = adb(
        serial,
        "shell",
        "am",
        "start",
        "-W",
        "-n",
        f"{PACKAGE}/{ACTIVITY}",
    )
    print(str(output).strip())


def command_tap(serial: str, args: argparse.Namespace) -> None:
    xml = dump_ui(serial)
    matched, clickable = matching_node(
        xml,
        args.text,
        args.contains,
        args.occurrence,
    )
    x, y = center(clickable)
    adb(serial, "shell", "input", "tap", str(x), str(y))
    print(
        json.dumps(
            {
                "query": args.text,
                "matchedText": matched.attrib.get("text", ""),
                "matchedDescription": matched.attrib.get("content-desc", ""),
                "matchedHint": matched.attrib.get("hint", ""),
                "tap": [x, y],
            }
        )
    )


def command_wait(serial: str, args: argparse.Namespace) -> None:
    deadline = time.monotonic() + args.timeout
    last_error = ""
    while time.monotonic() < deadline:
        try:
            xml = dump_ui(serial)
            matched, _ = matching_node(
                xml,
                args.text,
                args.contains,
                args.occurrence,
                require_clickable=False,
            )
            print(
                json.dumps(
                    {
                        "query": args.text,
                        "text": matched.attrib.get("text", ""),
                        "description": matched.attrib.get("content-desc", ""),
                        "hint": matched.attrib.get("hint", ""),
                    }
                )
            )
            return
        except DriverError as error:
            last_error = str(error)
            time.sleep(args.interval)
    raise DriverError(
        f"Timed out after {args.timeout:.1f}s waiting for "
        f"{args.text!r}: {last_error}"
    )


def safe_name(value: str) -> str:
    normalized = re.sub(r"[^0-9A-Za-z_.-]+", "-", value).strip("-")
    return normalized[:80] or "snapshot"


def write_command_output(
    serial: str,
    target: Path,
    *args: str,
) -> None:
    target.write_text(str(adb(serial, *args)), encoding="utf-8")


def command_snapshot(serial: str, args: argparse.Namespace) -> None:
    directory = Path(args.output).expanduser().resolve()
    directory.mkdir(parents=True, exist_ok=True)
    prefix = safe_name(args.name)

    ui_hierarchy = True
    ui_error = ""
    try:
        xml = dump_ui(serial)
        (directory / f"{prefix}.xml").write_text(xml, encoding="utf-8")
    except DriverError as error:
        # A continuously updating React Native view can keep UI-Automator from
        # reaching its idle state. Screenshot, process, memory and diagnostic
        # evidence must still be captured; record the hierarchy failure
        # explicitly instead of silently reusing stale XML.
        ui_hierarchy = False
        ui_error = str(error)
        (directory / f"{prefix}.ui-error.txt").write_text(
            ui_error + "\n",
            encoding="utf-8",
        )
    screenshot = adb(serial, "exec-out", "screencap", "-p", binary=True)
    (directory / f"{prefix}.png").write_bytes(screenshot)
    write_command_output(
        serial,
        directory / f"{prefix}.window.txt",
        "shell",
        "dumpsys",
        "window",
    )
    write_command_output(
        serial,
        directory / f"{prefix}.activity.txt",
        "shell",
        "dumpsys",
        "activity",
        "activities",
    )
    write_command_output(
        serial,
        directory / f"{prefix}.memory.txt",
        "shell",
        "dumpsys",
        "meminfo",
        PACKAGE,
    )
    logcat = str(adb(serial, "logcat", "-d", "-v", "threadtime", "-t", "5000"))
    relevant = "\n".join(
        line
        for line in logcat.splitlines()
        if (
            "MONERO_WALLET_DIAGNOSTICS" in line
            or PACKAGE in line
            or "NativeMoneroWallet" in line
            or "FATAL EXCEPTION" in line
            or "ANR in " in line
        )
    )
    (directory / f"{prefix}.logcat.txt").write_text(
        relevant + ("\n" if relevant else ""),
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "name": prefix,
                "output": str(directory),
                "screenshotBytes": len(screenshot),
                "logLines": len(relevant.splitlines()),
                "uiHierarchy": ui_hierarchy,
                "uiError": ui_error,
            }
        )
    )


def command_key(serial: str, args: argparse.Namespace) -> None:
    adb(serial, "shell", "input", "keyevent", args.key)


def command_text(serial: str, args: argparse.Namespace) -> None:
    if not args.text or len(args.text) > 256:
        raise DriverError("Text input must contain between 1 and 256 characters")
    adb(serial, "shell", "input", "text", args.text.replace(" ", "%s"))


def command_swipe(serial: str, args: argparse.Namespace) -> None:
    adb(
        serial,
        "shell",
        "input",
        "swipe",
        str(args.x1),
        str(args.y1),
        str(args.x2),
        str(args.y2),
        str(args.duration_ms),
    )


def command_tap_at(serial: str, args: argparse.Namespace) -> None:
    if args.x < 0 or args.y < 0:
        raise DriverError("Tap coordinates must be non-negative")
    adb(serial, "shell", "input", "tap", str(args.x), str(args.y))
    print(json.dumps({"tap": [args.x, args.y]}))


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument("--serial", default=os.environ.get("ANDROID_SERIAL"))
    result.add_argument("--package", default=PACKAGE)
    result.add_argument("--activity", default=ACTIVITY)
    subcommands = result.add_subparsers(dest="command", required=True)

    subcommands.add_parser("status")
    subcommands.add_parser("launch")

    tap = subcommands.add_parser("tap")
    tap.add_argument("--text", required=True)
    tap.add_argument("--contains", action="store_true")
    tap.add_argument("--occurrence", type=int, default=0)

    tap_at = subcommands.add_parser("tap-at")
    tap_at.add_argument("x", type=int)
    tap_at.add_argument("y", type=int)

    wait = subcommands.add_parser("wait")
    wait.add_argument("--text", required=True)
    wait.add_argument("--contains", action="store_true")
    wait.add_argument("--occurrence", type=int, default=0)
    wait.add_argument("--timeout", type=float, default=15.0)
    wait.add_argument("--interval", type=float, default=0.5)

    snapshot = subcommands.add_parser("snapshot")
    snapshot.add_argument("--name", required=True)
    snapshot.add_argument("--output", required=True)

    key = subcommands.add_parser("key")
    key.add_argument("--key", required=True)

    text = subcommands.add_parser("text")
    text.add_argument("--text", required=True)

    swipe = subcommands.add_parser("swipe")
    swipe.add_argument("x1", type=int)
    swipe.add_argument("y1", type=int)
    swipe.add_argument("x2", type=int)
    swipe.add_argument("y2", type=int)
    swipe.add_argument("--duration-ms", type=int, default=350)
    return result


def main() -> int:
    global PACKAGE, ACTIVITY
    args = parser().parse_args()
    PACKAGE = args.package
    ACTIVITY = args.activity
    try:
        serial = connected_serial(args.serial)
        handlers = {
            "status": command_status,
            "launch": command_launch,
            "tap": command_tap,
            "tap-at": command_tap_at,
            "wait": command_wait,
            "snapshot": command_snapshot,
            "key": command_key,
            "text": command_text,
            "swipe": command_swipe,
        }
        handlers[args.command](serial, args)
        return 0
    except (DriverError, ET.ParseError) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
