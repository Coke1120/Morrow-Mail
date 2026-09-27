import SwiftUI
import AppKit

struct NativeCalendarView: View {
    @EnvironmentObject var model: AppModel
    @AppStorage("calendarVisibility") private var savedVisibility = "{}"
    @State private var calendars: [CalendarSource] = []
    @State private var visibility: [String: Bool] = [:]
    @State private var events: [CalendarEntry] = []
    @State private var month = Date()
    @State private var selectedDate = Calendar.current.startOfDay(for: Date())
    @State private var connectionErrors = ""
    @State private var eventErrors: [String: String] = [:]
    @State private var selectionNotice = ""
    @State private var pendingError = ""
    @State private var draft: CalendarDraft?
    @State private var pending: CalendarDraft?
    @State private var loaded = false
    @State private var loading = false
    @State private var loadingCalendars = false
    @State private var completedCalendars = 0
    @State private var readTask: Task<Void, Never>?
    @State private var generation = UUID()
    private let calendar = Calendar.current
    private let maximumChecked = 12
    private var grid: CalendarMonth { CalendarMonth(containing: month, calendar: calendar) }
    private var checked: [CalendarSource] { calendars.filter { visibility[$0.preferenceKey] == true } }
    private var writable: [CalendarSource] { checked.filter { $0.canWrite && !$0.email.isEmpty } }
    private var canCreate: Bool { !model.busy && !loadingCalendars && pending == nil && pendingError.isEmpty && !writable.isEmpty }
    private var agenda: [CalendarEntry] {
        guard let day = calendar.dateInterval(of: .day, for: selectedDate) else { return [] }
        return events.filter { $0.overlaps(day) }
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    SectionHeading(title: "Calendar", detail: "\(TimeZone.current.identifier) · Google and Outlook calendars")
                    Spacer()
                    Button("Connections") { model.settings("calendar") }.disabled(model.busy)
                    Button("Refresh") { readMonth(reloadCalendars: true) }.disabled(loadingCalendars)
                }
                if let pending {
                    GroupBox {
                        HStack {
                            Label("An event request needs your review before creating another.", systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                            Spacer()
                            Button("Review Pending Request") { draft = pending }.disabled(model.busy)
                        }.padding(8)
                    }
                }
                if !pendingError.isEmpty { Text(pendingError).foregroundStyle(.red).textSelection(.enabled) }
                if !connectionErrors.isEmpty { Text(connectionErrors).foregroundStyle(.orange).textSelection(.enabled) }
                if calendars.isEmpty {
                    Text(loaded ? "No calendars available. Connect a calendar in Settings or refresh its permissions." : "Loading calendars…").foregroundStyle(.secondary)
                } else { calendarChoices }
                monthNavigation
                monthGrid
                if loading {
                    HStack { ProgressView().controlSize(.small); Text(loadingCalendars ? "Loading calendars…" : "Loading checked calendars · \(completedCalendars) of \(checked.count)").foregroundStyle(.secondary) }
                }
                ForEach(checked.filter { eventErrors[$0.id] != nil }) { source in
                    Label("\(providerLabel(source.provider)) · \(source.name): \(eventErrors[source.id] ?? "")", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange).textSelection(.enabled)
                }
                if !eventErrors.isEmpty || !connectionErrors.isEmpty {
                    Text("Some calendars could not be loaded. The month and agenda may be incomplete; refresh to try again.").font(.callout).foregroundStyle(.orange)
                }
                Divider()
                HStack {
                    Text(selectedDate.formatted(date: .complete, time: .omitted)).font(.title3.bold())
                    Spacer()
                }
                if writable.isEmpty && !calendars.isEmpty {
                    Text("Check a writable calendar to create an event. Read-only calendars can still be viewed.").font(.caption).foregroundStyle(.secondary)
                }
                if checked.isEmpty {
                    Text("Check calendars above to show their events.").foregroundStyle(.secondary)
                } else if agenda.isEmpty {
                    Text(loading ? "Events are still loading for this day." : eventErrors.isEmpty && connectionErrors.isEmpty ? "No events on this day in the checked calendars." : "No events available for this day from the calendars that loaded.").foregroundStyle(.secondary)
                } else {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(agenda) { event in agendaRow(event) }
                    }
                }
                Text("Calendar events are separate from AI Studio’s simulated schedules. These reads do not use AI.").font(.caption).foregroundStyle(.secondary)
            }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
        }
        .onAppear { readMonth(reloadCalendars: true) }
        .onDisappear { readTask?.cancel(); generation = UUID() }
        .onChange(of: model.showSettings) { showing in if !showing { readMonth(reloadCalendars: true) } }
        .sheet(item: $draft, onDismiss: { readMonth(reloadCalendars: true) }) { value in
            CalendarEditor(initial: value, calendars: writable).environmentObject(model)
        }
    }
    private var calendarChoices: some View {
        GroupBox("Show calendars") {
            VStack(alignment: .leading, spacing: 8) {
                ScrollView {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 280), alignment: .leading)], alignment: .leading, spacing: 9) {
                        ForEach(calendars) { source in
                            HStack {
                                Toggle(isOn: Binding(get: { visibility[source.preferenceKey] == true }, set: { setChecked(source, $0) })) {
                                    HStack(spacing: 7) {
                                        Circle().fill(calendarColor(source)).frame(width: 9, height: 9).accessibilityHidden(true)
                                        Text(source.name)
                                        Text("\(providerLabel(source.provider)) · \(source.email)\(source.canWrite ? "" : " · Read-only")").font(.caption).foregroundStyle(.secondary)
                                    }
                                }.toggleStyle(.checkbox)
                                Spacer(minLength: 0)
                            }
                        }
                    }.padding(4)
                }.frame(height: min(CGFloat(calendars.count), 3) * 28)
                Text(selectionNotice.isEmpty ? "Choose up to \(maximumChecked) calendars. Your choices are saved on this Mac." : selectionNotice)
                    .font(.caption).foregroundStyle(.secondary)
            }.padding(6)
        }
    }
    private var monthNavigation: some View {
        HStack {
            Button { moveMonth(-1) } label: { Image(systemName: "chevron.left") }.help("Previous month").accessibilityLabel("Previous month")
            Button("Today") { selectedDate = calendar.startOfDay(for: Date()); month = selectedDate; readMonth() }
            Button { moveMonth(1) } label: { Image(systemName: "chevron.right") }.help("Next month").accessibilityLabel("Next month")
            Text(month.formatted(.dateTime.month(.wide).year())).font(.title2.bold()).accessibilityAddTraits(.isHeader)
            Spacer()
            Button { newEvent() } label: { Label("New Event", systemImage: "plus") }
                .buttonStyle(.borderedProminent).disabled(!canCreate)
        }
    }
    private var monthGrid: some View {
        let month = grid
        let formatter = DateFormatter()
        formatter.calendar = calendar; formatter.locale = .current
        let symbols = formatter.shortStandaloneWeekdaySymbols!
        let fullSymbols = formatter.standaloneWeekdaySymbols!
        // Parse events only once on receipt, then compare half-open day intervals.
        let byDay = Dictionary(uniqueKeysWithValues: month.days.map { day in
            let interval = calendar.dateInterval(of: .day, for: day)!
            return (day, events.filter { $0.overlaps(interval) })
        })
        return LazyVGrid(columns: Array(repeating: GridItem(.flexible(minimum: 0), spacing: 4), count: 7), spacing: 4) {
            ForEach(0..<7, id: \.self) { index in
                let weekday = (calendar.firstWeekday - 1 + index) % 7
                Text(symbols[weekday]).font(.caption.bold()).frame(maxWidth: .infinity)
                    .accessibilityLabel(fullSymbols[weekday])
            }
            ForEach(month.days, id: \.self) { day in
                dayCell(day, entries: byDay[day] ?? [], inMonth: day >= month.interval.start && day < month.interval.end)
            }
        }
    }
    private func dayCell(_ day: Date, entries: [CalendarEntry], inMonth: Bool) -> some View {
        let selected = calendar.isDate(day, inSameDayAs: selectedDate)
        return Button {
            selectedDate = day
            if !inMonth { month = day; readMonth() }
            newEvent()
        } label: {
            VStack(alignment: .leading, spacing: 3) {
                Text(day.formatted(.dateTime.day())).font(.headline)
                    .foregroundStyle(calendar.isDateInToday(day) ? morrowGreen : inMonth ? Color.primary : Color.secondary)
                ForEach(entries.prefix(2)) { event in
                    HStack(spacing: 3) {
                        Circle().fill(calendarColor(event.source)).frame(width: 5, height: 5)
                        Text(event.value["title"].string).font(.caption2).lineLimit(1)
                    }
                }
                if entries.count > 2 { Text("+\(entries.count - 2) more").font(.caption2).foregroundStyle(.secondary) }
                Spacer(minLength: 0)
            }.padding(7).frame(maxWidth: .infinity, alignment: .topLeading).frame(height: 80, alignment: .topLeading)
                .background(selected ? morrowGreen.opacity(0.15) : Color.primary.opacity(inMonth ? 0.035 : 0.015), in: RoundedRectangle(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(selected ? morrowGreen : Color.clear, lineWidth: 2))
                .contentShape(Rectangle())
        }.buttonStyle(.plain)
        .accessibilityLabel("\(day.formatted(date: .complete, time: .omitted)), \(entries.count) events\(loading ? ", loading" : "")")
        .accessibilityValue(selected ? "Selected" : "")
        .accessibilityHint("Show this day’s agenda and create an event")
    }
    private func agendaRow(_ event: CalendarEntry) -> some View {
        HStack(alignment: .top, spacing: 12) {
            RoundedRectangle(cornerRadius: 3).fill(calendarColor(event.source)).frame(width: 4)
            VStack(alignment: .leading, spacing: 5) {
                Text(event.value["title"].string).font(.headline)
                Text("\(event.source.name) · \(providerLabel(event.source.provider)) · \(event.source.email)").font(.caption).foregroundStyle(.secondary)
                if event.allDay {
                    let last = calendar.date(byAdding: .day, value: -1, to: event.end)!
                    Text(calendar.isDate(event.start, inSameDayAs: last) ? "All day · \(event.start.formatted(date: .abbreviated, time: .omitted))" : "All day · \(event.start.formatted(date: .abbreviated, time: .omitted)) – \(last.formatted(date: .abbreviated, time: .omitted))").foregroundStyle(.secondary)
                } else {
                    Text("\(event.start.formatted(date: .abbreviated, time: .shortened)) – \(event.end.formatted(date: .abbreviated, time: .shortened))").foregroundStyle(.secondary)
                }
                if event.value["location"].nonempty { Label(event.value["location"].string, systemImage: "mappin.and.ellipse").font(.callout) }
                if event.value["description"].nonempty { Text(event.value["description"].string).font(.callout).lineLimit(4) }
                if let url = URL(string: event.value["webUrl"].string), url.scheme == "https", url.host != nil, url.user == nil, url.password == nil {
                    Link("Open in \(providerLabel(event.source.provider))", destination: url).font(.callout)
                }
            }.textSelection(.enabled)
            Spacer(minLength: 0)
        }.padding(10).background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 8))
    }
    private func moveMonth(_ offset: Int) {
        guard let next = calendar.date(byAdding: .month, value: offset, to: grid.interval.start) else { return }
        month = next; selectedDate = next; readMonth()
    }
    private func newEvent() {
        guard canCreate, let source = writable.first(where: { $0.primary }) ?? writable.first else { return }
        draft = CalendarDraft(provider: source.provider, calendarID: source.calendarID, calendarName: source.name, email: source.email, day: selectedDate, calendar: calendar)
    }
    private func setChecked(_ source: CalendarSource, _ checked: Bool) {
        guard !checked || self.checked.count < maximumChecked else {
            selectionNotice = "Uncheck a calendar before selecting another (maximum \(maximumChecked))."; return
        }
        visibility[source.preferenceKey] = checked; selectionNotice = ""
        saveVisibility(); readMonth()
    }
    private func saveVisibility() {
        if let data = try? JSONEncoder().encode(visibility), let text = String(data: data, encoding: .utf8) { savedVisibility = text }
    }
    private func restoreVisibility() {
        visibility = (try? JSONDecoder().decode([String: Bool].self, from: Data(savedVisibility.utf8))) ?? [:]
        // Only a provider's primary (or first) calendar starts checked. New
        // secondary calendars stay unchecked; an explicit all-off choice stays off.
        for provider in ["google", "microsoft"] {
            let sources = calendars.filter { $0.provider == provider }
            let hasChoices = sources.contains { visibility[$0.preferenceKey] != nil }
            let initial = sources.first(where: { $0.primary }) ?? sources.first
            for source in sources where visibility[source.preferenceKey] == nil {
                visibility[source.preferenceKey] = !hasChoices && source.id == initial?.id
            }
        }
        for source in checked.dropFirst(maximumChecked) { visibility[source.preferenceKey] = false }
        saveVisibility()
    }
    private func readMonth(reloadCalendars: Bool = false) {
        let reloadCatalog = reloadCalendars || !loaded || loadingCalendars
        readTask?.cancel()
        let requestGeneration = UUID(); generation = requestGeneration
        let range = grid.visibleInterval
        // Two civil days of padding also cover all-day events in remote time
        // zones at the edges of the visible grid. Only visible days are rendered.
        let beginning = calendar.date(byAdding: .day, value: -2, to: range.start)!
        let ending = calendar.date(byAdding: .day, value: 2, to: range.end)!
        events = []; eventErrors = [:]; completedCalendars = 0; loading = true
        loadingCalendars = reloadCatalog
        do { pending = try CalendarDraft.pending(in: model.dataDirectory); pendingError = "" }
        catch { pendingError = "The pending event request could not be read. Resolve it before creating another event. " + error.localizedDescription }
        readTask = Task { @MainActor in
            defer { if generation == requestGeneration { loading = false; loadingCalendars = false } }
            // Coalesce rapid month/checkbox changes before starting provider reads.
            do { try await Task.sleep(nanoseconds: 150_000_000) } catch { return }
            guard !Task.isCancelled, generation == requestGeneration else { return }
            if reloadCatalog {
                do {
                    let result = try await model.request("/calendars", mailbox: "")
                    guard !Task.isCancelled, generation == requestGeneration else { return }
                    guard case .array(let values) = result["calendars"], values.count <= 1000 else { throw APIError("The calendar list was invalid or too large.") }
                    let sources = values.map { CalendarSource($0, connections: result["connections"].array) }
                    guard sources.allSatisfy({ ["google", "microsoft"].contains($0.provider) && !$0.calendarID.isEmpty }), Set(sources.map(\.id)).count == sources.count else {
                        throw APIError("The provider returned an invalid calendar list.")
                    }
                    calendars = sources.sorted { $0.provider == $1.provider ? $0.name.localizedStandardCompare($1.name) == .orderedAscending : $0.provider < $1.provider }
                    connectionErrors = result["errors"].array.map { providerLabel($0["provider"].string) + ": " + $0["message"].string }.joined(separator: "\n")
                    restoreVisibility(); loaded = true; loadingCalendars = false
                } catch {
                    guard !Task.isCancelled, generation == requestGeneration else { return }
                    calendars = []; loaded = true; connectionErrors = error.localizedDescription; return
                }
            }
            // At most twelve calendars, one bounded request at a time. Date
            // selection uses this snapshot and never creates another request.
            let selected = Array(checked.prefix(maximumChecked))
            for source in selected {
                guard !Task.isCancelled, generation == requestGeneration else { return }
                do {
                    var query = URLComponents()
                    query.queryItems = [URLQueryItem(name: "calendarId", value: source.calendarID), URLQueryItem(name: "start", value: utcDate(beginning)), URLQueryItem(name: "end", value: utcDate(ending))]
                    let result = try await model.request("/calendars/\(source.provider)/events?" + (query.percentEncodedQuery ?? ""), mailbox: "")
                    guard !Task.isCancelled, generation == requestGeneration else { return }
                    guard case .array(let values) = result["events"], values.count <= 1000 else { throw APIError("The event list was invalid or too large. View this calendar at its provider.") }
                    let entries = try values.filter { $0["status"].string != "cancelled" }.map { try CalendarEntry($0, source: source, calendar: calendar) }
                    guard Set(entries.map(\.id)).count == entries.count else { throw APIError("The provider returned duplicate events; this calendar could not be loaded completely.") }
                    events += entries.filter { $0.overlaps(range) }
                    events.sort { $0.start == $1.start ? $0.id < $1.id : $0.start < $1.start }
                } catch {
                    guard !Task.isCancelled, generation == requestGeneration else { return }
                    eventErrors[source.id] = error.localizedDescription
                }
                completedCalendars += 1
            }
        }
    }
}

