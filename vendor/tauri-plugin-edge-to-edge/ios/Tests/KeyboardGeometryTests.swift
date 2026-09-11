import XCTest
@testable import tauri_plugin_edge_to_edge

final class KeyboardGeometryTests: XCTestCase {
    let bounds = CGRect(x: 0, y: 0, width: 400, height: 800)

    func testDockedKeyboardAndAccessoryResize() {
        XCTAssertEqual(dockedKeyboardInset(bounds: bounds, keyboard: CGRect(x: 0, y: 500, width: 400, height: 300)), 300)
        XCTAssertEqual(dockedKeyboardInset(bounds: bounds, keyboard: CGRect(x: 0, y: 450, width: 400, height: 350)), 350)
        XCTAssertEqual(dockedKeyboardInset(bounds: bounds, keyboard: CGRect(x: 0, y: 800, width: 400, height: 300)), 0)
    }

    func testFloatingAndUndockedKeyboardsDoNotShrinkTheTimeline() {
        XCTAssertEqual(dockedKeyboardInset(bounds: bounds, keyboard: CGRect(x: 100, y: 300, width: 200, height: 200)), 0)
        XCTAssertEqual(dockedKeyboardInset(bounds: bounds, keyboard: CGRect(x: 100, y: 600, width: 200, height: 200)), 0)
        XCTAssertEqual(dockedKeyboardInset(bounds: bounds, keyboard: CGRect(x: 0, y: 200, width: 400, height: 300)), 0)
    }

    func testWindowIntersectionIsRecomputedAfterResize() {
        let keyboard = CGRect(x: -100, y: 500, width: 1000, height: 400)
        XCTAssertEqual(dockedKeyboardInset(bounds: bounds, keyboard: keyboard), 300)
        XCTAssertEqual(dockedKeyboardInset(bounds: CGRect(x: 0, y: 0, width: 600, height: 600), keyboard: keyboard), 100)
        XCTAssertEqual(dockedKeyboardInset(bounds: CGRect(x: 0, y: 0, width: 400, height: 400), keyboard: keyboard), 0)
    }

    func testHiddenLayoutGuideIsOnlyTheSafeArea() {
        XCTAssertEqual(dockedKeyboardInset(bounds: bounds, keyboard: CGRect(x: 0, y: 766, width: 400, height: 34), safeBottom: 34), 0)
        XCTAssertEqual(dockedKeyboardInset(bounds: bounds, keyboard: CGRect(x: 0, y: 746, width: 400, height: 54), safeBottom: 34), 54)
    }
}
