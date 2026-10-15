#pragma once
#include <algorithm>
#include <cstdint>
#include <string_view>

namespace morrow::reader_diagnostics {
// Pure fixture bookkeeping. These values never control navigation or deadlines.
enum class Receipt { Record, Overflow, Suppress };
struct DetailBudget {
    static constexpr unsigned limit = 24;
    unsigned used = 0;
    Receipt take() noexcept {
        if (used < limit) { ++used; return Receipt::Record; }
        if (used == limit) { ++used; return Receipt::Overflow; }
        return Receipt::Suppress;
    }
};
enum class Completion { Environment, Controller, Handlers, Render };
inline char const* name(Completion value) noexcept {
    switch (value) {
    case Completion::Environment: return "environment-returned";
    case Completion::Controller: return "controller-returned";
    case Completion::Handlers: return "handlers-installed";
    case Completion::Render: return "render-returned";
    }
    return "invalid";
}
enum class DocumentEvent { Start, Decision, ContentLoading, DomLoaded, Completed };
inline char const* name(DocumentEvent value) noexcept {
    switch (value) {
    case DocumentEvent::Start: return "start";
    case DocumentEvent::Decision: return "decision";
    case DocumentEvent::ContentLoading: return "content-loading";
    case DocumentEvent::DomLoaded: return "dom-loaded";
    case DocumentEvent::Completed: return "completed";
    }
    return "invalid";
}
enum class DocumentOutcome { Observed, Allowed, Cancelled, Normal, ErrorPage, Success, Failure };
inline char const* name(DocumentOutcome value) noexcept {
    switch (value) {
    case DocumentOutcome::Observed: return "observed";
    case DocumentOutcome::Allowed: return "allowed";
    case DocumentOutcome::Cancelled: return "cancelled";
    case DocumentOutcome::Normal: return "normal";
    case DocumentOutcome::ErrorPage: return "error-page";
    case DocumentOutcome::Success: return "success";
    case DocumentOutcome::Failure: return "failure";
    }
    return "invalid";
}
enum class WaitPhase { MountLoaded, Environment, ControllerReady, InitialDocument };
inline char const* name(WaitPhase value) noexcept {
    switch (value) {
    case WaitPhase::MountLoaded: return "mount-loaded";
    case WaitPhase::Environment: return "environment";
    case WaitPhase::ControllerReady: return "controller-ready";
    case WaitPhase::InitialDocument: return "initial-document";
    }
    return "invalid";
}
enum class WaitOutcome { ConditionMet, Deadline, Cancelled, Aborted };
inline char const* name(WaitOutcome value) noexcept {
    switch (value) {
    case WaitOutcome::ConditionMet: return "condition-met";
    case WaitOutcome::Deadline: return "deadline";
    case WaitOutcome::Cancelled: return "cancelled";
    case WaitOutcome::Aborted: return "aborted";
    }
    return "invalid";
}
enum class ObservationFailure { EventRead, ContentSubscription, DomSubscription };
inline char const* name(ObservationFailure value) noexcept {
    switch (value) {
    case ObservationFailure::EventRead: return "event-read";
    case ObservationFailure::ContentSubscription: return "content-loading-subscribe";
    case ObservationFailure::DomSubscription: return "dom-loaded-subscribe";
    }
    return "invalid";
}
struct WaitMetrics {
    static constexpr unsigned iterationLimit = 10000;
    unsigned iterations = 0;
    uint64_t maxResumeGapMs = 0;
    bool overflow = false;
    void poll() noexcept {
        if (iterations < iterationLimit) ++iterations;
        else overflow = true;
    }
    void resumed(uint64_t suspendedAt, uint64_t resumedAt) noexcept {
        if (resumedAt < suspendedAt) { overflow = true; return; }
        maxResumeGapMs = std::max(maxResumeGapMs, resumedAt - suspendedAt);
    }
};
inline bool validRuntimeVersion(std::wstring_view value) noexcept {
    if (value.empty() || value.size() > 64) return false;
    size_t at = 0;
    for (unsigned component = 0; component < 4; ++component) {
        size_t begin = at;
        while (at < value.size() && value[at] >= L'0' && value[at] <= L'9') ++at;
        if (at == begin || at - begin > 10) return false;
        if (component != 3 && (at == value.size() || value[at++] != L'.')) return false;
    }
    auto suffix = value.substr(at);
    return suffix.empty() || suffix == L" beta" || suffix == L" dev" || suffix == L" canary";
}
}
