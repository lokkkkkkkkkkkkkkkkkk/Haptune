import Foundation
import UserNotifications

/// A gentle daily practice reminder (local notification, nothing leaves the device).
enum Reminders {
    static let id = "haptune.daily-practice"

    /// Returns false if the user declined notifications.
    @discardableResult
    static func update(enabled: Bool, minutesAfterMidnight: Int, streak: Int) async -> Bool {
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: [id])
        guard enabled else { return true }
        let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        guard granted else { return false }
        let content = UNMutableNotificationContent()
        content.title = String(localized: "Time to practise")
        content.body = streak > 1
            ? String(localized: "Keep your \(streak)-day streak going. Even 10 minutes counts.")
            : String(localized: "A short session today makes tomorrow easier. Even 10 minutes counts.")
        content.sound = .default
        var when = DateComponents()
        when.hour = minutesAfterMidnight / 60
        when.minute = minutesAfterMidnight % 60
        let request = UNNotificationRequest(identifier: id, content: content,
                                            trigger: UNCalendarNotificationTrigger(dateMatching: when, repeats: true))
        try? await center.add(request)
        return true
    }
}
