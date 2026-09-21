import Foundation
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
    private let lock = NSLock()
    private var completion: ((UNNotificationContent) -> Void)?
    private var fallback: UNMutableNotificationContent?
    private var policyRoot: String?
    private var originalSound: UNNotificationSound?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content)
            return
        }
        // APNs must carry a generic alert: neither failure nor expiry may reveal a preview.
        content.title = "Sable"
        content.subtitle = ""
        content.body = "New message"
        content.attachments = []
        content.sound = nil
        content.threadIdentifier = Self.conversationThread(request.content.userInfo) ?? ""
        lock.lock()
        completion = contentHandler
        fallback = content
        originalSound = request.content.sound
        policyRoot = nil
        lock.unlock()

        guard let group = Bundle.main.object(forInfoDictionaryKey: "SableAppGroup") as? String,
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group),
              let data = try? JSONSerialization.data(withJSONObject: request.content.userInfo),
              let payload = String(data: data, encoding: .utf8) else {
            finish(content)
            return
        }
        let root = container.appendingPathComponent("Sable", isDirectory: true)
        lock.lock()
        policyRoot = root.path
        lock.unlock()
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let result = root.path.withCString { path in
                payload.withCString { json in sable_push_render(path, json) }
            }
            guard let result else { self?.finish(content); return }
            defer { sable_push_free(result) }
            let bytes = Data(String(cString: result).utf8)
            guard let rendered = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
                  let body = rendered["body"] as? String else {
                self?.finish(content)
                return
            }
            guard let updated = content.mutableCopy() as? UNMutableNotificationContent else {
                self?.finish(content)
                return
            }
            updated.body = body
            if let user = rendered["user_id"] as? String, let room = rendered["room_id"] as? String {
                updated.threadIdentifier = user + "\u{0}" + room
            }
            self?.finish(updated)
        }
    }

    static func conversationThread(_ payload: [AnyHashable: Any]) -> String? {
        var notification = payload["notification"] as? [String: Any]
        if let encoded = payload["notification"] as? String,
           let data = encoded.data(using: .utf8) {
            notification = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        }
        let event = notification ?? payload.reduce(into: [String: Any]()) {
            if let key = $1.key as? String { $0[key] = $1.value }
        }
        var users = Set<String>()
        for candidate in [payload["user_id"], event["user_id"]] {
            if let user = candidate as? String, !user.isEmpty { users.insert(user) }
        }
        for device in event["devices"] as? [[String: Any]] ?? [] {
            guard let data = device["data"] as? [String: Any] else { continue }
            for candidate in [data["user_id"], (data["default_payload"] as? [String: Any])?["user_id"]] {
                if let user = candidate as? String, !user.isEmpty { users.insert(user) }
            }
        }
        guard users.count == 1, let user = users.first,
              let room = event["room_id"] as? String, !room.isEmpty else { return nil }
        return user + "\u{0}" + room
    }

    private func finish(_ content: UNNotificationContent) {
        let identity = Self.messageIdentity(content.userInfo)
        let thread = Self.conversationThread(content.userInfo)
        guard identity != nil || thread != nil else {
            complete(content)
            return
        }
        UNUserNotificationCenter.current().getDeliveredNotifications { [weak self] delivered in
            let duplicates = identity.map { identity in
                delivered.filter { Self.messageIdentity($0.request.content.userInfo) == identity }
                    .map { $0.request.identifier }
            } ?? []
            let standing = thread.map { thread in
                delivered.contains { $0.request.content.threadIdentifier == thread }
            } ?? false
            self?.complete(content, duplicates: duplicates, standing: standing)
        }
    }

    private static func messageIdentity(_ payload: [AnyHashable: Any]) -> String? {
        guard let thread = conversationThread(payload) else { return nil }
        var notification = payload["notification"] as? [String: Any]
        if let encoded = payload["notification"] as? String, let data = encoded.data(using: .utf8) {
            notification = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        }
        guard let event = (notification?["event_id"] ?? payload["event_id"]) as? String,
              !event.isEmpty else { return nil }
        return thread + "\u{0}" + event
    }

    private func complete(
        _ content: UNNotificationContent,
        duplicates: [String] = [],
        standing: Bool = false
    ) {
        lock.lock()
        let handler = completion
        completion = nil
        let root = policyRoot
        let sound = originalSound
        lock.unlock()
        guard let handler else { return }
        guard let updated = content.mutableCopy() as? UNMutableNotificationContent else {
            handler(content)
            return
        }
        let quiet = !duplicates.isEmpty
            || (standing && root?.withCString { sable_push_notify_once($0) } == true)
        updated.sound = !quiet && root?.withCString { sable_push_sounds($0) } == true ? sound : nil
        if !duplicates.isEmpty {
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: duplicates)
        }
        handler(updated)
    }

    override func serviceExtensionTimeWillExpire() {
        lock.lock()
        let content = fallback
        lock.unlock()
        if let content { complete(content) }
    }
}
