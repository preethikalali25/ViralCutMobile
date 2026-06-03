#import <React/RCTBridgeModule.h>
#import <AVFoundation/AVFoundation.h>
#import <UIKit/UIKit.h>
#import <Photos/Photos.h>
#import <Accelerate/Accelerate.h>

// ---------------------------------------------------------------------------
// Compositor instruction — carries text/style + vImage rotation constant.
// ---------------------------------------------------------------------------

@interface VTOCompositorInstruction : NSObject <AVVideoCompositionInstruction>
@property (nonatomic) CMTimeRange          timeRange;
@property (nonatomic) BOOL                 enablePostProcessing;
@property (nonatomic) BOOL                 containsTweening;
@property (nonatomic, strong) NSString    *text;
@property (nonatomic)         CGFloat      fontSize;
@property (nonatomic)         CGFloat      padX;
@property (nonatomic)         CGFloat      padY;
@property (nonatomic)         CMPersistentTrackID trackID;
// vImage rotation constants: 0=0° 1=90°CCW 2=180° 3=90°CW
@property (nonatomic)         uint8_t      vRotation;
@end

@implementation VTOCompositorInstruction

- (NSArray<NSValue *> *)requiredSourceTrackIDs { return @[@(_trackID)]; }
- (CMPersistentTrackID)passthroughTrackID      { return kCMPersistentTrackID_Invalid; }

- (instancetype)initWithText:(NSString *)text
                    fontSize:(CGFloat)fs
                        padX:(CGFloat)px
                        padY:(CGFloat)py
                     trackID:(CMPersistentTrackID)tid
                   timeRange:(CMTimeRange)range
                   vRotation:(uint8_t)rot {
    self = [super init];
    _text = text; _fontSize = fs; _padX = px; _padY = py;
    _trackID = tid; _timeRange = range; _vRotation = rot;
    _enablePostProcessing = NO; _containsTweening = NO;
    return self;
}

@end

// ---------------------------------------------------------------------------
// Custom compositor — 100% CPU, zero CALayer / IOSurface / XPC.
//
// Per-frame pipeline:
//   1. Lock src + dst pixel buffers.
//   2. Rotate src into dst using vImageRotate90_ARGB8888 (Accelerate).
//      For landscape src / portrait dst this handles the 90° rotation that
//      AVFoundation's preferredTransform requests.
//   3. Draw text on the dst buffer with a CGBitmapContext.
//   4. Unlock, finish request.
// ---------------------------------------------------------------------------

@interface VTOCompositor : NSObject <AVVideoCompositing>
@end

@implementation VTOCompositor {
    dispatch_queue_t _queue;
}

- (instancetype)init {
    self = [super init];
    _queue = dispatch_queue_create("vto.compositor", DISPATCH_QUEUE_SERIAL);
    return self;
}

- (NSDictionary *)sourcePixelBufferAttributes {
    return @{ (NSString *)kCVPixelBufferPixelFormatTypeKey: @[@(kCVPixelFormatType_32BGRA)] };
}
- (NSDictionary *)requiredPixelBufferAttributesForRenderContext {
    return @{ (NSString *)kCVPixelBufferPixelFormatTypeKey: @[@(kCVPixelFormatType_32BGRA)] };
}
- (void)renderContextChanged:(AVVideoCompositionRenderContext *)newRenderContext {}

- (void)startVideoCompositionRequest:(AVAsynchronousVideoCompositionRequest *)request {
    dispatch_async(_queue, ^{ [self _handleRequest:request]; });
}

