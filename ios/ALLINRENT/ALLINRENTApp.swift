import SwiftUI
import WebKit
import CoreLocation

private let startURL = URL(string: "https://www.all-inrent.com/fr")!
private let screenColor = UIColor(red: 8 / 255, green: 19 / 255, blue: 31 / 255, alpha: 1)

@main
struct ALLINRENTApp: App {
  var body: some Scene {
    WindowGroup {
      WebContainerView()
        .ignoresSafeArea(.all)
        .preferredColorScheme(.dark)
        .background(Color(red: 8 / 255, green: 19 / 255, blue: 31 / 255))
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

  override var prefersStatusBarHidden: Bool { false }
  override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = screenColor
    locationManager.delegate = self

    let config = WKWebViewConfiguration()
    config.allowsInlineMediaPlayback = true
    config.mediaTypesRequiringUserActionForPlayback = []
    config.defaultWebpagePreferences.allowsContentJavaScript = true

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
    webView.allowsBackForwardNavigationGestures = true
    webView.navigationDelegate = self
    webView.uiDelegate = self
    view.addSubview(webView)

    if locationManager.authorizationStatus == .notDetermined {
      locationManager.requestWhenInUseAuthorization()
    }

    webView.load(URLRequest(url: startURL))
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    webView.frame = view.bounds
    webView.scrollView.contentInset = .zero
    webView.scrollView.scrollIndicatorInsets = .zero
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

    let scheme = url.scheme?.lowercased() ?? ""
    if ["tel", "mailto", "whatsapp", "sms"].contains(scheme) || url.host == "wa.me" || url.host == "api.whatsapp.com" {
      UIApplication.shared.open(url)
      decisionHandler(.cancel)
      return
    }

    if scheme == "http" || scheme == "https" {
      let host = url.host?.lowercased() ?? ""
      let allowed =
        host.hasSuffix("all-inrent.com") ||
        host.contains("stripe.com") ||
        host.contains("js.stripe.com")
      if allowed || navigationAction.targetFrame != nil {
        decisionHandler(.allow)
        return
      }
      UIApplication.shared.open(url)
      decisionHandler(.cancel)
      return
    }

    decisionHandler(.allow)
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
    if navigationAction.targetFrame == nil, let url = navigationAction.request.url {
      webView.load(URLRequest(url: url))
    }
    return nil
  }
}
