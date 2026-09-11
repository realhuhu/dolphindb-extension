import * as React from 'react';
import { DdbChartType } from 'dolphindb/browser.js';
import type { ChartData } from './types';
import { get_chart_option } from '../upstream/charts';
import { useDecimals } from './preferences';
import { formatNumeric } from './format';

/** Normalize the two official SDKs, then use the original VS Code chart builder. */
export function chartConfig(chart: ChartData) {
  const { type, rowLabels, columnLabels, values } = chart;
  let data: any[];
  if (type === DdbChartType.kline) {
    data = values.map((row, i) => ({ row: rowLabels[i], row_: String(rowLabels[i]), open: row[0], high: row[1], low: row[2], close: row[3], ...(row.length > 4 ? { vol: row[4] } : {}) }));
  } else if (type === DdbChartType.line && chart.multiY) {
    data = values.map((row, i) => ({ row: rowLabels[i], ...Object.fromEntries(columnLabels.map((label, col) => [label, row[col]])) }));
  } else {
    data = columnLabels.flatMap((col, column) => values.map((row, i) => ({ col, row: type === DdbChartType.scatter ? Number(rowLabels[i]) : rowLabels[i], value: row[column] })));
  }
  return { charttype: type, data, titles: chart.titles, stacking: chart.stacking, multi_y_axes: chart.multiY, col_labels: columnLabels,
    bin_count: chart.binCount === undefined ? undefined : { value: chart.binCount },
    bin_start: chart.binStart === undefined ? undefined : { value: chart.binStart },
    bin_end: chart.binEnd === undefined ? undefined : { value: chart.binEnd } };
}

export function DataChart({ value }: { value: ChartData }): React.ReactElement {
  const host = React.useRef<HTMLDivElement>(null);
  const decimals = useDecimals();
  const [error, setError] = React.useState('');
  const [theme, setTheme] = React.useState(0);
  React.useEffect(() => {
    const observer = new MutationObserver(() => setTheme(n => n + 1));
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-jp-theme-light', 'data-jp-theme-name'] });
    return () => observer.disconnect();
  }, []);
  React.useEffect(() => {
    const element = host.current!;
    let disposed = false, cleanup = () => {}, resize = () => {};
    const styles = getComputedStyle(element), dark = document.body.dataset.jpThemeLight === 'false';
    const color = styles.getPropertyValue('--jp-ui-font-color1').trim() || (dark ? '#ddd' : '#222');
    const background = styles.getPropertyValue('--jp-layout-color1').trim() || (dark ? '#111' : '#fff');
    setError('');
    void (async () => {
      if (value.type === DdbChartType.surface) {
        const imported = await import('plotly.js-gl3d-dist-min');
        const plotly = imported.default ?? imported;
        if (disposed) { return; }
        await plotly.newPlot(element, [{ type: 'surface', x: value.columnLabels, y: value.rowLabels, z: value.values, colorscale: 'Viridis',
          ...(decimals === null ? {} : { zhoverformat: `.${decimals}f` }) }],
          { title: { text: value.titles.chart }, paper_bgcolor: background, font: { color }, margin: { t: 45, b: 30, l: 15, r: 15 },
            scene: { xaxis: { title: { text: value.titles.x_axis } }, yaxis: { title: { text: value.titles.y_axis } }, zaxis: { title: { text: value.titles.z_axis ?? '' } }, bgcolor: background } },
          { responsive: true, displaylogo: false });
        if (disposed) { plotly.purge(element); return; }
        cleanup = () => plotly.purge(element); resize = () => { void plotly.Plots.resize(element); };
      } else {
        const echarts = await import('echarts');
        if (disposed) { return; }
        const chart = echarts.init(element, dark ? 'dark' : undefined);
        const option = get_chart_option({ ...chartConfig(value), color });
        chart.setOption({ ...option, backgroundColor: background, title: { text: value.titles.chart, left: 'center', textStyle: { fontSize: 14 } },
          grid: { ...option.grid, top: 80, bottom: 65, left: 65, right: value.multiY ? 80 : 35 },
          tooltip: { ...option.tooltip, renderMode: 'richText', valueFormatter: (n: unknown) => formatNumeric(String(n), decimals),
            ...(value.type === DdbChartType.scatter ? { formatter: (point: any) => `X: ${formatNumeric(String(point.data[0]), decimals)}\nY: ${formatNumeric(String(point.data[1]), decimals)}` } : {}) },
          toolbox: { right: 10, feature: { restore: {}, saveAsImage: {} } },
          ...([DdbChartType.pie, DdbChartType.histogram].includes(value.type as any) ? {} : { dataZoom: [{ type: 'inside' }, { type: 'slider', bottom: 5 }] }) });
        cleanup = () => chart.dispose(); resize = () => chart.resize();
      }
    })().catch(reason => { if (!disposed) { setError(reason instanceof Error ? reason.message : '无法显示图表。'); } });
    const observer = new ResizeObserver(() => resize()); observer.observe(element);
    return () => { disposed = true; observer.disconnect(); cleanup(); };
  }, [value, decimals, theme]);
  return <div className="ddb-chart-container">{error && <p role="alert">{error}</p>}<div ref={host} className="ddb-chart" aria-label={value.titles.chart || 'DolphinDB 图表'}/></div>;
}