- (void)_handleRequest:(AVAsynchronousVideoCompositionRequest *)request {
    VTOCompositorInstruction *inst =
        (VTOCompositorInstruction *)request.videoCompositionInstruction;

    CVPixelBufferRef src = [request sourceFrameByTrackID:inst.trackID];
    if (!src) {
        [request finishWithError:[NSError errorWithDomain:@"VTO" code:1 userInfo:nil]];
        return;
    }

    CVPixelBufferRef dst = [request.renderContext newPixelBuffer];
    if (!dst) {
        [request finishWithError:[NSError errorWithDomain:@"VTO" code:2 userInfo:nil]];
        return;
    }

    CVPixelBufferLockBaseAddress(src, kCVPixelBufferLock_ReadOnly);
    CVPixelBufferLockBaseAddress(dst, 0);

    size_t srcW   = CVPixelBufferGetWidth(src);
    size_t srcH   = CVPixelBufferGetHeight(src);
    size_t srcBpr = CVPixelBufferGetBytesPerRow(src);
    void  *srcPtr = CVPixelBufferGetBaseAddress(src);

    size_t dstW   = CVPixelBufferGetWidth(dst);
    size_t dstH   = CVPixelBufferGetHeight(dst);
    size_t dstBpr = CVPixelBufferGetBytesPerRow(dst);
    void  *dstPtr = CVPixelBufferGetBaseAddress(dst);

    // ------------------------------------------------------------------
    // Step 1: Rotate / copy source pixels into destination.
    // vImageRotate90_ARGB8888 treats every 4-byte pixel as an opaque unit,
    // so it works identically for BGRA buffers.
    // ------------------------------------------------------------------
    vImage_Buffer srcVImg = { srcPtr, srcH, srcW, srcBpr };
    vImage_Buffer dstVImg = { dstPtr, dstH, dstW, dstBpr };
    uint8_t bg[4] = { 0, 0, 0, 255 };

    if (inst.vRotation == 0) {
        // Identity — plain row copy (src and dst should be the same size)
        size_t rows = MIN(srcH, dstH);
        size_t bpr  = MIN(srcBpr, dstBpr);
        for (size_t r = 0; r < rows; r++) {
            memcpy((uint8_t *)dstPtr + r * dstBpr,
                   (uint8_t *)srcPtr + r * srcBpr, bpr);
        }
    } else {
        vImageRotate90_ARGB8888(&srcVImg, &dstVImg, inst.vRotation, bg, 0);
    }

    // ------------------------------------------------------------------
    // Step 2: Draw text overlay with CoreGraphics on the rotated frame.
    // CGBitmapContext writes directly to the dst pixel buffer memory.
    // kCGBitmapByteOrder32Little | kCGImageAlphaPremultipliedFirst = BGRA.
    // ------------------------------------------------------------------
    CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
    CGBitmapInfo bi = (CGBitmapInfo)(kCGBitmapByteOrder32Little |
                                     kCGImageAlphaPremultipliedFirst);
    CGContextRef ctx = CGBitmapContextCreate(dstPtr, dstW, dstH, 8, dstBpr, cs, bi);
    CGColorSpaceRelease(cs);

    if (ctx) {
        CGFloat fs = inst.fontSize;
        CGFloat px = inst.padX;
        CGFloat py = inst.padY;
        CGFloat tw = (CGFloat)dstW - px * 2.0;
        CGFloat radius  = 10.0;
        CGFloat innerPad = 8.0;   // horizontal inset inside box
        CGFloat vPadding = fs * 0.6; // vertical padding inside box (top + bottom)

        NSMutableParagraphStyle *ps = [[NSMutableParagraphStyle alloc] init];
        ps.alignment     = NSTextAlignmentCenter;
        ps.lineBreakMode = NSLineBreakByWordWrapping;
        NSDictionary *attrs = @{
            NSFontAttributeName:            [UIFont boldSystemFontOfSize:fs],
            NSForegroundColorAttributeName: [UIColor whiteColor],
            NSParagraphStyleAttributeName:  ps
        };

        // Measure text to get the exact height needed for this hook text.
        CGFloat textWidth = tw - innerPad * 2.0;
        CGRect measured = [inst.text
            boundingRectWithSize:CGSizeMake(textWidth, CGFLOAT_MAX)
                         options:NSStringDrawingUsesLineFragmentOrigin | NSStringDrawingUsesFontLeading
                      attributes:attrs
                         context:nil];
        CGFloat textH = ceil(measured.size.height);
        CGFloat th    = textH + vPadding;   // box height sized to content

        // CG origin is bottom-left; position box near top of frame.
        CGFloat boxY    = (CGFloat)dstH - py - th;
        CGRect  boxRect = CGRectMake(px, boxY, tw, th);

        // Semi-transparent rounded background
        CGContextSetRGBFillColor(ctx, 0, 0, 0, 0.55);
        CGContextBeginPath(ctx);
        CGContextMoveToPoint   (ctx, CGRectGetMinX(boxRect) + radius, CGRectGetMinY(boxRect));
        CGContextAddArcToPoint (ctx, CGRectGetMaxX(boxRect), CGRectGetMinY(boxRect),
                                     CGRectGetMaxX(boxRect), CGRectGetMinY(boxRect) + radius, radius);
        CGContextAddArcToPoint (ctx, CGRectGetMaxX(boxRect), CGRectGetMaxY(boxRect),
                                     CGRectGetMaxX(boxRect) - radius, CGRectGetMaxY(boxRect), radius);
        CGContextAddArcToPoint (ctx, CGRectGetMinX(boxRect), CGRectGetMaxY(boxRect),
                                     CGRectGetMinX(boxRect), CGRectGetMaxY(boxRect) - radius, radius);
        CGContextAddArcToPoint (ctx, CGRectGetMinX(boxRect), CGRectGetMinY(boxRect),
                                     CGRectGetMinX(boxRect) + radius, CGRectGetMinY(boxRect), radius);
        CGContextClosePath(ctx);
        CGContextFillPath(ctx);

        // Flip ctx to UIKit's top-left origin so NSString drawing works.
        // After the flip, the box occupies (px, py, tw, th) in UIKit coords.
        CGContextSaveGState(ctx);
        CGContextTranslateCTM(ctx, 0, (CGFloat)dstH);
        CGContextScaleCTM(ctx, 1.0, -1.0);

        CGFloat vOff    = (vPadding / 2.0);   // center text vertically in box
        CGRect  textRect = CGRectMake(px + innerPad,
                                      py + vOff,
                                      textWidth,
                                      textH);
        UIGraphicsPushContext(ctx);
        [inst.text drawInRect:textRect withAttributes:attrs];
        UIGraphicsPopContext();

        CGContextRestoreGState(ctx);
        CGContextRelease(ctx);
    }

    CVPixelBufferUnlockBaseAddress(dst, 0);
    CVPixelBufferUnlockBaseAddress(src, kCVPixelBufferLock_ReadOnly);

    [request finishWithComposedVideoFrame:dst];
    CVPixelBufferRelease(dst);
}

- (void)cancelAllPendingVideoCompositionRequests {}

@end

// ---------------------------------------------------------------------------
// React Native module
// ---------------------------------------------------------------------------

@interface VideoTextOverlay : NSObject <RCTBridgeModule>
@end

@implementation VideoTextOverlay

RCT_EXPORT_MODULE();
+ (BOOL)requiresMainQueueSetup { return NO; }

// Derive vImage rotation constant from AVFoundation's preferredTransform.
// vImageRotate90_ARGB8888 constants: 0=0° 1=90°CW 2=180° 3=90°CCW
//   b > 0, c < 0  =>  90° CCW needed  =>  vImage constant 3
//   b < 0, c > 0  =>  90° CW  needed  =>  vImage constant 1
//   a < 0, d < 0  =>  180°             =>  vImage constant 2
+ (uint8_t)vRotationForTransform:(CGAffineTransform)t {
    if (fabs(t.b) > 0.5) return (t.b > 0) ? 3 : 1;
    if (t.a < -0.5)      return 2;
    return 0;
}

