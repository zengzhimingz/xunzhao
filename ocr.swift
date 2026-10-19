import Foundation
import Vision
import ImageIO
import CoreImage

// Apple Vision runs on this Mac. No image or recognized text leaves the device.
do {
    guard CommandLine.arguments.count == 2 else { throw NSError(domain: "OCR", code: 1) }
    let url = URL(fileURLWithPath: CommandLine.arguments[1])
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
          image.width * image.height <= 50000000 else {
        throw NSError(domain: "OCR", code: 2)
    }
    let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
    let orientationValue = (properties?[kCGImagePropertyOrientation] as? UInt32) ?? 1
    let orientation = CGImagePropertyOrientation(rawValue: orientationValue) ?? .up
    let ci = CIImage(cgImage: image).oriented(orientation)
    let context = CIContext()
    guard let upright = context.createCGImage(ci, from: ci.extent) else { throw NSError(domain: "OCR", code: 3) }
    let width = upright.width, height = upright.height
    func roleHint(_ box: [String: Double]) -> String {
        let rect = CGRect(x: box["x"]! * Double(width), y: box["y"]! * Double(height),
                          width: max(1, box["width"]! * Double(width)), height: max(1, box["height"]! * Double(height))).integral
        guard let crop = upright.cropping(to: rect) else { return "unknown" }
        var pixel = [UInt8](repeating: 0, count: 4)
        let color = CGColorSpaceCreateDeviceRGB()
        pixel.withUnsafeMutableBytes { bytes in
            if let ctx = CGContext(data: bytes.baseAddress, width: 1, height: 1, bitsPerComponent: 8,
                                   bytesPerRow: 4, space: color, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) {
                ctx.interpolationQuality = .high
                ctx.draw(crop, in: CGRect(x: 0, y: 0, width: 1, height: 1))
            }
        }
        let r = Int(pixel[0]), g = Int(pixel[1]), b = Int(pixel[2])
        if r-b > 11 && g-b > 8 && abs(r-g) < 30 { return "client_color_hint" }
        if box["x"]! < 0.29 && abs(r-b) < 12 && abs(g-b) < 12 { return "left_consultant_hint" }
        return "unknown"
    }
    // Long chat screenshots must be tiled; whole-image downsampling loses small Chinese text.
    let tileHeight = min(height, max(1800, min(3000, width * 2)))
    let overlap = min(180, tileHeight / 8)
    var start = 0
    var lines: [[String: Any]] = []
    while start < height {
        let actualHeight = min(tileHeight, height - start)
        guard let tile = upright.cropping(to: CGRect(x: 0, y: start, width: width, height: actualHeight)) else { break }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["zh-Hans", "en-US"]
        request.usesLanguageCorrection = true
        try VNImageRequestHandler(cgImage: tile, options: [:]).perform([request])
        for observation in request.results ?? [] {
            guard let candidate = observation.topCandidates(1).first else { continue }
            let b = observation.boundingBox
            let top = (Double(start) + (1 - b.maxY) * Double(actualHeight)) / Double(height)
            let h = b.height * Double(actualHeight) / Double(height)
            let center = top + h / 2
            // De-duplicate overlapping tiles using position, rather than removing repeated chat messages.
            if let duplicateIndex = lines.firstIndex(where: { row in
                guard let box = row["box"] as? [String: Double], let text = row["text"] as? String else { return false }
                let verticalMatch = abs((box["y"]! + box["height"]! / 2) - center) * Double(height) < 24
                let horizontalMatch = abs(box["x"]! - b.minX) * Double(width) < 60
                let sameExtent = min(box["width"]!, b.width) / max(box["width"]!, b.width) > 0.7
                return verticalMatch && horizontalMatch && (sameExtent || text == candidate.string || text.contains(candidate.string) || candidate.string.contains(text))
            }) {
                let previousConfidence = (lines[duplicateIndex]["confidence"] as? Float) ?? 0
                if candidate.confidence > previousConfidence {
                    lines[duplicateIndex] = ["text": candidate.string, "confidence": candidate.confidence,
                                             "box": ["x": b.minX, "y": top, "width": b.width, "height": h]]
                }
                continue
            }
            lines.append(["text": candidate.string, "confidence": candidate.confidence,
                          "box": ["x": b.minX, "y": top, "width": b.width, "height": h]])
        }
        if start + actualHeight >= height { break }
        start += tileHeight - overlap
    }
    lines.sort { a, b in
        let ba = a["box"] as! [String: Double], bb = b["box"] as! [String: Double]
        return abs(ba["y"]! - bb["y"]!) * Double(height) < 8 ? ba["x"]! < bb["x"]! : ba["y"]! < bb["y"]!
    }
    for index in lines.indices {
        if let box = lines[index]["box"] as? [String: Double] { lines[index]["roleHint"] = roleHint(box) }
    }
    let result: [String: Any] = ["lines": lines, "engine": "Apple Vision · 本机文字识别"]
    let data = try JSONSerialization.data(withJSONObject: result)
    print(String(decoding: data, as: UTF8.self))
} catch {
    FileHandle.standardError.write(Data("图片无法识别，请使用清晰的 JPG、PNG 或 HEIC 图片。\n".utf8))
    exit(1)
}
