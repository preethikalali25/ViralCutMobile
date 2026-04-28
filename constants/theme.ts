// ViralCut Design System
export const Colors = {
  // Base
  background: '#080a14',
  surface: '#0f1120',
  surfaceElevated: '#141828',
  surfaceBorder: '#1e2235',
  
  // Brand
  primary: '#7c3aed',
  primaryLight: '#9d5ff0',
  primaryGlow: 'rgba(124, 58, 237, 0.25)',
  
  // Accent
  violet: '#a855f7',
  pink: '#ec4899',
  cyan: '#06b6d4',
  amber: '#f59e0b',
  emerald: '#10b981',
  rose: '#f43f5e',
  sky: '#0ea5e9',
  
  // Platform colors
  tiktok: '#010101',
  reels: '#e1306c',
  youtube: '#ff0000',
  
  // Text
  textPrimary: '#f0f0ff',
  textSecondary: '#8892b0',
  textMuted: '#4a5568',
  
  // Semantic
  success: '#10b981',
  warning: '#f59e0b',
  error: '#f43f5e',
  
  // Gradient stops
  gradStart: '#7c3aed',
  gradEnd: '#a855f7',
};

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
};

export const Radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  full: 9999,
};

export const FontSize = {
  xs: 11,
  sm: 13,
  md: 16,
  lg: 18,
  xl: 20,
  xxl: 24,
  xxxl: 28,
};

export const FontWeight = {
  regular: '400' as const,
  medium: '500' as const,
  semibold: '600' as const,
  bold: '700' as const,
  extrabold: '800' as const,
};