// Core processing — accepts any AVAsset (AVURLAsset, AVComposition, etc.)
// Using the asset directly preserves Photos sandbox access rights for audio.
//
// Two-step export to avoid AVAssetExportSession silently dropping audioMix
// when a customVideoCompositorClass is also set on the same session:
//   Step 1 — video-only composition + custom compositor → rotated + text temp file
//   Step 2 — step1 video + original audio + bg audio, NO videoComposition → final file
- (void)processAsset:(AVAsset *)asset
                text:(NSString *)text
  backgroundAudioUri:(NSString *)backgroundAudioUri
      originalVolume:(float)originalVolume
            bgVolume:(float)bgVolume
         originalUri:(NSString *)originalUri
             resolve:(RCTPromiseResolveBlock)resolve {

    dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
        @try {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
            NSArray *videoTracks = [asset tracksWithMediaType:AVMediaTypeVideo];
            if (!videoTracks.count) { resolve(originalUri); return; }

            AVAssetTrack *vTrack   = videoTracks.firstObject;
            CGSize naturalSize     = vTrack.naturalSize;
            CGAffineTransform pref = vTrack.preferredTransform;
            CMTime duration        = asset.duration;
            NSArray *audioTracks   = [asset tracksWithMediaType:AVMediaTypeAudio];
#pragma clang diagnostic pop

            CMTimeRange timeRange = CMTimeRangeMake(kCMTimeZero, duration);

            CGSize ts = CGSizeApplyAffineTransform(naturalSize, pref);
            CGSize renderSize = CGSizeMake(fabs(ts.width), fabs(ts.height));
            if (renderSize.width < 1 || renderSize.height < 1) { resolve(originalUri); return; }

            // ---------------------------------------------------------------
            // STEP 1 — video-only + custom compositor (rotation + text)
            // Audio intentionally excluded so the custom compositor has no
            // conflict with audioMix during export.
            // ---------------------------------------------------------------
            AVMutableComposition *comp1 = [AVMutableComposition composition];
            AVMutableCompositionTrack *cv =
                [comp1 addMutableTrackWithMediaType:AVMediaTypeVideo
                                   preferredTrackID:kCMPersistentTrackID_Invalid];
            if (!cv) { resolve(originalUri); return; }
            NSError *err = nil;
            [cv insertTimeRange:timeRange ofTrack:vTrack atTime:kCMTimeZero error:&err];
            if (err) { resolve(originalUri); return; }
            // Pixels are already rotated by vImage; clear track transform so
            // players don't apply the rotation a second time.
            [cv setPreferredTransform:CGAffineTransformIdentity];

            uint8_t vRot = [VideoTextOverlay vRotationForTransform:pref];
            CGFloat fs   = renderSize.width * 0.072;
            CGFloat pad  = renderSize.width * 0.045;

            VTOCompositorInstruction *inst =
                [[VTOCompositorInstruction alloc] initWithText:text
                                                      fontSize:fs
                                                          padX:pad
                                                          padY:pad
                                                       trackID:cv.trackID
                                                     timeRange:timeRange
                                                     vRotation:vRot];

            AVMutableVideoComposition *vc = [AVMutableVideoComposition videoComposition];
            vc.customVideoCompositorClass = [VTOCompositor class];
            vc.frameDuration = CMTimeMake(1, 30);
            vc.renderSize    = renderSize;
            vc.instructions  = @[inst];

            long ts1 = (long)[[NSDate date] timeIntervalSince1970];
            NSURL *temp1 = [NSFileManager.defaultManager.temporaryDirectory
                            URLByAppendingPathComponent:
                                [NSString stringWithFormat:@"hook_step1_%ld.mp4", ts1]];
            [NSFileManager.defaultManager removeItemAtURL:temp1 error:nil];

            AVAssetExportSession *ses1 =
                [[AVAssetExportSession alloc] initWithAsset:comp1
                                                 presetName:AVAssetExportPresetHighestQuality];
            if (!ses1) { resolve(originalUri); return; }
            ses1.outputURL        = temp1;
            ses1.outputFileType   = AVFileTypeMPEG4;
            ses1.videoComposition = vc; // custom compositor, no audioMix

            dispatch_semaphore_t step1Sema = dispatch_semaphore_create(0);
            __block BOOL step1OK = NO;
            [ses1 exportAsynchronouslyWithCompletionHandler:^{
                step1OK = (ses1.status == AVAssetExportSessionStatusCompleted);
                if (!step1OK) {
                    NSLog(@"[VideoTextOverlay] step1 export error: %@",
                          ses1.error.localizedDescription);
                }
                dispatch_semaphore_signal(step1Sema);
            }];
            dispatch_semaphore_wait(step1Sema,
                dispatch_time(DISPATCH_TIME_NOW, (int64_t)(120 * NSEC_PER_SEC)));

            if (!step1OK) { resolve(originalUri); return; }

            // ---------------------------------------------------------------
            // STEP 2 — audio mixing, NO custom compositor
            // videoComposition is NOT set so audioMix is guaranteed to apply.
            // Video source = step1 output (already rotated + text burned).
            // ---------------------------------------------------------------
            AVURLAsset *step1Asset = [AVURLAsset URLAssetWithURL:temp1 options:nil];
            dispatch_semaphore_t s1Sema = dispatch_semaphore_create(0);
            [step1Asset loadValuesAsynchronouslyForKeys:@[@"tracks"] completionHandler:^{
                dispatch_semaphore_signal(s1Sema);
            }];
            dispatch_semaphore_wait(s1Sema,
                dispatch_time(DISPATCH_TIME_NOW, (int64_t)(10 * NSEC_PER_SEC)));

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
            NSArray *step1VideoTracks = [step1Asset tracksWithMediaType:AVMediaTypeVideo];
#pragma clang diagnostic pop
            if (!step1VideoTracks.count) {
                // Step 1 output has no video — return it as-is (video+text, no audio)
                resolve(temp1.absoluteString);
                return;
            }

            AVMutableComposition *comp2 = [AVMutableComposition composition];
            AVMutableCompositionTrack *cv2 =
                [comp2 addMutableTrackWithMediaType:AVMediaTypeVideo
                                   preferredTrackID:kCMPersistentTrackID_Invalid];
            NSError *v2Err = nil;
            [cv2 insertTimeRange:timeRange ofTrack:step1VideoTracks.firstObject
                          atTime:kCMTimeZero error:&v2Err];
            if (v2Err) { resolve(temp1.absoluteString); return; }

            // Original audio from the source asset (not from step1, which has none).
            AVMutableCompositionTrack *ca2 = nil;
            if (audioTracks.count) {
                AVAssetTrack *aTrack = audioTracks.firstObject;
                ca2 = [comp2 addMutableTrackWithMediaType:AVMediaTypeAudio
                                          preferredTrackID:kCMPersistentTrackID_Invalid];
                CMTime audioDur = CMTimeMinimum(aTrack.timeRange.duration, duration);
                NSError *aErr = nil;
                [ca2 insertTimeRange:CMTimeRangeMake(kCMTimeZero, audioDur)
                             ofTrack:aTrack atTime:kCMTimeZero error:&aErr];
                if (aErr) {
                    NSLog(@"[VideoTextOverlay] step2 orig audio insert error: %@",
                          aErr.localizedDescription);
                    ca2 = nil;
                }
            } else {
                NSLog(@"[VideoTextOverlay] no audio tracks in source asset");
            }

            // Background music — loop to fill video duration.
            AVMutableCompositionTrack *bgAudio2 = nil;
            if (backgroundAudioUri.length > 0) {
                // Primary URL from file:// string; if URLWithString: returns nil
                // (e.g. unencoded '@' from Expo path), decode and retry with fileURLWithPath:.
                NSURL *bgUrl = [backgroundAudioUri hasPrefix:@"file://"]
                    ? [NSURL URLWithString:backgroundAudioUri]
                    : [NSURL fileURLWithPath:backgroundAudioUri];

                if (!bgUrl && [backgroundAudioUri hasPrefix:@"file://"]) {
                    NSString *decoded = [[backgroundAudioUri substringFromIndex:7]
                                        stringByRemovingPercentEncoding];
                    if (decoded) bgUrl = [NSURL fileURLWithPath:decoded];
                    NSLog(@"[VideoTextOverlay] ⚠ bgUrl nil from URLWithString, fallback path=%@", decoded);
                }

                NSLog(@"[VideoTextOverlay] bgUrl=%@", bgUrl ?: @"NIL");

                if (bgUrl) {
                    NSString *bgPath = bgUrl.path;
                    NSLog(@"[VideoTextOverlay] bgPath=%@", bgPath);

                    NSError *attrErr = nil;
                    NSDictionary *attrs = [[NSFileManager defaultManager]
                                          attributesOfItemAtPath:bgPath error:&attrErr];
                    long long fileSize = [[attrs objectForKey:NSFileSize] longLongValue];
                    BOOL fileExists = [[NSFileManager defaultManager] fileExistsAtPath:bgPath];
                    NSLog(@"[VideoTextOverlay] bg file: exists=%@ size=%lld attrErr=%@",
                          fileExists ? @"YES" : @"NO", fileSize, attrErr.localizedDescription);

                    if (!fileExists || fileSize < 1000) {
                        NSLog(@"[VideoTextOverlay] ⚠ bg file missing or too small — skipping");
                    } else {
                        AVURLAsset *bgAsset = [AVURLAsset URLAssetWithURL:bgUrl options:nil];
                        dispatch_semaphore_t bgSema = dispatch_semaphore_create(0);
                        [bgAsset loadValuesAsynchronouslyForKeys:@[@"tracks"] completionHandler:^{
                            dispatch_semaphore_signal(bgSema);
                        }];
                        intptr_t bgWait = dispatch_semaphore_wait(bgSema,
                            dispatch_time(DISPATCH_TIME_NOW, (int64_t)(8 * NSEC_PER_SEC)));
                        NSLog(@"[VideoTextOverlay] bg load: %s", bgWait == 0 ? "signaled" : "TIMED OUT");

                        NSError *bgLoadErr = nil;
                        AVKeyValueStatus bgStatus = [bgAsset statusOfValueForKey:@"tracks"
                                                                           error:&bgLoadErr];
                        NSLog(@"[VideoTextOverlay] bg status=%ld err=%@",
                              (long)bgStatus, bgLoadErr.localizedDescription);

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
                        NSArray *bgTracks = [bgAsset tracksWithMediaType:AVMediaTypeAudio];
#pragma clang diagnostic pop
                        NSLog(@"[VideoTextOverlay] bg audio tracks=%lu", (unsigned long)bgTracks.count);

                        if (bgTracks.count > 0) {
                            bgAudio2 = [comp2 addMutableTrackWithMediaType:AVMediaTypeAudio
                                                           preferredTrackID:kCMPersistentTrackID_Invalid];
                            AVAssetTrack *bgTrack = bgTracks.firstObject;
                            CMTime bgDur = bgTrack.timeRange.duration;
                            CMTime insertAt = kCMTimeZero;
                            int loopCount = 0;
                            while (CMTimeCompare(insertAt, duration) < 0) {
                                CMTime remaining = CMTimeSubtract(duration, insertAt);
                                CMTime seg = CMTimeMinimum(bgDur, remaining);
                                NSError *bgErr = nil;
                                [bgAudio2 insertTimeRange:CMTimeRangeMake(kCMTimeZero, seg)
                                                  ofTrack:bgTrack atTime:insertAt error:&bgErr];
                                if (bgErr) {
                                    NSLog(@"[VideoTextOverlay] bg insert error loop=%d: %@",
                                          loopCount, bgErr.localizedDescription);
                                    break;
                                }
                                insertAt = CMTimeAdd(insertAt, seg);
                                loopCount++;
                            }
                            NSLog(@"[VideoTextOverlay] bg inserted: %d loops, dur=%.1fs",
                                  loopCount, CMTimeGetSeconds(duration));
                        } else {
                            NSLog(@"[VideoTextOverlay] ⚠ bg 0 audio tracks (corrupt/unsupported?)");
                        }
                    }
                } else {
                    NSLog(@"[VideoTextOverlay] ⚠ bgUrl is nil for URI=%@", backgroundAudioUri);
                }
            }

            NSURL *out = [NSFileManager.defaultManager.temporaryDirectory
                          URLByAppendingPathComponent:
                              [NSString stringWithFormat:@"hook_%ld.mp4", ts1 + 1]];
            [NSFileManager.defaultManager removeItemAtURL:out error:nil];

            NSLog(@"[VideoTextOverlay] step2: ca2=%@ bgAudio2=%@ bgURI=%@",
                  ca2 ? @"YES" : @"NO",
                  bgAudio2 ? @"YES" : @"NO",
                  backgroundAudioUri.length ? backgroundAudioUri : @"(empty)");

            AVAssetExportSession *ses2 =
                [[AVAssetExportSession alloc] initWithAsset:comp2
                                                 presetName:AVAssetExportPresetHighestQuality];
            if (!ses2) { resolve(temp1.absoluteString); return; }
            ses2.outputURL      = out;
            ses2.outputFileType = AVFileTypeMPEG4;
            // videoComposition intentionally NOT set — audioMix works reliably without it

            // Use volume ramps over the full duration — more reliable than setVolume:atTime:
            // for ensuring the volume is applied to every sample buffer.
            CMTimeRange fullRange = CMTimeRangeMake(kCMTimeZero, duration);
            if (ca2 || bgAudio2) {
                NSMutableArray *params = [NSMutableArray array];
                if (ca2) {
                    float vol = bgAudio2 ? originalVolume : 1.0f;
                    AVMutableAudioMixInputParameters *p =
                        [AVMutableAudioMixInputParameters audioMixInputParametersWithTrack:ca2];
                    [p setVolumeRampFromStartVolume:vol toEndVolume:vol timeRange:fullRange];
                    [params addObject:p];
                    NSLog(@"[VideoTextOverlay] orig vol=%.2f", vol);
                }
                if (bgAudio2) {
                    AVMutableAudioMixInputParameters *p =
                        [AVMutableAudioMixInputParameters audioMixInputParametersWithTrack:bgAudio2];
                    [p setVolumeRampFromStartVolume:bgVolume toEndVolume:bgVolume timeRange:fullRange];
                    [params addObject:p];
                    NSLog(@"[VideoTextOverlay] bg vol=%.2f", bgVolume);
                }
                AVMutableAudioMix *audioMix = [AVMutableAudioMix audioMix];
                audioMix.inputParameters = params;
                ses2.audioMix = audioMix;
            }

            [ses2 exportAsynchronouslyWithCompletionHandler:^{
                if (ses2.status == AVAssetExportSessionStatusCompleted) {
                    [NSFileManager.defaultManager removeItemAtURL:temp1 error:nil];
                    NSLog(@"[VideoTextOverlay] step2 DONE → %@", out.absoluteString);
                    resolve(out.absoluteString);
                } else {
                    NSLog(@"[VideoTextOverlay] step2 FAILED: %@", ses2.error.localizedDescription);
                    // Fall back to step1 result (text+video, no audio mix)
                    resolve(temp1.absoluteString);
                }
            }];

        } @catch (NSException *e) {
            NSLog(@"[VideoTextOverlay] exception: %@ — %@", e.name, e.reason);
            resolve(originalUri);
        }
    });
}

