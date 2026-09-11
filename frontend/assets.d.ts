declare module '*.svg' {
  const svg: string;
  export default svg;
}
declare module 'plotly.js-gl3d-dist-min' {
  const plotly: { newPlot(element: HTMLElement, data: unknown[], layout: unknown, config: unknown): Promise<unknown>; purge(element: HTMLElement): void; Plots: { resize(element: HTMLElement): Promise<void> } };
  export default plotly;
}
