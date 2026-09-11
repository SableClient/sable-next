package com.plugin.edgetoedge

import android.app.Activity
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.webkit.WebView
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsAnimationCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.ScriptHandler
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.util.Locale

@TauriPlugin
class EdgeToEdgePlugin(private val activity: Activity) : Plugin(activity) {
    private var webView: WebView? = null
    private var insetHostView: View? = null
    private var viewportCoverScriptHandler: ScriptHandler? = null
    private var cachedInsets = SafeAreaInsets(0, 0, 0, 0)
    private var cachedRawInsets = SafeAreaInsets(0, 0, 0, 0)
    private var cachedKeyboardHeight = 0
    private var cachedKeyboardVisible = false
    private var hasViewportCover = false

    data class SafeAreaInsets(val top: Int, val right: Int, val bottom: Int, val left: Int)

    companion object {
        private const val DOM_READY_BRIDGE = "EdgeToEdgeAndroid"
        private const val DOM_READY_MESSAGE = "dom-ready"
        private const val WEBVIEW_VERSION_WITH_SAFE_AREA_FIX = 140
        private const val WEBVIEW_VERSION_WITH_SAFE_AREA_KEYBOARD_FIX = 144
        private val EMPTY_INSETS = Insets.of(0, 0, 0, 0)
        private val ALLOWED_ORIGIN_RULES = setOf("*")
        private val VIEWPORT_META_JS_FUNCTION = """
            (function() {
                const meta = document.querySelectorAll("meta[name=viewport]");
                if (meta.length === 0) {
                    return false;
                }
                const metaContent = meta[meta.length - 1].content || "";
                return metaContent.includes("viewport-fit=cover");
            })();
        """.trimIndent()
        private val DOCUMENT_START_SCRIPT = """
            (function() {
                if (window.__edgeToEdgeDomReadyHookInstalled) {
                    return;
                }
                window.__edgeToEdgeDomReadyHookInstalled = true;

                function notifyDomReady() {
                    if (window.__edgeToEdgeDomReadyNotified) {
                        return;
                    }
                    window.__edgeToEdgeDomReadyNotified = true;
                    try {
                        window.EdgeToEdgeAndroid.postMessage("dom-ready");
                    } catch (_) {
                    }
                }

                if (document.readyState === "loading") {
                    document.addEventListener("DOMContentLoaded", notifyDomReady, { once: true });
                } else {
                    notifyDomReady();
                }
            })();
        """.trimIndent()
    }

    override fun load(webView: WebView) {
        super.load(webView)
        this.webView = webView
        this.insetHostView = resolveInsetHostView(webView)

        activity.runOnUiThread {
            enable()
            setTransparentSystemBars()
            setSystemBarAppearance()
            setupViewportCoverDetection(webView)
            refreshViewportCoverState(webView)
            setupKeyboardAnimationListener()
            setupWindowInsetsListener()
            requestApplyInsets()
        }

        println("[EdgeToEdge] Plugin loaded successfully")
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        activity.runOnUiThread {
            setSystemBarAppearance()
            requestApplyInsets()
        }
    }

