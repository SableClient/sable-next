import Darwin
import Foundation

enum AlertCooldown {
    static func record(root: String, thread: String, now: TimeInterval, window: TimeInterval) -> Bool? {
        edit(root: root) { entries in
            if let previous = entries[thread], now >= previous, now - previous < window {
                return false
            }
            entries = entries.filter { now >= $0.value && now - $0.value < window }
            entries[thread] = now
            return true
        }.map { !$0 }
    }

    /// Without `rooms`, every room of the user.
    static func forget(root: String, user: String, rooms: [String]?) {
        _ = edit(root: root) { entries in
            let before = entries.count
            entries = entries.filter { entry in
                let parts = entry.key.split(separator: "\u{0}", maxSplits: 1, omittingEmptySubsequences: false)
                guard parts.count == 2, parts[0] == user else { return true }
                return rooms.map { !$0.contains(String(parts[1])) } ?? false
            }
            return entries.count != before
        }
    }

    /// Writes the entries back when `change` returns true. Nil when the file cannot be used.
    private static func edit(root: String, _ change: (inout [String: TimeInterval]) -> Bool) -> Bool? {
        let path = (root as NSString).appendingPathComponent("alert-cooldown.json")
        let fd = open(path, O_RDWR | O_CREAT, S_IRUSR | S_IWUSR)
        guard fd >= 0 else { return nil }
        defer { close(fd) }
        guard flock(fd, LOCK_EX) == 0 else { return nil }
        defer { flock(fd, LOCK_UN) }

        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
        let data = handle.readDataToEndOfFile()
        var entries = (try? JSONDecoder().decode([String: TimeInterval].self, from: data)) ?? [:]
        guard change(&entries) else { return false }
        guard let encoded = try? JSONEncoder().encode(entries),
              lseek(fd, 0, SEEK_SET) >= 0, ftruncate(fd, 0) == 0 else { return nil }
        do {
            try handle.write(contentsOf: encoded)
            return true
        } catch {
            return nil
        }
    }
}
