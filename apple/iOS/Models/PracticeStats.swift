import Foundation

/// Numbers for the Summary screen, computed from the practice history.
struct PracticeStats {
    let history: [PracticeRecord]
    var calendar = Calendar.current
    var now = Date()

    struct Day: Identifiable {
        let date: Date
        let minutes: Double
        var id: Date { date }
    }

    func minutes(on day: Date) -> Double {
        history.filter { calendar.isDate($0.date, inSameDayAs: day) }.reduce(0) { $0 + $1.seconds } / 60
    }

    var todayMinutes: Double { minutes(on: now) }

    /// The last `count` days, oldest first (for the weekly bar chart).
    func lastDays(_ count: Int = 7) -> [Day] {
        let today = calendar.startOfDay(for: now)
        return (0..<count).reversed().compactMap { back in
            calendar.date(byAdding: .day, value: -back, to: today).map { Day(date: $0, minutes: minutes(on: $0)) }
        }
    }

    /// Consecutive days with practice, ending today (or yesterday, so the streak survives until tonight).
    var streak: Int {
        var day = calendar.startOfDay(for: now)
        if minutes(on: day) == 0 { day = calendar.date(byAdding: .day, value: -1, to: day) ?? day }
        var n = 0
        while minutes(on: day) > 0 {
            n += 1
            guard let prev = calendar.date(byAdding: .day, value: -1, to: day) else { break }
            day = prev
        }
        return n
    }

    var weekMinutes: Double { lastDays(7).reduce(0) { $0 + $1.minutes } }

    var previousWeekMinutes: Double {
        let start = calendar.date(byAdding: .day, value: -14, to: calendar.startOfDay(for: now)) ?? now
        let end = calendar.date(byAdding: .day, value: -7, to: calendar.startOfDay(for: now)) ?? now
        return history.filter { $0.date >= start && $0.date < end }.reduce(0) { $0 + $1.seconds } / 60
    }

    /// Takes with notes, newest last.
    func recentTakes(_ limit: Int = 12) -> [PracticeRecord] { Array(history.filter { $0.total > 0 }.suffix(limit)) }

    var lastTake: PracticeRecord? { history.last(where: { $0.total > 0 }) }

    /// Share of notes played in tune over the last 7 days.
    var inTuneRate: Double? {
        let start = calendar.date(byAdding: .day, value: -7, to: now) ?? now
        let recs = history.filter { $0.date >= start && $0.total > 0 }
        let total = recs.reduce(0) { $0 + $1.total }
        guard total > 0 else { return nil }
        return 1 - Double(recs.reduce(0) { $0 + $1.outOfTune }) / Double(total)
    }

    /// Timing slips (rushing / dragging) per 100 notes over the last 7 days.
    var timingPer100: Double? {
        let start = calendar.date(byAdding: .day, value: -7, to: now) ?? now
        let recs = history.filter { $0.date >= start && $0.total > 0 }
        let total = recs.reduce(0) { $0 + $1.total }
        guard total > 0 else { return nil }
        return Double(recs.reduce(0) { $0 + $1.timing }) / Double(total) * 100
    }

    struct Highlight: Identifiable {
        let id: String
        let symbol: String
        let text: String
    }

    /// Plain-language trends, like the Health app's highlights.
    var highlights: [Highlight] {
        var out: [Highlight] = []
        let week = weekMinutes, prev = previousWeekMinutes
        if week > 0 && prev > 0 {
            let change = Int(((week - prev) / prev * 100).rounded())
            let pct = "\(abs(change))%"
            if change >= 10 {
                out.append(.init(id: "more", symbol: "arrow.up.right",
                                 text: String(localized: "You practised \(pct) more this week than last week.")))
            } else if change <= -10 {
                out.append(.init(id: "less", symbol: "arrow.down.right",
                                 text: String(localized: "You practised \(pct) less this week than last week. A short session today keeps your streak going.")))
            }
        }
        // biggest improvement on one piece
        let byPiece = Dictionary(grouping: history.filter { $0.total > 0 }, by: { $0.title })
        var best: (title: String, from: Int, to: Int)?
        for (title, recs) in byPiece where recs.count >= 2 {
            let sorted = recs.sorted { $0.date < $1.date }
            let first = Int((sorted.first!.accuracy * 100).rounded())
            let last = Int((sorted.last!.accuracy * 100).rounded())
            if last - first >= 5, last - first > (best.map { $0.to - $0.from } ?? 0) { best = (title, first, last) }
        }
        if let b = best {
            let from = "\(b.from)%", to = "\(b.to)%"
            out.append(.init(id: "improved", symbol: "chart.line.uptrend.xyaxis",
                             text: String(localized: "Your accuracy on \(b.title) rose from \(from) to \(to).")))
        }
        if streak >= 3 {
            out.append(.init(id: "streak", symbol: "flame.fill",
                             text: String(localized: "\(streak) days in a row. Musicians who practise a little every day improve fastest.")))
        }
        if let t = inTuneRate, t >= 0.9 {
            let pct = "\(Int((t * 100).rounded()))%"
            out.append(.init(id: "tune", symbol: "tuningfork",
                             text: String(localized: "\(pct) of your notes were in tune this week.")))
        }
        return out
    }
}
