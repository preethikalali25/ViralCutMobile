#import <React/RCTBridgeModule.h>
#import <AVFoundation/AVFoundation.h>
#import <UIKit/UIKit.h>
#import <Photos/Photos.h>

@interface VideoTextOverlay : NSObject <RCTBridgeModule>
@end

@implementation VideoTextOverlay

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup { return NO; }

- (void)processVideoAtURL:(NSURL *)inputUrl
                     text:(NSString *)text
              originalUri:(NSString *)originalUri
                  resolve:(RCTPromiseResolveBlock)resolve {

  // Step 1: load asset metadata on a background thread (safe for AVFoundation)
  dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    AVURLAsset *asset    = [AVURLAsset URLAssetWithURL:inputUrl options:nil];
    NSArray *videoTracks = [asset tracksWithMediaType:AVMediaTypeVideo];
    if (!videoTracks.count) { resolve(originalUri); return; }

    AVAssetTrack *vTrack   = videoTracks.firstObject;
    CGSize naturalSize     = vTrack.naturalSize;
    CGAffineTransform pref = vTrack.preferredTransform;
    CMTime duration        = asset.duration;
    NSArray *audioTracks   = [asset tracksWithMediaType:AVMediaTypeAudio];
#pragma clang diagnostic pop

    CMTimeRange timeRange = CMTimeRangeMake(kCMTimeZero, duration);

    // Compute display size (handles portrait/landscape rotation)
    CGSize t = CGSizeApplyAffineTransform(naturalSize, pref);
    CGSize renderSize = CGSizeMake(fabs(t.width), fabs(t.height));
    if (renderSize.width < 1 || renderSize.height < 1) { resolve(originalUri); return; }

    // Build AVMutableComposition on background thread (AVFoundation is thread-safe)
    AVMutableComposition *comp = [AVMutableComposition composition];
    AVMutableCompositionTrack *cv =
      [comp addMutableTrackWithMediaType:AVMediaTypeVideo
                        preferredTrackID:kCMPersistentTrackID_Invalid];
    NSError *err = nil;
    [cv insertTimeRange:timeRange ofTrack:vTrack atTime:kCMTimeZero error:&err];
    if (err) { resolve(originalUri); return; }

    if (audioTracks.count) {
      AVMutableCompositionTrack *ca =
        [comp addMutableTrackWithMediaType:AVMediaTypeAudio
                          preferredTrackID:kCMPersistentTrackID_Invalid];
      [ca insertTimeRange:timeRange ofTrack:audioTracks.firstObject atTime:kCMTimeZero error:nil];
    }

    // Step 2: CALayer/CATextLayer MUST be created on the main thread
    dispatch_async(dispatch_get_main_queue(), ^{

      CGFloat fs  = renderSize.width * 0.072;
      CGFloat pad = renderSize.width * 0.045;
      CGFloat tw  = renderSize.width - pad * 2;
      CGFloat th  = fs * 2.4;

      CATextLayer *tl    = [CATextLayer layer];
      tl.string          = text;
      tl.foregroundColor = [UIColor whiteColor].CGColor;
      tl.backgroundColor = [UIColor colorWithRed:0 green:0 blue:0 alpha:0.55].CGColor;
      tl.alignmentMode   = kCAAlignmentCenter;
      tl.contentsScale   = 1.0;
      tl.wrapped         = YES;
      tl.font            = CFSTR("Helvetica-Bold");
      tl.fontSize        = fs;
      tl.cornerRadius    = 10;
      tl.masksToBounds   = YES;
      tl.frame           = CGRectMake(pad, 80, tw, th);

      CALayer *parent = [CALayer layer];
      CALayer *vLayer = [CALayer layer];
      parent.frame    = CGRectMake(0, 0, renderSize.width, renderSize.height);
      vLayer.frame    = CGRectMake(0, 0, renderSize.width, renderSize.height);
      [parent addSublayer:vLayer];
      [parent addSublayer:tl];

      // Wire layers into video composition
      AVMutableVideoComposition *vc = [AVMutableVideoComposition videoComposition];
      vc.frameDuration = CMTimeMake(1, 30);
      vc.renderSize    = renderSize;
      vc.animationTool =
        [AVVideoCompositionCoreAnimationTool
           videoCompositionCoreAnimationToolWithPostProcessingAsVideoLayer:vLayer
                                                                  inLayer:parent];

      AVMutableVideoCompositionInstruction *inst =
        [AVMutableVideoCompositionInstruction videoCompositionInstruction];
      inst.timeRange = timeRange;
      AVMutableVideoCompositionLayerInstruction *li =
        [AVMutableVideoCompositionLayerInstruction
           videoCompositionLayerInstructionWithAssetTrack:cv];
      [li setTransform:pref atTime:kCMTimeZero];
      inst.layerInstructions = @[li];
      vc.instructions = @[inst];

      // Export (runs asynchronously on its own internal thread)
      NSString *fname = [NSString stringWithFormat:@"hook_%ld.mp4",
                         (long)[[NSDate date] timeIntervalSince1970]];
      NSURL *out = [NSFileManager.defaultManager.temporaryDirectory
                    URLByAppendingPathComponent:fname];
      [NSFileManager.defaultManager removeItemAtURL:out error:nil];

      AVAssetExportSession *ses =
        [[AVAssetExportSession alloc] initWithAsset:comp
                                         presetName:AVAssetExportPresetHighestQuality];
      ses.outputURL        = out;
      ses.outputFileType   = AVFileTypeMPEG4;
      ses.videoComposition = vc;

      [ses exportAsynchronouslyWithCompletionHandler:^{
        if (ses.status == AVAssetExportSessionStatusCompleted) {
          resolve(out.absoluteString);
        } else {
          NSLog(@"[VideoTextOverlay] export failed: %@", ses.error.localizedDescription);
          resolve(originalUri);
        }
      }];
    }); // end main thread
  }); // end background thread
}

RCT_EXPORT_METHOD(burnText:(NSString *)videoUri
                  text:(NSString *)text
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {

  if ([[text stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]] length] == 0) {
    resolve(videoUri); return;
  }

  if ([videoUri hasPrefix:@"ph://"]) {
    NSString *localId = [[videoUri substringFromIndex:5] componentsSeparatedByString:@"?"].firstObject;
    PHFetchResult *r  = [PHAsset fetchAssetsWithLocalIdentifiers:@[localId] options:nil];
    PHAsset *phAsset  = r.firstObject;
    if (!phAsset || phAsset.mediaType != PHAssetMediaTypeVideo) { resolve(videoUri); return; }

    PHVideoRequestOptions *opts = [[PHVideoRequestOptions alloc] init];
    opts.version = PHVideoRequestOptionsVersionCurrent;
    opts.networkAccessAllowed = NO;
    [[PHImageManager defaultManager]
       requestAVAssetForVideo:phAsset options:opts
                resultHandler:^(AVAsset *av, AVAudioMix *mix, NSDictionary *info) {
      AVURLAsset *ua = (AVURLAsset *)av;
      if (!ua) { resolve(videoUri); return; }
      [self processVideoAtURL:ua.URL text:text originalUri:videoUri resolve:resolve];
    }];
  } else {
    NSURL *fileUrl = [videoUri hasPrefix:@"file://"]
      ? [NSURL URLWithString:videoUri]
      : [NSURL fileURLWithPath:videoUri];
    [self processVideoAtURL:fileUrl text:text originalUri:videoUri resolve:resolve];
  }
}

@end
