import Intents
import UIKit
import os

@objc(SableConversations)
final class SableConversations: NSObject {
  private static let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "moe.sable.app", category: "conversations")

  /// Same conversation identifier `NotificationService` donates and the share extension parses.
  @objc(donateSentByUser:room:name:avatar:)
  static func donateSent(user: String, room: String, name: String, avatar: Data?) {
    let intent = INSendMessageIntent(
      recipients: nil,
      outgoingMessageType: .outgoingMessageText,
      content: nil,
      speakableGroupName: INSpeakableString(spokenPhrase: name),
      conversationIdentifier: user + "\u{0}" + room,
      serviceName: nil,
      sender: nil,
      attachments: nil
    )
    if let image = avatar.flatMap(square) {
      intent.setImage(INImage(imageData: image), forParameterNamed: \.speakableGroupName)
    }
    let interaction = INInteraction(intent: intent, response: nil)
    interaction.direction = .outgoing
    interaction.donate { error in
      if let error {
        log.error("could not donate a sent message: \(error.localizedDescription, privacy: .public)")
      }
    }
  }

  /// Thumbnails keep the avatar's aspect ratio and the share sheet stretches the image into a circle.
  private static func square(_ data: Data) -> Data? {
    guard let image = UIImage(data: data) else { return nil }
    if image.size.width == image.size.height { return data }
    let side = min(image.size.width, image.size.height)
    let format = UIGraphicsImageRendererFormat()
    format.scale = image.scale
    return UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format).pngData { _ in
      image.draw(at: CGPoint(
        x: ((side - image.size.width) / 2).rounded(),
        y: ((side - image.size.height) / 2).rounded()
      ))
    }
  }
}
