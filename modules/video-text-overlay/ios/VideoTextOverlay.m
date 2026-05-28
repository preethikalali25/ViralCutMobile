#import <React/RCTBridgeModule.h>
#import <AVFoundation/AVFoundation.h>
#import <UIKit/UIKit.h>
#import <Photos/Photos.h>
#import <CoreImage/CoreImage.h>
#import <CoreGraphics/CoreGraphics.h>

// ---------------------------------------------------------------------------
// Instruction object — carries all per-segment data the compositor needs.
// All AVVideoCompositionInstruction protocol properties are redeclared as
// readwrite so the compiler can synthesise ivars for them.
// ---------------------------------------------------------------------------

@interface VTOCompositorInstruction : NSObject <AVVideoCompositionInstruction>
@property (nonatomic) CMTimeRange          timeRange;
@property (nonatomic) BOOL                 enablePostProcessing;
@property (nonatomic) BOOL                 containsTweening;
@property (nonatomic, strong) NSString    *text;
@property (nonatomic) CGFloat              fontSize;
@property (nonatomic) CGFloat              padX;
@property (nonatomic) CGFloat              padY;
@property (nonatomic) CMPersistentTrackID  trackID;
@property (nonatomic) CGAffineTransform    preferredTransform;
@end

@implementation VTOCompositorInstruction

- (NSArray<NSValue *> *)requiredSourceTrackIDs {
    return @[@(_trackID)];
}
- (CMPersistentTrackID)passthroughTrackID {
    return kCMPersistentTrackID_Invalid;
}

- (instancetype)initWithText:(NSString *)text
                    fontSize:(CGFloat)fs
                        padX:(CGFloat)px
                        padY:(CGFloat)py
                     trackID:(CMPersistentTrackID)tid
                   timeRange:(CMTimeRange)range
                   transform:(CGAffineTransform)xform {
    self = [super init];
    _text                 = text;
    _fontSize             = fs;
    _padX                 = px;
    _padY                 = py;
    _trackID              = tid;
    _timeRange            = range;
    _preferredTransform   = xform;
    _enablePostProcessing = NO;
    _containsTweening     = NO;
    return self;
}

@end

// ---------------------------------------------------------------------------
// Custom compositor — no CALayer, no CoreAnimation tool, no IOSurface/XPC.
//
// Per-frame pipeline:
//   1. Wrap source CVPixelBuffer in a CIImage.
//   2. Apply the track's preferredTransform via CIImage (CPU-only soft renderer)
//      so portrait videos render upright even though the raw buffer is landscape.
//   3. Render the rotated CIImage into the destination CVPixelBuffer.
//   4. Overlay text using a CGBitmapContext pointing at the same destination
//      memory — pure CoreGraphics, no IOSurface involved.
// ---------------------------------------------------------------------------

@interface VTOCompositor : NSObject <AVVideoCompositing>
@end

@implementation VTOCompositor {
    dispatch_queue_t _queue;
    CIContext       *_ciCtx;
}

