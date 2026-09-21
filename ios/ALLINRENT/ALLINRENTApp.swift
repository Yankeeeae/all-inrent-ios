import SwiftUI

@main
struct ALLINRENTApp: App {
  var body: some Scene {
    WindowGroup {
      WebContainerView()
        .ignoresSafeArea()
        .preferredColorScheme(.dark)
    }
  }
}
