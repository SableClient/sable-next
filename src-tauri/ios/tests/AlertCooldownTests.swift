import Foundation

@main
struct AlertCooldownTests {
    static func main() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        func record(_ thread: String, _ now: TimeInterval) -> Bool? {
            AlertCooldown.record(root: root.path, thread: thread, now: now, window: 300)
        }
        precondition(record("user\0room", 1000) == false)
        precondition(record("user\0room", 1001) == true)
        precondition(record("user\0other", 1001) == false)
        precondition(record("other\0room", 1001) == false)
        precondition(record("user\0room", 1300) == false)
        precondition(record("user\0room", 900) == false)
        precondition(AlertCooldown.record(root: root.appendingPathComponent("missing").path, thread: "r", now: 1000, window: 300) == nil)

        precondition(record("user\0read", 1400) == false)
        precondition(record("user\0kept", 1400) == false)
        precondition(record("other\0read", 1400) == false)
        AlertCooldown.forget(root: root.path, user: "user", rooms: ["read"])
        precondition(record("user\0read", 1401) == false)
        precondition(record("user\0kept", 1401) == true)
        precondition(record("other\0read", 1401) == true)
        AlertCooldown.forget(root: root.path, user: "user", rooms: nil)
        precondition(record("user\0kept", 1402) == false)
        precondition(record("other\0read", 1402) == true)

        let lock = NSLock()
        var results: [Bool] = []
        DispatchQueue.concurrentPerform(iterations: 32) { _ in
            let result = AlertCooldown.record(root: root.path, thread: "concurrent", now: 2000, window: 300)
            lock.lock()
            if let result { results.append(result) }
            lock.unlock()
        }
        precondition(results.count == 32)
        precondition(results.filter { !$0 }.count == 1)
    }
}
