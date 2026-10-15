#pragma once
#include <cstdint>

namespace morrow::reader_diagnostics {
// Fixed fixture metadata only. No exception messages, document data or paths.
enum class Stage { EnvironmentOptions, EnvironmentCreate, ControllerOptions, ControllerEnsure, CorePolicy, Handlers, InitialRender };
enum class Origin { StartupTimeout, Hresult, Exception };

inline char const* name(Stage stage) noexcept {
    switch (stage) {
    case Stage::EnvironmentOptions: return "environment-options";
    case Stage::EnvironmentCreate: return "environment-create";
    case Stage::ControllerOptions: return "controller-options";
    case Stage::ControllerEnsure: return "controller-ensure";
    case Stage::CorePolicy: return "core-policy";
    case Stage::Handlers: return "handlers";
    case Stage::InitialRender: return "initial-render";
    }
    return "invalid";
}
inline char const* name(Origin origin) noexcept {
    switch (origin) {
    case Origin::StartupTimeout: return "startup-timeout";
    case Origin::Hresult: return "hresult";
    case Origin::Exception: return "exception";
    }
    return "invalid";
}

struct FirstFailure {
    bool recorded = false;
    Origin origin = Origin::Exception;
    Stage stage = Stage::EnvironmentOptions;
    uint32_t hresult = 0;
    uint64_t elapsedMs = 0;

    bool record(Origin cause, Stage at, uint32_t code, uint64_t elapsed) noexcept {
        if (recorded) return false;
        recorded = true; origin = cause; stage = at; hresult = code; elapsedMs = elapsed;
        return true;
    }
};
}
