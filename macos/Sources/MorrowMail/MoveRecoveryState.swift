import Foundation

// These refs authorize only the saved journal entry. They are never derived
// from the globally selected message or regenerated after a failed request.
struct MoveRecoveryContext: Equatable {
    let owner: String
    let viewOwner: String
    let section: String
    let connection: JSON
    let presentationID: String
    func accepts(_ current: MoveRecoveryContext) -> Bool {
        !owner.isEmpty && owner != "all" && !presentationID.isEmpty && !moveRecoveryConnectionRef(connection).isEmpty && self == current
    }
}

func moveRecoveryConnectionRef(_ settings: JSON) -> String {
    let value = settings["moveConnectionRef"]
    return value.nonempty && value.string.utf16.count <= 1024 ? value.string : ""
}

func validMoveRecoveryOperation(_ value: JSON, owner: String) -> Bool {
    let fields = ["id", "accountId", "connectionRef", "operationRef", "messageId", "subject", "sourceName", "targetName", "stage", "status", "diagnosticCode", "diagnostic"]
    return value.isObject && value["accountId"].string == owner && !owner.isEmpty && owner != "all"
        && fields.allSatisfy { if case .string(let text) = value[$0] { return text.utf16.count <= 8192 }; return false }
        && ["id", "connectionRef", "operationRef", "messageId"].allSatisfy { value[$0].nonempty && value[$0].string.utf16.count <= 1024 }
        && ["uncertain", "partial", "providerComplete", "completed", "resolved"].contains(value["status"].string)
        && ["canPreview", "canResolve"].allSatisfy { if case .bool = value[$0] { return true }; return false }
}

func validMoveRecoverySnapshot(_ value: JSON, owner: String) -> Bool {
    guard value["accountId"].string == owner, value["connectionRef"].nonempty, value["connectionRef"].string.utf16.count <= 1024,
          case .array(let entries) = value["operations"], entries.count <= 120 else { return false }
    return entries.allSatisfy { validMoveRecoveryOperation($0, owner: owner) }
        && Set(entries.map(\.id)).count == entries.count
}

func moveRecoveryIsOpen(_ value: JSON) -> Bool { ["uncertain", "partial", "providerComplete"].contains(value["status"].string) }

func moveRecoveryReviewMatches(_ reviewed: JSON, saved: JSON, selectedID: String, owner: String) -> Bool {
    validMoveRecoveryOperation(reviewed, owner: owner) && validMoveRecoveryOperation(saved, owner: owner)
        && reviewed.id == selectedID && saved.id == selectedID && reviewed["operationRef"] == saved["operationRef"]
        && reviewed["connectionRef"] == saved["connectionRef"]
}

func moveRecoveryFinishAction(_ value: JSON, owner: String, connectionRef: String) -> String? {
    guard validMoveRecoveryOperation(value, owner: owner), !connectionRef.isEmpty,
          value["connectionRef"].string == connectionRef, value["canFinish"] == .bool(true),
          value["reviewRef"].nonempty, moveRecoveryIsOpen(value),
          ["completeMove", "applyConfirmedResult"].contains(value["finishAction"].string) else { return nil }
    return value["finishAction"].string
}

func moveRecoveryStatus(_ value: JSON) -> String {
    switch value["status"].string {
    case "uncertain": return "Result uncertain"
    case "partial": return "Partially completed"
    case "providerComplete": return "Provider move confirmed; local update pending"
    case "completed": return "Move completed"
    case "resolved": return "Marked resolved by you"
    default: return "Status unavailable"
    }
}

func moveRecoveryConfirmation(_ value: JSON, owner: String, action: String) -> String {
    let facts = "Mailbox: \(owner)\nSubject: \(value["subject"].string)\nFrom folder: \(value["sourceName"].string)\nTo folder: \(value["targetName"].string)\n\n\(value["diagnostic"].string)"
    if action == "resolve" {
        return facts + "\n\nConfirm only after reviewing and resolving this move in your mail provider. This records your decision locally. It does not move, delete, copy or verify mail at the provider."
    }
    if action == "completeMove" {
        return facts + "\n\nThe checked destination copy is present. Morrow will recheck both folders, then remove only this original message from the source folder and update its local location. It will not copy the message again."
    }
    return facts + "\n\nThe provider move was checked. Morrow will recheck the saved source and destination identities, then apply the confirmed location locally. It will not copy or delete mail."
}

func moveRecoveryFailure(_ payload: JSON, owner: String) -> String? {
    guard payload["code"].string == "imap_move_unresolved", payload["accountId"].string == owner,
          !owner.isEmpty, owner != "all", payload["operationId"].nonempty, payload["operationId"].string.utf16.count <= 1024 else { return nil }
    return payload["operationId"].string
}
