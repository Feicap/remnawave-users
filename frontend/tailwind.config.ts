import type { Config } from "tailwindcss"
import forms from "@tailwindcss/forms"
import containerQueries from "@tailwindcss/container-queries"

const config: Config = {
  darkMode: "class",
  content: [
    "./index.html",
    "./src/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: "#4A90E2",

        "background-light": "#F8F9FA",
        "background-dark": "#101622",

        "surface-light": "#FFFFFF",
        "surface-dark": "#1a2233",

        "text-primary-light": "#333333",
        "text-primary-dark": "#e0e0e0",

        "text-secondary-light": "#6c757d",
        "text-secondary-dark": "#92a4c9",

        "border-light": "#dee2e6",
        "border-dark": "#232f48",

        success: "#28a745",
        warning: "#ffc107",
        danger: "#dc3545",
        info: "#17a2b8",
      },
      fontFamily: {
        display: ["Inter", "sans-serif"],
      },
      borderRadius: {
        DEFAULT: "0.25rem",
        lg: "0.5rem",
        xl: "0.75rem",
        full: "9999px",
      },
    },
  },
  plugins: [
    forms,
    containerQueries,
  ],
}

export default config