private func calendarColor(_ source: CalendarSource) -> Color {
    if source.color.range(of: "^#[0-9a-fA-F]{6}$", options: .regularExpression) != nil, let rgb = UInt32(source.color.dropFirst(), radix: 16) {
        return Color(red: Double((rgb >> 16) & 255) / 255, green: Double((rgb >> 8) & 255) / 255, blue: Double(rgb & 255) / 255)
    }
    let palette: [Color] = [.blue, .orange, .purple, .green, .pink, .teal, .indigo]
    let index = source.id.utf8.reduce(0) { ($0 * 31 + Int($1)) % palette.count }
    return palette[index]
}

struct CalendarEditor: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) var dismiss
    let initial: CalendarDraft
    let calendars: [CalendarSource]
    @State private var draft: CalendarDraft
    @State private var reviewing: Bool
    @State private var error = ""
    init(initial: CalendarDraft, calendars: [CalendarSource] = []) {
        self.initial = initial; self.calendars = calendars
        _draft = State(initialValue: initial); _reviewing = State(initialValue: initial.attempted)
    }
    private var dirty: Bool { draft != initial && !draft.attempted }
    private var destination: String { draft.provider + ":" + encodedPath(draft.calendarID) }
    private var valid: Bool {
        var utc = Calendar(identifier: .gregorian); utc.timeZone = TimeZone(secondsFromGMT: 0)!
        return !draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && draft.title.count <= 300 && draft.location.count <= 1000 && draft.description.count <= 10000 && draft.end > draft.start && draft.end <= utc.date(byAdding: .day, value: 90, to: draft.start)! && (draft.reminder?.isValid(for: draft.provider) ?? true) && (draft.attempted || calendars.contains { $0.id == destination && $0.canWrite && $0.email == draft.email })
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            SectionHeading(title: reviewing ? "Review your event" : "Make time for it", detail: "\(providerLabel(draft.provider)) · \(draft.calendarName)\n\(draft.email)")
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if reviewing { review } else { fields }
                    Text("Reminders are managed by the calendar provider, including while Morrow is closed. Delivery depends on your provider’s notification settings.").font(.caption).foregroundStyle(.secondary)
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.frame(maxHeight: 440)
            if !error.isEmpty { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            HStack {
                Button(draft.attempted ? "Keep for Later" : "Cancel") { if !dirty || model.confirmDiscard() { dismiss() } }.keyboardShortcut(.cancelAction)
                if reviewing && !draft.attempted { Button("Edit") { reviewing = false } }
                if draft.attempted {
                    Button("Resolve…") {
                        if model.confirm("Resolve this pending request?", detail: "Confirm you checked the provider’s calendar. This forgets the pending request; it does not delete any event.") {
                            do { try CalendarDraft.clearPending(in: model.dataDirectory); dismiss() } catch { self.error = error.localizedDescription }
                        }
                    }
                }
                Spacer()
                if model.busy { ProgressView().controlSize(.small) }
                Button(reviewing ? (draft.attempted ? "Retry Same Request" : "Create Event") : "Review Event") {
                    if reviewing { create() } else { reviewing = true }
                }.buttonStyle(.borderedProminent).disabled(!valid)
            }
        }.padding(28).frame(width: 640).disabled(model.busy)
        .interactiveDismissDisabled(dirty || model.busy)
        .onChange(of: draft) { _ in model.dirty("calendar", dirty) }
        .onDisappear { model.dirty("calendar", false) }
    }
    private var review: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(draft.title).font(.title2.bold()).textSelection(.enabled)
            Text("\(draft.start.formatted(date: .complete, time: .shortened))\nUntil \(draft.end.formatted(date: .complete, time: .shortened))\n\(TimeZone.current.identifier)").foregroundStyle(.secondary)
            if !draft.location.isEmpty { Label(draft.location, systemImage: "mappin.and.ellipse") }
            if !draft.description.isEmpty { Text(draft.description).textSelection(.enabled) }
            Label(draft.reminder?.label ?? "Provider default reminder", systemImage: "bell")
            Text(draft.attempted ? "The previous result was not confirmed. This retry uses the same request ID, calendar, connection email and original details, including its reminder. Check your calendar before continuing." : "This creates a real event in the calendar above. No attendees or invitations will be added.").font(.callout).foregroundStyle(draft.attempted ? Color.orange : Color.secondary)
        }
    }
    private var fields: some View {
        VStack(alignment: .leading, spacing: 14) {
            Picker("Calendar", selection: Binding(get: { destination }, set: { selectCalendar($0) })) {
                ForEach(calendars.filter(\.canWrite)) { source in
                    Text("\(source.name) · \(providerLabel(source.provider)) · \(source.email)").tag(source.id)
                }
            }
            Text("Only checked, writable calendars are available here.").font(.caption).foregroundStyle(.secondary)
            TextField("Event title", text: $draft.title).textFieldStyle(.roundedBorder)
            DatePicker("Starts", selection: $draft.start)
            DatePicker("Ends", selection: $draft.end)
            Text(TimeZone.current.identifier).font(.caption).foregroundStyle(.secondary)
            Picker("Reminder", selection: Binding(get: { draft.reminder?.method ?? "default" }, set: { value in
                draft.reminder = value == "default" ? nil : CalendarReminder(method: value, minutes: value == "none" ? nil : draft.reminder?.minutes ?? 15)
            })) {
                Text("Provider default").tag("default")
                Text("None").tag("none")
                Text("Notification").tag("popup")
                if draft.provider == "google" { Text("Email (Google)").tag("email") }
            }
            if let reminder = draft.reminder, reminder.method != "none" {
                Picker("Remind me", selection: Binding(get: { draft.reminder?.minutes ?? 15 }, set: { draft.reminder?.minutes = $0 })) {
                    ForEach([0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080, 40320], id: \.self) { minutes in
                        Text(minutes == 0 ? "At the start" : minutes < 60 ? "\(minutes) minutes before" : minutes < 1440 ? "\(minutes / 60) hours before" : "\(minutes / 1440) days before").tag(minutes)
                    }
                }
            }
            if draft.provider == "microsoft" { Text("Outlook supports notification reminders; email reminders are not supported.").font(.caption).foregroundStyle(.secondary) }
            TextField("Location (optional)", text: $draft.location).textFieldStyle(.roundedBorder)
            TextArea(title: "Description (optional)", text: $draft.description)
        }
    }
    private func selectCalendar(_ id: String) {
        guard !draft.attempted, let source = calendars.first(where: { $0.id == id && $0.canWrite }) else { return }
        draft.provider = source.provider; draft.calendarID = source.calendarID; draft.calendarName = source.name; draft.email = source.email
        if draft.reminder?.method == "email", source.provider != "google" {
            draft.reminder = nil
            error = "Outlook does not support email reminders. Provider default is selected; choose and review the reminder before creating the event."
        } else { error = "" }
    }
    private func create() {
        guard valid else { return }
        model.perform {
            do {
                var submission = draft
                submission.prepareForSubmission()
                try submission.savePending(in: model.dataDirectory)
                draft = submission
                model.dirty("calendar", false)
                _ = try await model.request("/calendars/\(draft.requestProvider)/events", method: "POST", body: draft.payload, mailbox: "")
                try CalendarDraft.clearPending(in: model.dataDirectory)
                model.notice = "Event created in \(draft.calendarName)."; dismiss()
            } catch { self.error = error.localizedDescription }
        }
    }
}
