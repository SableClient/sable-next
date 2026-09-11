import Foundation

func dockedKeyboardInset(bounds: CGRect, keyboard: CGRect, safeBottom: CGFloat = 0) -> CGFloat {
    let overlap = bounds.intersection(keyboard)
    guard !overlap.isNull, !overlap.isEmpty,
          overlap.maxY >= bounds.maxY - 1,
          overlap.width >= bounds.width - 1,
          overlap.height > safeBottom + 1 else { return 0 }
    return overlap.height
}
