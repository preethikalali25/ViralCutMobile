Pod::Spec.new do |s|
  s.name         = 'VideoTextOverlay'
  s.version      = '0.1.0'
  s.summary      = 'Burns text overlay into video using AVFoundation — no external binaries'
  s.homepage     = 'https://github.com/preethikalali25/ViralCutMobile'
  s.license      = { :type => 'MIT' }
  s.authors      = { 'ViralCut' => 'preethika.kallaguntla@gmail.com' }
  s.platform     = :ios, '15.1'
  s.source       = { :path => '.' }
  s.source_files = 'ios/**/*.{h,m,mm}'
  s.frameworks   = 'AVFoundation', 'UIKit', 'Foundation', 'Photos', 'Accelerate'
  s.dependency   'React-Core'
end
