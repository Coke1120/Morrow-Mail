#!/usr/bin/env python3
"""Exercise actual Windows Downloads/refresh coroutines with held fake transport.

The page/UI/WinRT boundary is mocked. This does not replace the native smoke
case, Windows SDK compilation, or provider-download acceptance.
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
    parser.add_argument("--without-shared-refresh", action="store_true",
                        help="Mutation control: omit completion refresh, modeling the old panel-only result; expected to fail")
    arguments = parser.parse_args()
    compiler = shutil.which(os.environ.get("CXX", "g++"))
    if compiler is None:
        raise RuntimeError("A C++20 compiler with AddressSanitizer is required")
    fixture = (ROOT / "windows/Checks/DownloadRefresh.cpp").read_text()
    for marker, path, signature, is_struct in [
        ("CONNECTION_REF", "windows/Downloads.cpp", "hstring downloadConnectionRef(Json const& state, hstring const& owner) {", False),
        ("DOWNLOAD_LOADING", "windows/Downloads.cpp", "struct DownloadLoading {", True),
        ("DOWNLOAD_SCOPE", "windows/Downloads.cpp", "struct DownloadRefreshScope {", True),
        ("DOWNLOAD_VIEWS", "windows/Downloads.cpp", "IAsyncOperation<bool> refreshDownloadedViews(std::shared_ptr<Shell> shell, DownloadRefreshScope scope) {", False),
        ("REPAIR", "windows/Downloads.cpp", "IAsyncOperation<bool> Shell::repairDownloadedMessage(Json message, hstring account, hstring connectionRef) {", False),
        ("REFRESH", "windows/App.cpp", "IAsyncOperation<bool> Shell::refresh(bool rebuild, WorkspaceReadGuard validity) {", False),
        ("READER", "windows/App.cpp", "IAsyncOperation<bool> Shell::refreshMailReader(WorkspaceReadGuard validity) {", False),
    ]:
        seam = "// PRODUCTION_" + marker
        if fixture.count(seam) != 1:
            raise RuntimeError("Duplicate fixture insertion: " + seam)
        implementation = extract(path, signature, is_struct)
        if arguments.without_shared_refresh and marker == "REPAIR":
            completion = "co_return co_await refreshDownloadedViews(lifetime,scope);"
            if implementation.count(completion) != 1:
                raise RuntimeError("The missing-refresh control seam changed")
            implementation = implementation.replace(completion, "co_return true;")
        fixture = fixture.replace(seam, implementation)
    if arguments.without_shared_refresh:
        print("Mutation control: actual repair coroutine with completion refresh omitted; expected failure, not a byte-identical baseline replay.", flush=True)
    with tempfile.TemporaryDirectory(prefix="morrow-download-refresh-") as temporary:
        source = Path(temporary) / "download-refresh.cpp"
        binary = Path(temporary) / "download-refresh"
        source.write_text(fixture)
        subprocess.run([compiler, "-std=c++20", "-O0", "-g", "-Wall", "-Wextra", "-Werror",
                        "-fsanitize=address,undefined", "-fsanitize-address-use-after-scope",
                        "-fno-omit-frame-pointer", str(source), "-o", str(binary)], check=True)
        environment = dict(os.environ, ASAN_OPTIONS="detect_stack_use_after_return=1:halt_on_error=1")
        subprocess.run([str(binary)], check=True, env=environment)


if __name__ == "__main__":
    main()
