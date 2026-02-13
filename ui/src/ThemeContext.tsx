import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import { Theme, ThemeMode, themes } from './theme'

interface ThemeContextType {
  theme: Theme
  mode: ThemeMode
  toggleTheme: () => void
  setTheme: (mode: ThemeMode) => void
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined)

const STORAGE_KEY = 'automate-theme'

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored === 'light' || stored === 'dark') return stored
      // Check system preference
      if (window.matchMedia?.('(prefers-color-scheme: light)').matches) {
        return 'light'
      }
    }
    return 'dark'
  })

  const theme = themes[mode]

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, mode)
    // Update CSS variables on document root
    const root = document.documentElement
    Object.entries(theme.colors).forEach(([key, value]) => {
      root.style.setProperty(`--${key}`, value)
    })
    root.style.setProperty('--theme-mode', mode)
  }, [mode, theme])

  const toggleTheme = () => setMode(m => m === 'dark' ? 'light' : 'dark')
  const setTheme = (newMode: ThemeMode) => setMode(newMode)

  return (
    <ThemeContext.Provider value={{ theme, mode, toggleTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider')
  }
  return context
}

// Helper hook to get just the colors
export function useColors() {
  return useTheme().theme.colors
}
