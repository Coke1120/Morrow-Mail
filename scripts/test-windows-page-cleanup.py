#!/usr/bin/env python3
"""Check actual loadPage control ownership with a split completion/UI transport.

The production page coroutine and Downloads scope are extracted verbatim except
for native row rendering, which records adoption. WinRT, controls and transport
are portable fakes; this is not Windows SDK execution or a native race replay.
"""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def extract(path: str, signature: str, struct: bool = False) -> str:
    source = (ROOT / path).read_text()
    if source.count(signature) != 1:
        raise RuntimeError("The exact production source seam changed: " + signature)
    start = source.index(signature)
    depth = 0
    for end in range(source.index("{", start), len(source)):
        if source[end] == "{":
            depth += 1
        elif source[end] == "}":
            depth -= 1
            if depth == 0:
                return source[start:end + 1 + int(struct)]
    raise RuntimeError("Unclosed source seam: " + signature)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--without-control-cleanup", action="store_true",
                        help="Mutation control: keep the old loading-only abandonment; expected failure")
    args = parser.parse_args()
    compiler = shutil.which(os.environ.get("CXX", "g++"))
    if compiler is None:
        raise RuntimeError("A C++20 compiler with AddressSanitizer is required")
    fixture = (ROOT / "windows/Checks/DownloadPageCleanup.cpp").read_text()
    for marker, path, signature, is_struct in [
        ("CONNECTION_REF", "windows/Downloads.cpp", "hstring downloadConnectionRef(Json const& state, hstring const& owner) {", False),
        ("DOWNLOAD_SCOPE", "windows/Downloads.cpp", "struct DownloadRefreshScope {", True),
        ("PAGE", "windows/App.cpp", "IAsyncOperation<bool> Shell::loadPage(int pageDelta, bool refreshReader, bool reset, WorkspaceReadGuard validity) {", False),
    ]:
        implementation = extract(path, signature, is_struct)
        if marker == "PAGE":
            first = "        std::set<std::wstring> selectedIds;"
            last = "        cursors = std::move(requested);"
            if implementation.count(first) != 1 or implementation.count(last) != 1:
                raise RuntimeError("The native row-rendering boundary changed")
            begin, end = implementation.index(first), implementation.index(last)
            implementation = implementation[:begin] + "        recordPage(result);\n" + implementation[end:]
            if args.without_control_cleanup:
                begin = implementation.index("    auto releaseAbandonedPage = [&] {")
                end = implementation.index("    previous.IsEnabled(false);", begin)
                implementation = implementation[:begin] + (
                    "    auto releaseAbandonedPage = [&] { "
                    "if (rows == targetRows && mailLoadTicket == ticket) loading = false; };\n"
                ) + implementation[end:]
                # The mutation leaves the new identity predicate unused.
                implementation = implementation.replace("    auto ownsPage = [&]", "    [[maybe_unused]] auto ownsPage = [&]")
        seam = "// PRODUCTION_" + marker
        if fixture.count(seam) != 1:
            raise RuntimeError("Duplicate fixture insertion: " + seam)
        fixture = fixture.replace(seam, implementation)
    if args.without_control_cleanup:
        print("Mutation control: actual loadPage with former loading-only cleanup; expected assertion failure, not a native binary replay.", flush=True)
    with tempfile.TemporaryDirectory(prefix="morrow-page-cleanup-") as temporary:
        source = Path(temporary) / "page-cleanup.cpp"
        binary = Path(temporary) / "page-cleanup"
        source.write_text(fixture)
        subprocess.run([compiler, "-std=c++20", "-O0", "-g", "-Wall", "-Wextra", "-Werror",
                        "-fsanitize=address,undefined", "-fsanitize-address-use-after-scope",
                        "-fno-omit-frame-pointer", str(source), "-o", str(binary)], check=True)
        environment = dict(os.environ, ASAN_OPTIONS="detect_stack_use_after_return=1:halt_on_error=1")
        subprocess.run([str(binary)], check=True, env=environment)


if __name__ == "__main__":
    main()
