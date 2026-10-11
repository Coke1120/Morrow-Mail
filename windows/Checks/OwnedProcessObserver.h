#pragma once
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <psapi.h>
#include <algorithm>
#include <cstdint>
#include <cstddef>
#include <cstdio>
#include <string>
#include <vector>

// Fixture-only launch/observation. Never attach, enumerate processes, inspect
// process memory/debug strings, enable privileges, or ship this in the app.
namespace owned {
constexpr long long EpochTicks = 504911232000000000LL;
struct Handle {
    HANDLE value{};
    Handle() = default;
    explicit Handle(HANDLE h) : value(h) {}
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
    ~Handle() { reset(); }
    bool reset(HANDLE h = nullptr) {
        const bool closed = !value || value == INVALID_HANDLE_VALUE || CloseHandle(value);
        value = h;
        return closed;
    }
};
inline long long Ticks(FILETIME t) {
    ULARGE_INTEGER n{}; n.LowPart = t.dwLowDateTime; n.HighPart = t.dwHighDateTime;
    return static_cast<long long>(n.QuadPart) + EpochTicks;
}
inline bool Times(HANDLE h, long long& born, long long& exited) {
    FILETIME a{}, b{}, c{}, d{};
    if (!GetProcessTimes(h, &a, &b, &c, &d)) return false;
    born = Ticks(a); exited = (b.dwLowDateTime || b.dwHighDateTime) ? Ticks(b) : 0;
    return true;
}
inline long long Stamp() { LARGE_INTEGER n{}; QueryPerformanceCounter(&n); return n.QuadPart; }
inline double Elapsed(long long at, long long launch) {
    LARGE_INTEGER hz{}; QueryPerformanceFrequency(&hz);
    return static_cast<double>(at - launch) * 1000.0 / static_cast<double>(hz.QuadPart);
}
struct BasicInfo {
    LONG status; void* peb; ULONG_PTR affinity; LONG priority;
    ULONG_PTR pid; ULONG_PTR parent;
};
using QueryBasic = LONG (NTAPI*)(HANDLE, ULONG, void*, ULONG, ULONG*);
struct Row {
    DWORD pid{}, parent{}; long long ticks{}, parentTicks{}, exitTicks{};
    HANDLE pin{}; unsigned birthSeq{}, exitSeq{};
    bool exitSeen{}, exitProven{}, proofFailed{}, initialBreak{}, inJob{};
    DWORD eventCode{}, exitCode{}, waitResult{WAIT_TIMEOUT}, waitError{};
    const char* outcome{"alive"}; const char* role{"other"};
};
struct Event { unsigned seq{}, row{}; bool birth{}; };
enum class Fault {
    None, DropBirth, DropExit, ParentIdentity, CreationIdentity, WrongJob,
    ClosedHandle, UnknownWait, ExitCode, Bound, Timeout, CounterDenied, DelayExit
};
struct Options {
    std::wstring exe, arguments;
    long long launch{}; DWORD deadlineMs{180000}; Fault fault{Fault::None};
    FILE* samples{};
};
struct Result {
    std::vector<Row> rows; std::vector<Event> ledger; std::vector<const char*> failures;
    unsigned births{}, exits{}, sequence{}, events{}, duplicates{}, closed{}, samples{}, pendingExitWaits{};
    DWORD rootPid{}, rootCode{}, jobTotal{}, jobActive{};
    long long rootTicks{}, launcherTicks{}, launch{};
    double rootExitElapsedMs{};
    bool ready{}, normalDrain{}, cleanup{}, forced{}, rootProven{}, faultUsed{}, tokenElevated{}, debugPrivilegeEnabled{};
    void Fail(const char* reason) {
        if (std::find(failures.begin(), failures.end(), reason) == failures.end()) failures.push_back(reason);
    }
};
inline bool ParentMatches(const Row& child, const Row& parent) {
    long long born{}, terminal{};
    return child.parent == parent.pid && child.parentTicks == parent.ticks &&
        parent.ticks <= child.ticks && Times(parent.pin, born, terminal) && born == parent.ticks &&
        (!terminal || terminal >= child.ticks) && parent.birthSeq < child.birthSeq;
}
inline bool BirthMatches(Row& row, HANDLE job) {
    long long born{}, terminal{}; BOOL member{};
    row.inJob = IsProcessInJob(row.pin, job, &member) && member;
    return GetProcessId(row.pin) == row.pid && Times(row.pin, born, terminal) && born == row.ticks &&
        !terminal && row.inJob;
}
inline const char* WaitOutcome(DWORD wait) {
    return wait == WAIT_OBJECT_0 ? "signaled" : wait == WAIT_TIMEOUT ? "alive" :
        wait == WAIT_FAILED ? "nativeFailure" : "invalidWait";
}
inline bool ProveExit(Row& row, Result& result, Fault fault) {
    row.waitResult = WaitForSingleObject(row.pin, 0);
    row.waitError = row.waitResult == WAIT_FAILED ? GetLastError() : 0;
    if (fault == Fault::UnknownWait && row.pid != result.rootPid && !result.faultUsed) {
        row.waitResult = WAIT_ABANDONED; row.waitError = 0; result.faultUsed = true;
    }
    if (fault == Fault::DelayExit && row.pid != result.rootPid && !result.faultUsed) {
        row.waitResult = WAIT_TIMEOUT; row.waitError = 0; result.faultUsed = true;
    }
    row.outcome = WaitOutcome(row.waitResult);
    if (row.waitResult == WAIT_TIMEOUT) { ++result.pendingExitWaits; return false; }
    if (row.waitResult != WAIT_OBJECT_0) { row.proofFailed = true; result.Fail("native-wait"); return false; }
    long long born{};
    if (!GetExitCodeProcess(row.pin, &row.exitCode) || !Times(row.pin, born, row.exitTicks) ||
        GetProcessId(row.pin) != row.pid || born != row.ticks || row.exitTicks < row.ticks ||
        !row.exitSeen || row.exitCode != row.eventCode) {
        row.outcome = "unproven"; row.proofFailed = true; result.Fail("exit-proof"); return false;
    }
    row.exitProven = true;
    row.outcome = row.exitCode == 0 ? "zero" : "nonzero";
    if (row.exitCode != 0) result.Fail("nonzero-exit");
    if (row.pid == result.rootPid) {
        result.rootProven = true; result.rootCode = row.exitCode;
        result.rootExitElapsedMs = Elapsed(Stamp(), result.launch);
    }
    return true;
}
inline const char* Role(HANDLE pin, bool root) {
    if (root) return "ui";
    wchar_t path[32768]{}; DWORD size = 32768;
    if (!QueryFullProcessImageNameW(pin, 0, path, &size)) return nullptr;
    const std::wstring image(path, size); const auto slash = image.find_last_of(L"\\/");
    const auto name = image.substr(slash == std::wstring::npos ? 0 : slash + 1);
    return _wcsicmp(name.c_str(), L"morrow-service.exe") == 0 ? "service" :
        _wcsicmp(name.c_str(), L"msedgewebview2.exe") == 0 ? "webview" : "other";
}
inline bool WriteBounded(FILE* file, const std::string& line, bool footer = false) {
    if (!file) return true;
    const auto at = _ftelli64(file);
    if (at < 0 || line.size() > 32768 || at + static_cast<long long>(line.size()) >
        (footer ? 2097152 : 2096640)) return false;
    return std::fwrite(line.data(), 1, line.size(), file) == line.size() && std::fflush(file) == 0;
}
inline void Number(std::string& out, long long value) { out += std::to_string(value); }
inline void Sample(Result& r, const Options& options) {
    const auto at = Stamp(); std::string processes, failures;
    unsigned skipped{}, rootSkipped{};
    for (auto& row : r.rows) {
        if (row.exitSeen) continue;
        const auto wait = WaitForSingleObject(row.pin, 0);
        const auto waitError = wait == WAIT_FAILED ? GetLastError() : 0;
        // The eventual debug exit and final conservation still have to prove
        // this exact lifetime. No counters are invented for a terminated pin.
        if (wait == WAIT_OBJECT_0) continue;
        DWORD error{}; const char* stage = "counters";
        Handle denied; HANDLE memoryPin = row.pin;
        if (options.fault == Fault::CounterDenied && row.pid != r.rootPid) {
            HANDLE restricted{};
            if (!DuplicateHandle(GetCurrentProcess(), row.pin, GetCurrentProcess(), &restricted, SYNCHRONIZE, FALSE, 0)) r.Fail("counter-fixture");
            else { denied.reset(restricted); memoryPin = restricted; r.faultUsed = true; }
        }
        PROCESS_MEMORY_COUNTERS_EX memory{}; memory.cb = sizeof(memory);
        FILETIME born{}, end{}, kernel{}, user{};
        const bool identity = GetProcessId(row.pin) == row.pid &&
            GetProcessTimes(row.pin, &born, &end, &kernel, &user) && Ticks(born) == row.ticks;
        if (wait != WAIT_TIMEOUT) { error = waitError; stage = "nativeWait"; }
        else if (!identity) { error = GetLastError(); stage = "identity"; }
        else if (!GetProcessMemoryInfo(memoryPin, reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&memory), sizeof(memory))) error = GetLastError();
        else {
            if (!processes.empty()) processes += ',';
            processes += "{\"pid\":"; Number(processes, row.pid);
            processes += ",\"parentPid\":"; Number(processes, row.parent);
            processes += ",\"startUtcTicks\":"; Number(processes, row.ticks);
            processes += ",\"workingSetBytes\":"; Number(processes, static_cast<long long>(memory.WorkingSetSize));
            processes += ",\"privateBytes\":"; Number(processes, static_cast<long long>(memory.PrivateUsage));
            processes += ",\"cpuMs\":";
            ULARGE_INTEGER k{}, u{}; k.LowPart = kernel.dwLowDateTime; k.HighPart = kernel.dwHighDateTime;
            u.LowPart = user.dwLowDateTime; u.HighPart = user.dwHighDateTime;
            processes += std::to_string(static_cast<double>(k.QuadPart + u.QuadPart) / 10000.0);
            processes += ",\"role\":\""; processes += row.role; processes += "\"}";
            continue;
        }
        ++skipped; if (row.pid == r.rootPid) ++rootSkipped;
        if (!denied.reset()) r.Fail("counter-fixture");
        r.Fail("counter-read");
        if (!failures.empty()) failures += ',';
        failures += "{\"pid\":"; Number(failures, row.pid);
        failures += ",\"parentPid\":"; Number(failures, row.parent);
        failures += ",\"cimStartUtcTicks\":"; Number(failures, row.ticks);
        failures += ",\"source\":\"retained\",\"reason\":\"counterReadFailed\",\"stage\":\"";
        failures += stage; failures += "\",\"errorKind\":\"";
        failures += error == ERROR_ACCESS_DENIED ? "accessDenied" : "native";
        failures += "\",\"errorCode\":"; Number(failures, error); failures += ",\"exitCode\":null}";
    }
    std::string line = "{\"kind\":0,\"elapsedMs\":" + std::to_string(Elapsed(at, options.launch)) +
        ",\"queryMs\":" + std::to_string(Elapsed(Stamp(), at)) + ",\"skipped\":" + std::to_string(skipped) +
        ",\"rootSkipped\":" + std::to_string(rootSkipped) + ",\"rootExitedDuringSample\":" + (r.rootProven ? "true" : "false") +
        ",\"skipReasonCounts\":{\"parentUnavailable\":0,\"parentExited\":0,\"processUnavailable\":0,\"processExited\":0,\"identityMismatch\":0,\"counterReadFailed\":" +
        std::to_string(skipped) + ",\"unclassified\":0},\"processes\":[" + processes + "],\"lifecycleEvents\":[],\"failedRecords\":[" + failures + "]}\n";
    if (!WriteBounded(options.samples, line)) r.Fail("sample-bound");
    else ++r.samples;
}
inline void ValidateLedger(Result& r) {
    if (!r.ready || !r.rootProven || !r.normalDrain || r.jobActive || r.jobTotal != r.births ||
        r.births != r.exits || r.births != r.rows.size() || r.sequence != r.births + r.exits ||
        r.ledger.size() != r.sequence) r.Fail("event-loss");
    std::vector<unsigned> born(r.rows.size()), exited(r.rows.size());
    unsigned last{};
    for (const auto& event : r.ledger) {
        if (event.seq != ++last || event.row >= r.rows.size()) { r.Fail("ledger-sequence"); continue; }
        const auto& row = r.rows[event.row];
        if (event.birth) {
            if (++born[event.row] != 1 || event.seq != row.birthSeq) r.Fail("ledger-birth");
        } else if (++exited[event.row] != 1 || !born[event.row] || event.seq != row.exitSeq || !row.exitProven) r.Fail("ledger-exit");
    }
    for (size_t i = 0; i < r.rows.size(); ++i) {
        if (born[i] != 1 || exited[i] != 1 || !r.rows[i].exitProven) r.Fail("missing-lifetime");
        for (size_t j = 0; j < i; ++j)
            if (r.rows[j].pid == r.rows[i].pid && r.rows[j].ticks == r.rows[i].ticks) r.Fail("duplicate-identity");
    }
}
inline Result Run(const Options& options) {
    Result r; r.rows.reserve(64); r.ledger.reserve(128); r.launch = options.launch;
    auto Close = [&](Handle& handle, const char* reason) { if (!handle.reset()) r.Fail(reason); };
    // Only two metadata booleans from this helper's own token. Never enable a
    // privilege, read account/SID data, or silently call an elevated mechanism.
    Handle token; HANDLE tokenValue{}; TOKEN_ELEVATION elevation{}; DWORD needed{};
    LUID debugLuid{};
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &tokenValue)) { r.Fail("token-query"); return r; }
    token.reset(tokenValue);
    if (!GetTokenInformation(token.value, TokenElevation, &elevation, sizeof(elevation), &needed) ||
        !LookupPrivilegeValueW(nullptr, SE_DEBUG_NAME, &debugLuid)) { r.Fail("token-query"); return r; }
    r.tokenElevated = elevation.TokenIsElevated != 0;
    needed = 0;
    if (GetTokenInformation(token.value, TokenPrivileges, nullptr, 0, &needed) || GetLastError() != ERROR_INSUFFICIENT_BUFFER ||
        needed < sizeof(TOKEN_PRIVILEGES) || needed > 16384) { r.Fail("token-query"); return r; }
    std::vector<unsigned char> privileges(needed);
    if (!GetTokenInformation(token.value, TokenPrivileges, privileges.data(), needed, &needed)) { r.Fail("token-query"); return r; }
    const auto view = reinterpret_cast<const TOKEN_PRIVILEGES*>(privileges.data());
    if (view->PrivilegeCount > (needed - offsetof(TOKEN_PRIVILEGES, Privileges)) / sizeof(LUID_AND_ATTRIBUTES)) { r.Fail("token-query"); return r; }
    for (DWORD i = 0; i < view->PrivilegeCount; ++i) {
        const auto& privilege = view->Privileges[i];
        if (privilege.Luid.LowPart == debugLuid.LowPart && privilege.Luid.HighPart == debugLuid.HighPart)
            r.debugPrivilegeEnabled = (privilege.Attributes & SE_PRIVILEGE_ENABLED) != 0;
    }
    Close(token, "token-query");
    Handle job(CreateJobObjectW(nullptr, nullptr)); JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!job.value || !SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) { r.Fail("job-create"); return r; }
    auto query = reinterpret_cast<QueryBasic>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationProcess"));
    long long launcherExit{};
    if (!query || sizeof(BasicInfo) != 48 || !Times(GetCurrentProcess(), r.launcherTicks, launcherExit)) { r.Fail("parent-api"); return r; }
    // Inherit only the parent's explicitly duplicated stderr and two NUL
    // handles. Job, files and retained process pins are never inheritable.
    SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE};
    Handle input(CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, nullptr));
    Handle output(CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, nullptr));
    Handle error; HANDLE duplicated{};
    if (!DuplicateHandle(GetCurrentProcess(), GetStdHandle(STD_ERROR_HANDLE), GetCurrentProcess(), &duplicated, 0, TRUE, DUPLICATE_SAME_ACCESS)) { r.Fail("stderr-handle"); return r; }
    error.reset(duplicated);
    SIZE_T attributeSize{}; InitializeProcThreadAttributeList(nullptr, 1, 0, &attributeSize);
    std::vector<unsigned char> attributes(attributeSize);
    auto list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());
    if (!InitializeProcThreadAttributeList(list, 1, 0, &attributeSize)) { r.Fail("launch-attributes"); return r; }
    HANDLE inherited[]{input.value, output.value, error.value};
    const bool set = UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), nullptr, nullptr) != FALSE;
    STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup); startup.lpAttributeList = list;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = input.value; startup.StartupInfo.hStdOutput = output.value; startup.StartupInfo.hStdError = error.value;
    PROCESS_INFORMATION pi{}; auto command = L"\"" + options.exe + L"\" " + options.arguments;
    const bool created = set && CreateProcessW(options.exe.c_str(), command.data(), nullptr, nullptr, TRUE,
        DEBUG_PROCESS | CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT, nullptr, nullptr, &startup.StartupInfo, &pi);
    DeleteProcThreadAttributeList(list);
    if (!created) { r.Fail("root-launch"); return r; }
    Handle root(pi.hProcess), thread(pi.hThread); r.rootPid = pi.dwProcessId;
    long long rootExit{};
    if (!AssignProcessToJobObject(job.value, root.value) || !Times(root.value, r.rootTicks, rootExit)) {
        r.Fail("root-admission");
        if (!TerminateProcess(root.value, 96)) { r.Fail("root-cleanup"); return r; }
    } else r.ready = true;
    if (r.ready && ResumeThread(thread.value) == static_cast<DWORD>(-1)) r.Fail("root-resume");
    Close(thread, "launch-close"); Close(input, "launch-close"); Close(output, "launch-close"); Close(error, "launch-close");
    auto lastSample = options.launch; long long rootExitAt{};
    bool finished{};
    while (Elapsed(Stamp(), options.launch) < options.deadlineMs) {
        DEBUG_EVENT event{};
        if (WaitForDebugEvent(&event, 10)) {
            ++r.events;
            DWORD continuation = DBG_CONTINUE;
            auto found = std::find_if(r.rows.begin(), r.rows.end(), [&](const Row& row) { return row.pid == event.dwProcessId && !row.exitSeen; });
            if (event.dwDebugEventCode == CREATE_PROCESS_DEBUG_EVENT) {
                ++r.births; ++r.sequence;
                Handle image(event.u.CreateProcessInfo.hFile);
                Row row; row.pid = event.dwProcessId; row.birthSeq = r.sequence;
                BasicInfo basic{}; ULONG written{};
                if (query(event.u.CreateProcessInfo.hProcess, 0, &basic, sizeof(basic), &written) < 0 || written != sizeof(basic) ||
                    basic.pid != row.pid || basic.parent > MAXDWORD || !Times(event.u.CreateProcessInfo.hProcess, row.ticks, row.exitTicks)) r.Fail("birth-identity");
                row.parent = static_cast<DWORD>(basic.parent);
                if (!DuplicateHandle(GetCurrentProcess(), event.u.CreateProcessInfo.hProcess, GetCurrentProcess(), &row.pin,
                    PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, 0)) r.Fail("birth-pin");
                else ++r.duplicates;
                if (row.pid == r.rootPid) {
                    row.parentTicks = r.launcherTicks;
                    if (row.ticks != r.rootTicks || row.parent != GetCurrentProcessId()) r.Fail("root-identity");
                } else {
                    std::vector<size_t> parents;
                    for (size_t i = 0; i < r.rows.size(); ++i) {
                        auto candidate = row; candidate.parentTicks = r.rows[i].ticks;
                        if (ParentMatches(candidate, r.rows[i])) parents.push_back(i);
                    }
                    if (parents.size() != 1) r.Fail("parent-identity");
                    else row.parentTicks = r.rows[parents[0]].ticks;
                    if (options.fault == Fault::ParentIdentity) ++row.parentTicks;
                    if (parents.size() == 1 && !ParentMatches(row, r.rows[parents[0]])) r.Fail("parent-identity");
                    if (options.fault == Fault::CreationIdentity) ++row.ticks;
                }
                Handle wrongJob(options.fault == Fault::WrongJob && row.pid != r.rootPid ? CreateJobObjectW(nullptr, nullptr) : nullptr);
                if (!BirthMatches(row, wrongJob.value ? wrongJob.value : job.value)) r.Fail("birth-proof");
                row.role = Role(row.pin, row.pid == r.rootPid);
                if (!row.role) { r.Fail("role-read"); row.role = "other"; }
                if (r.rows.size() >= (options.fault == Fault::Bound ? 1ULL : 64ULL)) {
                    r.Fail("identity-bound"); if (row.pin) { if (CloseHandle(row.pin)) ++r.closed; else r.Fail("pin-close"); }
                } else {
                    const auto index = static_cast<unsigned>(r.rows.size()); r.rows.push_back(row);
                    if (options.fault != Fault::DropBirth || row.pid == r.rootPid) r.ledger.push_back({r.sequence, index, true});
                }
                Close(image, "image-close"); Close(wrongJob, "job-cleanup");
            } else if (event.dwDebugEventCode == EXIT_PROCESS_DEBUG_EVENT) {
                ++r.exits; ++r.sequence;
                if (found == r.rows.end()) r.Fail("exit-without-birth");
                else {
                    found->exitSeen = true; found->exitSeq = r.sequence; found->eventCode = event.u.ExitProcess.dwExitCode;
                    if (options.fault == Fault::ExitCode && found->pid != r.rootPid) ++found->eventCode;
                    if (options.fault == Fault::ClosedHandle && found->pid != r.rootPid) {
                        if (CloseHandle(found->pin)) ++r.closed; else r.Fail("pin-close");
                        found->pin = nullptr;
                    }
                    if (options.fault != Fault::DropExit || found->pid == r.rootPid)
                        r.ledger.push_back({r.sequence, static_cast<unsigned>(found - r.rows.begin()), false});
                    if (found->pid == r.rootPid) rootExitAt = Stamp();
                }
            } else if (event.dwDebugEventCode == LOAD_DLL_DEBUG_EVENT) {
                Handle image(event.u.LoadDll.hFile);
                Close(image, "image-close");
            } else if (event.dwDebugEventCode == EXCEPTION_DEBUG_EVENT) {
                if (found != r.rows.end() && !found->initialBreak && event.u.Exception.dwFirstChance &&
                    event.u.Exception.ExceptionRecord.ExceptionCode == EXCEPTION_BREAKPOINT) found->initialBreak = true;
                else continuation = DBG_EXCEPTION_NOT_HANDLED;
            } else if (event.dwDebugEventCode == RIP_EVENT) r.Fail("debug-rip");
            if (!ContinueDebugEvent(event.dwProcessId, event.dwThreadId, continuation)) { r.Fail("debug-continue"); break; }
            if (r.events >= 8192 || r.sequence > 128 ||
                std::find(r.failures.begin(), r.failures.end(), "identity-bound") != r.failures.end()) {
                r.Fail("event-bound"); break;
            }
        } else if (GetLastError() != ERROR_SEM_TIMEOUT) { r.Fail("debug-wait"); break; }
        for (auto& row : r.rows) if (row.exitSeen && !row.exitProven && !row.proofFailed) ProveExit(row, r, options.fault);
        if (r.rootProven && r.births == r.exits && std::all_of(r.rows.begin(), r.rows.end(),
            [](const Row& row) { return row.exitProven || row.proofFailed; })) {
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION drain{};
            if (!QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation, &drain, sizeof(drain), nullptr)) r.Fail("job-accounting");
            else if (!drain.ActiveProcesses) { finished = true; break; }
        }
        if (rootExitAt && Elapsed(Stamp(), rootExitAt) >= 2000) { r.Fail("descendant-drain"); break; }
        if (options.samples && Elapsed(Stamp(), lastSample) >= 1000) {
            if (r.samples == 180) { r.Fail("sample-bound"); break; }
            Sample(r, options); lastSample = Stamp();
        }
    }
    if (!finished) r.Fail("deadline");
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    if (!QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr)) r.Fail("job-accounting");
    else { r.jobTotal = accounting.TotalProcesses; r.jobActive = accounting.ActiveProcesses; r.normalDrain = finished && !r.jobActive; }
    ValidateLedger(r); // Must run before KILL_ON_JOB_CLOSE cleanup.
    r.forced = r.jobActive != 0;
    if (r.forced && !TerminateJobObject(job.value, 96)) r.Fail("job-cleanup");
    const auto cleanupAt = Stamp();
    while (Elapsed(Stamp(), cleanupAt) < 2000) {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION cleanupAccounting{};
        const bool queried = QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation, &cleanupAccounting, sizeof(cleanupAccounting), nullptr) != FALSE;
        if (!queried) r.Fail("job-cleanup");
        auto signaled = [&](HANDLE pin) {
            const auto wait = WaitForSingleObject(pin, 0);
            if (wait != WAIT_OBJECT_0 && wait != WAIT_TIMEOUT) r.Fail("cleanup-wait");
            return wait == WAIT_OBJECT_0;
        };
        bool done = queried && !cleanupAccounting.ActiveProcesses && signaled(root.value);
        for (const auto& row : r.rows) if (row.pin && !signaled(row.pin)) done = false;
        if (done) { r.cleanup = true; break; }
        DEBUG_EVENT event{};
        if (WaitForDebugEvent(&event, 10)) {
            if (event.dwDebugEventCode == CREATE_PROCESS_DEBUG_EVENT) { Handle image(event.u.CreateProcessInfo.hFile); Close(image, "image-close"); }
            if (event.dwDebugEventCode == LOAD_DLL_DEBUG_EVENT) { Handle image(event.u.LoadDll.hFile); Close(image, "image-close"); }
            if (!ContinueDebugEvent(event.dwProcessId, event.dwThreadId,
                event.dwDebugEventCode == EXCEPTION_DEBUG_EVENT ? DBG_EXCEPTION_NOT_HANDLED : DBG_CONTINUE)) { r.Fail("debug-continue"); break; }
        } else if (GetLastError() != ERROR_SEM_TIMEOUT) { r.Fail("debug-wait"); break; }
    }
    Close(job, "root-cleanup"); Close(root, "root-cleanup");
    for (auto& row : r.rows) if (row.pin) { if (CloseHandle(row.pin)) ++r.closed; else r.Fail("pin-close"); row.pin = nullptr; }
    if (!r.cleanup || r.closed != r.duplicates) r.Fail("cleanup");
    if (options.samples) {
        const auto reason = r.failures.empty() ? 0 : 3;
        if (!WriteBounded(options.samples, "{\"kind\":1,\"reason\":" + std::to_string(reason) +
            ",\"samples\":" + std::to_string(r.samples) + ",\"failureStage\":\"" +
            (reason == 0 ? "none" : "sample") + "\"}\n", true)) r.Fail("sample-footer");
    }
    return r;
}
inline std::string Ledger(const Result& r) {
    std::string out = "{\"kind\":0,\"schemaVersion\":1,\"rootPid\":" + std::to_string(r.rootPid) +
        ",\"rootTicks\":" + std::to_string(r.rootTicks) + ",\"launcherPid\":" + std::to_string(GetCurrentProcessId()) +
        ",\"launcherTicks\":" + std::to_string(r.launcherTicks) + ",\"launchTimestamp\":" + std::to_string(r.launch) +
        ",\"readyBeforeResume\":" + (r.ready ? "true" : "false") + ",\"tokenElevated\":" + (r.tokenElevated ? "true" : "false") +
        ",\"debugPrivilegeEnabled\":" + (r.debugPrivilegeEnabled ? "true" : "false") + "}\n";
    for (const auto& event : r.ledger) {
        const auto& row = r.rows[event.row];
        out += "{\"kind\":" + std::to_string(event.birth ? 1 : 2) + ",\"seq\":" + std::to_string(event.seq) +
            ",\"pid\":" + std::to_string(row.pid) + ",\"ticks\":" + std::to_string(row.ticks);
        if (event.birth) out += ",\"parentPid\":" + std::to_string(row.parent) + ",\"parentTicks\":" + std::to_string(row.parentTicks) +
            ",\"role\":\"" + row.role + "\",\"inJob\":" + (row.inJob ? "true" : "false");
        else out += ",\"exitTicks\":" + std::to_string(row.exitTicks) + ",\"eventCode\":" + std::to_string(static_cast<LONG>(row.eventCode)) +
            ",\"exitCode\":" + (row.exitProven ? std::to_string(static_cast<LONG>(row.exitCode)) : "null") +
            ",\"waitResult\":" + std::to_string(row.waitResult) + ",\"outcome\":\"" + row.outcome +
            "\",\"nativeError\":" + (row.waitResult == WAIT_FAILED ? std::to_string(row.waitError) : "null");
        out += "}\n";
    }
    out += "{\"kind\":3,\"births\":" + std::to_string(r.births) + ",\"exits\":" + std::to_string(r.exits) +
        ",\"sequence\":" + std::to_string(r.sequence) + ",\"debugEvents\":" + std::to_string(r.events) +
        ",\"jobTotal\":" + std::to_string(r.jobTotal) + ",\"jobActive\":" + std::to_string(r.jobActive) +
        ",\"normalDrain\":" + (r.normalDrain ? "true" : "false") + ",\"cleanup\":" + (r.cleanup ? "true" : "false") +
        ",\"forced\":" + (r.forced ? "true" : "false") + ",\"duplicates\":" + std::to_string(r.duplicates) + ",\"closed\":" + std::to_string(r.closed) +
        ",\"rootExitCode\":" + (r.rootProven ? std::to_string(static_cast<LONG>(r.rootCode)) : "null") +
        ",\"rootExitElapsedMs\":" + (r.rootProven ? std::to_string(r.rootExitElapsedMs) : "null") + ",\"failures\":[";
    for (size_t i = 0; i < r.failures.size(); ++i) out += (i ? ",\"" : "\"") + std::string(r.failures[i]) + "\"";
    return out + "]}\n";
}
} // namespace owned
