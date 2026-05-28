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
        CGFloat th = fs * 2.4;
        // CG origin is bottom-left; boxY near top of frame
        CGFloat boxY   = (CGFloat)dstH - py - th;
        CGRect  boxRect = CGRectMake(px, boxY, tw, th);
        CGFloat radius  = 10.0;

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

        // Flip ctx to UIKit's top-left origin so NSString drawing works
        CGContextSaveGState(ctx);
        CGContextTranslateCTM(ctx, 0, (CGFloat)dstH);
        CGContextScaleCTM(ctx, 1.0, -1.0);

        NSMutableParagraphStyle *ps = [[NSMutableParagraphStyle alloc] init];
        ps.alignment     = NSTextAlignmentCenter;
        ps.lineBreakMode = NSLineBreakByWordWrapping;
        NSDictionary *attrs = @{
            NSFontAttributeName:            [UIFont boldSystemFontOfSize:fs],
            NSForegroundColorAttributeName: [UIColor whiteColor],
            NSParagraphStyleAttributeName:  ps
        };
        CGRect textRect = CGRectMake(px + 8,
                                     py + (th - fs * 1.3) / 2.0,
                                     tw - 16,
                                     fs * 1.6);
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
// AVFoundation / UIKit: origin top-left, y-down.
// vImage:               origin top-left, y-down  (same convention).
// So the transform.b sign maps directly to CCW/CW without coordinate flip.
//   b > 0, c < 0  =>  90° CCW in UIKit  =>  vImage constant 1
//   b < 0, c > 0  =>  90° CW  in UIKit  =>  vImage constant 3
//   a < 0, d < 0  =>  180°              =>  vImage constant 2
//   identity                            =>  vImage constant 0
+ (uint8_t)vRotationForTransform:(CGAffineTransform)t {
    if (fabs(t.b) > 0.5) return (t.b > 0) ? 1 : 3;
    if (t.a < -0.5)      return 2;
    return 0;
}

- (void)processVideoAtURL:(NSURL *)inputUrl
                     text:(NSString *)text
              originalUri:(NSString *)originalUri
                  resolve:(RCTPromiseResolveBlock)resolve {

    dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
        @try {
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

            if (audioTracks.count) {
                AVMutableCompositionTrack *ca =
                    [comp addMutableTrackWithMediaType:AVMediaTypeAudio
                                      preferredTrackID:kCMPersistentTrackID_Invalid];
                [ca insertTimeRange:timeRange ofTrack:audioTracks.firstObject
                             atTime:kCMTimeZero error:nil];
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

RCT_EXPORT_METHOD(burnText:(NSString *)videoUri
                  text:(NSString *)text
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {

    if (!videoUri || !text ||
        [[text stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]] length] == 0) {
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
            AVURLAsset *ua = (AVURLAsset *)av;
            if (!ua) { resolve(videoUri); return; }
            [self processVideoAtURL:ua.URL text:text originalUri:videoUri resolve:resolve];
        }];
    } else {
        NSURL *fileUrl = [videoUri hasPrefix:@"file://"]
            ? [NSURL URLWithString:videoUri]
            : [NSURL fileURLWithPath:videoUri];
        if (!fileUrl) { resolve(videoUri); return; }
        [self processVideoAtURL:fileUrl text:text originalUri:videoUri resolve:resolve];
    }
}

@end
