import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider
import FirebaseCore

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?
  private var privacyShield: UIView?

  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    if FirebaseApp.allApps?.isEmpty != false,
       let configPath = Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist"),
       let options = FirebaseOptions(contentsOfFile: configPath) {
      FirebaseApp.configure(options: options)
    }

    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    window = UIWindow(frame: UIScreen.main.bounds)

    factory.startReactNative(
      withModuleName: "MoneroWallet",
      in: window,
      launchOptions: launchOptions
    )

    NotificationCenter.default.addObserver(
      self,
      selector: #selector(screenCaptureStateChanged),
      name: UIScreen.capturedDidChangeNotification,
      object: nil
    )

    return true
  }

  func applicationWillResignActive(_ application: UIApplication) {
    showPrivacyShield()
  }

  func applicationDidBecomeActive(_ application: UIApplication) {
    if UIScreen.main.isCaptured {
      showPrivacyShield()
    } else {
      hidePrivacyShield()
    }
  }

  func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    RCTLinkingManager.application(app, open: url, options: options)
  }

  func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    RCTLinkingManager.application(
      application,
      continue: userActivity,
      restorationHandler: restorationHandler
    )
  }

  @objc private func screenCaptureStateChanged() {
    if UIScreen.main.isCaptured {
      showPrivacyShield()
    } else if UIApplication.shared.applicationState == .active {
      hidePrivacyShield()
    }
  }

  private func showPrivacyShield() {
    guard let window, privacyShield == nil else { return }
    let shield = UIView(frame: window.bounds)
    shield.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    shield.backgroundColor = UIColor(red: 0.025, green: 0.025, blue: 0.055, alpha: 1)

    let label = UILabel()
    label.translatesAutoresizingMaskIntoConstraints = false
    label.text = "Monero Fast Wallet\nLocked for privacy"
    label.numberOfLines = 2
    label.textAlignment = .center
    label.textColor = .white
    label.font = UIFont.systemFont(ofSize: 20, weight: .semibold)
    shield.addSubview(label)
    NSLayoutConstraint.activate([
      label.centerXAnchor.constraint(equalTo: shield.centerXAnchor),
      label.centerYAnchor.constraint(equalTo: shield.centerYAnchor),
    ])

    window.addSubview(shield)
    privacyShield = shield
  }

  private func hidePrivacyShield() {
    privacyShield?.removeFromSuperview()
    privacyShield = nil
  }
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    return self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    if let bundled = Bundle.main.url(forResource: "main", withExtension: "jsbundle") {
      return bundled
    }

    // Keep the wallet dev server isolated from other local React Native apps.
    let provider = RCTBundleURLProvider.sharedSettings()
    provider.jsLocation = "localhost:9101"
    return provider.jsBundleURL(forBundleRoot: "index")
#else
    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
