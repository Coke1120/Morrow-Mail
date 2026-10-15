import Foundation

struct FolderSyncVersions: Equatable {
    let connection: JSON
    let selection: JSON
    init(_ snapshot: JSON) { connection = snapshot["connectionVersion"]; selection = snapshot["selectionVersion"] }
}

// A response may be the same successful write already seen by a state refresh.
// It may not roll back a different connection or newer saved selection.
func folderSyncVersionsCurrent(_ captured: FolderSyncVersions, _ latest: FolderSyncVersions,
                               response: FolderSyncVersions? = nil) -> Bool {
    latest == captured || response == latest
}

// The editable selection belongs to one saved server snapshot, never the
// globally selected mailbox. Reloading is explicit and cannot replace edits.
struct FolderSyncSelection {
    let owner: String
    private(set) var snapshot: JSON = .null
    private(set) var selected: Set<String> = []
    private(set) var baseline: Set<String> = []
    var reviewedBaseline = false

    var rows: [JSON] { snapshot["folders"].array }
    var loaded: Bool { snapshot.isObject }
    var supported: Bool { snapshot["supported"].bool }
    var dirty: Bool { selected != baseline }
    var limit: Int { 20 }
    var needsBaseline: Bool { rows.contains { selected.contains($0["folderId"].string) && $0["recoveryAction"].string == "reselect" } }
    var canSave: Bool {
        loaded && supported && selected.count <= limit && (dirty || needsBaseline) && (!needsBaseline || reviewedBaseline)
            && (selected.isEmpty || snapshot["catalogFresh"].bool && selected.allSatisfy { id in rows.contains { $0["folderId"].string == id && $0["available"].bool } })
    }
    var canSync: Bool { loaded && supported && !dirty && !needsBaseline && !baseline.isEmpty }
    var payload: JSON {
        .object(["folderIds": .array(selected.sorted().map(JSON.string)), "selectionVersion": snapshot["selectionVersion"], "connectionVersion": snapshot["connectionVersion"]])
    }
    var syncPayload: JSON {
        .object(["folderSyncSelectionVersion": snapshot["selectionVersion"], "folderSyncConnectionVersion": snapshot["connectionVersion"]])
    }
    func retryPayload(_ row: JSON) -> JSON? {
        guard loaded, !dirty, !needsBaseline, row["selected"].bool, row["selectionId"].nonempty,
              row["recoveryAction"].string == "retry", rows.contains(row) else { return nil }
        return .object(["selectionId": row["selectionId"], "selectionVersion": snapshot["selectionVersion"], "connectionVersion": snapshot["connectionVersion"]])
    }
    @discardableResult mutating func adopt(_ value: JSON) -> Bool {
        guard !dirty, value["accountId"].string == owner, !owner.isEmpty, owner != "all",
              value["connectionVersion"].nonempty, case .string = value["selectionVersion"],
              case .array(let rows) = value["folders"],
              rows.allSatisfy({ $0["folderId"].nonempty }),
              Set(rows.map { $0["folderId"].string }).count == rows.count else { return false }
        snapshot = value
        baseline = Set(rows.filter { $0["selected"].bool }.map { $0["folderId"].string })
        selected = baseline; reviewedBaseline = false
        return true
    }
    mutating func select(_ id: String, _ value: Bool) {
        guard let row = rows.first(where: { $0["folderId"].string == id }) else { return }
        if value { guard row["available"].bool, selected.count < limit else { return }; selected.insert(id) }
        else { selected.remove(id) }
        reviewedBaseline = false
    }
    mutating func deselectAll() { selected = []; reviewedBaseline = false }
    mutating func discard() { selected = baseline; reviewedBaseline = false }
    // A successful write may replace the baseline only after its captured
    // owner/operation/connection checks have passed in the native view.
    mutating func saved(_ value: JSON) -> Bool {
        var next = FolderSyncSelection(owner: owner)
        guard next.adopt(value) else { return false }
        self = next; return true
    }
}

func folderSyncStatus(_ row: JSON) -> String {
    switch row["status"].string {
    case "unselected": return "Not selected"
    case "queued": return "Waiting for a sync"
    case "current": return "Last bounded check caught up"
    case "catching_up": return "More new mail to download"
    case "retry": return "Retry pending"
    case "blocked": return "Needs attention"
    default: return "Status not recorded"
    }
}

func folderSyncTimes(_ row: JSON) -> String {
    [("Last attempt", "lastAttemptAt"), ("Last successful check", "lastSuccessfulSyncAt"), ("Last caught up", "lastCaughtUpAt")]
        .map { title, key in "\(title): \(row[key].nonempty ? dateLabel(row[key].string) : "Not recorded")" }.joined(separator: "\n")
}

func folderSyncContextCurrent(owner: String, scope: String, connection: JSON, ticket: UInt64,
                              active: Bool, currentScope: String, accounts: [JSON], operation: UInt64) -> Bool {
    active && ticket == operation && scope == currentScope
        && accounts.contains { $0.id == owner && $0["settings"] == connection }
}
