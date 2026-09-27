import Foundation
import Sentry

@objc(SableSentry)
final class SableSentry: NSObject {
  private static var enabled = false

  @objc(setEnabled:dsn:environment:release:)
  static func setEnabled(
    _ shouldEnable: Bool,
    dsn: NSString,
    environment: NSString,
    release: NSString
  ) {
    DispatchQueue.main.async {
      guard shouldEnable, let dsn = dsn as String?, !dsn.isEmpty else {
        if enabled {
          SentrySDK.close()
          enabled = false
        }
        return
      }
      guard !enabled else { return }

      SentrySDK.start { options in
        options.dsn = dsn
        options.environment = (environment as String).nilIfEmpty
        options.releaseName = (release as String).nilIfEmpty
        options.sendDefaultPii = false
      }
      enabled = true
    }
  }
}

private extension String {
  var nilIfEmpty: String? { isEmpty ? nil : self }
}
