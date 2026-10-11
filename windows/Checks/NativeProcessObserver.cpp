#include "OwnedProcessObserver.h"
#include <fcntl.h>
#include <io.h>
#pragma comment(lib, "advapi32.lib")

// The caller creates two protected, empty regular files inside its marked
// disposable fixture. This helper never creates/truncates or follows a reparse.
static FILE* OpenReport(const wchar_t* path) {
    owned::Handle file(CreateFileW(path, GENERIC_WRITE, FILE_SHARE_READ, nullptr,
        OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    BY_HANDLE_FILE_INFORMATION info{};
    if (file.value == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(file.value, &info) ||
        (info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) || info.nFileSizeHigh || info.nFileSizeLow) return nullptr;
    const auto handle = reinterpret_cast<intptr_t>(file.value); file.value = nullptr;
    const auto descriptor = _open_osfhandle(handle, _O_WRONLY | _O_BINARY);
    if (descriptor == -1) { CloseHandle(reinterpret_cast<HANDLE>(handle)); return nullptr; }
    auto stream = _fdopen(descriptor, "wb");
    if (!stream) _close(descriptor);
    return stream;
}
int wmain(int argc, wchar_t** argv) {
    if (argc != 5) return 98;
    wchar_t* end{};
    const auto launch = _wcstoi64(argv[4], &end, 10);
    if (!launch || *end || launch > owned::Stamp() || owned::Elapsed(owned::Stamp(), launch) >= 180000) return 98;
    auto sample = OpenReport(argv[2]); auto ledger = OpenReport(argv[3]);
    if (!sample || !ledger) { if (sample) std::fclose(sample); if (ledger) std::fclose(ledger); return 98; }
    owned::Options options; options.exe = argv[1]; options.arguments = L"--native-smoke"; options.launch = launch; options.samples = sample;
    auto result = owned::Run(options);
    const auto text = owned::Ledger(result);
    const bool written = text.size() <= 32768 && owned::WriteBounded(ledger, text, true);
    const bool closedSample = std::fclose(sample) == 0; const bool closedLedger = std::fclose(ledger) == 0;
    if (!result.rootProven || !result.cleanup || !written || !closedSample || !closedLedger) return 98;
    // UI status stays separate from the strict observer result. A missing birth,
    // counter failure or nonzero child still rejects the report/footer/ledger.
    return static_cast<int>(result.rootCode);
}
