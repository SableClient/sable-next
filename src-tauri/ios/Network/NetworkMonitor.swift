import Foundation
import Network

@objc(SableNetwork)
final class SableNetwork: NSObject {
  private static var monitor: NWPathMonitor?

  @objc(startWithHandler:)
  static func start(handler: @escaping (Bool) -> Void) {
    DispatchQueue.main.async {
      monitor?.cancel()
      let next = NWPathMonitor()
      next.pathUpdateHandler = { path in
        handler(
          path.status == .satisfied &&
          !path.usesInterfaceType(.cellular) &&
          !path.isExpensive &&
          !path.isConstrained
        )
      }
      monitor = next
      next.start(queue: DispatchQueue(label: "moe.sable.next.network"))
    }
  }
}
