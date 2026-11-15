// Turn a folder of numbered PNG frames into an H.264 .mp4 with macOS's own encoder (no ffmpeg needed).
//
//     swift scripts/frames_to_mp4.swift <frames folder> <frames per second> <out.mp4> [megabits per second]
//
// The frames are read in name order and must all be the same size.

import AVFoundation
import CoreGraphics
import Foundation
import ImageIO

let args = CommandLine.arguments
guard args.count >= 4, let fps = Int32(args[2]) else {
    FileHandle.standardError.write("usage: frames_to_mp4.swift <frames folder> <fps> <out.mp4> [mbps]\n".data(using: .utf8)!)
    exit(2)
}
let folder = URL(fileURLWithPath: args[1])
let out = URL(fileURLWithPath: args[3])
let mbps = args.count > 4 ? Double(args[4]) ?? 16 : 16

let files = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
    .filter { $0.pathExtension.lowercased() == "png" }
    .sorted { $0.lastPathComponent < $1.lastPathComponent }
guard let first = files.first, let probe = CGImageSourceCreateWithURL(first as CFURL, nil),
      let firstImage = CGImageSourceCreateImageAtIndex(probe, 0, nil) else {
    FileHandle.standardError.write("no PNG frames in \(folder.path)\n".data(using: .utf8)!)
    exit(1)
}
let width = firstImage.width, height = firstImage.height

try? FileManager.default.removeItem(at: out)
let writer = try AVAssetWriter(outputURL: out, fileType: .mp4)
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: width,
    AVVideoHeightKey: height,
    AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: Int(mbps * 1_000_000),
        AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
        AVVideoExpectedSourceFrameRateKey: fps,
        AVVideoMaxKeyFrameIntervalKey: fps * 2,
    ],
])
input.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    kCVPixelBufferWidthKey as String: width,
    kCVPixelBufferHeightKey as String: height,
])
writer.add(input)
guard writer.startWriting() else {
    FileHandle.standardError.write("cannot start writing: \(String(describing: writer.error))\n".data(using: .utf8)!)
    exit(1)
}
writer.startSession(atSourceTime: .zero)

let space = CGColorSpace(name: CGColorSpace.sRGB)!
for (i, file) in files.enumerated() {
    guard let source = CGImageSourceCreateWithURL(file as CFURL, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
          image.width == width, image.height == height, let pool = adaptor.pixelBufferPool else {
        FileHandle.standardError.write("frame \(file.lastPathComponent) cannot be read or has another size\n".data(using: .utf8)!)
        exit(1)
    }
    var made: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(nil, pool, &made)
    guard let buffer = made else { exit(1) }
    CVPixelBufferLockBaseAddress(buffer, [])
    let context = CGContext(data: CVPixelBufferGetBaseAddress(buffer), width: width, height: height, bitsPerComponent: 8,
                            bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: space,
                            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    CVPixelBufferUnlockBaseAddress(buffer, [])
    while !input.isReadyForMoreMediaData { usleep(2000) }
    if !adaptor.append(buffer, withPresentationTime: CMTime(value: CMTimeValue(i), timescale: fps)) {
        FileHandle.standardError.write("frame \(i) was refused: \(String(describing: writer.error))\n".data(using: .utf8)!)
        exit(1)
    }
}
input.markAsFinished()
let done = DispatchSemaphore(value: 0)
writer.finishWriting { done.signal() }
done.wait()
guard writer.status == .completed else {
    FileHandle.standardError.write("the file was not finished: \(String(describing: writer.error))\n".data(using: .utf8)!)
    exit(1)
}
print("\(files.count) frames, \(width)x\(height), \(fps) fps -> \(out.path)")
