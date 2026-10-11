#include "OwnedProcessObserver.h"

static std::wstring Self() {
    wchar_t value[32768]{};
    const auto size = GetModuleFileNameW(nullptr, value, 32768);
    return size && size < 32768 ? std::wstring(value, size) : L"";
}
static PROCESS_INFORMATION Spawn(const std::wstring& mode) {
    PROCESS_INFORMATION pi{}; STARTUPINFOW startup{}; startup.cb = sizeof(startup);
    const auto exe = Self(); auto command = L"\"" + exe + L"\" " + mode;
    if (!CreateProcessW(exe.c_str(), command.data(), nullptr, nullptr, FALSE, 0, nullptr, nullptr, &startup, &pi)) return {};
    return pi;
}
static int HandledException() {
    __try { RaiseException(EXCEPTION_ACCESS_VIOLATION, 0, 0, nullptr); }
    __except (EXCEPTION_EXECUTE_HANDLER) { return 0; }
    return 99;
}
static int Fixture(const std::wstring& mode) {
    SetErrorMode(SEM_NOGPFAULTERRORBOX | SEM_FAILCRITICALERRORS);
    if (mode == L"leaf0") return 0;
    if (mode == L"leaf7") return 7;
    if (mode == L"leaf-late") { Sleep(100); return 0; }
    if (mode == L"leaf-sample") { Sleep(2300); return 0; }
    if (mode == L"leaf-handled") return HandledException();
    if (mode == L"leaf-crash" || mode == L"leaf-breakpoint") {
        RaiseException(mode == L"leaf-crash" ? EXCEPTION_ACCESS_VIOLATION : EXCEPTION_BREAKPOINT,
            EXCEPTION_NONCONTINUABLE, 0, nullptr);
        return 99;
    }
    if (mode == L"fixture-timeout") { Sleep(20000); return 0; }
    const auto child = mode == L"parent" ? L"leaf-late" : mode == L"fixture-counters" ? L"leaf-sample" : mode == L"fixture-orphan" ? L"parent" :
        mode == L"fixture-nonzero" ? L"leaf7" : mode == L"fixture-crash" ? L"leaf-crash" :
        mode == L"fixture-breakpoint" ? L"leaf-breakpoint" : mode == L"fixture-handled" ? L"leaf-handled" : L"leaf0";
    auto pi = Spawn(child);
    if (!pi.hProcess) return 98;
    CloseHandle(pi.hThread);
    if (mode != L"parent" && WaitForSingleObject(pi.hProcess, 10000) != WAIT_OBJECT_0) {
        CloseHandle(pi.hProcess); return 97;
    }
    CloseHandle(pi.hProcess); return 0;
}
int wmain(int argc, wchar_t** argv) {
    if (argc != 2 && argc != 3) return 93;
    const std::wstring mode = argv[1];
    if (mode.starts_with(L"fixture-") || mode.starts_with(L"leaf") || mode == L"parent") return Fixture(mode);
    owned::Options options; options.exe = Self(); options.launch = owned::Stamp(); options.deadlineMs = 12000;
    bool negative = true, acquire = mode.starts_with(L"acquire-");
    if (mode == L"zero" || mode == L"acquire-zero") { options.arguments = L"fixture-zero"; negative = false; }
    else if (mode == L"orphan") { options.arguments = L"fixture-orphan"; negative = false; }
    else if (mode == L"handled-exception") { options.arguments = L"fixture-handled"; negative = false; }
    else if (mode == L"counters" || mode == L"counter-denied") {
        options.arguments = L"fixture-counters"; negative = mode != L"counters";
        if (negative) options.fault = owned::Fault::CounterDenied;
    }
    else if (mode == L"pending-exit-wait") {
        options.arguments = L"fixture-zero"; negative = false; options.fault = owned::Fault::DelayExit;
    }
    else if (mode == L"nonzero" || mode == L"acquire-nonzero") options.arguments = L"fixture-nonzero";
    else if (mode == L"crash" || mode == L"acquire-crash") options.arguments = L"fixture-crash";
    else if (mode == L"user-breakpoint") options.arguments = L"fixture-breakpoint";
    else {
        options.arguments = L"fixture-zero";
        if (mode == L"loss-birth") options.fault = owned::Fault::DropBirth;
        else if (mode == L"loss-exit") options.fault = owned::Fault::DropExit;
        else if (mode == L"identity-mismatch") options.fault = owned::Fault::ParentIdentity;
        else if (mode == L"creation-mismatch") options.fault = owned::Fault::CreationIdentity;
        else if (mode == L"wrong-job") options.fault = owned::Fault::WrongJob;
        else if (mode == L"wait-failed") options.fault = owned::Fault::ClosedHandle;
        else if (mode == L"wait-unknown") options.fault = owned::Fault::UnknownWait;
        else if (mode == L"exit-mismatch") options.fault = owned::Fault::ExitCode;
        else if (mode == L"overflow") options.fault = owned::Fault::Bound;
        else if (mode == L"timeout") { options.arguments = L"fixture-timeout"; options.deadlineMs = 1500; }
        else return 94;
    }
    FILE* samples{};
    if (argc == 3 && (mode == L"counters" || mode == L"counter-denied")) {
        const auto path = std::wstring(argv[2]) + L".samples";
        if (_wfopen_s(&samples, path.c_str(), L"wb") || !samples) return 95;
        options.samples = samples;
    }
    auto result = owned::Run(options);
    if (samples && std::fclose(samples)) result.Fail("sample-footer");
    if (argc == 3) {
        FILE* ledger{};
        if (_wfopen_s(&ledger, argv[2], L"wb") || !ledger) return 95;
        const auto text = owned::Ledger(result);
        const auto written = owned::WriteBounded(ledger, text, true);
        if (std::fclose(ledger) || !written) return 95;
    }
    DWORD acquireError{}; bool acquireEvidence = !acquire;
    if (acquire && result.rows.size() == 2 && result.rows[1].exitProven) {
        // After all original handles close, try the prior snapshot PID once.
        // Error 87 itself cannot say whether this exact lifetime exited zero.
        Sleep(20);
        owned::Handle reopened(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, result.rows[1].pid));
        acquireError = reopened.value ? 0 : GetLastError();
        acquireEvidence = !reopened.value && acquireError == ERROR_INVALID_PARAMETER;
    }
    const bool accepted = result.failures.empty();
    std::printf("{\"kind\":\"birth-probe\",\"readyBeforeResume\":%s,\"accepted\":%s,\"expectedNegative\":%s,\"births\":%u,\"exits\":%u,\"jobTotal\":%u,\"jobDrained\":%s,\"cleanup\":%s,\"duplicates\":%u,\"closed\":%u,\"firstAcquireError\":%u,\"firstAcquireEvidence\":%s,\"failures\":[",
        result.ready ? "true" : "false", accepted ? "true" : "false", negative ? "true" : "false", result.births, result.exits,
        result.jobTotal, result.normalDrain ? "true" : "false", result.cleanup ? "true" : "false", result.duplicates, result.closed,
        acquireError, acquireEvidence ? "true" : "false");
    for (size_t i = 0; i < result.failures.size(); ++i) std::printf("%s\"%s\"", i ? "," : "", result.failures[i]);
    std::printf("],\"samples\":%u,\"pendingExitWaits\":%u,\"faultUsed\":%s,\"lifetimes\":[", result.samples, result.pendingExitWaits, result.faultUsed ? "true" : "false");
    for (size_t i = 0; i < result.rows.size(); ++i) {
        const auto& row = result.rows[i];
        const auto exitCode = row.exitProven ? std::to_string(static_cast<LONG>(row.exitCode)) : "null";
        std::printf("%s{\"pid\":%u,\"parent\":%u,\"ticks\":%lld,\"parentTicks\":%lld,\"exited\":%s,\"exitCode\":%s,\"waitResult\":%u,\"outcome\":\"%s\",\"nativeError\":%u}",
            i ? "," : "", row.pid, row.parent, row.ticks, row.parentTicks, row.exitProven ? "true" : "false",
            exitCode.c_str(), row.waitResult, row.outcome, row.waitError);
    }
    std::printf("]}\n");
    return result.ready && result.cleanup && acquireEvidence && (accepted != negative) ? 0 : 1;
}