    override fun onDestroy() {
        val currentWebView = webView ?: return

        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            viewportCoverScriptHandler?.remove()
            viewportCoverScriptHandler = null
        }

        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.removeWebMessageListener(currentWebView, DOM_READY_BRIDGE)
        }
    }

    private fun enable() {
        WindowCompat.setDecorFitsSystemWindows(activity.window, false)
        println("[EdgeToEdge] Edge-to-edge mode enabled")
    }

    private fun setTransparentSystemBars() {
        val window = activity.window
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.isNavigationBarContrastEnforced = false
        }

        println("[EdgeToEdge] System bars set to transparent")
    }

    private fun setSystemBarAppearance() {
        val window = activity.window
        val decorView = window.decorView
        val isDarkTheme =
            (activity.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
                Configuration.UI_MODE_NIGHT_YES

        WindowCompat.getInsetsController(window, decorView)?.apply {
            isAppearanceLightStatusBars = !isDarkTheme
            isAppearanceLightNavigationBars = !isDarkTheme
        }
    }

    private fun setupViewportCoverDetection(webView: WebView) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
        ) {
            println("[EdgeToEdge] Document-start viewport bridge unavailable; using direct viewport checks only")
            return
        }

        WebViewCompat.addWebMessageListener(
            webView,
            DOM_READY_BRIDGE,
            ALLOWED_ORIGIN_RULES,
            object : WebViewCompat.WebMessageListener {
                override fun onPostMessage(
                    view: WebView,
                    message: WebMessageCompat,
                    sourceOrigin: Uri,
                    isMainFrame: Boolean,
                    replyProxy: JavaScriptReplyProxy,
                ) {
                    if (!isMainFrame || message.data != DOM_READY_MESSAGE) {
                        return
                    }

                    refreshViewportCoverState(view)
                }
            },
        )

        viewportCoverScriptHandler = WebViewCompat.addDocumentStartJavaScript(
            webView,
            DOCUMENT_START_SCRIPT,
            ALLOWED_ORIGIN_RULES,
        )

        webView.evaluateJavascript(DOCUMENT_START_SCRIPT, null)
    }

    private fun refreshViewportCoverState(targetWebView: WebView) {
        targetWebView.evaluateJavascript(VIEWPORT_META_JS_FUNCTION) { result ->
            hasViewportCover = result == "true"
            requestApplyInsets()
        }
    }

    private fun setupKeyboardAnimationListener() {
        val hostView = requireInsetHostView()

        ViewCompat.setWindowInsetsAnimationCallback(
            hostView,
            object : WindowInsetsAnimationCompat.Callback(DISPATCH_MODE_STOP) {
                override fun onProgress(
                    windowInsets: WindowInsetsCompat,
                    runningAnimations: MutableList<WindowInsetsAnimationCompat>,
                ): WindowInsetsCompat {
                    syncInjectedInsets(
                        currentInjectedSafeArea(windowInsets),
                        windowInsets.isVisible(WindowInsetsCompat.Type.ime()),
                        windowInsets.getInsets(WindowInsetsCompat.Type.ime()).bottom,
                    )

                    return windowInsets
                }

                override fun onEnd(animation: WindowInsetsAnimationCompat) {
                    super.onEnd(animation)

                    val rootWindowInsets = ViewCompat.getRootWindowInsets(hostView) ?: return
                    syncInjectedInsets(
                        currentInjectedSafeArea(rootWindowInsets),
                        rootWindowInsets.isVisible(WindowInsetsCompat.Type.ime()),
                        rootWindowInsets.getInsets(WindowInsetsCompat.Type.ime()).bottom,
                    )
                }
            },
        )
    }

    private fun setupWindowInsetsListener() {
        val hostView = requireInsetHostView()

        ViewCompat.setOnApplyWindowInsetsListener(hostView) { view, windowInsets ->
            val systemBarsInsets = windowInsets.getInsets(systemBarsAndCutoutMask())
            val imeInsets = windowInsets.getInsets(WindowInsetsCompat.Type.ime())
            val keyboardVisible = windowInsets.isVisible(WindowInsetsCompat.Type.ime())
            val rawSafeAreaInsets = calcSafeAreaInsets(windowInsets)

            cachedRawInsets = rawSafeAreaInsets.toSafeAreaInsets()

            if (hasViewportCover && getWebViewMajorVersion() >= WEBVIEW_VERSION_WITH_SAFE_AREA_FIX) {
                view.setPadding(0, 0, 0, if (keyboardVisible) imeInsets.bottom else 0)
                syncInjectedInsets(rawSafeAreaInsets, keyboardVisible, imeInsets.bottom)

                return@setOnApplyWindowInsetsListener WindowInsetsCompat.Builder(windowInsets)
                    .setInsets(
                        systemBarsAndCutoutMask(),
                        Insets.of(
                            systemBarsInsets.left,
                            systemBarsInsets.top,
                            systemBarsInsets.right,
                            getBottomInset(systemBarsInsets, keyboardVisible),
                        ),
                    )
                    .build()
            }

            view.setPadding(
                systemBarsInsets.left,
                systemBarsInsets.top,
                systemBarsInsets.right,
                if (keyboardVisible) imeInsets.bottom else systemBarsInsets.bottom,
            )

            val rewrittenInsets = WindowInsetsCompat.Builder(windowInsets)
                .setInsets(systemBarsAndCutoutMask(), Insets.of(0, 0, 0, 0))
                .build()

            syncInjectedInsets(calcSafeAreaInsets(rewrittenInsets), keyboardVisible, imeInsets.bottom)
            rewrittenInsets
        }
    }

    private fun currentInjectedSafeArea(windowInsets: WindowInsetsCompat): Insets {
        return if (hasViewportCover && getWebViewMajorVersion() >= WEBVIEW_VERSION_WITH_SAFE_AREA_FIX) {
            calcSafeAreaInsets(windowInsets)
        } else {
            EMPTY_INSETS
        }
    }

    private fun syncInjectedInsets(
        insets: Insets,
        keyboardVisible: Boolean,
        keyboardHeight: Int,
    ) {
        cachedInsets = insets.toSafeAreaInsets()
        cachedKeyboardVisible = keyboardVisible
        cachedKeyboardHeight = keyboardHeight
        injectSafeAreaToWebView(cachedInsets, keyboardVisible, keyboardHeight)
    }

    private fun injectSafeAreaToWebView(
        insets: SafeAreaInsets,
        isKeyboardVisible: Boolean = false,
        keyboardHeight: Int = 0,
    ) {
        val currentWebView = webView ?: return

        val topDp = toDpString(insets.top)
        val rightDp = toDpString(insets.right)
        val bottomDp = toDpString(insets.bottom)
        val leftDp = toDpString(insets.left)
        val keyboardDp = toDpString(keyboardHeight)

        val jsCode = """
            (function() {
                var style = document.documentElement.style;
                style.setProperty('--safe-area-inset-top', '${topDp}px');
                style.setProperty('--safe-area-inset-right', '${rightDp}px');
                style.setProperty('--safe-area-inset-bottom', '${bottomDp}px');
                style.setProperty('--safe-area-inset-left', '${leftDp}px');
                style.setProperty('--safe-area-top', '${topDp}px');
                style.setProperty('--safe-area-right', '${rightDp}px');
                style.setProperty('--safe-area-bottom', '${bottomDp}px');
                style.setProperty('--safe-area-left', '${leftDp}px');
                style.setProperty('--keyboard-height', '${keyboardDp}px');
                style.setProperty('--keyboard-visible', '${if (isKeyboardVisible) "1" else "0"}');
                window.dispatchEvent(new CustomEvent('safeAreaChanged', {
                    detail: {
                        top: $topDp,
                        right: $rightDp,
                        bottom: $bottomDp,
                        left: $leftDp,
                        keyboardHeight: $keyboardDp,
                        keyboardVisible: $isKeyboardVisible
                    }
                }));
            })();
        """.trimIndent()

        currentWebView.evaluateJavascript(jsCode, null)
    }

    private fun calcSafeAreaInsets(windowInsets: WindowInsetsCompat): Insets {
        val safeArea = windowInsets.getInsets(systemBarsAndCutoutMask())
        return if (windowInsets.isVisible(WindowInsetsCompat.Type.ime())) {
            Insets.of(safeArea.left, safeArea.top, safeArea.right, 0)
        } else {
            Insets.of(safeArea.left, safeArea.top, safeArea.right, safeArea.bottom)
        }
    }

    private fun requestApplyInsets() {
        requireInsetHostView().requestApplyInsets()
        webView?.requestApplyInsets()
    }

    private fun resolveInsetHostView(webView: WebView): View {
        return (webView.parent as? View)
            ?: activity.window.decorView.findViewById(android.R.id.content)
    }

    private fun requireInsetHostView(): View {
        val currentHostView = insetHostView
        if (currentHostView != null) {
            return currentHostView
        }

        val currentWebView = webView ?: error("WebView has not been loaded yet")
        return resolveInsetHostView(currentWebView).also { insetHostView = it }
    }

    private fun toDpString(px: Int): String {
        val density = activity.resources.displayMetrics.density
        val dp = px.toFloat() / density
        return String.format(Locale.US, "%.4f", dp)
    }

    private fun getWebViewMajorVersion(): Int {
        val info = WebViewCompat.getCurrentWebViewPackage(activity)
        val versionName = info?.versionName ?: return 0
        return versionName.split(".").firstOrNull()?.toIntOrNull() ?: 0
    }

    private fun getBottomInset(systemBarsInsets: Insets, keyboardVisible: Boolean): Int {
        if (getWebViewMajorVersion() < WEBVIEW_VERSION_WITH_SAFE_AREA_KEYBOARD_FIX && keyboardVisible) {
            return 0
        }

        return systemBarsInsets.bottom
    }

    private fun systemBarsAndCutoutMask(): Int {
        return WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
    }

    private fun Insets.toSafeAreaInsets(): SafeAreaInsets {
        return SafeAreaInsets(top, right, bottom, left)
    }

    private fun SafeAreaInsets.topDp(): Float = top.toFloat() / activity.resources.displayMetrics.density
    private fun SafeAreaInsets.rightDp(): Float = right.toFloat() / activity.resources.displayMetrics.density
    private fun SafeAreaInsets.bottomDp(): Float = bottom.toFloat() / activity.resources.displayMetrics.density
    private fun SafeAreaInsets.leftDp(): Float = left.toFloat() / activity.resources.displayMetrics.density

    @Command
    fun getSafeAreaInsets(invoke: Invoke) {
        val density = activity.resources.displayMetrics.density
        val rootWindowInsets = ViewCompat.getRootWindowInsets(requireInsetHostView())
        val safeAreaInsets = rootWindowInsets?.let { calcSafeAreaInsets(it).toSafeAreaInsets() } ?: cachedRawInsets
        val statusBars = rootWindowInsets?.getInsets(WindowInsetsCompat.Type.statusBars()) ?: EMPTY_INSETS
        val navigationBars = rootWindowInsets?.getInsets(WindowInsetsCompat.Type.navigationBars()) ?: EMPTY_INSETS

        val result = JSObject()
        result.put("statusBar", statusBars.top / density)
        result.put("navigationBar", navigationBars.bottom / density)
        result.put("top", safeAreaInsets.topDp())
        result.put("bottom", safeAreaInsets.bottomDp())
        result.put("left", safeAreaInsets.leftDp())
        result.put("right", safeAreaInsets.rightDp())
        invoke.resolve(result)
    }

    @Command
    fun getKeyboardInfo(invoke: Invoke) {
        val density = activity.resources.displayMetrics.density
        val rootWindowInsets = ViewCompat.getRootWindowInsets(requireInsetHostView())

        val keyboardVisible = rootWindowInsets?.isVisible(WindowInsetsCompat.Type.ime()) ?: cachedKeyboardVisible
        val keyboardHeightPx = rootWindowInsets?.getInsets(WindowInsetsCompat.Type.ime())?.bottom ?: cachedKeyboardHeight

        val result = JSObject()
        result.put("keyboardHeight", keyboardHeightPx / density)
        result.put("isVisible", keyboardVisible)
        invoke.resolve(result)
    }

    @Command
    fun enable(invoke: Invoke) {
        activity.runOnUiThread {
            enable()
            setTransparentSystemBars()
            setSystemBarAppearance()
            webView?.let { refreshViewportCoverState(it) }
            requestApplyInsets()
        }
        invoke.resolve()
    }

    @Command
    fun disable(invoke: Invoke) {
        activity.runOnUiThread {
            WindowCompat.setDecorFitsSystemWindows(activity.window, true)
            requireInsetHostView().setPadding(0, 0, 0, 0)
            syncInjectedInsets(EMPTY_INSETS, false, 0)
            println("[EdgeToEdge] Edge-to-edge mode disabled")
        }
        invoke.resolve()
    }

    @Command
    fun showKeyboard(invoke: Invoke) {
        activity.runOnUiThread {
            val currentFocus = activity.currentFocus ?: webView
            if (currentFocus != null) {
                val imm = activity.getSystemService(android.content.Context.INPUT_METHOD_SERVICE) as InputMethodManager
                imm.showSoftInput(currentFocus, 0)
            }
        }
        invoke.resolve()
    }

    @Command
    fun hideKeyboard(invoke: Invoke) {
        activity.runOnUiThread {
            val imm = activity.getSystemService(android.content.Context.INPUT_METHOD_SERVICE) as InputMethodManager
            val currentFocus = activity.currentFocus ?: webView
            if (currentFocus != null) {
                imm.hideSoftInputFromWindow(currentFocus.windowToken, InputMethodManager.HIDE_NOT_ALWAYS)
            }
        }
        invoke.resolve()
    }
}
