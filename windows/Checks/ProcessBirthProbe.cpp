#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <cstdio>
#include <cstdint>
#include <string>
#include <vector>
#include <algorithm>

// A disposable, non-packaged discriminator. No attach, process inventory,
// memory/string reads, privileges, registry writes or real app are involved.
struct BasicInfo {
    LONG status; void* peb; ULONG_PTR affinity; LONG priority;
    ULONG_PTR pid; ULONG_PTR parent;
};
using QueryBasic = LONG (NTAPI*)(HANDLE, ULONG, void*, ULONG, ULONG*);
struct Row {
    DWORD pid{}, parent{}; long long ticks{}, parentTicks{}, exitTicks{};
    HANDLE pin{}; bool exited{}, initialBreak{}; DWORD code{};
};
static long long Ticks(FILETIME t) {
    ULARGE_INTEGER n{}; n.LowPart = t.dwLowDateTime; n.HighPart = t.dwHighDateTime;
    return static_cast<long long>(n.QuadPart) + 504911232000000000LL;
}
static bool Times(HANDLE h, long long& born, long long& exited) {
    FILETIME a{}, b{}, c{}, d{};
    if (!GetProcessTimes(h, &a, &b, &c, &d)) return false;
    born = Ticks(a); exited = (b.dwLowDateTime || b.dwHighDateTime) ? Ticks(b) : 0;
    return true;
}
static std::wstring Self() {
    wchar_t value[32768]{};
    const auto size = GetModuleFileNameW(nullptr, value, 32768);
    return size && size < 32768 ? std::wstring(value, size) : L"";
}
static PROCESS_INFORMATION Spawn(const std::wstring& mode, DWORD flags) {
    PROCESS_INFORMATION pi{}; STARTUPINFOW si{}; si.cb = sizeof(si);
    const auto exe = Self(); auto cmd = L"\"" + exe + L"\" " + mode;
    if (!CreateProcessW(exe.c_str(), cmd.data(), nullptr, nullptr, FALSE,
        flags, nullptr, nullptr, &si, &pi)) return {};
    return pi;
}
static int Fixture(const std::wstring& mode) {
    SetErrorMode(SEM_NOGPFAULTERRORBOX | SEM_FAILCRITICALERRORS);
    if (mode == L"leaf0") return 0;
    if (mode == L"leaf7") return 7;
    if (mode == L"leaf-late") { Sleep(100); return 0; }
    if (mode == L"leaf-crash") {
        RaiseException(EXCEPTION_ACCESS_VIOLATION, EXCEPTION_NONCONTINUABLE, 0, nullptr);
        return 99;
    }
    if (mode == L"fixture-timeout") { Sleep(20000); return 0; }
    const auto child = mode == L"parent" ? L"leaf-late" :
        mode == L"fixture-orphan" ? L"parent" :
        mode == L"fixture-nonzero" ? L"leaf7" :
        mode == L"fixture-crash" ? L"leaf-crash" : L"leaf0";
    auto pi = Spawn(child, 0);
    if (!pi.hProcess) return 98;
    CloseHandle(pi.hThread);
    if (mode != L"parent") {
        if (WaitForSingleObject(pi.hProcess, 10000) != WAIT_OBJECT_0) {
            CloseHandle(pi.hProcess); return 97;
        }
    }
    CloseHandle(pi.hProcess); return 0;
}

