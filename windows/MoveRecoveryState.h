#pragma once
#include <cstdint>
#include <string>
#include <string_view>

namespace morrow {
struct MoveRecoveryScope {
    std::wstring owner, viewOwner, connection;
    uint64_t generation = 0;
    bool accepts(MoveRecoveryScope const& current) const {
        return !owner.empty() && owner != L"all" && !connection.empty()
            && owner == current.owner && viewOwner == current.viewOwner
            && connection == current.connection && generation == current.generation;
    }
};
struct MoveRecoveryReviewKey {
    std::wstring owner, operation, reference, connection;
    bool matches(MoveRecoveryReviewKey const& current) const {
        return !owner.empty() && owner != L"all" && !operation.empty() && !reference.empty() && !connection.empty()
            && owner == current.owner && operation == current.operation && reference == current.reference && connection == current.connection;
    }
};
inline bool moveRecoveryStatusValid(std::wstring_view status) {
    return status == L"uncertain" || status == L"partial" || status == L"providerComplete"
        || status == L"completed" || status == L"resolved";
}
inline bool moveRecoveryIsOpen(std::wstring_view status) {
    return status == L"uncertain" || status == L"partial" || status == L"providerComplete";
}
inline bool moveRecoveryFinishAllowed(std::wstring_view owner, std::wstring_view operationOwner,
    std::wstring_view currentConnection, std::wstring_view operationConnection, std::wstring_view status,
    std::wstring_view operationRef, std::wstring_view reviewRef, std::wstring_view action, bool allowed) {
    return !owner.empty() && owner != L"all" && owner == operationOwner && !currentConnection.empty()
        && currentConnection == operationConnection && moveRecoveryIsOpen(status) && !operationRef.empty() && !reviewRef.empty()
        && (action == L"completeMove" || action == L"applyConfirmedResult") && allowed;
}
}
