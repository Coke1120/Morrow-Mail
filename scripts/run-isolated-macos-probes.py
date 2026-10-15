#!/usr/bin/env python3
"""Branch-only fictional AppKit diagnostics; never a release/primary gate waiver."""
import argparse
import base64
import binascii
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import struct
import subprocess
import sys
import time
import zlib

ROOT = Path(__file__).resolve().parents[1]
PNG_LIMIT = 524288


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def source_snapshot():
    names = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT).decode().split("\0")[:-1]
    files = {name: digest((ROOT / name).read_bytes()) for name in names}
    return {"head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
            "tree": subprocess.check_output(["git", "rev-parse", "HEAD^{tree}"], cwd=ROOT, text=True).strip(),
            "trackedFiles": len(files), "digest": digest(canonical(files))}


def validate_png(data):
    if not 0 < len(data) <= PNG_LIMIT or not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("Invalid bounded native PNG")
    offset, dimensions, ended = 8, None, False
    while offset < len(data):
        if offset + 12 > len(data):
            raise ValueError("Truncated PNG chunk")
        length = struct.unpack(">I", data[offset:offset + 4])[0]
        end = offset + length + 12
        if end > len(data):
            raise ValueError("Truncated PNG payload")
        kind = data[offset + 4:offset + 8]
        payload = data[offset + 8:end - 4]
        if binascii.crc32(kind + payload) & 0xffffffff != struct.unpack(">I", data[end - 4:end])[0]:
            raise ValueError("PNG CRC mismatch")
        if dimensions is None:
            if kind != b"IHDR" or length != 13:
                raise ValueError("Missing PNG header")
            dimensions = struct.unpack(">II", payload[:8])
            if not (0 < dimensions[0] <= 3200 and 0 < dimensions[1] <= 2000
                    and dimensions[0] * dimensions[1] <= 6_400_000):
                raise ValueError("PNG dimensions exceed the native fixture bound")
        if kind == b"IEND":
            if length or end != len(data):
                raise ValueError("Invalid PNG end")
            ended = True
        offset = end
    if not ended:
        raise ValueError("Missing PNG end")
    return dimensions


def parse_images(output, kind, mode):
    lines = output.splitlines()
    allowed = {f"{kind}-{mode}-before", f"{kind}-{mode}-after"}
    images, pending = {}, {}
    for line in lines:
        if line.startswith(b"MORROW_ISOLATED_IMAGE_BEGIN "):
            _, raw_name, size, sha, count = line.split()
            name = raw_name.decode("ascii")
            if (name not in allowed or name in pending or name in images
                    or not 0 < int(size) <= PNG_LIMIT or not re.fullmatch(b"[0-9a-f]{64}", sha)
                    or not 0 < int(count) <= 1024):
                raise ValueError("Invalid or duplicate native image header")
            pending[name] = {"size": int(size), "sha256": sha.decode(), "count": int(count), "chunks": []}
        elif line.startswith(b"MORROW_ISOLATED_IMAGE_CHUNK "):
            _, raw_name, index, payload = line.split()
            name = raw_name.decode("ascii")
            item = pending.get(name)
            if (item is None or int(index) != len(item["chunks"]) or len(payload) > 1024
                    or len(item["chunks"]) >= item["count"]):
                raise ValueError("Invalid native image chunk sequence")
            item["chunks"].append(payload)
        elif line.startswith(b"MORROW_ISOLATED_IMAGE_END "):
            name = line.split()[1].decode("ascii")
            item = pending.pop(name, None)
            if item is None or len(item["chunks"]) != item["count"]:
                raise ValueError("Incomplete native image")
            data = base64.b64decode(b"".join(item.pop("chunks")), validate=True)
            if len(data) != item["size"] or digest(data) != item["sha256"]:
                raise ValueError("Native image size/hash mismatch")
            width, height = validate_png(data)
            images[name] = dict(item, width=width, height=height, data=data)
    if pending or f"{kind}-{mode}-before" not in images:
        raise ValueError("Missing or incomplete before-action native bitmap")
    return images


def parse_capture(output, kind, mode, nonce):
    lines = output.splitlines()
    expected = f"MORROW_ISOLATED_COMPLETE {kind} {mode} {nonce}".encode()
    completions = [line for line in lines if line.startswith(b"MORROW_ISOLATED_COMPLETE ")]
    if completions != [expected]:
        raise ValueError("Native process lacks one matching final completion receipt")
    records = [json.loads(line.removeprefix(b"MORROW_ISOLATED_RESULT "))
               for line in lines if line.startswith(b"MORROW_ISOLATED_RESULT ")]
    if len(records) != 1:
        raise ValueError("Native process lacks one result")
    record = records[0]
    if not (record.get("schema") == 1 and record.get("kind") == kind and record.get("mode") == mode
            and record.get("nonce") == nonce and record.get("diagnosticComplete") is True
            and type(record.get("passed")) is bool):
        raise ValueError("Mismatched native result")
    if lines.index(expected) < next(index for index, line in enumerate(lines) if line.startswith(b"MORROW_ISOLATED_RESULT ")):
        raise ValueError("Completion preceded native result")
    return record, parse_images(output, kind, mode)


