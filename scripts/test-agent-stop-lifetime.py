#!/usr/bin/env python3
"""Run actual Windows Stop/recovery coroutines in a portable ASan fixture.

This checks C++ coroutine ownership and owner/conversation routing. It does not
replace a WinUI build or native UI acceptance. No service/model/provider is used.
"""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[1]


def production_handler(signature: str) -> str:
    source = (ROOT / "windows/Intelligence.cpp").read_text()
    if source.count(signature) != 1:
        raise RuntimeError("The handler must be a named coroutine with by-value frame parameters: " + signature)
    start = source.index(signature)
    depth = 0
    for end in range(source.index("{", start), len(source)):
        if source[end] == "{":
            depth += 1
        elif source[end] == "}":
            depth -= 1
            if depth == 0:
                return source[start:end + 1]
    raise RuntimeError("Unclosed handler: " + signature)


def main() -> None:
    compiler = shutil.which(os.environ.get("CXX", "g++"))
    if compiler is None:
        raise RuntimeError("A C++20 compiler with AddressSanitizer is required")
    fixture = (ROOT / "windows/Checks/AgentStopLifetime.cpp").read_text()
    for marker, signature in [
        ("// PRODUCTION_AGENT_STOP", "fire_and_forget agentStop(Page page) {"),
        ("// PRODUCTION_AGENT_MUTATION", "IAsyncAction agentMutation(Page page, hstring path, Json input) {"),
        ("// PRODUCTION_AGENT_REFRESH", "fire_and_forget refreshAgent(Page page) {")
    ]:
        assert fixture.count(marker) == 1
        fixture = fixture.replace(marker, production_handler(signature))
    with tempfile.TemporaryDirectory(prefix="morrow-agent-stop-") as directory:
        source = Path(directory) / "agent-stop.cpp"
        binary = Path(directory) / "agent-stop"
        source.write_text(fixture)
        subprocess.run([compiler, "-std=c++20", "-O0", "-g", "-fsanitize=address",
                        "-fsanitize-address-use-after-scope", "-fno-omit-frame-pointer",
                        str(source), "-o", str(binary)], check=True)
        env = dict(os.environ, ASAN_OPTIONS="detect_stack_use_after_return=1:halt_on_error=1")
        subprocess.run([str(binary)], check=True, env=env)


if __name__ == "__main__":
    main()
