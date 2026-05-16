/** @type {import('tailwindcss').Config} */
export default {
  content: ['./app/**/*.{js,jsx}', './components/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        blvck: {
          950: '#050505',
          900: '#0b0b0f',
          800: '#111118',
          accent: '#8b5cf6'
        }
      }
    },
  },
  plugins: [],
};