- (void)processVideoAtURL:(NSURL *)inputUrl
                     text:(NSString *)text
       backgroundAudioUri:(NSString *)backgroundAudioUri
           originalVolume:(float)originalVolume
                 bgVolume:(float)bgVolume
              originalUri:(NSString *)originalUri
                  resolve:(RCTPromiseResolveBlock)resolve {
    AVURLAsset *asset = [AVURLAsset URLAssetWithURL:inputUrl options:nil];
    if (!asset) { resolve(originalUri); return; }
    [self processAsset:asset text:text backgroundAudioUri:backgroundAudioUri
        originalVolume:originalVolume bgVolume:bgVolume
           originalUri:originalUri resolve:resolve];
}

RCT_EXPORT_METHOD(burnText:(NSString *)videoUri
                  text:(NSString *)text
                  backgroundAudioUri:(NSString *)backgroundAudioUri
                  originalVolume:(nonnull NSNumber *)originalVolumeNum
                  bgVolume:(nonnull NSNumber *)bgVolumeNum
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {

    NSString *bg = backgroundAudioUri ?: @"";
    float origVol = [originalVolumeNum floatValue];
    float bgVol   = [bgVolumeNum floatValue];
    NSLog(@"[VideoTextOverlay] v5 burnText — bgLen=%lu origVol=%.2f bgVol=%.2f",
          (unsigned long)bg.length, origVol, bgVol);

    if (!videoUri || (!text.length && !bg.length)) {
        resolve(videoUri ?: @""); return;
    }

    if ([videoUri hasPrefix:@"ph://"]) {
        NSString *localId = [[videoUri substringFromIndex:5]
                             componentsSeparatedByString:@"?"].firstObject;
        PHFetchResult *r = [PHAsset fetchAssetsWithLocalIdentifiers:@[localId] options:nil];
        PHAsset *phAsset = r.firstObject;
        if (!phAsset || phAsset.mediaType != PHAssetMediaTypeVideo) { resolve(videoUri); return; }

        PHVideoRequestOptions *opts = [[PHVideoRequestOptions alloc] init];
        opts.version              = PHVideoRequestOptionsVersionCurrent;
        opts.networkAccessAllowed = NO;
        [[PHImageManager defaultManager]
           requestAVAssetForVideo:phAsset options:opts
                    resultHandler:^(AVAsset *av, AVAudioMix *mix, NSDictionary *info) {
            if (!av) { resolve(videoUri); return; }
            [self processAsset:av text:text backgroundAudioUri:bg
                originalVolume:origVol bgVolume:bgVol
                   originalUri:videoUri resolve:resolve];
        }];
    } else {
        NSURL *fileUrl = [videoUri hasPrefix:@"file://"]
            ? [NSURL URLWithString:videoUri]
            : [NSURL fileURLWithPath:videoUri];
        if (!fileUrl) { resolve(videoUri); return; }
        [self processVideoAtURL:fileUrl text:text backgroundAudioUri:bg
             originalVolume:origVol bgVolume:bgVol
                originalUri:videoUri resolve:resolve];
    }
}

// ---------------------------------------------------------------------------
// Photo → Video: renders each photo as an aspect-fill frame at 1080×1920.
// ---------------------------------------------------------------------------

- (CVPixelBufferRef)createPixelBufferFromImage:(UIImage *)image targetSize:(CGSize)targetSize {
    CVPixelBufferRef pb = NULL;
    NSDictionary *opts = @{
        (NSString *)kCVPixelBufferCGImageCompatibilityKey: @YES,
        (NSString *)kCVPixelBufferCGBitmapContextCompatibilityKey: @YES,
    };
    CVReturn status = CVPixelBufferCreate(kCFAllocatorDefault,
                                         (size_t)targetSize.width, (size_t)targetSize.height,
                                         kCVPixelFormatType_32BGRA,
                                         (__bridge CFDictionaryRef)opts, &pb);
    if (status != kCVReturnSuccess || !pb) return NULL;

    CVPixelBufferLockBaseAddress(pb, 0);
    void *base = CVPixelBufferGetBaseAddress(pb);
    size_t bpr  = CVPixelBufferGetBytesPerRow(pb);

    CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
    CGContextRef ctx = CGBitmapContextCreate(base,
                                             (size_t)targetSize.width, (size_t)targetSize.height,
                                             8, bpr, cs,
                                             kCGBitmapByteOrder32Little | kCGImageAlphaPremultipliedFirst);
    CGColorSpaceRelease(cs);
    if (!ctx) { CVPixelBufferUnlockBaseAddress(pb, 0); CVPixelBufferRelease(pb); return NULL; }

    // Black background
    CGContextSetFillColorWithColor(ctx, UIColor.blackColor.CGColor);
    CGContextFillRect(ctx, CGRectMake(0, 0, targetSize.width, targetSize.height));

    // Aspect-fill: scale so image fills target, centre-crop
    CGFloat iw = image.size.width, ih = image.size.height;
    CGFloat tw = targetSize.width,  th = targetSize.height;
    CGFloat scale = (iw / ih > tw / th) ? (th / ih) : (tw / iw);
    CGFloat ox = (tw - iw * scale) / 2.0;
    CGFloat oy = (th - ih * scale) / 2.0;

    // CGBitmapContext origin is bottom-left; flip Y before drawing
    CGContextTranslateCTM(ctx, 0, th);
    CGContextScaleCTM(ctx, 1, -1);
    CGContextDrawImage(ctx, CGRectMake(ox, oy, iw * scale, ih * scale), image.CGImage);

    CGContextRelease(ctx);
    CVPixelBufferUnlockBaseAddress(pb, 0);
    return pb;
}

// ---------------------------------------------------------------------------
// Combined media (photos + video clips) → single 1080×1920 MP4.
// Each item is { "uri": "...", "type": "photo"|"video" }.
// Videos are frame-sampled at 30 fps (max 15 s each) so they scale correctly.
// ---------------------------------------------------------------------------

RCT_EXPORT_METHOD(combineMediaToVideo:(NSArray<NSDictionary *> *)mediaItems
                  durationPerPhoto:(nonnull NSNumber *)durationNum
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {

    if (!mediaItems || mediaItems.count == 0) {
        reject(@"combine_media", @"No media items provided", nil);
        return;
    }

    dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
        float secPerPhoto   = MAX([durationNum floatValue], 0.5f);
        const int32_t fps   = 30;
        const float maxVSec = 15.0f;
        CGSize sz           = CGSizeMake(1080, 1920);

        NSString *outPath = [NSTemporaryDirectory() stringByAppendingPathComponent:
            [NSString stringWithFormat:@"combined_%lld.mp4",
             (long long)([[NSDate date] timeIntervalSince1970] * 1000)]];
        NSURL *outUrl = [NSURL fileURLWithPath:outPath];
        [[NSFileManager defaultManager] removeItemAtURL:outUrl error:nil];

        NSError *wErr = nil;
        AVAssetWriter *writer = [AVAssetWriter assetWriterWithURL:outUrl
                                                         fileType:AVFileTypeMPEG4 error:&wErr];
        if (!writer) { reject(@"combine_media", @"Could not create writer", wErr); return; }

        NSDictionary *vSettings = @{
            AVVideoCodecKey: AVVideoCodecTypeH264,
            AVVideoWidthKey: @((int)sz.width),
            AVVideoHeightKey: @((int)sz.height),
            AVVideoCompressionPropertiesKey: @{
                AVVideoAverageBitRateKey: @5000000,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            }
        };
        AVAssetWriterInput *vIn = [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeVideo
                                                                     outputSettings:vSettings];
        vIn.expectsMediaDataInRealTime = NO;
        AVAssetWriterInputPixelBufferAdaptor *adaptor =
            [AVAssetWriterInputPixelBufferAdaptor
                assetWriterInputPixelBufferAdaptorWithAssetWriterInput:vIn
                sourcePixelBufferAttributes:@{
                    (NSString *)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA),
                    (NSString *)kCVPixelBufferWidthKey:  @((int)sz.width),
                    (NSString *)kCVPixelBufferHeightKey: @((int)sz.height),
                }];
        [writer addInput:vIn];
        [writer startWriting];
        [writer startSessionAtSourceTime:kCMTimeZero];

        PHImageManager *mgr = [PHImageManager defaultManager];
        PHImageRequestOptions *iOpts = [[PHImageRequestOptions alloc] init];
        iOpts.synchronous = YES;
        iOpts.deliveryMode = PHImageRequestOptionsDeliveryModeHighQualityFormat;
        iOpts.resizeMode = PHImageRequestOptionsResizeModeExact;

        __block int64_t totalFrames = 0;
        __block BOOL aborted = NO;

        for (NSDictionary *item in mediaItems) {
            if (aborted) break;
            NSString *uri  = item[@"uri"]  ?: @"";
            NSString *type = item[@"type"] ?: @"photo";

            if ([type isEqualToString:@"photo"]) {
                __block UIImage *img = nil;
                if ([uri hasPrefix:@"ph://"]) {
                    NSString *aid = [[uri substringFromIndex:5] componentsSeparatedByString:@"/"].firstObject;
                    PHFetchResult *fr = [PHAsset fetchAssetsWithLocalIdentifiers:@[aid] options:nil];
                    PHAsset *pa = fr.firstObject;
                    if (pa) {
                        dispatch_semaphore_t s = dispatch_semaphore_create(0);
                        [mgr requestImageForAsset:pa targetSize:CGSizeMake(sz.width, sz.height)
                                      contentMode:PHImageContentModeAspectFill options:iOpts
                                    resultHandler:^(UIImage *i, NSDictionary *info) { img = i; dispatch_semaphore_signal(s); }];
                        dispatch_semaphore_wait(s, dispatch_time(DISPATCH_TIME_NOW, 15 * NSEC_PER_SEC));
                    }
                } else {
                    NSString *path = [uri hasPrefix:@"file://"] ? [[NSURL URLWithString:uri] path] : uri;
                    img = [UIImage imageWithContentsOfFile:path];
                }
                if (!img) { NSLog(@"[combineMedia] photo load failed: %@", uri); continue; }

                CVPixelBufferRef pb = [self createPixelBufferFromImage:img targetSize:sz];
                if (!pb) continue;
                int nf = (int)roundf(secPerPhoto * fps);
                for (int f = 0; f < nf && !aborted; f++) {
                    CMTime t = CMTimeMake(totalFrames + f, fps);
                    NSUInteger w = 0;
                    while (!vIn.isReadyForMoreMediaData && !aborted) { [NSThread sleepForTimeInterval:0.01]; if (++w>500){aborted=YES;break;} }
                    if (!aborted && ![adaptor appendPixelBuffer:pb withPresentationTime:t]) aborted = YES;
                }
                totalFrames += nf;
                CVPixelBufferRelease(pb);

            } else if ([type isEqualToString:@"video"]) {
                __block AVAsset *asset = nil;
                if ([uri hasPrefix:@"ph://"]) {
                    NSString *lid = [[uri substringFromIndex:5] componentsSeparatedByString:@"?"].firstObject;
                    PHFetchResult *r = [PHAsset fetchAssetsWithLocalIdentifiers:@[lid] options:nil];
                    PHAsset *pa = r.firstObject;
                    if (pa) {
                        PHVideoRequestOptions *vOpts = [[PHVideoRequestOptions alloc] init];
                        vOpts.version = PHVideoRequestOptionsVersionCurrent;
                        vOpts.networkAccessAllowed = NO;
                        dispatch_semaphore_t s = dispatch_semaphore_create(0);
                        [mgr requestAVAssetForVideo:pa options:vOpts
                                     resultHandler:^(AVAsset *av, AVAudioMix *mix, NSDictionary *info) { asset = av; dispatch_semaphore_signal(s); }];
                        dispatch_semaphore_wait(s, dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC));
                    }
                } else {
                    NSURL *url = [uri hasPrefix:@"file://"] ? [NSURL URLWithString:uri] : [NSURL fileURLWithPath:uri];
                    if (url) asset = [AVURLAsset URLAssetWithURL:url options:nil];
                }
                if (!asset) { NSLog(@"[combineMedia] video load failed: %@", uri); continue; }

                float vDur = MIN(CMTimeGetSeconds(asset.duration), maxVSec);
                if (vDur <= 0) continue;
                int nf = (int)roundf(vDur * fps);

                AVAssetImageGenerator *gen = [AVAssetImageGenerator assetImageGeneratorWithAsset:asset];
                gen.appliesPreferredTrackTransform = YES;
                gen.maximumSize = CGSizeMake(sz.width * 2, sz.height * 2);
                gen.requestedTimeToleranceBefore = CMTimeMake(1, fps);
                gen.requestedTimeToleranceAfter  = CMTimeMake(1, fps);

                for (int f = 0; f < nf && !aborted; f++) {
                    CMTime vt = CMTimeMakeWithSeconds((double)f / fps, 600);
                    NSError *iErr = nil;
                    CGImageRef cg = [gen copyCGImageAtTime:vt actualTime:nil error:&iErr];
                    if (!cg) continue;
                    UIImage *frameImg = [UIImage imageWithCGImage:cg];
                    CGImageRelease(cg);

                    CVPixelBufferRef pb = [self createPixelBufferFromImage:frameImg targetSize:sz];
                    if (!pb) continue;

                    CMTime t = CMTimeMake(totalFrames + f, fps);
                    NSUInteger w = 0;
                    while (!vIn.isReadyForMoreMediaData && !aborted) { [NSThread sleepForTimeInterval:0.01]; if (++w>500){aborted=YES;break;} }
                    if (!aborted && ![adaptor appendPixelBuffer:pb withPresentationTime:t]) aborted = YES;
                    CVPixelBufferRelease(pb);
                }
                totalFrames += nf;
            }
        }

        [vIn markAsFinished];
        dispatch_semaphore_t done = dispatch_semaphore_create(0);
        [writer finishWritingWithCompletionHandler:^{ dispatch_semaphore_signal(done); }];
        dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 300 * NSEC_PER_SEC));

        if (writer.status == AVAssetWriterStatusCompleted) {
            NSLog(@"[combineMedia] done → %@", outUrl.absoluteString);
            resolve(outUrl.absoluteString);
        } else {
            NSLog(@"[combineMedia] failed: %@", writer.error);
            reject(@"combine_media", writer.error.localizedDescription ?: @"Writing failed", writer.error);
        }
    });
}

