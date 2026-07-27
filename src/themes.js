// Colour presets. Values are allowed above 1.0 — the pipeline is HDR, and
// overdriven inner colours are what make the bloom glow instead of just glare.
export const THEMES = {
  gargantua: {
    label: 'Gargantua',
    hot: [1.45, 0.86, 0.34],
    cool: [0.92, 0.26, 0.05],
    nebula: [0.26, 0.20, 0.46],
  },
  cygnus: {
    label: 'Cygnus X-1',
    hot: [0.52, 1.15, 1.60],
    cool: [0.26, 0.28, 1.05],
    nebula: [0.16, 0.30, 0.62],
  },
  nova: {
    label: 'Nova',
    hot: [1.60, 0.42, 0.92],
    cool: [1.05, 0.34, 0.16],
    nebula: [0.42, 0.14, 0.52],
  },
  emerald: {
    label: 'Emerald',
    hot: [0.62, 1.50, 0.82],
    cool: [0.06, 0.52, 0.44],
    nebula: [0.10, 0.38, 0.36],
  },
  ember: {
    label: 'Ember',
    hot: [1.55, 0.34, 0.12],
    cool: [0.48, 0.06, 0.02],
    nebula: [0.34, 0.12, 0.10],
  },
  monochrome: {
    label: 'Monochrome',
    hot: [1.35, 1.35, 1.40],
    cool: [0.42, 0.44, 0.50],
    nebula: [0.20, 0.22, 0.28],
  },
};

export const THEME_IDS = Object.keys(THEMES);
