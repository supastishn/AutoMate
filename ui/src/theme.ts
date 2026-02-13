// Theme definitions for AutoMate UI

export type ThemeMode = 'dark' | 'light'

export interface Theme {
  mode: ThemeMode
  colors: {
    // Backgrounds
    bgPrimary: string
    bgSecondary: string
    bgTertiary: string
    bgCard: string
    bgHover: string
    bgActive: string
    bgOverlay: string
    bgDanger: string
    bgDangerHover: string
    
    // Text
    textPrimary: string
    textSecondary: string
    textMuted: string
    textAccent: string
    
    // Borders
    border: string
    borderLight: string
    borderFocus: string
    borderDanger: string
    borderSuccess: string
    
    // Accent
    accent: string
    accentHover: string
    accentMuted: string
    
    // Status
    success: string
    successMuted: string
    error: string
    errorMuted: string
    warning: string
    warningMuted: string
    info: string
    infoMuted: string
    
    // Special colors
    heartbeat: string
    subagent: string
    
    // Syntax highlighting
    syntaxKeyword: string
    syntaxString: string
    syntaxNumber: string
    syntaxComment: string
    syntaxPunctuation: string
    syntaxInlineCode: string
    
    // Input
    inputBg: string
    inputBorder: string
    inputText: string
    inputPlaceholder: string
    
    // Scrollbar
    scrollbarTrack: string
    scrollbarThumb: string
    
    // Contrast text (for text on colored backgrounds)
    accentContrast: string
    successContrast: string

    // Additional backgrounds
    bgSuccess: string
    bgWarning: string

    // Shadow
    shadow: string
    shadowLight: string
  }
}

export const darkTheme: Theme = {
  mode: 'dark',
  colors: {
    bgPrimary: '#0a0a0a',
    bgSecondary: '#111',
    bgTertiary: '#1a1a2e',
    bgCard: '#141414',
    bgHover: '#1a1a1a',
    bgActive: '#1a1a2e',
    bgOverlay: 'rgba(0,0,0,0.5)',
    bgDanger: '#2e1a1a',
    bgDangerHover: '#3a2020',
    
    textPrimary: '#e0e0e0',
    textSecondary: '#888',
    textMuted: '#555',
    textAccent: '#4fc3f7',
    
    border: '#222',
    borderLight: '#333',
    borderFocus: '#4fc3f7',
    borderDanger: '#4a2a2a',
    borderSuccess: '#2a4a2a',
    
    accent: '#4fc3f7',
    accentHover: '#81d4fa',
    accentMuted: 'rgba(79,195,247,0.1)',
    
    success: '#4caf50',
    successMuted: 'rgba(76,175,80,0.15)',
    error: '#f44336',
    errorMuted: 'rgba(244,67,54,0.15)',
    warning: '#ff9800',
    warningMuted: 'rgba(255,152,0,0.15)',
    info: '#2196f3',
    infoMuted: 'rgba(33,150,243,0.15)',
    
    heartbeat: '#ce93d8',
    subagent: '#b39ddb',
    
    syntaxKeyword: '#c678dd',
    syntaxString: '#98c379',
    syntaxNumber: '#d19a66',
    syntaxComment: '#5c6370',
    syntaxPunctuation: '#abb2bf',
    syntaxInlineCode: '#e6db74',
    
    inputBg: '#181818',
    inputBorder: '#333',
    inputText: '#e0e0e0',
    inputPlaceholder: '#666',
    
    scrollbarTrack: '#1a1a1a',
    scrollbarThumb: '#333',
    
    accentContrast: '#000',
    successContrast: '#000',

    bgSuccess: '#0d1f0d',
    bgWarning: '#1f1a0d',

    shadow: 'rgba(0,0,0,0.5)',
    shadowLight: 'rgba(0,0,0,0.3)',
  }
}

export const lightTheme: Theme = {
  mode: 'light',
  colors: {
    bgPrimary: '#f5f5f5',
    bgSecondary: '#ffffff',
    bgTertiary: '#e3f2fd',
    bgCard: '#ffffff',
    bgHover: '#f0f0f0',
    bgActive: '#e3f2fd',
    bgOverlay: 'rgba(0,0,0,0.3)',
    bgDanger: '#ffebee',
    bgDangerHover: '#ffcdd2',
    
    textPrimary: '#1a1a1a',
    textSecondary: '#666',
    textMuted: '#999',
    textAccent: '#0288d1',
    
    border: '#e0e0e0',
    borderLight: '#eee',
    borderFocus: '#0288d1',
    borderDanger: '#ef9a9a',
    borderSuccess: '#a5d6a7',
    
    accent: '#0288d1',
    accentHover: '#0277bd',
    accentMuted: 'rgba(2,136,209,0.1)',
    
    success: '#43a047',
    successMuted: 'rgba(67,160,71,0.15)',
    error: '#e53935',
    errorMuted: 'rgba(229,57,53,0.15)',
    warning: '#fb8c00',
    warningMuted: 'rgba(251,140,0,0.15)',
    info: '#1e88e5',
    infoMuted: 'rgba(30,136,229,0.15)',
    
    heartbeat: '#9c27b0',
    subagent: '#7e57c2',
    
    syntaxKeyword: '#7c4dff',
    syntaxString: '#2e7d32',
    syntaxNumber: '#e65100',
    syntaxComment: '#78909c',
    syntaxPunctuation: '#546e7a',
    syntaxInlineCode: '#795548',
    
    inputBg: '#ffffff',
    inputBorder: '#ddd',
    inputText: '#1a1a1a',
    inputPlaceholder: '#999',
    
    scrollbarTrack: '#f0f0f0',
    scrollbarThumb: '#ccc',
    
    accentContrast: '#fff',
    successContrast: '#fff',

    bgSuccess: '#e8f5e9',
    bgWarning: '#fff3e0',

    shadow: 'rgba(0,0,0,0.1)',
    shadowLight: 'rgba(0,0,0,0.05)',
  }
}

export const themes = { dark: darkTheme, light: lightTheme }
