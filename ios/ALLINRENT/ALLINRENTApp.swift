import SwiftUI
import WebKit
import CoreLocation
import UserNotifications

private let startURL = URL(string: "https://www.all-inrent.com/fr")!
private let screenColor = UIColor(red: 5 / 255, green: 11 / 255, blue: 24 / 255, alpha: 1)
private let airOpenPushURL = Notification.Name("airOpenPushURL")

@main
struct ALLINRENTApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

  var body: some Scene {
    WindowGroup {
      WebContainerView()
        .ignoresSafeArea(.all)
        .preferredColorScheme(.dark)
        .background(Color(red: 5 / 255, green: 11 / 255, blue: 24 / 255))
    }
  }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    UNUserNotificationCenter.current().delegate = self
    self.requestPush()
    if let payload = launchOptions?[.remoteNotification] as? [AnyHashable: Any],
       let url = Self.url(from: payload) {
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) {
        NotificationCenter.default.post(name: airOpenPushURL, object: url)
      }
    }
    return true
  }

  func applicationDidBecomeActive(_ application: UIApplication) {
    requestPush()
  }

  func requestPush() {
    UNUserNotificationCenter.current().getNotificationSettings { settings in
      switch settings.authorizationStatus {
      case .notDetermined:
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
          guard granted else { return }
          DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
        }
      case .authorized, .provisional, .ephemeral:
        DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
      default:
        break
      }
    }
  }

  func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
    let token = deviceToken.map { String(format: "%02x", $0) }.joined()
    UserDefaults.standard.set(token, forKey: "air.pushToken")
    Self.registerToken(token)
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .sound])
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    if let url = Self.url(from: response.notification.request.content.userInfo) {
      NotificationCenter.default.post(name: airOpenPushURL, object: url)
    }
    completionHandler()
  }

  static func url(from userInfo: [AnyHashable: Any]) -> URL? {
    if let raw = userInfo["url"] as? String { return URL(string: raw) }
    return nil
  }

  static func registerToken(_ token: String) {
    var body: [String: Any] = [
      "platform": "ios",
      "role": "traveler",
      "token": token,
      "locale": Locale.current.languageCode ?? "fr",
    ]
    if let city = UserDefaults.standard.string(forKey: "air.pushCity"), !city.isEmpty {
      body["city"] = city
    }
    guard let data = try? JSONSerialization.data(withJSONObject: body),
          let url = URL(string: "https://www.all-inrent.com/api/push/register") else { return }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = data
    URLSession.shared.dataTask(with: req).resume()
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
  private let bootOverlay = UIView()
  private let bootRing = BootRingView()
  private var didHideBoot = false
  private var bootShownAt = Date()

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
      window.fbq = function(){};
      window._fbq = function(){};
      window.gtag = function(){};
      var css = document.createElement('style');
      css.textContent = 'html.air-native-app,html.air-native-app body{background:#fff!important} html.air-native-app #air-boot-splash{display:none!important} html.air-native-app footer:not(.air-bottom){display:none!important} html.air-native-app .air-publish,html.air-native-app a[href*="tiktok.com"],html.air-native-app iframe[src*="tiktok.com"]{display:none!important} html.air-native-app .air-mobile-home-hero{display:flex!important} html.air-native-app .air-desktop-home-hero{display:none!important} html.air-native-app .site-main-pad,html.air-native-app .site-main-pad-desktop{padding-bottom:var(--app-safe-bottom,env(safe-area-inset-bottom,0px))!important}';
      document.documentElement.appendChild(css);
    })();
    """
    config.userContentController.addUserScript(
      WKUserScript(source: bootJS, injectionTime: .atDocumentStart, forMainFrameOnly: true)
    )

    webView = WKWebView(frame: view.bounds, configuration: config)
    webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    webView.backgroundColor = .white
    webView.isOpaque = true
    webView.scrollView.backgroundColor = .white
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
    installBootOverlay()
    installAdBlockerThenLoad()
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(openPushURL(_:)),
      name: airOpenPushURL,
      object: nil
    )
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
  }

  @objc private func openPushURL(_ note: Notification) {
    guard let url = note.object as? URL, isAllowedWebHost(url), !isConsumerBlockedPath(url) else { return }
    webView.load(URLRequest(url: url))
  }

  private func installAdBlockerThenLoad() {
    var didLoad = false
    func loadOnce() {
      guard !didLoad else { return }
      didLoad = true
      webView.load(URLRequest(url: startURL))
    }
    let rules: String
    if let url = Bundle.main.url(forResource: "ContentBlocker", withExtension: "json"),
       let data = try? String(contentsOf: url, encoding: .utf8) {
      rules = data
    } else {
      rules = """
      [{"trigger":{"url-filter":"connect\\\\.facebook\\\\.net"},"action":{"type":"block"}},{"trigger":{"url-filter":"facebook\\\\.com/tr"},"action":{"type":"block"}},{"trigger":{"url-filter":"doubleclick\\\\.net"},"action":{"type":"block"}},{"trigger":{"url-filter":"googleadservices\\\\.com"},"action":{"type":"block"}},{"trigger":{"url-filter":"googletagmanager\\\\.com"},"action":{"type":"block"}},{"trigger":{"url-filter":"google-analytics\\\\.com"},"action":{"type":"block"}}]
      """
    }
    let controller = webView.configuration.userContentController
    WKContentRuleListStore.default().compileContentRuleList(
      forIdentifier: "air-no-ads",
      encodedContentRuleList: rules
    ) { list, _ in
      DispatchQueue.main.async {
        if let list {
          controller.add(list)
        }
        loadOnce()
      }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
      loadOnce()
    }
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    webView.frame = view.bounds
    bootOverlay.frame = view.bounds
    webView.scrollView.contentInset = .zero
    webView.scrollView.scrollIndicatorInsets = .zero
    pushSafeAreaInsets()
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    pushSafeAreaInsets()
    hideBootOverlay()
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    hideBootOverlay()
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    hideBootOverlay()
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    showBootOverlay()
    webView.reload()
  }

  private func installBootOverlay() {
    bootOverlay.backgroundColor = screenColor
    bootOverlay.frame = view.bounds
    bootOverlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    bootOverlay.isUserInteractionEnabled = false

    let logo = UIImageView(image: UIImage(named: "BootLogo") ?? UIImage(named: "LaunchLogo"))
    logo.translatesAutoresizingMaskIntoConstraints = false
    logo.contentMode = .scaleAspectFit
    logo.clipsToBounds = true
    logo.setContentHuggingPriority(.required, for: .horizontal)
    logo.setContentHuggingPriority(.required, for: .vertical)

    bootRing.translatesAutoresizingMaskIntoConstraints = false
    bootRing.start()

    let stack = UIStackView(arrangedSubviews: [logo, bootRing])
    stack.translatesAutoresizingMaskIntoConstraints = false
    stack.axis = .vertical
    stack.alignment = .center
    stack.spacing = 32
    bootOverlay.addSubview(stack)
    view.addSubview(bootOverlay)
    bootShownAt = Date()

    NSLayoutConstraint.activate([
      logo.widthAnchor.constraint(equalToConstant: 168),
      logo.heightAnchor.constraint(equalToConstant: 56),
      bootRing.widthAnchor.constraint(equalToConstant: 28),
      bootRing.heightAnchor.constraint(equalToConstant: 28),
      stack.centerXAnchor.constraint(equalTo: bootOverlay.centerXAnchor),
      stack.centerYAnchor.constraint(equalTo: bootOverlay.centerYAnchor)
    ])
  }

  private func showBootOverlay() {
    didHideBoot = false
    bootShownAt = Date()
    bootOverlay.alpha = 1
    if bootOverlay.superview == nil {
      view.addSubview(bootOverlay)
    }
    bootRing.start()
  }

  private func hideBootOverlay() {
    guard !didHideBoot else { return }
    let remain = max(0, 1.0 - Date().timeIntervalSince(bootShownAt))
    DispatchQueue.main.asyncAfter(deadline: .now() + remain) { [weak self] in
      guard let self, !self.didHideBoot else { return }
      self.didHideBoot = true
      UIView.animate(withDuration: 0.4, delay: 0, options: [.curveEaseOut, .allowUserInteraction]) {
        self.bootOverlay.alpha = 0
      } completion: { _ in
        self.bootOverlay.removeFromSuperview()
        self.bootRing.stop()
      }
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
      if isTikTokHost(url) {
        decisionHandler(.cancel)
        return
      }
      if isAllowedWebHost(url) {
        if isConsumerBlockedPath(url) {
          webView.load(URLRequest(url: startURL))
          decisionHandler(.cancel)
          return
        }
        decisionHandler(.allow)
        return
      }
      UIApplication.shared.open(url)
      decisionHandler(.cancel)
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
      } else if isTikTokHost(url) {
        return nil
      } else if isAllowedWebHost(url), isConsumerBlockedPath(url) {
        webView.load(URLRequest(url: startURL))
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
    guard let location = locations.last else { return }
    injectGeo(location.coordinate)
    CLGeocoder().reverseGeocodeLocation(location) { marks, _ in
      let city = marks?.first?.locality?.trimmingCharacters(in: .whitespacesAndNewlines)
      guard let city, !city.isEmpty else { return }
      UserDefaults.standard.set(city, forKey: "air.pushCity")
      if let token = UserDefaults.standard.string(forKey: "air.pushToken") {
        AppDelegate.registerToken(token)
      }
    }
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

  private func isTikTokHost(_ url: URL) -> Bool {
    let host = url.host?.lowercased() ?? ""
    return host == "tiktok.com" || host.hasSuffix(".tiktok.com")
  }

  private func pathWithoutLocale(_ path: String) -> String {
    let locales = ["fr", "en", "es", "de", "it", "pt", "zh", "ru", "ar"]
    let parts = path.lowercased().split(separator: "/", omittingEmptySubsequences: true).map(String.init)
    guard let first = parts.first, locales.contains(first) else {
      return path.isEmpty ? "/" : path
    }
    let rest = parts.dropFirst().joined(separator: "/")
    return rest.isEmpty ? "/" : "/\(rest)"
  }

  private func isConsumerBlockedPath(_ url: URL) -> Bool {
    let rest = pathWithoutLocale(url.path)
    if rest == "/agences" { return true }
    let blocked = ["/publier", "/agency", "/admin", "/reseaux-sociaux"]
    return blocked.contains { rest == $0 || rest.hasPrefix("\($0)/") }
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

private final class BootRingView: UIView {
  private let track = CAShapeLayer()
  private let ring = CAShapeLayer()

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    track.fillColor = UIColor.clear.cgColor
    track.strokeColor = UIColor.white.withAlphaComponent(0.14).cgColor
    track.lineWidth = 2.4
    ring.fillColor = UIColor.clear.cgColor
    ring.strokeColor = UIColor(red: 24 / 255, green: 119 / 255, blue: 242 / 255, alpha: 1).cgColor
    ring.lineWidth = 2.4
    ring.lineCap = .round
    ring.strokeStart = 0
    ring.strokeEnd = 0.78
    layer.addSublayer(track)
    layer.addSublayer(ring)
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let inset = ring.lineWidth / 2
    let path = UIBezierPath(ovalIn: bounds.insetBy(dx: inset, dy: inset)).cgPath
    track.frame = bounds
    ring.frame = bounds
    track.path = path
    ring.path = path
  }

  func start() {
    layer.removeAnimation(forKey: "spin")
    let spin = CABasicAnimation(keyPath: "transform.rotation.z")
    spin.fromValue = 0
    spin.toValue = CGFloat.pi * 2
    spin.duration = 0.85
    spin.repeatCount = .infinity
    layer.add(spin, forKey: "spin")
  }

  func stop() {
    layer.removeAnimation(forKey: "spin")
  }
}
