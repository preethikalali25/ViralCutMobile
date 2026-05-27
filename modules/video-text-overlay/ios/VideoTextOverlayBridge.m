#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(VideoTextOverlay, NSObject)

RCT_EXTERN_ASYNC_METHOD(burnText:(NSString *)videoUri
                        text:(NSString *)text
                        resolver:(RCTPromiseResolveBlock)resolve
                        rejecter:(RCTPromiseRejectBlock)reject)

@end
