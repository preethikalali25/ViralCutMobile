import AVFoundation
import UIKit
import Foundation
import Photos

@objc(VideoTextOverlay)
class VideoTextOverlay: NSObject {

  @objc
  static func requiresMainQueueSetup() -> Bool { false }

  // Resolve ph:// and file:// URIs to a local file URL
  private func resolveToFileURL(_ uri: String, completion: @escaping (URL?) -> Void) {
    if uri.hasPrefix("ph://") {
      // Extract the local identifier (everything after "ph://")
      let raw = uri.dropFirst("ph://".count)
      let localId = String(raw.prefix(upTo: raw.firstIndex(of: "?") ?? raw.endIndex))
      let result = PHAsset.fetchAssets(withLocalIdentifiers: [localId], options: nil)
      guard let asset = result.firstObject, asset.mediaType == .video else {
        completion(nil); return
      }
      let opts = PHVideoRequestOptions()
      opts.version = .current
      opts.isNetworkAccessAllowed = false
      PHImageManager.default().requestAVAsset(forVideo: asset, options: opts) { av, _, _ in
        completion((av as? AVURLAsset)?.url)
      }
    } else if uri.hasPrefix("file://") {
      completion(URL(string: uri))
    } else {
      completion(URL(fileURLWithPath: uri))
    }
  }

  @objc
  func burnText(_ videoUri: String,
                text: String,
                resolver resolve: @escaping RCTPromiseResolveBlock,
                rejecter _: @escaping RCTPromiseRejectBlock) {

    guard !text.trimmingCharacters(in: .whitespaces).isEmpty else {
      resolve(videoUri); return
    }

    resolveToFileURL(videoUri) { [weak self] fileUrl in
      guard let self, let fileUrl else { resolve(videoUri); return }
      self.compose(inputUrl: fileUrl, text: text, originalUri: videoUri, resolve: resolve)
    }
  }

  private func compose(inputUrl: URL, text: String, originalUri: String,
                        resolve: @escaping RCTPromiseResolveBlock) {
    let asset = AVURLAsset(url: inputUrl)

    Task {
      do {
        let videoTracks = try await asset.loadTracks(withMediaType: .video)
        guard let videoTrack = videoTracks.first else { resolve(originalUri); return }

        let naturalSize   = try await videoTrack.load(.naturalSize)
        let prefTransform = try await videoTrack.load(.preferredTransform)
        let duration      = try await asset.load(.duration)
        let timeRange     = CMTimeRange(start: .zero, duration: duration)

        // Determine the final display size after rotation
        let renderSize = self.renderSize(naturalSize: naturalSize, transform: prefTransform)

        // Build composition
        let composition = AVMutableComposition()

        guard let compVideo = composition.addMutableTrack(
          withMediaType: .video,
          preferredTrackID: kCMPersistentTrackID_Invalid
        ) else { resolve(originalUri); return }
        try compVideo.insertTimeRange(timeRange, of: videoTrack, at: .zero)

        let audioTracks = try await asset.loadTracks(withMediaType: .audio)
        if let audioTrack = audioTracks.first,
           let compAudio = composition.addMutableTrack(
             withMediaType: .audio,
             preferredTrackID: kCMPersistentTrackID_Invalid) {
          try? compAudio.insertTimeRange(timeRange, of: audioTrack, at: .zero)
        }

        // Text layer — Core Animation y=0 is at the BOTTOM of the frame
        let fontSize   = renderSize.width * 0.072
        let padding    = renderSize.width * 0.045
        let textW      = renderSize.width - padding * 2
        let textH      = fontSize * 2.4
        let yFromBottom: CGFloat = 80

        let textLayer = CATextLayer()
        textLayer.string         = text
        textLayer.foregroundColor = UIColor.white.cgColor
        textLayer.backgroundColor = UIColor.black.withAlphaComponent(0.55).cgColor
        textLayer.alignmentMode  = .center
        textLayer.contentsScale  = 1.0
        textLayer.isWrapped      = true
        textLayer.font           = CTFontCreateWithName("Helvetica-Bold" as CFString, fontSize, nil)
        textLayer.fontSize       = fontSize
        textLayer.cornerRadius   = 10
        textLayer.masksToBounds  = true
        textLayer.frame          = CGRect(x: padding, y: yFromBottom, width: textW, height: textH)

        let parentLayer = CALayer()
        let videoLayer  = CALayer()
        parentLayer.frame = CGRect(origin: .zero, size: renderSize)
        videoLayer.frame  = CGRect(origin: .zero, size: renderSize)
        parentLayer.addSublayer(videoLayer)
        parentLayer.addSublayer(textLayer)

        // Video composition
        let videoComp = AVMutableVideoComposition()
        videoComp.frameDuration = CMTimeMake(value: 1, timescale: 30)
        videoComp.renderSize    = renderSize
        videoComp.animationTool = AVVideoCompositionCoreAnimationTool(
          postProcessingAsVideoLayer: videoLayer, in: parentLayer)

        let instruction = AVMutableVideoCompositionInstruction()
        instruction.timeRange = timeRange

        let layerInstr = AVMutableVideoCompositionLayerInstruction(assetTrack: compVideo)
        layerInstr.setTransform(prefTransform, at: .zero)
        instruction.layerInstructions = [layerInstr]
        videoComp.instructions = [instruction]

        // Export
        let outputUrl = FileManager.default.temporaryDirectory
          .appendingPathComponent("hook_\(Int(Date().timeIntervalSince1970)).mp4")
        try? FileManager.default.removeItem(at: outputUrl)

        guard let session = AVAssetExportSession(
          asset: composition,
          presetName: AVAssetExportPresetHighestQuality
        ) else { resolve(originalUri); return }

        session.outputURL       = outputUrl
        session.outputFileType  = .mp4
        session.videoComposition = videoComp

        await session.export()

        if session.status == .completed {
          resolve(outputUrl.absoluteString)
        } else {
          print("[VideoTextOverlay] export error:", session.error?.localizedDescription ?? "nil")
          resolve(originalUri)
        }

      } catch {
        print("[VideoTextOverlay] error:", error.localizedDescription)
        resolve(originalUri)
      }
    }
  }

  // Compute display size accounting for video rotation metadata
  private func renderSize(naturalSize: CGSize, transform: CGAffineTransform) -> CGSize {
    let s = naturalSize.applying(transform)
    return CGSize(width: abs(s.width), height: abs(s.height))
  }
}
