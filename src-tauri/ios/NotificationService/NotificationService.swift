import CallKit
import CryptoKit
import Foundation
import Intents
import os
import StoreKit
import UniformTypeIdentifiers
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
    private let lock = NSLock()
    private var completion: ((UNNotificationContent) -> Void)?
    private var fallback: UNMutableNotificationContent?
    private var policyRoot: String?
    private var originalSound: UNNotificationSound?
    private var activeElsewhere = false
    private var communication: INSendMessageIntent?
    private static let messageCategory = "sable-message"
    private static let inviteCategory = "sable-invite"
    private static let alertedAtKey = "sable_alerted_at"
    private static let notifyOnceWindow: TimeInterval = 5 * 60
    private static let log = Logger(subsystem: "moe.sable.app.notifications", category: "push")

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
        activeElsewhere = false
        communication = nil
        policyRoot = nil
        lock.unlock()

        guard let group = Bundle.main.object(forInfoDictionaryKey: "SableAppGroup") as? String,
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else {
            finish(content)
            return
        }
        let root = container.appendingPathComponent("Sable", isDirectory: true)
        lock.lock()
        policyRoot = root.path
        lock.unlock()
        UNUserNotificationCenter.current().getDeliveredNotifications { [weak self] delivered in
            var userInfo = request.content.userInfo
            userInfo["sable_shown_room_ids"] = Self.deliveredRooms(
                delivered,
                user: Self.conversationUser(request.content.userInfo)
            )
            guard let data = try? JSONSerialization.data(withJSONObject: userInfo),
                  let payload = String(data: data, encoding: .utf8) else {
                self?.finish(content)
                return
            }
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                guard let keychain = Bundle.main.object(forInfoDictionaryKey: "SableKeychainGroup") as? String,
                      keychain.withCString({ sable_push_install_keychain($0) }) else {
                    Self.log.error("keychain unavailable, showing the generic alert")
                    self?.finish(content)
                    return
                }
                let result = root.path.withCString { path in
                    payload.withCString { json in sable_push_render(path, json) }
                }
                guard let result else {
                    Self.log.error("render failed, showing the generic alert")
                    self?.finish(content)
                    return
                }
                defer { sable_push_free(result) }
                let bytes = Data(String(cString: result).utf8)
                guard let rendered = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] else {
                    self?.finish(content)
                    return
                }
                if let rooms = rendered["read_rooms"] as? [String],
                   let user = rendered["user_id"] as? String {
                    self?.clearReadRooms(rooms, user: user)
                }
                if rendered["discard"] as? Bool == true {
                    Self.log.info("discarded by push rules")
                    self?.suppress()
                    return
                }
                if let ring = rendered["ring"] as? [String: Any], let room = rendered["room_id"] as? String,
                   let user = rendered["user_id"] as? String {
                    self?.ring(ring, room: room, user: user, fallback: content)
                    return
                }
                if let read = rendered["read"] as? [String: Any], let user = rendered["user_id"] as? String {
                    self?.clearRead(read, user: user)
                    return
                }
                guard let body = rendered["body"] as? String,
                      let updated = content.mutableCopy() as? UNMutableNotificationContent else {
                    self?.finish(content)
                    return
                }
                if let title = rendered["title"] as? String { updated.title = title }
                updated.body = body
                if let image = rendered["image"] as? [String: Any], let attachment = Self.attachment(image) {
                    updated.attachments = [attachment]
                }
                let invite = rendered["invite"] as? Bool == true
                updated.categoryIdentifier = invite ? Self.inviteCategory : Self.messageCategory
                if rendered["active_elsewhere"] as? Bool == true {
                    self?.lock.lock()
                    self?.activeElsewhere = true
                    self?.lock.unlock()
                }
                guard let user = rendered["user_id"] as? String, let room = rendered["room_id"] as? String else {
                    self?.finish(updated)
                    return
                }
                updated.threadIdentifier = user + "\u{0}" + room
                guard !invite, let intent = Self.intent(rendered, conversation: updated.threadIdentifier) else {
                    self?.finish(updated)
                    return
                }
                let interaction = INInteraction(intent: intent, response: nil)
                interaction.direction = .incoming
                interaction.donate { [weak self] error in
                    if error == nil {
                        self?.lock.lock()
                        self?.communication = intent
                        self?.lock.unlock()
                    }
                    self?.finish(updated)
                }
            }
        }
    }

    private static func intent(_ rendered: [String: Any], conversation: String) -> INSendMessageIntent? {
        guard let name = (rendered["sender"] as? String).flatMap({ $0.isEmpty ? nil : $0 }),
              let text = rendered["text"] as? String else { return nil }
        let id = (rendered["sender_id"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? name
        let sender = INPerson(
            personHandle: INPersonHandle(value: id, type: .unknown),
            nameComponents: nil,
            displayName: name,
            image: image(rendered["sender_avatar"]),
            contactIdentifier: nil,
            customIdentifier: id
        )
        let group = rendered["group"] as? Bool == true
            ? (rendered["title"] as? String).map { INSpeakableString(spokenPhrase: $0) }
            : nil
        let intent = INSendMessageIntent(
            recipients: nil,
            outgoingMessageType: .outgoingMessageText,
            content: text,
            speakableGroupName: group,
            conversationIdentifier: conversation,
            serviceName: nil,
            sender: sender,
            attachments: nil
        )
        if group != nil, let room = image(rendered["room_avatar"]) {
            intent.setImage(room, forParameterNamed: \.speakableGroupName)
        }
        // Without recipients, iOS shows a group as a one-to-one conversation.
        if group != nil, let members = rendered["members"] as? Int, members > 2 {
            let metadata = INSendMessageIntentDonationMetadata()
            metadata.recipientCount = members - 2
            intent.donationMetadata = metadata
        }
        return intent
    }

    /// iOS moves an attachment's file into its own store, so it gets a copy of the cached one.
    private static func attachment(_ image: [String: Any]) -> UNNotificationAttachment? {
        guard let path = image["path"] as? String,
              let mimetype = image["mimetype"] as? String,
              ["image/png", "image/jpeg", "image/gif"].contains(mimetype),
              let type = UTType(mimeType: mimetype) else { return nil }
        let copy = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension(type.preferredFilenameExtension ?? "image")
        guard (try? FileManager.default.copyItem(at: URL(fileURLWithPath: path), to: copy)) != nil else {
            return nil
        }
        guard let attachment = try? UNNotificationAttachment(
            identifier: "image",
            url: copy,
            options: [UNNotificationAttachmentOptionsTypeHintKey: type.identifier]
        ) else {
            try? FileManager.default.removeItem(at: copy)
            return nil
        }
        return attachment
    }

    private static func image(_ path: Any?) -> INImage? {
        guard let path = path as? String, let data = FileManager.default.contents(atPath: path) else {
            return nil
        }
        return INImage(imageData: data)
    }

    private func clearRead(_ read: [String: Any], user: String) {
        guard read["clear"] as? Bool == true else {
            suppress()
            return
        }
        let room = read["room_id"] as? String
        UNUserNotificationCenter.current().getDeliveredNotifications { [weak self] delivered in
            let identifiers = delivered.filter { notification in
                let parts = notification.request.content.threadIdentifier
                    .split(separator: "\u{0}", maxSplits: 1, omittingEmptySubsequences: false)
                return parts.count == 2 && parts[0] == user && (room == nil || String(parts[1]) == room)
            }.map { $0.request.identifier }
            if !identifiers.isEmpty {
                UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: identifiers)
            }
            self?.suppress()
        }
    }

    private func clearReadRooms(_ rooms: [String], user: String) {
        guard !rooms.isEmpty else { return }
        UNUserNotificationCenter.current().getDeliveredNotifications { delivered in
            let roomSet = Set(rooms)
            let identifiers = delivered.filter { notification in
                let parts = notification.request.content.threadIdentifier
                    .split(separator: "\u{0}", maxSplits: 1, omittingEmptySubsequences: false)
                return parts.count == 2 && parts[0] == user && roomSet.contains(String(parts[1]))
            }.map { $0.request.identifier }
            if !identifiers.isEmpty {
                UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: identifiers)
            }
        }
    }

    private func suppress() {
        lock.lock()
        let handler = completion
        completion = nil
        lock.unlock()
        handler?(UNNotificationContent())
    }

    private func ring(_ ring: [String: Any], room: String, user: String, fallback: UNMutableNotificationContent) {
        let caller = (ring["caller_name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "Someone"
        guard let alert = fallback.mutableCopy() as? UNMutableNotificationContent else {
            finish(fallback)
            return
        }
        alert.body = "\(caller) is calling"
        let eventId = ring["notification_event_id"] as? String
        let uuid = eventId.map { Self.callUUID(user: user, room: room, event: $0) } ?? UUID()
        var payload: [AnyHashable: Any] = [
            "room_id": room,
            "uuid": uuid.uuidString,
            "caller_name": caller,
        ]
        if let expiresAt = ring["expires_at"] as? Double { payload["expires_at"] = expiresAt }
        if let eventId { payload["notification_event_id"] = eventId }
        payload["has_video"] = ring["has_video"] as? Bool ?? false
        Task { [weak self] in
            let storefront = await Storefront.current
            guard let self, isPending() else { return }
            guard storefront?.countryCode.uppercased() != "CHN",
                  Locale.autoupdatingCurrent.regionCode?.uppercased() != "CN" else {
                finish(alert)
                return
            }
            CXProvider.reportNewIncomingVoIPPushPayload(payload) { [weak self] error in
                if error == nil {
                    self?.suppress()
                } else {
                    self?.finish(alert)
                }
            }
        }
    }

    private static func callUUID(user: String, room: String, event: String) -> UUID {
        var bytes = Array(SHA256.hash(data: Data("\(user)\u{0}\(room)\u{0}\(event)".utf8)).prefix(16))
        bytes[6] = (bytes[6] & 0x0f) | 0x80
        bytes[8] = (bytes[8] & 0x3f) | 0x80
        return UUID(uuid: (bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
                           bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]))
    }

    private func isPending() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return completion != nil
    }

    private static func eventPayload(_ payload: [AnyHashable: Any]) -> [String: Any] {
        if let notification = payload["notification"] as? [String: Any] { return notification }
        if let encoded = payload["notification"] as? String,
           let data = encoded.data(using: .utf8),
           let value = try? JSONSerialization.jsonObject(with: data),
           let notification = value as? [String: Any] {
            return notification
        }
        return payload.reduce(into: [String: Any]()) {
            if let key = $1.key as? String { $0[key] = $1.value }
        }
    }

    static func conversationUser(_ payload: [AnyHashable: Any]) -> String? {
        let event = eventPayload(payload)
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
        guard users.count == 1 else { return nil }
        return users.first
    }

    static func conversationThread(_ payload: [AnyHashable: Any]) -> String? {
        let event = eventPayload(payload)
        guard let user = conversationUser(payload) else { return nil }
        guard let room = event["room_id"] as? String, !room.isEmpty else { return nil }
        return user + "\u{0}" + room
    }

    private static func deliveredRooms(_ delivered: [UNNotification], user: String?) -> [String] {
        guard let user else { return [] }
        return Array(Set(delivered.compactMap { notification in
            let parts = notification.request.content.threadIdentifier
                .split(separator: "\u{0}", maxSplits: 1, omittingEmptySubsequences: false)
            guard parts.count == 2, parts[0] == user else { return nil }
            return String(parts[1]).isEmpty ? nil : String(parts[1])
        }))
    }

    private func finish(_ content: UNNotificationContent) {
        let identity = Self.messageIdentity(content.userInfo)
        let thread = content.threadIdentifier.isEmpty
            ? Self.conversationThread(content.userInfo) : content.threadIdentifier
        guard identity != nil || thread != nil else {
            complete(content)
            return
        }
        UNUserNotificationCenter.current().getDeliveredNotifications { [weak self] delivered in
            let duplicates = identity.map { identity in
                delivered.filter { Self.messageIdentity($0.request.content.userInfo) == identity }
                    .map { $0.request.identifier }
            } ?? []
            let alertedAt = thread.flatMap { thread in
                delivered.filter { $0.request.content.threadIdentifier == thread }
                    .compactMap { $0.request.content.userInfo[Self.alertedAtKey] as? TimeInterval }
                    .max()
            }
            self?.complete(content, duplicates: duplicates, alertedAt: alertedAt)
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
        alertedAt: TimeInterval? = nil
    ) {
        lock.lock()
        let handler = completion
        completion = nil
        let root = policyRoot
        let sound = originalSound
        let activeElsewhere = self.activeElsewhere
        let intent = communication
        communication = nil
        lock.unlock()
        guard let handler else { return }
        guard let updated = content.mutableCopy() as? UNMutableNotificationContent else {
            handler(content)
            return
        }
        let now = Date().timeIntervalSince1970
        let enabled = root?.withCString { sable_push_notify_once($0) } == true
        let thread = updated.threadIdentifier.isEmpty
            ? Self.conversationThread(updated.userInfo) : updated.threadIdentifier
        let priorCooling = alertedAt.map { now >= $0 && now - $0 < Self.notifyOnceWindow } ?? false
        let cooling: Bool
        if enabled, !activeElsewhere, duplicates.isEmpty, updated.categoryIdentifier != Self.inviteCategory,
           let root, let thread {
            cooling = AlertCooldown.record(
                root: root, thread: thread, now: now, window: Self.notifyOnceWindow
            ) ?? priorCooling
        } else {
            cooling = false
        }
        let quiet = !duplicates.isEmpty
            || activeElsewhere
            || cooling
        // Dropping the alert needs the filtering entitlement. Without it the generic fallback stays visible.
        if activeElsewhere || cooling { updated.interruptionLevel = .passive }
        updated.sound = !quiet && root?.withCString { sable_push_sounds($0) } == true ? sound : nil
        if let stamp = quiet ? alertedAt : Optional(now) {
            updated.userInfo[Self.alertedAtKey] = stamp
        }
        if !duplicates.isEmpty {
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: duplicates)
        }
        handler(intent.flatMap { try? updated.updating(from: $0) } ?? updated)
    }

    override func serviceExtensionTimeWillExpire() {
        Self.log.error("time expired, showing the generic alert")
        lock.lock()
        let content = fallback
        communication = nil
        lock.unlock()
        if let content { complete(content) }
    }
}