static int Probe(const std::wstring& scenario) {
    const bool negative = scenario != L"zero" && scenario != L"orphan";
    std::vector<Row> rows; std::vector<const char*> failures;
    auto Fail = [&](const char* s) { if (std::find(failures.begin(), failures.end(), s) == failures.end()) failures.push_back(s); };
    HANDLE job = CreateJobObjectW(nullptr, nullptr);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!job || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) return 90;
    // No completion notifications are used as proof. Job totals are only a
    // separate conservation check against the synchronous debug protocol.
    auto mode = scenario == L"orphan" ? L"fixture-orphan" :
        scenario == L"nonzero" ? L"fixture-nonzero" :
        scenario == L"crash" ? L"fixture-crash" :
        scenario == L"timeout" ? L"fixture-timeout" : L"fixture-zero";
    auto root = Spawn(mode, DEBUG_PROCESS | CREATE_SUSPENDED);
    if (!root.hProcess) { CloseHandle(job); return 91; }
    if (!AssignProcessToJobObject(job, root.hProcess)) {
        TerminateProcess(root.hProcess, 96); CloseHandle(root.hThread); CloseHandle(root.hProcess); CloseHandle(job); return 92;
    }
    auto query = reinterpret_cast<QueryBasic>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationProcess"));
    if (!query || sizeof(BasicInfo) != 48) Fail("parent-api");
    long long rootTicks{}, rootExit{}; if (!Times(root.hProcess, rootTicks, rootExit)) Fail("root-identity");
    const bool ready = failures.empty();
    if (ResumeThread(root.hThread) == static_cast<DWORD>(-1)) Fail("resume");
    CloseHandle(root.hThread);
    const auto begin = GetTickCount64();
    unsigned births{}, exits{}, events{}, duplicates{}, closed{};
    bool dropped{}, finished{}, jobDrained{}, cleanup{};
    DWORD projectedWait{}, waitError{};
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    while (GetTickCount64() - begin < (scenario == L"timeout" ? 1500ULL : 12000ULL)) {
        DEBUG_EVENT event{};
        if (!WaitForDebugEvent(&event, 20)) {
            const auto error = GetLastError();
            if (error != ERROR_SEM_TIMEOUT) { Fail("debug-wait"); break; }
            if (births && births == exits) { finished = true; break; }
            continue;
        }
        if (++events > 8192) { Fail("event-bound"); }
        DWORD continuation = DBG_CONTINUE;
        auto found = std::find_if(rows.begin(), rows.end(), [&](const Row& r) { return r.pid == event.dwProcessId && !r.exited; });
        if (event.dwDebugEventCode == CREATE_PROCESS_DEBUG_EVENT) {
            ++births;
            if (event.u.CreateProcessInfo.hFile) CloseHandle(event.u.CreateProcessInfo.hFile);
            Row row{}; row.pid = event.dwProcessId;
            BasicInfo basic{}; ULONG written{};
            if (!query || query(event.u.CreateProcessInfo.hProcess, 0, &basic, sizeof(basic), &written) < 0 ||
                written != sizeof(basic) || basic.pid != row.pid || basic.parent > MAXDWORD) Fail("parent-api");
            row.parent = static_cast<DWORD>(basic.parent);
            if (GetProcessId(event.u.CreateProcessInfo.hProcess) != row.pid ||
                !Times(event.u.CreateProcessInfo.hProcess, row.ticks, row.exitTicks)) Fail("birth-identity");
            if (!DuplicateHandle(GetCurrentProcess(), event.u.CreateProcessInfo.hProcess, GetCurrentProcess(),
                &row.pin, PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, 0)) Fail("birth-pin");
            else ++duplicates;
            if (row.pid == root.dwProcessId) {
                if (row.ticks != rootTicks || row.parent != GetCurrentProcessId()) Fail("root-identity");
            } else {
                auto parent = std::find_if(rows.rbegin(), rows.rend(), [&](const Row& r) { return r.pid == row.parent && r.ticks <= row.ticks; });
                if (parent == rows.rend()) Fail("parent-scope");
                else {
                    long long actual{}, terminal{};
                    if (!Times(parent->pin, actual, terminal) || actual != parent->ticks ||
                        (terminal && terminal < row.ticks)) Fail("parent-identity");
                    row.parentTicks = parent->ticks;
                }
            }
            if (scenario == L"identity-mismatch" && row.pid != root.dwProcessId) {
                ++row.parentTicks; Fail("projected-parent-identity");
            }
            if (rows.size() == 64) Fail("identity-bound");
            if (scenario == L"loss-birth" && row.pid != root.dwProcessId && !dropped) {
                dropped = true; if (row.pin) { CloseHandle(row.pin); ++closed; }
            } else rows.push_back(row);
        } else if (event.dwDebugEventCode == EXIT_PROCESS_DEBUG_EVENT) {
            ++exits;
            if (found == rows.end()) Fail("exit-without-birth");
            else if (scenario == L"loss-exit" && found->pid != root.dwProcessId && !dropped) dropped = true;
            else { found->exited = true; found->code = event.u.ExitProcess.dwExitCode; }
        } else if (event.dwDebugEventCode == LOAD_DLL_DEBUG_EVENT) {
            if (event.u.LoadDll.hFile) CloseHandle(event.u.LoadDll.hFile);
        } else if (event.dwDebugEventCode == EXCEPTION_DEBUG_EVENT) {
            // Only the loader's first breakpoint is consumed. Application
            // exceptions reach their handlers and second-chance termination.
            if (found != rows.end() && !found->initialBreak && event.u.Exception.dwFirstChance &&
                event.u.Exception.ExceptionRecord.ExceptionCode == EXCEPTION_BREAKPOINT) found->initialBreak = true;
            else continuation = DBG_EXCEPTION_NOT_HANDLED;
        } else if (event.dwDebugEventCode == RIP_EVENT) Fail("debug-rip");
        if (!ContinueDebugEvent(event.dwProcessId, event.dwThreadId, continuation)) { Fail("debug-continue"); break; }
    }
    if (!finished) Fail("deadline");
    if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr)) Fail("job-accounting");
    else {
        jobDrained = accounting.ActiveProcesses == 0;
        if (!jobDrained || accounting.TotalProcesses != rows.size() || accounting.TotalProcesses != births || births != exits) Fail("event-loss");
    }
    for (auto& row : rows) {
        if (!row.exited) { Fail("missing-exit"); continue; }
        const auto wait = WaitForSingleObject(row.pin, 2000);
        DWORD actual{}; long long born{}, terminal{};
        if (wait != WAIT_OBJECT_0 || !GetExitCodeProcess(row.pin, &actual) || actual != row.code ||
            !Times(row.pin, born, terminal) || born != row.ticks || !terminal) Fail("exit-proof");
        if (row.code != 0) Fail("nonzero-exit");
        if (row.pid != root.dwProcessId && scenario == L"wait-failed") {
            projectedWait = WaitForSingleObject(nullptr, 0); waitError = GetLastError();
            if (projectedWait != WAIT_FAILED || waitError != ERROR_INVALID_HANDLE) Fail("wait-fixture");
            Fail("native-wait-failure");
        }
        if (row.pid != root.dwProcessId && scenario == L"wait-unknown") {
            projectedWait = WAIT_ABANDONED; Fail("projected-invalid-wait");
        }
    }
    // Job closure terminates only the fixture scope. Drain killed debuggees so
    // no pending debug event can leave a process suspended behind this helper.
    CloseHandle(job); job = nullptr;
    const auto flush = GetTickCount64();
    while (WaitForSingleObject(root.hProcess, 0) != WAIT_OBJECT_0 && GetTickCount64() - flush < 2000) {
        DEBUG_EVENT event{};
        if (WaitForDebugEvent(&event, 20)) {
            if (event.dwDebugEventCode == LOAD_DLL_DEBUG_EVENT && event.u.LoadDll.hFile) CloseHandle(event.u.LoadDll.hFile);
            if (event.dwDebugEventCode == CREATE_PROCESS_DEBUG_EVENT && event.u.CreateProcessInfo.hFile) CloseHandle(event.u.CreateProcessInfo.hFile);
            ContinueDebugEvent(event.dwProcessId, event.dwThreadId,
                event.dwDebugEventCode == EXCEPTION_DEBUG_EVENT ? DBG_EXCEPTION_NOT_HANDLED : DBG_CONTINUE);
        }
    }
    cleanup = WaitForSingleObject(root.hProcess, 0) == WAIT_OBJECT_0;
    for (auto& row : rows) {
        if (row.pin) {
            if (WaitForSingleObject(row.pin, 0) != WAIT_OBJECT_0) cleanup = false;
            CloseHandle(row.pin); ++closed;
        }
    }
    CloseHandle(root.hProcess);
    if (!cleanup || closed != duplicates) Fail("cleanup");
    const bool accepted = failures.empty();
    std::printf("{\"kind\":\"birth-probe\",\"readyBeforeResume\":%s,\"accepted\":%s,\"expectedNegative\":%s,\"births\":%u,\"exits\":%u,\"jobTotal\":%u,\"jobDrained\":%s,\"cleanup\":%s,\"duplicates\":%u,\"closed\":%u,\"waitResult\":%u,\"waitError\":%u,\"failures\":[",
        ready ? "true" : "false", accepted ? "true" : "false", negative ? "true" : "false", births, exits,
        accounting.TotalProcesses, jobDrained ? "true" : "false", cleanup ? "true" : "false", duplicates, closed, projectedWait, waitError);
    for (size_t i = 0; i < failures.size(); ++i) std::printf("%s\"%s\"", i ? "," : "", failures[i]);
    std::printf("],\"lifetimes\":[");
    for (size_t i = 0; i < rows.size(); ++i) {
        const auto& row = rows[i];
        std::printf("%s{\"pid\":%u,\"parent\":%u,\"ticks\":%lld,\"parentTicks\":%lld,\"exited\":%s,\"exitCode\":%ld}",
            i ? "," : "", row.pid, row.parent, row.ticks, row.parentTicks, row.exited ? "true" : "false", static_cast<LONG>(row.code));
    }
    std::printf("]}\n");
    return ready && cleanup && (accepted != negative) ? 0 : 1;
}
int wmain(int argc, wchar_t** argv) {
    if (argc != 2) return 93;
    const std::wstring mode = argv[1];
    if (mode.starts_with(L"fixture-") || mode.starts_with(L"leaf") || mode == L"parent") return Fixture(mode);
    if (mode != L"zero" && mode != L"orphan" && mode != L"nonzero" && mode != L"crash" &&
        mode != L"loss-birth" && mode != L"loss-exit" && mode != L"identity-mismatch" &&
        mode != L"wait-failed" && mode != L"wait-unknown" && mode != L"timeout") return 94;
    return Probe(mode);
}