RCT_EXPORT_METHOD(photosToVideo:(NSArray<NSString *> *)photoUris
                  durationPerPhoto:(nonnull NSNumber *)durationNum
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {

    if (!photoUris || photoUris.count == 0) {
        reject(@"photos_to_video", @"No photo URIs provided", nil);
        return;
    }

    dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
        float secPerPhoto = MAX([durationNum floatValue], 0.5f);
        const int fps = 30;
        CGSize sz = CGSizeMake(1080, 1920);

        NSString *outPath = [NSTemporaryDirectory() stringByAppendingPathComponent:
            [NSString stringWithFormat:@"photo_reel_%lld.mp4",
             (long long)([[NSDate date] timeIntervalSince1970] * 1000)]];
        NSURL *outUrl = [NSURL fileURLWithPath:outPath];
        [[NSFileManager defaultManager] removeItemAtURL:outUrl error:nil];

        NSError *wErr = nil;
        AVAssetWriter *writer = [AVAssetWriter assetWriterWithURL:outUrl
                                                         fileType:AVFileTypeMPEG4 error:&wErr];
        if (!writer) { reject(@"photos_to_video", @"Could not create video writer", wErr); return; }

        NSDictionary *vSettings = @{
            AVVideoCodecKey: AVVideoCodecTypeH264,
            AVVideoWidthKey: @((int)sz.width),
            AVVideoHeightKey: @((int)sz.height),
            AVVideoCompressionPropertiesKey: @{
                AVVideoAverageBitRateKey: @4000000,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            }
        };
        AVAssetWriterInput *vInput = [AVAssetWriterInput
            assetWriterInputWithMediaType:AVMediaTypeVideo outputSettings:vSettings];
        vInput.expectsMediaDataInRealTime = NO;

        AVAssetWriterInputPixelBufferAdaptor *adaptor =
            [AVAssetWriterInputPixelBufferAdaptor
                assetWriterInputPixelBufferAdaptorWithAssetWriterInput:vInput
                sourcePixelBufferAttributes:@{
                    (NSString *)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA),
                    (NSString *)kCVPixelBufferWidthKey:  @((int)sz.width),
                    (NSString *)kCVPixelBufferHeightKey: @((int)sz.height),
                }];

        [writer addInput:vInput];
        [writer startWriting];
        [writer startSessionAtSourceTime:kCMTimeZero];

        int framesPerPhoto = (int)roundf(secPerPhoto * fps);
        PHImageManager *mgr = [PHImageManager defaultManager];
        PHImageRequestOptions *imgOpts = [[PHImageRequestOptions alloc] init];
        imgOpts.synchronous = YES;
        imgOpts.deliveryMode = PHImageRequestOptionsDeliveryModeHighQualityFormat;
        imgOpts.resizeMode   = PHImageRequestOptionsResizeModeExact;

        __block BOOL aborted = NO;

        for (NSUInteger idx = 0; idx < photoUris.count && !aborted; idx++) {
            NSString *uri = photoUris[idx];
            NSLog(@"[photosToVideo] photo %lu/%lu", (unsigned long)(idx+1), (unsigned long)photoUris.count);

            __block UIImage *img = nil;

            if ([uri hasPrefix:@"ph://"]) {
                NSString *assetId = [[uri substringFromIndex:5]
                                     componentsSeparatedByString:@"/"].firstObject;
                PHFetchResult *fr = [PHAsset fetchAssetsWithLocalIdentifiers:@[assetId] options:nil];
                PHAsset *pAsset = fr.firstObject;
                if (pAsset) {
                    dispatch_semaphore_t s = dispatch_semaphore_create(0);
                    [mgr requestImageForAsset:pAsset
                                   targetSize:CGSizeMake(sz.width, sz.height)
                                  contentMode:PHImageContentModeAspectFill
                                      options:imgOpts
                                resultHandler:^(UIImage *i, NSDictionary *info) {
                        img = i; dispatch_semaphore_signal(s);
                    }];
                    dispatch_semaphore_wait(s, dispatch_time(DISPATCH_TIME_NOW, 15 * NSEC_PER_SEC));
                }
            } else {
                NSString *path = [uri hasPrefix:@"file://"] ? [[NSURL URLWithString:uri] path] : uri;
                img = [UIImage imageWithContentsOfFile:path];
            }

            if (!img) { NSLog(@"[photosToVideo] skip %lu — load failed", (unsigned long)idx); continue; }

            CVPixelBufferRef pb = [self createPixelBufferFromImage:img targetSize:sz];
            if (!pb) { NSLog(@"[photosToVideo] skip %lu — pixbuf failed", (unsigned long)idx); continue; }

            for (int f = 0; f < framesPerPhoto && !aborted; f++) {
                CMTime t = CMTimeMake((int64_t)(idx * framesPerPhoto + f), fps);
                NSUInteger w = 0;
                while (!vInput.isReadyForMoreMediaData && !aborted) {
                    [NSThread sleepForTimeInterval:0.01];
                    if (++w > 500) { aborted = YES; break; }
                }
                if (!aborted && ![adaptor appendPixelBuffer:pb withPresentationTime:t]) {
                    NSLog(@"[photosToVideo] append failed photo=%lu f=%d", (unsigned long)idx, f);
                    aborted = YES;
                }
            }
            CVPixelBufferRelease(pb);
        }

        [vInput markAsFinished];

        dispatch_semaphore_t done = dispatch_semaphore_create(0);
        [writer finishWritingWithCompletionHandler:^{ dispatch_semaphore_signal(done); }];
        dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 120 * NSEC_PER_SEC));

        if (writer.status == AVAssetWriterStatusCompleted) {
            NSLog(@"[photosToVideo] done → %@", outUrl.absoluteString);
            resolve(outUrl.absoluteString);
        } else {
            NSLog(@"[photosToVideo] failed: %@", writer.error);
            reject(@"photos_to_video", writer.error.localizedDescription ?: @"Writing failed", writer.error);
        }
    });
}

@end
