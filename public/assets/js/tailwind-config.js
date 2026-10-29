// tailwind-config.js
tailwind.config = {
    theme: {
        extend: {
            colors: {
                'furiozo-dark': '#1F4229',
                'furiozo-light': '#8A9A4A',
                'furiozo-accent': '#E5F0D8',
                // Tons escuros do novo visual (verde quase preto, como "tinta")
                'ink': '#050b07',
                'coal': '#0a140d',
                'soot': '#101d14',
                'ash': '#1d2e22',
                'smoke': '#8c9a8f',
                'bone': '#eef1e6',
                'neon': '#ccff00',
            },
            fontFamily: {
                'sport': ['"Big Shoulders Display"', '"Big Shoulders"', 'Montserrat', 'sans-serif'],
                'stencil': ['"Big Shoulders Stencil Display"', '"Big Shoulders Stencil"', '"Big Shoulders Display"', 'sans-serif'],
                'serif': ['"Instrument Serif"', 'Georgia', 'serif'],
                'mono': ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
                'body': ['Inter', 'sans-serif'],
            },
            transitionTimingFunction: {
                'razor': 'cubic-bezier(0.77, 0, 0.18, 1)',
            }
        }
    }
}
