import AppKit
import Foundation

guard CommandLine.arguments.count == 3 else {
  fputs("Usage: generate-macos-icon.swift <monero-symbol.png> <output.png>\n", stderr)
  exit(64)
}

let sourceURL = URL(fileURLWithPath: CommandLine.arguments[1])
let outputURL = URL(fileURLWithPath: CommandLine.arguments[2])

guard let source = NSImage(contentsOf: sourceURL) else {
  fputs("Could not load \(sourceURL.path)\n", stderr)
  exit(1)
}

let canvasSize = CGSize(width: 2048, height: 2048)
let image = NSImage(size: canvasSize)
image.lockFocus()

guard let context = NSGraphicsContext.current?.cgContext else {
  fputs("Could not create a graphics context\n", stderr)
  exit(1)
}

context.setShouldAntialias(true)
context.setAllowsAntialiasing(true)

// A square macOS app-icon surface gives the Dock a consistent silhouette.
// The inset leaves a small amount of breathing room while the rounded card
// stays visually aligned with standard macOS app icons.
let cardRect = NSRect(x: 92, y: 92, width: 1864, height: 1864)
let card = NSBezierPath(roundedRect: cardRect, xRadius: 430, yRadius: 430)

NSColor(calibratedWhite: 0.975, alpha: 1).setFill()
card.fill()

NSColor(calibratedWhite: 0.80, alpha: 0.62).setStroke()
card.lineWidth = 10
card.stroke()

// The official mark remains untouched and is deliberately smaller than the
// card, following the visual balance of Telegram and other macOS Dock icons.
let logoRect = NSRect(x: 304, y: 304, width: 1440, height: 1440)
source.draw(
  in: logoRect,
  from: NSRect(origin: .zero, size: source.size),
  operation: .sourceOver,
  fraction: 1,
  respectFlipped: true,
  hints: [.interpolation: NSImageInterpolation.high]
)

image.unlockFocus()

guard let tiff = image.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff),
      let png = bitmap.representation(using: .png, properties: [:]) else {
  fputs("Could not encode the app icon\n", stderr)
  exit(1)
}

try png.write(to: outputURL, options: .atomic)
