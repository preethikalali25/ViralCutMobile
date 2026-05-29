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
- (void)processAsset:(AVAsset *)asset
                text:(NSString *)text
  backgroundAudioUri:(NSString *)backgroundAudioUri
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

            // renderSize = display size after applying the rotation
            CGSize ts = CGSizeApplyAffineTransform(naturalSize, pref);
            CGSize renderSize = CGSizeMake(fabs(ts.width), fabs(ts.height));
            if (renderSize.width < 1 || renderSize.height < 1) { resolve(originalUri); return; }

            AVMutableComposition *comp = [AVMutableComposition composition];
            AVMutableCompositionTrack *cv =
                [comp addMutableTrackWithMediaType:AVMediaTypeVideo
                                  preferredTrackID:kCMPersistentTrackID_Invalid];
            if (!cv) { resolve(originalUri); return; }
            NSError *err = nil;
            [cv insertTimeRange:timeRange ofTrack:vTrack atTime:kCMTimeZero error:&err];
            if (err) { resolve(originalUri); return; }
            // Pixels are already rotated by the vImage compositor, so clear the
            // track transform — otherwise players apply the rotation a second time.
            [cv setPreferredTransform:CGAffineTransformIdentity];

            // Hoist ca so we can reference it when building the audioMix below.
            AVMutableCompositionTrack *ca = nil;
            if (audioTracks.count) {
                ca = [comp addMutableTrackWithMediaType:AVMediaTypeAudio
                                       preferredTrackID:kCMPersistentTrackID_Invalid];
                AVAssetTrack *aTrack = audioTracks.firstObject;
                CMTime audioDur = CMTimeMinimum(aTrack.timeRange.duration, duration);
                NSError *aErr = nil;
                [ca insertTimeRange:CMTimeRangeMake(kCMTimeZero, audioDur)
                            ofTrack:aTrack atTime:kCMTimeZero error:&aErr];
                if (aErr) {
                    NSLog(@"[VideoTextOverlay] audio insert error: %@", aErr.localizedDescription);
                    ca = nil;
                }
            } else {
                NSLog(@"[VideoTextOverlay] no audio tracks in source asset");
            }

            // Background music track — loop to fill the video duration.
            AVMutableCompositionTrack *bgAudio = nil;
            if (backgroundAudioUri.length > 0) {
                NSURL *bgUrl = [backgroundAudioUri hasPrefix:@"file://"]
                    ? [NSURL URLWithString:backgroundAudioUri]
                    : [NSURL fileURLWithPath:backgroundAudioUri];
                if (bgUrl) {
                    AVURLAsset *bgAsset = [AVURLAsset URLAssetWithURL:bgUrl options:nil];

                    // The deprecated sync tracksWithMediaType: may return 0 tracks if the
                    // asset hasn't finished loading.  Block until AVFoundation confirms.
                    dispatch_semaphore_t bgSema = dispatch_semaphore_create(0);
                    [bgAsset loadValuesAsynchronouslyForKeys:@[@"tracks"] completionHandler:^{
                        dispatch_semaphore_signal(bgSema);
                    }];
                    // Wait up to 6 s for a local m4a — should be near-instant.
                    dispatch_semaphore_wait(bgSema,
                        dispatch_time(DISPATCH_TIME_NOW, (int64_t)(6 * NSEC_PER_SEC)));

                    NSError *bgLoadErr = nil;
                    AVKeyValueStatus bgStatus = [bgAsset statusOfValueForKey:@"tracks"
                                                                       error:&bgLoadErr];
                    if (bgStatus != AVKeyValueStatusLoaded) {
                        NSLog(@"[VideoTextOverlay] bg asset not loaded: status=%ld err=%@",
                              (long)bgStatus, bgLoadErr.localizedDescription);
                    } else {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
                        NSArray *bgTracks = [bgAsset tracksWithMediaType:AVMediaTypeAudio];
#pragma clang diagnostic pop
                        if (bgTracks.count) {
                            bgAudio = [comp addMutableTrackWithMediaType:AVMediaTypeAudio
                                                        preferredTrackID:kCMPersistentTrackID_Invalid];
                            AVAssetTrack *bgTrack = bgTracks.firstObject;
                            CMTime bgDur = bgTrack.timeRange.duration;
                            CMTime insertAt = kCMTimeZero;
                            // Loop the preview clip to cover the full video duration.
                            while (CMTimeCompare(insertAt, duration) < 0) {
                                CMTime remaining = CMTimeSubtract(duration, insertAt);
                                CMTime seg = CMTimeMinimum(bgDur, remaining);
                                NSError *bgErr = nil;
                                [bgAudio insertTimeRange:CMTimeRangeMake(kCMTimeZero, seg)
                                                ofTrack:bgTrack atTime:insertAt error:&bgErr];
                                if (bgErr) { NSLog(@"[VideoTextOverlay] bg insert error: %@", bgErr); break; }
                                insertAt = CMTimeAdd(insertAt, seg);
                            }
                            NSLog(@"[VideoTextOverlay] bg audio inserted, loops=%d",
                                  (int)(CMTimeGetSeconds(duration) / CMTimeGetSeconds(bgDur) + 1));
                        } else {
                            NSLog(@"[VideoTextOverlay] bg asset has 0 audio tracks");
                        }
                    }
                }
            }

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

            NSString *fname = [NSString stringWithFormat:@"hook_%ld.mp4",
                               (long)[[NSDate date] timeIntervalSince1970]];
            NSURL *out = [NSFileManager.defaultManager.temporaryDirectory
                          URLByAppendingPathComponent:fname];
            [NSFileManager.defaultManager removeItemAtURL:out error:nil];

            AVAssetExportSession *ses =
                [[AVAssetExportSession alloc] initWithAsset:comp
                                                 presetName:AVAssetExportPresetHighestQuality];
            if (!ses) { resolve(originalUri); return; }
            ses.outputURL        = out;
            ses.outputFileType   = AVFileTypeMPEG4;
            ses.videoComposition = vc;

            // When a custom videoCompositorClass is set, AVAssetExportSession drops
            // audio unless audioMix is explicitly provided. Build a mix with:
            //   • original audio at full volume (or ducked to 40% when bg music plays)
            //   • background music at 70%
            if (ca || bgAudio) {
                NSMutableArray *params = [NSMutableArray array];
                if (ca) {
                    AVMutableAudioMixInputParameters *p =
                        [AVMutableAudioMixInputParameters audioMixInputParametersWithTrack:ca];
                    [p setVolume:(bgAudio ? 0.4f : 1.0f) atTime:kCMTimeZero];
                    [params addObject:p];
                }
                if (bgAudio) {
                    AVMutableAudioMixInputParameters *p =
                        [AVMutableAudioMixInputParameters audioMixInputParametersWithTrack:bgAudio];
                    [p setVolume:0.7f atTime:kCMTimeZero];
                    [params addObject:p];
                }
                AVMutableAudioMix *audioMix = [AVMutableAudioMix audioMix];
                audioMix.inputParameters = params;
                ses.audioMix = audioMix;
            }

            [ses exportAsynchronouslyWithCompletionHandler:^{
                if (ses.status == AVAssetExportSessionStatusCompleted) {
                    resolve(out.absoluteString);
                } else {
                    NSLog(@"[VideoTextOverlay] export error: %@",
                          ses.error.localizedDescription);
                    resolve(originalUri);
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
              originalUri:(NSString *)originalUri
                  resolve:(RCTPromiseResolveBlock)resolve {
    AVURLAsset *asset = [AVURLAsset URLAssetWithURL:inputUrl options:nil];
    if (!asset) { resolve(originalUri); return; }
    [self processAsset:asset text:text backgroundAudioUri:backgroundAudioUri originalUri:originalUri resolve:resolve];
}

RCT_EXPORT_METHOD(burnText:(NSString *)videoUri
                  text:(NSString *)text
                  backgroundAudioUri:(NSString *)backgroundAudioUri
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {

    NSString *bg = backgroundAudioUri ?: @"";

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
            [self processAsset:av text:text backgroundAudioUri:bg originalUri:videoUri resolve:resolve];
        }];
    } else {
        NSURL *fileUrl = [videoUri hasPrefix:@"file://"]
            ? [NSURL URLWithString:videoUri]
            : [NSURL fileURLWithPath:videoUri];
        if (!fileUrl) { resolve(videoUri); return; }
        [self processVideoAtURL:fileUrl text:text backgroundAudioUri:bg originalUri:videoUri resolve:resolve];
    }
}

@end
