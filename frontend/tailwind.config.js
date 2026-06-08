/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      colors: {
        navy: {
          950: '#020818',
          900: '#040d1e',
          800: '#071428',
          700: '#0a1c38',
          600: '#0d2448',
        },
        cyan: {
          400: '#22d3ee',
          300: '#67e8f9',
          200: '#a5f3fc',
        },
        violet: {
          400: '#a78bfa',
          500: '#8b5cf6',
          600: '#7c3aed',
        },
        coral: {
          400: '#fb7185',
          500: '#f43f5e',
        },
        ocean: {
          blue: '#3b82f6',
          teal: '#06b6d4',
          deep: '#1e3a5f',
        },
      },
      backgroundImage: {
        'ocean-gradient': 'linear-gradient(135deg, #020818 0%, #040d1e 40%, #071428 100%)',
        'card-gradient': 'linear-gradient(135deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%)',
        'cyan-glow': 'radial-gradient(ellipse at center, rgba(34,211,238,0.15) 0%, transparent 70%)',
        'score-low': 'linear-gradient(90deg, #22d3ee, #3b82f6)',
        'score-medium': 'linear-gradient(90deg, #f59e0b, #fb923c)',
        'score-high': 'linear-gradient(90deg, #fb923c, #f43f5e)',
        'score-critical': 'linear-gradient(90deg, #f43f5e, #a78bfa)',
      },
      boxShadow: {
        glass: '0 8px 32px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.08)',
        'glass-hover': '0 16px 48px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.12)',
        cyan: '0 0 20px rgba(34,211,238,0.3)',
        'cyan-strong': '0 0 40px rgba(34,211,238,0.5)',
        coral: '0 0 20px rgba(244,63,94,0.3)',
        violet: '0 0 20px rgba(167,139,250,0.3)',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4,0,0.6,1) infinite',
        'glow-pulse': 'glowPulse 2s ease-in-out infinite',
        'scan-line': 'scanLine 2s linear infinite',
        float: 'float 6s ease-in-out infinite',
        'spin-slow': 'spin 8s linear infinite',
      },
      keyframes: {
        glowPulse: {
          '0%, 100%': { opacity: '0.6' },
          '50%': { opacity: '1' },
        },
        scanLine: {
          '0%': { transform: 'translateY(-100%)' },
          '100%': { transform: 'translateY(100vh)' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-10px)' },
        },
      },
      backdropBlur: {
        xs: '2px',
      },
    },
  },
  plugins: [],
}
