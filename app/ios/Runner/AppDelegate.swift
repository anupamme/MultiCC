import Flutter
import UIKit
import UserNotifications

@main
@objc class AppDelegate: FlutterAppDelegate {
  /// 「🖥 屏幕」高清流畅模式的 VideoToolbox 解码器（见 H264Decoder.swift）。
  private var h264Platform: H264Platform?

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    // FlutterAppDelegate forwards foreground presentation and tap callbacks
    // to flutter_local_notifications.
    UNUserNotificationCenter.current().delegate = self
    GeneratedPluginRegistrant.register(with: self)
    if let registrar = self.registrar(forPlugin: "MulticcH264") {
      h264Platform = H264Platform(messenger: registrar.messenger())
    }
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