- (instancetype)init {
    self = [super init];
    _queue = dispatch_queue_create("vto.compositor", DISPATCH_QUEUE_SERIAL);
    // kCIContextUseSoftwareRenderer forces CPU rendering — no Metal/GPU,
    // no IOSurface creation, works in both Simulator and device.
    _ciCtx = [CIContext contextWithOptions:@{kCIContextUseSoftwareRenderer: @YES}];
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

    // ------------------------------------------------------------------
    // Step 1: Rotate / orient the source frame into the destination buffer
    // using a software-only CIContext (no GPU, no IOSurface).
    //
    // CIImage.imageByApplyingTransform uses the AVFoundation preferred
    // transform; the resulting extent may have a non-zero origin, so we
    // translate it back to {0,0} before rendering.
    // ------------------------------------------------------------------
    CIImage *srcCI   = [CIImage imageWithCVPixelBuffer:src];
    CIImage *rotated = [srcCI imageByApplyingTransform:inst.preferredTransform];
    CGRect   extent  = rotated.extent;
    if (extent.origin.x != 0 || extent.origin.y != 0) {
        rotated = [rotated imageByApplyingTransform:
                   CGAffineTransformMakeTranslation(-extent.origin.x, -extent.origin.y)];
    }
    // CIContext handles locking the dst buffer internally
    [_ciCtx render:rotated toCVPixelBuffer:dst];

    // ------------------------------------------------------------------
    // Step 2: Draw text overlay directly onto the destination pixel buffer
    // with CoreGraphics — zero CALayer / QuartzCore involvement.
    // Use the DESTINATION dimensions (post-rotation) throughout.
    // ------------------------------------------------------------------
    CVPixelBufferLockBaseAddress(dst, 0);
    void  *dstBase = CVPixelBufferGetBaseAddress(dst);
    size_t dstW    = CVPixelBufferGetWidth(dst);
    size_t dstH    = CVPixelBufferGetHeight(dst);
    size_t dstBpr  = CVPixelBufferGetBytesPerRow(dst);

    CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
    // BGRA pixel format: ByteOrder32Little + PremultipliedFirst
    CGBitmapInfo bitmapInfo = (CGBitmapInfo)(kCGBitmapByteOrder32Little |
                                             kCGImageAlphaPremultipliedFirst);
    CGContextRef cgCtx = CGBitmapContextCreate(dstBase, dstW, dstH, 8, dstBpr, cs, bitmapInfo);
    CGColorSpaceRelease(cs);

    if (cgCtx) {
        CGFloat fs = inst.fontSize;
        CGFloat px = inst.padX;
        CGFloat py = inst.padY;
        CGFloat tw = (CGFloat)dstW - px * 2.0;
        CGFloat radius = 10.0;

        // Measure the actual text height so the box expands for multi-line hooks
        NSMutableParagraphStyle *ps = [[NSMutableParagraphStyle alloc] init];
        ps.alignment     = NSTextAlignmentCenter;
        ps.lineBreakMode = NSLineBreakByWordWrapping;
        NSDictionary *attrs = @{
            NSFontAttributeName:            [UIFont boldSystemFontOfSize:fs],
            NSForegroundColorAttributeName: [UIColor whiteColor],
            NSParagraphStyleAttributeName:  ps
        };
        CGFloat textW = tw - 16.0;
        CGRect measured = [inst.text
            boundingRectWithSize:CGSizeMake(textW, CGFLOAT_MAX)
                         options:NSStringDrawingUsesLineFragmentOrigin |
                                 NSStringDrawingUsesFontLeading
                     attributes:attrs
                        context:nil];
        CGFloat textH = ceil(measured.size.height);
        CGFloat th    = textH + py;
        // CG origin is bottom-left; boxY positions the box near the top of frame
        CGFloat boxY   = (CGFloat)dstH - py - th;
        CGRect boxRect = CGRectMake(px, boxY, tw, th);

        // Semi-transparent rounded background
        CGContextSetRGBFillColor(cgCtx, 0, 0, 0, 0.55);
        CGContextBeginPath(cgCtx);
        CGContextMoveToPoint(cgCtx, CGRectGetMinX(boxRect) + radius, CGRectGetMinY(boxRect));
        CGContextAddArcToPoint(cgCtx, CGRectGetMaxX(boxRect), CGRectGetMinY(boxRect),
                               CGRectGetMaxX(boxRect), CGRectGetMinY(boxRect) + radius, radius);
        CGContextAddArcToPoint(cgCtx, CGRectGetMaxX(boxRect), CGRectGetMaxY(boxRect),
                               CGRectGetMaxX(boxRect) - radius, CGRectGetMaxY(boxRect), radius);
        CGContextAddArcToPoint(cgCtx, CGRectGetMinX(boxRect), CGRectGetMaxY(boxRect),
                               CGRectGetMinX(boxRect), CGRectGetMaxY(boxRect) - radius, radius);
        CGContextAddArcToPoint(cgCtx, CGRectGetMinX(boxRect), CGRectGetMinY(boxRect),
                               CGRectGetMinX(boxRect) + radius, CGRectGetMinY(boxRect), radius);
        CGContextClosePath(cgCtx);
        CGContextFillPath(cgCtx);

        // Flip context to UIKit's top-left origin for NSString drawing
        CGContextSaveGState(cgCtx);
        CGContextTranslateCTM(cgCtx, 0, (CGFloat)dstH);
        CGContextScaleCTM(cgCtx, 1.0, -1.0);

        // In flipped (UIKit) coords, py from top aligns with the box; centre text vertically
        CGRect textRect = CGRectMake(px + 8,
                                     py + (th - textH) / 2.0,
                                     textW,
                                     textH);
        UIGraphicsPushContext(cgCtx);
        [inst.text drawInRect:textRect withAttributes:attrs];
        UIGraphicsPopContext();

        CGContextRestoreGState(cgCtx);
        CGContextRelease(cgCtx);
    }

    CVPixelBufferUnlockBaseAddress(dst, 0);
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

            // renderSize = display size after applying the preferred transform
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
            // The compositor already applies the rotation to each pixel buffer,
            // so clear the track metadata transform to avoid a double-rotation.
            cv.preferredTransform = CGAffineTransformIdentity;

            if (audioTracks.count) {
                AVMutableCompositionTrack *ca =
                    [comp addMutableTrackWithMediaType:AVMediaTypeAudio
                                      preferredTrackID:kCMPersistentTrackID_Invalid];
                [ca insertTimeRange:timeRange ofTrack:audioTracks.firstObject
                             atTime:kCMTimeZero error:nil];
            }

            CGFloat fs  = renderSize.width * 0.072;
            CGFloat pad = renderSize.width * 0.045;

            // Shrink font until the hook text fits within 3 lines
            {
                CGFloat maxTextW = renderSize.width - pad * 2.0 - 16.0;
                NSMutableParagraphStyle *sp = [[NSMutableParagraphStyle alloc] init];
                sp.lineBreakMode = NSLineBreakByWordWrapping;
                CGFloat minFs = floor(renderSize.width * 0.036);
                for (;;) {
                    NSDictionary *a = @{
                        NSFontAttributeName:      [UIFont boldSystemFontOfSize:fs],
                        NSParagraphStyleAttributeName: sp
                    };
                    CGRect br = [text boundingRectWithSize:CGSizeMake(maxTextW, CGFLOAT_MAX)
                                                   options:NSStringDrawingUsesLineFragmentOrigin |
                                                           NSStringDrawingUsesFontLeading
                                               attributes:a
                                                  context:nil];
                    if (br.size.height <= fs * 1.4 * 3.0 || fs <= minFs) break;
                    fs = MAX(fs * 0.85, minFs);
                }
            }

            // Pass the preferred transform so the compositor can orient each frame
            VTOCompositorInstruction *inst =
                [[VTOCompositorInstruction alloc] initWithText:text
                                                      fontSize:fs
                                                          padX:pad
                                                          padY:pad
                                                       trackID:cv.trackID
                                                     timeRange:timeRange
                                                     transform:pref];

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
                    NSLog(@"[VideoTextOverlay] export error: %@", ses.error.localizedDescription);
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
