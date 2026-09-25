import SwiftUI
import WebKit
import CoreLocation

private let startURL = URL(string: "https://www.all-inrent.com/fr")!
private let screenColor = UIColor(red: 5 / 255, green: 11 / 255, blue: 24 / 255, alpha: 1)

@main
struct ALLINRENTApp: App {
  var body: some Scene {
    WindowGroup {
      WebContainerView()
        .ignoresSafeArea(.all)
        .preferredColorScheme(.dark)
        .background(Color(red: 5 / 255, green: 11 / 255, blue: 24 / 255))
    }
  }
}

struct WebContainerView: UIViewControllerRepresentable {
  func makeUIViewController(context: Context) -> WebViewController {
    WebViewController()
  }

  func updateUIViewController(_ uiViewController: WebViewController, context: Context) {}
}

final class WebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, CLLocationManagerDelegate {
  private let locationManager = CLLocationManager()
  private var webView: WKWebView!
  private var pendingGeoDecision: ((WKPermissionDecision) -> Void)?
  private let fadeCover = UIView()
  private var didFadeCover = false

  override var prefersStatusBarHidden: Bool { false }
  override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }
  override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { [.left, .top] }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = screenColor
    locationManager.delegate = self
    locationManager.desiredAccuracy = kCLLocationAccuracyHundredMeters

    let config = WKWebViewConfiguration()
    config.applicationNameForUserAgent = "AllInRent/1.0"
    config.allowsInlineMediaPlayback = true
    config.mediaTypesRequiringUserActionForPlayback = []
    config.defaultWebpagePreferences.allowsContentJavaScript = true
    let bootJS = """
    (function(){
      document.documentElement.classList.add('air-native-app');
      document.documentElement.style.backgroundColor = '#050B18';
      var css = document.createElement('style');
      css.textContent = 'html,body{background:#050B18!important} html.air-native-app footer{display:none!important}';
      document.documentElement.appendChild(css);
    })();
    """
    config.userContentController.addUserScript(
      WKUserScript(source: bootJS, injectionTime: .atDocumentStart, forMainFrameOnly: true)
    )

    webView = WKWebView(frame: view.bounds, configuration: config)
    webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    webView.backgroundColor = screenColor
    webView.isOpaque = true
    webView.scrollView.backgroundColor = screenColor
    webView.scrollView.contentInsetAdjustmentBehavior = .never
    webView.scrollView.contentInset = .zero
    webView.scrollView.verticalScrollIndicatorInsets = .zero
    webView.scrollView.horizontalScrollIndicatorInsets = .zero
    webView.scrollView.bounces = true
    webView.scrollView.delaysContentTouches = false
    webView.allowsBackForwardNavigationGestures = true
    webView.navigationDelegate = self
    webView.uiDelegate = self
    view.addSubview(webView)

    fadeCover.backgroundColor = screenColor
    fadeCover.frame = view.bounds
    fadeCover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    fadeCover.isUserInteractionEnabled = false
    view.addSubview(fadeCover)

    webView.load(URLRequest(url: startURL))
    DispatchQueue.main.asyncAfter(deadline: .now() + 2.8) { [weak self] in
      self?.fadeOutCover()
    }
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    webView.frame = view.bounds
    if fadeCover.superview != nil {
      fadeCover.frame = view.bounds
    }
    webView.scrollView.contentInset = .zero
    webView.scrollView.scrollIndicatorInsets = .zero
    pushSafeAreaInsets()
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    pushSafeAreaInsets()
    fadeOutCover()
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    fadeOutCover()
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    fadeOutCover()
  }

  private func fadeOutCover() {
    guard !didFadeCover else { return }
    didFadeCover = true
    UIView.animate(withDuration: 0.5, delay: 0.04, options: [.curveEaseOut, .allowUserInteraction]) {
      self.fadeCover.alpha = 0
    } completion: { _ in
      self.fadeCover.removeFromSuperview()
    }
  }

  private func windowSafeArea() -> UIEdgeInsets {
    if let insets = view.window?.safeAreaInsets, insets.top > 0 {
      return insets
    }
    let scene =
      view.window?.windowScene
      ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
    if let insets = scene?.windows.first(where: \.isKeyWindow)?.safeAreaInsets, insets.top > 0 {
      return insets
    }
    if let insets = scene?.windows.first?.safeAreaInsets, insets.top > 0 {
      return insets
    }
    return UIEdgeInsets(top: 59, left: 0, bottom: 34, right: 0)
  }

  private func pushSafeAreaInsets() {
    let insets = windowSafeArea()
    let top = (insets.top > 0 ? insets.top : 59) + 10
    let bottom = insets.bottom > 0 ? insets.bottom : 34
    let js = """
    (function(){
      var r = document.documentElement;
      r.style.setProperty('--app-safe-top', '\(top)px');
      r.style.setProperty('--app-safe-bottom', '\(bottom)px');
      var s = document.getElementById('allinrent-safe');
      if (!s) {
        s = document.createElement('style');
        s.id = 'allinrent-safe';
        (document.head || r).appendChild(s);
      }
      s.textContent = '.app-map-topbar,.relative.z-30.shrink-0.border-b{padding-top:max(12px,var(--app-safe-top))!important;}';
    })();
    """
    webView.evaluateJavaScript(js, completionHandler: nil)
  }

  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    guard let url = navigationAction.request.url else {
      decisionHandler(.allow)
      return
    }

    if shouldOpenExternally(url) {
      openExternally(url)
      decisionHandler(.cancel)
      return
    }

    let scheme = url.scheme?.lowercased() ?? ""
    if scheme == "http" || scheme == "https" {
      if isAllowedWebHost(url) {
        decisionHandler(.allow)
        return
      }
      if navigationAction.targetFrame == nil {
        UIApplication.shared.open(url)
        decisionHandler(.cancel)
        return
      }
      decisionHandler(.allow)
      return
    }

    decisionHandler(.cancel)
  }

  func webView(
    _ webView: WKWebView,
    runJavaScriptAlertPanelWithMessage message: String,
    initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping () -> Void
  ) {
    completionHandler()
  }

  func webView(
    _ webView: WKWebView,
    createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction,
    windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    if let url = navigationAction.request.url, url.absoluteString != "about:blank" {
      if shouldOpenExternally(url) {
        openExternally(url)
      } else if !isAllowedWebHost(url) {
        UIApplication.shared.open(url)
      }
    }
    return nil
  }

  func webView(
    _ webView: WKWebView,
    requestGeolocationPermissionFor origin: WKSecurityOrigin,
    initiatedByFrame frame: WKFrameInfo,
    decisionHandler: @escaping (WKPermissionDecision) -> Void
  ) {
    switch locationManager.authorizationStatus {
    case .authorizedAlways, .authorizedWhenInUse:
      decisionHandler(.grant)
      locationManager.requestLocation()
    case .denied, .restricted:
      decisionHandler(.deny)
    case .notDetermined:
      pendingGeoDecision = decisionHandler
      locationManager.requestWhenInUseAuthorization()
    @unknown default:
      decisionHandler(.deny)
    }
  }

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    let status = manager.authorizationStatus
    if let pending = pendingGeoDecision {
      pendingGeoDecision = nil
      switch status {
      case .authorizedAlways, .authorizedWhenInUse:
        pending(.grant)
        manager.requestLocation()
      default:
        pending(.deny)
      }
      return
    }
    if status == .authorizedAlways || status == .authorizedWhenInUse {
      manager.requestLocation()
    }
  }

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    guard let coordinate = locations.last?.coordinate else { return }
    injectGeo(coordinate)
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {}

  private func injectGeo(_ coordinate: CLLocationCoordinate2D) {
    let js = "window.__AIR_GEO={lat:\(coordinate.latitude),lng:\(coordinate.longitude)};"
    webView.evaluateJavaScript(js, completionHandler: nil)
  }

  private func isAllowedWebHost(_ url: URL) -> Bool {
    let host = url.host?.lowercased() ?? ""
    return host.hasSuffix("all-inrent.com") || host.contains("stripe.com")
  }

  private func shouldOpenExternally(_ url: URL) -> Bool {
    let scheme = url.scheme?.lowercased() ?? ""
    if ["tel", "mailto", "whatsapp", "sms", "allinrent"].contains(scheme) {
      return true
    }
    let host = url.host?.lowercased() ?? ""
    if host == "wa.me" || host.hasSuffix(".wa.me") {
      return true
    }
    if host.contains("whatsapp.com") || host.contains("whatsapp.net") {
      return true
    }
    return false
  }

  private func openExternally(_ url: URL) {
    if url.scheme?.lowercased() == "allinrent" {
      if let settings = URL(string: UIApplication.openSettingsURLString) {
        UIApplication.shared.open(settings)
      }
      return
    }
    UIApplication.shared.open(url)
  }
}
