import SwiftRs
import Tauri
import UIKit
import WebKit

private final class GeometryProbe: UIView {
    var changed: (() -> Void)?

    override func layoutSubviews() {
        super.layoutSubviews()
        changed?()
    }

    override func safeAreaInsetsDidChange() {
        super.safeAreaInsetsDidChange()
        changed?()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        changed?()
    }
}

class EdgeToEdgePlugin: Plugin, UIScrollViewDelegate {
    private weak var webviewRef: WKWebView?
    private var observers: [NSObjectProtocol] = []
    private var loadingObservation: NSKeyValueObservation?
    private var keyboardFrame: CGRect?
    private var keyboardHeight: CGFloat = 0
    private var updatePending = false
    private var lastInjection: String?

    @objc public override func load(webview: WKWebView) {
        guard webviewRef == nil else { return }
        webviewRef = webview
        setupEdgeToEdge(webview: webview)

        let probe = GeometryProbe()
        probe.isUserInteractionEnabled = false
        probe.accessibilityElementsHidden = true
        probe.translatesAutoresizingMaskIntoConstraints = false
        probe.changed = { [weak self] in self?.scheduleUpdate() }
        webview.addSubview(probe)
        let bottom: NSLayoutYAxisAnchor
        if #available(iOS 15.0, *) {
            webview.keyboardLayoutGuide.followsUndockedKeyboard = false
            bottom = webview.keyboardLayoutGuide.topAnchor
        } else {
            bottom = webview.bottomAnchor
        }
        NSLayoutConstraint.activate([
            probe.topAnchor.constraint(equalTo: webview.topAnchor),
            probe.leadingAnchor.constraint(equalTo: webview.leadingAnchor),
            probe.trailingAnchor.constraint(equalTo: webview.trailingAnchor),
            probe.bottomAnchor.constraint(equalTo: bottom)
        ])

        let center = NotificationCenter.default
        for name in [UIResponder.keyboardWillShowNotification, UIResponder.keyboardDidShowNotification,
                     UIResponder.keyboardWillChangeFrameNotification, UIResponder.keyboardDidChangeFrameNotification,
                     UIResponder.keyboardWillHideNotification, UIResponder.keyboardDidHideNotification] {
            center.removeObserver(webview, name: name, object: nil)
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] notification in
                guard let self = self, let view = self.webviewRef else { return }
                if view.window?.isKeyWindow == true {
                    if name == UIResponder.keyboardWillHideNotification || name == UIResponder.keyboardDidHideNotification {
                        self.keyboardFrame = nil
                    } else if let frame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect {
                        self.keyboardFrame = frame
                    }
                }
                self.resetScrollView(webview: view)
                self.scheduleUpdate()
            })
        }
        loadingObservation = webview.observe(\.isLoading, options: [.initial, .new]) { [weak self] view, _ in
            if !view.isLoading {
                self?.lastInjection = nil
                self?.scheduleUpdate()
            }
        }
        scheduleUpdate()
    }

    private func setupEdgeToEdge(webview: WKWebView) {
        webview.isOpaque = false
        webview.backgroundColor = .clear
        webview.scrollView.backgroundColor = .clear
        webview.scrollView.contentInsetAdjustmentBehavior = .never
        webview.scrollView.automaticallyAdjustsScrollIndicatorInsets = false
        webview.scrollView.bounces = false
        webview.scrollView.delegate = self
        resetScrollView(webview: webview)
    }

    private func resetScrollView(webview: WKWebView) {
        webview.scrollView.contentInset = .zero
        webview.scrollView.scrollIndicatorInsets = .zero
    }

    private func scheduleUpdate() {
        guard !updatePending else { return }
        updatePending = true
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.updatePending = false
            self.updateInsets()
        }
    }

    private func updateInsets() {
        guard let webview = webviewRef, let window = webview.window else { return }
        let safe = webview.safeAreaInsets
        if #available(iOS 15.0, *) {
            keyboardHeight = dockedKeyboardInset(bounds: webview.bounds, keyboard: webview.keyboardLayoutGuide.layoutFrame, safeBottom: safe.bottom)
        } else if let frame = keyboardFrame, window.isKeyWindow {
            let local = webview.convert(frame, from: window.screen.coordinateSpace)
            keyboardHeight = dockedKeyboardInset(bounds: webview.bounds, keyboard: local)
        } else {
            keyboardHeight = 0
        }
        let visible = keyboardHeight > 0
        let script = """
        (() => {
            if (!document.documentElement) return;
            const style = document.documentElement.style;
            const insets = { top: \(safe.top), right: \(safe.right), bottom: \(safe.bottom), left: \(safe.left) };
            for (const [edge, value] of Object.entries(insets)) {
                style.setProperty('--safe-area-inset-' + edge, value + 'px');
                style.setProperty('--safe-area-' + edge, value + 'px');
            }
            style.setProperty('--keyboard-height', '\(keyboardHeight)px');
            style.setProperty('--keyboard-visible', '\(visible ? "1" : "0")');
            window.dispatchEvent(new CustomEvent('safeAreaChanged', {
                detail: { ...insets, keyboardHeight: \(keyboardHeight), keyboardVisible: \(visible) }
            }));
        })();
        """
        guard script != lastInjection else { return }
        lastInjection = script
        webview.evaluateJavaScript(script, completionHandler: nil)
    }

    @objc public func getSafeAreaInsets(_ invoke: Invoke) throws {
        DispatchQueue.main.async { [weak self] in
            let safe = self?.webviewRef?.safeAreaInsets ?? .zero
            invoke.resolve(["top": safe.top, "right": safe.right, "bottom": safe.bottom, "left": safe.left])
        }
    }

    @objc public func getKeyboardInfo(_ invoke: Invoke) throws {
        invoke.resolve(["keyboardHeight": keyboardHeight, "isVisible": keyboardHeight > 0])
    }

    @objc public func enable(_ invoke: Invoke) throws {
        if let webview = webviewRef { setupEdgeToEdge(webview: webview) }
        scheduleUpdate()
        invoke.resolve()
    }

    @objc public func disable(_ invoke: Invoke) throws { invoke.resolve() }
    @objc public func showKeyboard(_ invoke: Invoke) throws { invoke.resolve() }

    @objc public func hideKeyboard(_ invoke: Invoke) throws {
        DispatchQueue.main.async { [weak self] in self?.webviewRef?.endEditing(true) }
        invoke.resolve()
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        if scrollView.contentOffset != .zero { scrollView.contentOffset = .zero }
    }

    deinit {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        loadingObservation?.invalidate()
    }
}

@_cdecl("init_plugin_edge_to_edge")
func initPlugin() -> Plugin { EdgeToEdgePlugin() }
