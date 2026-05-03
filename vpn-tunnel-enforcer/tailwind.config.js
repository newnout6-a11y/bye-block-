/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/**/*.{ts,tsx,html}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        accent: {
          DEFAULT: '#6366f1',
          foreground: '#ffffff'
        },
        success: '#22c55e',
        danger: '#ef4444',
        warning: '#f59e0b',
        surface: {
          DEFAULT: '#1e1e2e',
          light: '#2a2a3e',
          lighter: '#363650'
        }
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite'
      }
    }
  },
  plugins: []
}
