import SwiftUI
import WebKit
import CoreLocation

private let startURL = URL(string: "https://www.all-inrent.com/fr")!

struct WebContainerView: UIViewRepresentable {
  func makeCoordinator() -> Coordinator {
    Coordinator()
  }

  func makeUIView(context: Context) -> WKWebView {
    let config = WKWebViewConfiguration()
    config.allowsInlineMediaPlayback = true
    config.mediaTypesRequiringUserActionForPlayback = []
    config.defaultWebpagePreferences.allowsContentJavaScript = true

    let webView = WKWebView(frame: .zero, configuration: config)
    webView.scrollView.bounces = true
    webView.allowsBackForwardNavigationGestures = true
    webView.navigationDelegate = context.coordinator
    webView.uiDelegate = context.coordinator
    context.coordinator.webView = webView
    context.coordinator.requestLocationIfNeeded()
    webView.load(URLRequest(url: startURL))
    return webView
  }

  func updateUIView(_ uiView: WKWebView, context: Context) {}

  final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, CLLocationManagerDelegate {
    weak var webView: WKWebView?
    private let locationManager = CLLocationManager()

    override init() {
      super.init()
      locationManager.delegate = self
    }

    func requestLocationIfNeeded() {
      switch locationManager.authorizationStatus {
      case .notDetermined:
        locationManager.requestWhenInUseAuthorization()
      default:
        break
      }
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
}
