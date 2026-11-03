import Intents
import UIKit
import UniformTypeIdentifiers
import os

final class ShareViewController: UIViewController {
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        let context = extensionContext
        Task {
            let providers = (context?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
            guard await ShareStaging.stage(providers, target: ShareStaging.target(context?.intent)) else {
                context?.completeRequest(returningItems: nil)
                return
            }
            if let url = ShareStaging.appURL(), await open(url) {
                context?.completeRequest(returningItems: nil)
                return
            }
            let alert = UIAlertController(title: nil, message: "Saved. Open Sable to send it.", preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in
                context?.completeRequest(returningItems: nil)
            })
            present(alert, animated: true)
        }
    }

    /// Only Today and iMessage extensions may open URLs, so this walks the responder chain
    /// to the host's `UIApplication`, as Element X does. iOS may stop allowing it.
    private func open(_ url: URL) async -> Bool {
        var responder: UIResponder? = self
        while let current = responder {
            if let application = current as? UIApplication {
                return await application.open(url)
            }
            responder = current.next
        }
        ShareStaging.log.error("no application in the responder chain to open Sable")
        return false
    }
}

enum ShareStaging {
    static let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "moe.sable.app.share", category: "share")

    /// Matches `SHARE_MANIFEST_VERSION` in `share_inbox.rs`.
    private static let manifestVersion = 1

    static func stage(_ providers: [NSItemProvider], target: [String: String]?) async -> Bool {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "SableAppGroup") as? String,
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else {
            log.error("App Group container unavailable")
            return false
        }
        let root = container.appendingPathComponent("Sable", isDirectory: true)
        let batchId = "\(Int(Date().timeIntervalSince1970 * 1000))-\(UUID().uuidString.lowercased())"
        // Built outside the inbox: the app drops any batch it finds without a manifest.
        let staging = root.appendingPathComponent("share_staging", isDirectory: true)
            .appendingPathComponent(batchId, isDirectory: true)
        let inbox = root.appendingPathComponent("share_inbox", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: staging) }
        do {
            try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true)
        } catch {
            log.error("could not create the share batch: \(error.localizedDescription, privacy: .public)")
            return false
        }

        var items: [[String: String]] = []
        for (index, provider) in providers.enumerated() {
            if let item = await stage(provider, index: index, into: staging) {
                items.append(item)
            }
        }
        guard !items.isEmpty else {
            log.error("nothing in the share could be staged")
            return false
        }

        var manifest: [String: Any] = ["version": manifestVersion, "items": items]
        if let target { manifest["target"] = target }
        do {
            let data = try JSONSerialization.data(withJSONObject: manifest)
            try data.write(to: staging.appendingPathComponent("share.json"))
            try FileManager.default.moveItem(at: staging, to: inbox.appendingPathComponent(batchId, isDirectory: true))
        } catch {
            log.error("could not write the share batch: \(error.localizedDescription, privacy: .public)")
            return false
        }
        return true
    }

    static func target(_ intent: INIntent?) -> [String: String]? {
        guard let conversation = (intent as? INSendMessageIntent)?.conversationIdentifier else { return nil }
        let parts = conversation.split(separator: "\u{0}", omittingEmptySubsequences: false)
        guard parts.count == 2, parts[0].hasPrefix("@"), parts[1].hasPrefix("!") else { return nil }
        return ["userId": String(parts[0]), "roomId": String(parts[1])]
    }

    static func appURL() -> URL? {
        let app = Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent()
        let types = Bundle(url: app)?.object(forInfoDictionaryKey: "CFBundleURLTypes") as? [[String: Any]]
        let scheme = types?.compactMap { $0["CFBundleURLSchemes"] as? [String] }
            .flatMap { $0 }
            .first { ["moe.sable.next", "moe.sable.app"].contains($0) }
        guard let scheme, let url = URL(string: "\(scheme)://share") else {
            log.error("Sable's URL scheme is missing from the app's Info.plist")
            return nil
        }
        return url
    }

    private static func stage(_ provider: NSItemProvider, index: Int, into batch: URL) async -> [String: String]? {
        if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
           let url = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL,
           !url.isFileURL {
            return textItem(url.absoluteString)
        }
        // A shared text file loads as a URL here and is staged as a file below.
        if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
           let text = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
            return textItem(text)
        }
        guard let type = provider.registeredTypeIdentifiers.lazy.compactMap(UTType.init)
            .first(where: { $0.conforms(to: .data) && !$0.conforms(to: .url) }) else {
            log.error("unsupported shared item: \(provider.registeredTypeIdentifiers, privacy: .public)")
            return nil
        }
        guard let fileName = await copyFile(provider, type: type, index: index, into: batch) else { return nil }
        return ["kind": "file", "fileName": fileName, "mime": type.preferredMIMEType ?? "application/octet-stream"]
    }

    private static func textItem(_ text: String) -> [String: String] {
        ["kind": text.hasPrefix("http://") || text.hasPrefix("https://") ? "url" : "text", "text": text]
    }

    private static func copyFile(_ provider: NSItemProvider, type: UTType, index: Int, into batch: URL) async -> String? {
        let suggested = provider.suggestedName
        return await withCheckedContinuation { continuation in
            _ = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, error in
                guard let url else {
                    log.error("could not load a shared file: \(error?.localizedDescription ?? "", privacy: .public)")
                    continuation.resume(returning: nil)
                    return
                }
                let name = fileName(suggested ?? url.deletingPathExtension().lastPathComponent, type: type, index: index)
                do {
                    try FileManager.default.copyItem(at: url, to: batch.appendingPathComponent(name))
                    continuation.resume(returning: name)
                } catch {
                    log.error("could not copy a shared file: \(error.localizedDescription, privacy: .public)")
                    continuation.resume(returning: nil)
                }
            }
        }
    }

    /// Mirrors `MainActivity.stageFile`: the index prefix keeps names unique and is stripped for display.
    private static func fileName(_ suggested: String, type: UTType, index: Int) -> String {
        var name = String(suggested
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "\\", with: "_")
            .replacingOccurrences(of: "\u{0}", with: "")
            .prefix(120))
        if name.isEmpty || name == "." || name == ".." { name = "shared" }
        if (name as NSString).pathExtension.isEmpty, let ext = type.preferredFilenameExtension {
            name += ".\(ext)"
        }
        return "\(index)-\(name)"
    }
}
