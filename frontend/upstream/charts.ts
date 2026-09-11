// @ts-nocheck
// Generated from DolphinDB VS Code src/dataview/obj.tsx (Apache-2.0).
// Rebuild with scripts/sync_dataview.py; see dataview-provenance.json.
import { DdbChartType } from 'dolphindb/browser.js';
import type * as echarts from 'echarts';
const unique = values => [...new Set(values)];
const t = text => text;
type ChartConfig = any;

export function get_chart_option (config: ChartConfig): echarts.EChartsOption {
    const { charttype, data, titles, stacking, multi_y_axes, col_labels, bin_count } = config

    const base: echarts.EChartsOption = {
        tooltip: {
            trigger: 'axis',
            axisPointer: {
                type: 'cross',
                label: {
                    borderRadius: 0,
                }
            },
            borderRadius: 0,
        },
        legend: {
            data: col_labels.map(String),
            top: 30,
            right: 30,
            textStyle: {
                color: config.color || '#000000'
            }
        },
        grid: {
            top: 10,
            bottom: 0,
            left: 10,
            right: 10,
            outerBoundsMode: 'same',
        },
        animation: false
    }

    // 通用的坐标轴样式
    const axis_style: echarts.EChartsOption['xAxis'] & echarts.EChartsOption['yAxis'] = {
        axisLine: { },
        splitLine: {
            lineStyle: {
                color: '#80808050',
                width: 0.5
            }
        },
        nameTextStyle: {
            fontSize: 12,
            padding: [0, 10, 0, 10]
        },
        nameLocation: 'middle' as const,
        nameGap: 10,
        axisTick: {
            show: true,
            alignWithLabel: true
        },
        axisLabel: {
            interval: 'auto',
            hideOverlap: true,
            formatter (value, index) {
                if (typeof value === 'string' && value.length > 10)
                    return value.slice(0, 10) + '…'
                return value
            }
        }
    }

    switch (charttype) {
        case DdbChartType.line:
            if (!multi_y_axes)
                return {
                    ...base,
                    xAxis: {
                        type: 'category',
                        name: titles.x_axis,
                        data: [...new Set(data.map(item => item.row))],
                        ...axis_style
                    } as echarts.EChartsOption['xAxis'],
                    yAxis: {
                        type: 'value' as any,
                        name: titles.y_axis,
                        ...axis_style
                    },
                    series: col_labels.map(label => ({
                        name: String(label),
                        type: 'line',
                        stack: stacking ? 'total' : undefined,
                        data: data.filter(d => d.col === label).map(d => d.value),
                        symbol: 'none',
                        smooth: false
                    }))
                }
            else
                return {
                    ...base,
                    xAxis: {
                        ...axis_style,
                        type: 'category',
                        name: titles.x_axis,
                        data: data.map(d => d.row),
                    },
                    yAxis: col_labels.map((label, index) => {
                        const isRight = index % 2 === 1 // 判断是否为右侧
                        const sideOffset = Math.floor(index / 2) * 30 // 每个 Y 轴之间的间隔

                        return {
                            ...axis_style,
                            type: 'value',
                            position: isRight ? 'right' : 'left',
                            offset: sideOffset, // 设置偏移量以避免重叠
                            name: label,
                            nameLocation: 'end',
                            alignTicks: true,
                            axisLabel: {
                                margin: 8, // 轴标签的边距
                            },
                        } as any
                    }),
                    series: col_labels.map((label, index) => ({
                        name: String(label),
                        type: 'line',
                        yAxisIndex: index,
                        data: data.map(d => d[label]),
                        symbol: 'none',
                        smooth: false
                    }))
                }


        case DdbChartType.column:
            return {
                ...base,
                xAxis: {
                    ...axis_style,
                    type: 'category',
                    name: titles.x_axis,
                    data: unique(data.map(item => item.row)),
                } as echarts.EChartsOption['xAxis'],
                yAxis: {
                    ...axis_style,
                    type: 'value' as any,
                    name: titles.y_axis,
                },
                series: col_labels.map(label => ({
                    name: label,
                    type: 'bar',
                    stack: stacking ? 'total' : undefined,
                    data: data.filter(d => d.col === label).map(d => d.value)
                }))
            }

        case DdbChartType.bar:
            return {
                ...base,
                xAxis: {
                    ...axis_style,
                    type: 'value' as any,
                    name: titles.y_axis,
                },
                yAxis: {
                    ...axis_style,
                    type: 'category',
                    name: titles.x_axis,
                    data: unique(data.map(item => item.row)),
                } as echarts.EChartsOption['yAxis'],
                series: col_labels.map(label => ({
                    name: label,
                    type: 'bar',
                    stack: stacking ? 'total' : undefined,
                    data: data.filter(d => d.col === label).map(d => d.value)
                }))
            }

        case DdbChartType.pie:
            return {
                ...base,
                series: [{
                    type: 'pie',
                    radius: '90%',
                    data: data.map(d => ({
                        name: d.row,
                        value: d.value
                    })),
                    label: {
                        formatter (params) {
                            return `${params.name}: ${params.percent.toFixed(2)}%`
                        },
                        backgroundColor: 'transparent',
                        color: '#888888'
                    }
                }]
            }

        case DdbChartType.area:
            return {
                ...base,
                xAxis: {
                    ...axis_style,
                    type: 'category',
                    name: titles.x_axis,
                    data: [...new Set(data.map(item => item.row))],
                },
                yAxis: {
                    ...axis_style,
                    type: 'value' as any,
                    name: titles.y_axis,
                },
                series: col_labels.map(label => ({
                    name: label,
                    type: 'line',
                    areaStyle: { },
                    stack: stacking ? 'total' : undefined,
                    data: data.filter(d => d.col === label).map(d => d.value),
                    symbol: 'none',
                    smooth: false
                }))
            }

        case DdbChartType.scatter:
            return {
                ...base,
                legend: null,
                tooltip: {
                    trigger: 'item',
                    formatter: function (params) {
                        return `X : ${params.data[0]}<br/>
                                Y : ${params.data[1]}`
                    }
                },
                xAxis: {
                    ...axis_style,
                    type: 'value' as any,
                    name: titles.x_axis,
                },
                yAxis: {
                    ...axis_style,
                    type: 'value' as any,
                    name: titles.y_axis,
                },
                series: col_labels.map(label => ({
                    name: label,
                    type: 'scatter',
                    data: data.filter(d => d.col === label).map(d => [d.row, d.value])
                }))
            }

        case DdbChartType.histogram:
            const values = data.map(d => d.value).filter(v => v !== null && Number.isFinite(v))
            if (!values.length) return base
            const minValue = config.bin_start ? Number(config.bin_start.value) : values.reduce((a, b) => Math.min(a, b), Infinity)
            const maxValue = config.bin_end ? Number(config.bin_end.value) : values.reduce((a, b) => Math.max(a, b), -Infinity)
            const xMin = Math.floor(minValue)
            const xMax = Math.ceil(maxValue)
            const binCount = config.bin_count ? Number(config.bin_count.value) : 30
            const binWidth = (maxValue - minValue) / binCount || 1

            // 创建区间并统计每个区间的频次
            const bins = new Array(binCount).fill(0)
            values.forEach(value => {
                if (value >= minValue && value <= maxValue) {
                    const binIndex = Math.min(Math.floor((value - minValue) / binWidth), binCount - 1)
                    bins[binIndex]++
                }
            })

            return {
                ...base,
                tooltip: {
                    formatter: params => {
                        const i = params.dataIndex
                        const start = minValue + i * binWidth
                        const end = minValue + (i + 1) * binWidth
                        const count = bins[i]
                        const percentage = ((count / values.length) * 100).toFixed(2)
                        return `[${start.toFixed(2)}, ${end.toFixed(2)}]: ${percentage}% (${count})`
                    }
                },
                xAxis: {
                    ...axis_style,
                    type: 'value' as any,
                    name: !titles.x_axis || titles.x_axis === '' ? t('区间') : titles.x_axis,
                    min: xMin,
                    max: xMax,
                },
                yAxis: {
                    ...axis_style,
                    type: 'value' as any,
                    name: !titles.y_axis || titles.y_axis === '' ? t('频次') : titles.y_axis,
                },
                series: [{
                    type: 'custom',
                    renderItem: (params, api) => ({
                        type: 'rect',
                        shape: {
                            x: api.coord([minValue + params.dataIndex * binWidth, 0])[0],
                            y: api.coord([0, api.value(0)])[1],
                            width: api.size([binWidth, 0])[0],
                            height: api.size([0, api.value(0)])[1]
                        },
                        style: api.style()
                    }),
                    data: bins,
                }]
            }

        case DdbChartType.kline:
            return {
                ...base,
                xAxis: {
                    ...axis_style,
                    type: 'category',
                    name: titles.x_axis,
                    data: data.map(d => d.row_),
                },
                yAxis: [
                    {
                        ...axis_style,
                        type: 'value' as any,
                        name: titles.y_axis,
                        scale: true,
                    } as any,
                    {
                        ...axis_style,
                        type: 'value' as any,
                        name: t('成交量'),
                        scale: true,
                    }
                ],
                series: [
                    {
                        type: 'candlestick',
                        data: data.map(d => [d.open, d.close, d.low, d.high])
                    },
                    ... data[0]?.vol !== undefined ? [{
                        name: t('成交量'),
                        type: 'bar',
                        yAxisIndex: 1,
                        data: data.map(d => d.vol)
                    } as echarts.BarSeriesOption] : [ ]
                ]
            }

        default:
            return base
    }
}
