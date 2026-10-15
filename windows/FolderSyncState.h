#pragma once
#include <map>
#include <set>
#include <string>
#include <utility>

namespace morrow {
struct FolderSyncVersions {
    std::wstring connection, selection;
    bool operator==(FolderSyncVersions const&) const = default;
};
// Accept the same successful write already observed by a state refresh, but
// never replace a different connection or newer selection with a late response.
inline bool folderSyncVersionsCurrent(FolderSyncVersions const& captured, FolderSyncVersions const& latest,
    FolderSyncVersions const* response = nullptr) {
    return latest == captured || (response && latest == *response);
}
// Native editor state is deliberately independent of the current shell owner.
// The service validates the two captured versions again before any mutation.
struct FolderSyncRow {
    std::wstring id, name, selectionId, status, recovery, error, warning;
    std::wstring attempted, successful, caughtUp, nextRetry;
    bool selected = false, available = false;
};
struct FolderSyncSnapshot {
    std::wstring owner, connection, version;
    std::map<std::wstring, FolderSyncRow> rows;
    bool supported = false, fresh = false, automatic = false;
    unsigned interval = 0;
};
struct FolderSyncSelection {
    std::wstring owner;
    FolderSyncSnapshot snapshot;
    std::set<std::wstring> selected, baseline;
    bool loaded = false, reviewedBaseline = false;
    explicit FolderSyncSelection(std::wstring account) : owner(std::move(account)) {}
    bool dirty() const { return selected != baseline; }
    bool needsBaseline() const {
        for (auto const& id : selected) {
            auto row = snapshot.rows.find(id);
            if (row != snapshot.rows.end() && row->second.recovery == L"reselect") return true;
        }
        return false;
    }
    bool canSave() const {
        if (!loaded || !snapshot.supported || selected.size() > 20 || (!dirty() && !needsBaseline())
            || (needsBaseline() && !reviewedBaseline)) return false;
        if (selected.empty()) return true; // Stale catalogs must still allow cancelling all selections.
        if (!snapshot.fresh) return false;
        for (auto const& id : selected) {
            auto row = snapshot.rows.find(id);
            if (row == snapshot.rows.end() || !row->second.available) return false;
        }
        return true;
    }
    bool canSync() const { return loaded && snapshot.supported && !dirty() && !needsBaseline() && !baseline.empty(); }
    bool canRetry(std::wstring const& id) const {
        auto row = snapshot.rows.find(id);
        return loaded && !dirty() && !needsBaseline() && row != snapshot.rows.end()
            && row->second.selected && !row->second.selectionId.empty() && row->second.recovery == L"retry";
    }
    bool adopt(FolderSyncSnapshot const& value) {
        if (dirty() || owner.empty() || owner == L"all" || value.owner != owner || value.connection.empty()) return false;
        std::set<std::wstring> next;
        for (auto const& [id, row] : value.rows) {
            if (id.empty() || row.id != id) return false;
            if (row.selected) next.insert(id);
        }
        snapshot = value; baseline = next; selected = next; loaded = true; reviewedBaseline = false;
        return true;
    }
    bool saved(FolderSyncSnapshot const& value) {
        FolderSyncSelection next(owner);
        if (!next.adopt(value)) return false;
        *this = std::move(next); return true;
    }
    void select(std::wstring const& id, bool value) {
        auto row = snapshot.rows.find(id);
        if (row == snapshot.rows.end()) return;
        if (value) {
            if (!row->second.available || selected.size() >= 20) return;
            selected.insert(id);
        } else selected.erase(id);
        reviewedBaseline = false;
    }
    void discard() { selected = baseline; reviewedBaseline = false; }
    void deselectAll() { selected.clear(); reviewedBaseline = false; }
};
inline std::wstring folderSyncStatus(FolderSyncRow const& row) {
    if (row.status == L"unselected") return L"Not selected";
    if (row.status == L"queued") return L"Waiting for a sync";
    if (row.status == L"current") return L"Last bounded check caught up";
    if (row.status == L"catching_up") return L"More new mail to download";
    if (row.status == L"retry") return L"Retry pending";
    if (row.status == L"blocked") return L"Needs attention";
    return L"Status not recorded";
}
}