def prepare_inputs(output, kind):
    private = output / "inputs"
    private.mkdir()
    sources = ROOT / "macos/Sources/MorrowMail"
    originals = {str(path.relative_to(ROOT)): digest(path.read_bytes()) for path in sorted(sources.glob("*.swift"))}
    model = (sources / "AppModel.swift").read_text()
    seam = "private(set) var baseURL: URL?"
    if model.count(seam) != 1:
        raise ValueError("Existing private fixture initialization seam changed")
    (private / "AppModel.swift").write_text(model.replace(seam, seam + ' = URL(string: "http://127.0.0.1:18484")', 1))
    inputs = [path for path in sorted(sources.glob("*.swift")) if path.name != "AppModel.swift"]
    inputs += [private / "AppModel.swift"]
    helper = ROOT / "macos/Checks/IsolatedProbeEvidence.swift"
    probe = ROOT / f"macos/Checks/Isolated{'MenuLifecycle' if kind == 'menu' else 'RowProjection'}.swift"
    check = ROOT / ("macos/Checks/ReviewWorkspaceAssertions.swift" if kind == "menu" else "macos/Checks/MailboxLatency.swift")
    original = check.read_bytes()
    if original.count(b"@main") != 1:
        raise ValueError("Existing native helper entry seam changed")
    adapted = private / check.name
    adapted.write_bytes(original.replace(b"@main", b"", 1))
    inputs += [adapted, helper, probe]
    for path in [check, helper, probe]:
        originals[str(path.relative_to(ROOT))] = digest(path.read_bytes())
    if kind == "menu":
        fixture = ROOT / "macos/Checks/ReviewWorkspaceFixtures.swift"
        inputs.append(fixture)
        originals[str(fixture.relative_to(ROOT))] = digest(fixture.read_bytes())
        view = (sources / "ReplySuggestionsView.swift").read_text()
        marker = 'Button("Skip suggestion") {'
        if view.count(marker) != 1:
            raise ValueError("Existing private Skip symbol seam changed")
        action = view.split(marker, 1)[1].split('}.disabled(', 1)[0]
        invoke = private / "InvokeReviewSkip.swift"
        invoke.write_text('import SwiftUI\n@MainActor func invokeReviewSkip(_ proposal: JSON, model: AppModel) async throws {\n'
                          '    let review = model.review, owner = model.review.owner(proposal)\n' + action + '\n'
                          '    let deadline = Date().addingTimeInterval(5)\n'
                          '    while (model.busy || review.writing) && Date() < deadline { try await Task.sleep(nanoseconds:20_000_000) }\n'
                          '    if model.busy || review.writing { throw APIError("Synthetic Skip handler did not complete") }\n}\n')
        inputs.append(invoke)
    receipt = {"originals": originals, "private": {p.name: digest(p.read_bytes()) for p in private.glob("*.swift")}}
    (output / "compiler-inputs.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return inputs, receipt


def captured(command, *, environment, timeout, path):
    try:
        result = subprocess.run(command, cwd=ROOT, env=environment, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, timeout=timeout, check=False)
        data, code = result.stdout, result.returncode
    except subprocess.TimeoutExpired as error:
        data, code = error.output or b"", None
    path.write_bytes(data)
    sys.stdout.buffer.write(data); sys.stdout.buffer.flush()
    return data, code


def run(probe, output):
    if sys.platform != "darwin":
        raise ValueError("Isolated AppKit probes require macOS")
    output.mkdir(parents=True, exist_ok=False)
    before = source_snapshot()
    print("MORROW_ISOLATED_SOURCE " + json.dumps(before, sort_keys=True), flush=True)
    inputs, compiler_inputs = prepare_inputs(output, probe)
    print("MORROW_ISOLATED_COMPILER_INPUTS " + json.dumps(compiler_inputs, sort_keys=True), flush=True)
    cases = []
    for mode in ("async", "appkit"):
        nonce = secrets.token_hex(16)
        environment = os.environ.copy()
        environment.update(MORROW_DATA_DIR=str(output / f"fictional-{probe}-{mode}"),
                           MORROW_ISOLATED_NONCE=nonce, MORROW_ISOLATED_KIND=probe, MORROW_ISOLATED_MODE=mode)
        environment.pop("MORROW_REVIEW_BASELINE", None)
        executable = output / f"{probe}-{mode}"
        command = ["/usr/bin/xcrun", "swiftc", "-D", "MORROW_WINDOW_CHECKS", "-parse-as-library",
                   "-module-cache-path", str(output / "module-cache")]
        if probe == "row":
            command.append("-O")
        if mode == "appkit":
            command += ["-D", "MORROW_PROBE_APPKIT"]
        command += [*map(str, inputs), "-o", str(executable)]
        result = {"kind": probe, "mode": mode, "nonce": nonce, "compilerTimeout": 180, "nativeTimeout": 45,
                  "diagnosticComplete": False, "originalGatePassed": False}
        started = time.monotonic()
        _, build_code = captured(command, environment=environment, timeout=180, path=output / f"{mode}-build.log")
        result["buildExitCode"] = build_code
        if build_code == 0:
            binary_hash = digest(executable.read_bytes())
            data, code = captured([str(executable)], environment=environment, timeout=45, path=output / f"{mode}-native.log")
            result.update(nativeExitCode=code, binarySha256=binary_hash, outputBytes=len(data), outputSha256=digest(data))
            try:
                # Preserve independently verified before-action pixels even
                # when this negative-control process exits before its receipt.
                images = parse_images(data, probe, mode)
                result.update(imagesComplete=True, images={})
                for name, image in images.items():
                    png = image.pop("data")
                    with (output / f"{name}.png").open("xb") as stream:
                        stream.write(png)
                    result["images"][name] = image
            except (ValueError, KeyError, IndexError, TypeError) as error:
                result["imagesComplete"] = False
                result["imageError"] = str(error)
            try:
                record, _ = parse_capture(data, probe, mode, nonce)
                if code != 0 or digest(executable.read_bytes()) != binary_hash:
                    raise ValueError("Native probe did not exit0 with unchanged binary")
                result.update(diagnosticComplete=True, originalGatePassed=record["passed"])
            except (ValueError, KeyError, IndexError, TypeError) as error:
                result["captureError"] = str(error)
        result["elapsedSeconds"] = time.monotonic() - started
        cases.append(result)
        print("MORROW_ISOLATED_DRIVER_CASE " + json.dumps(result, sort_keys=True), flush=True)
    after = source_snapshot()
    final = {"schema": 1, "kind": probe, "source": before, "sourceAfter": after,
             "sourceUnchanged": before == after, "cases": cases,
             "diagnosticComplete": all(case["diagnosticComplete"] for case in cases),
             "allOriginalGatesPassed": all(case["originalGatePassed"] for case in cases),
             "productionAcceptance": False}
    (output / "evidence.json").write_text(json.dumps(final, indent=2) + "\n")
    print("MORROW_ISOLATED_DRIVER_FINAL " + json.dumps(final, sort_keys=True), flush=True)
    return 0 if final["sourceUnchanged"] and final["diagnosticComplete"] and final["allOriginalGatesPassed"] else 1


def self_check():
    def chunk(kind, value):
        return struct.pack(">I", len(value)) + kind + value + struct.pack(">I", binascii.crc32(kind + value) & 0xffffffff)
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(b"\0\0\0\0\xff")) + chunk(b"IEND", b""))
    nonce, name = "0" * 32, "row-async-before"
    record = dict(schema=1, kind="row", mode="async", nonce=nonce, passed=False, diagnosticComplete=True)
    data = (f"MORROW_ISOLATED_IMAGE_BEGIN {name} {len(png)} {digest(png)} 1\n".encode()
            + f"MORROW_ISOLATED_IMAGE_CHUNK {name} 0 ".encode() + base64.b64encode(png) + b"\n"
            + f"MORROW_ISOLATED_IMAGE_END {name}\nMORROW_ISOLATED_RESULT ".encode() + canonical(record)
            + f"\nMORROW_ISOLATED_COMPLETE row async {nonce}\n".encode())
    result, images = parse_capture(data, "row", "async", nonce)
    assert result["passed"] is False and images[name]["data"] == png
    incomplete = data.replace(b"MORROW_ISOLATED_COMPLETE ", b"MISSING_COMPLETE ")
    assert parse_images(incomplete, "row", "async")[name]["data"] == png
    bad = [data.replace(b"MORROW_ISOLATED_COMPLETE ", b"MISSING_COMPLETE "),
           data.replace(nonce.encode(), b"1" * 32), data + f"MORROW_ISOLATED_COMPLETE row async {nonce}\n".encode(),
           data.replace(b"IMAGE_CHUNK row-async-before 0", b"IMAGE_CHUNK row-async-before 1"),
           data.replace(digest(png).encode(), b"f" * 64), data.replace(b"MORROW_ISOLATED_IMAGE_END", b"MISSING_IMAGE_END")]
    for candidate in bad:
        try:
            parse_capture(candidate, "row", "async", nonce)
        except ValueError:
            pass
        else:
            raise AssertionError("Invalid capture accepted")
    print("Isolated probe capture controls: false original gate retained; incomplete-process pixels preserved; six nonce/image completeness negatives rejected. No AppKit execution.")


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-check"]:
        self_check()
        raise SystemExit(0)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--probe", choices=("menu", "row"), required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    raise SystemExit(run(args.probe, args.output.resolve()))
