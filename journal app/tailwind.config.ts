import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        page: "var(--page)",
        surface: "var(--surface-1)",
        ink: "var(--ink)",
        ink2: "var(--ink-2)",
        muted: "var(--muted)",
        line: "var(--grid)",
        baseline: "var(--baseline)",
        accent: "var(--accent)",
        pos: "var(--pos)",
        neg: "var(--neg)",
      },
      borderColor: {
        DEFAULT: "var(--grid)",
      },
    },
  },
  plugins: [],
};

export default config;
