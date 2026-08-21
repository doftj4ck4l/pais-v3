import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { ChartProps } from '@/features/agents/lib/ui-blocks'

/**
 * A model-authored chart. The spec is already validated, so this only has to
 * turn declarative props into a recharts tree — it never parses model output.
 *
 * Colours are a fixed categorical palette rather than theme tokens: recharts
 * needs concrete fills, and these six mid-tones were chosen to read on both the
 * light and dark chat background. Axis and grid *do* follow the theme, through
 * `currentColor` at a low opacity, so the frame recedes and the data does not.
 */
const PALETTE = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#06b6d4', '#a855f7']

const AXIS = { stroke: 'currentColor', tick: { fill: 'currentColor', fontSize: 12 }, opacity: 0.55 }

export function Chart({ type, data, x, y, title }: ChartProps) {
  const series = Array.isArray(y) ? y : [y]

  return (
    <figure className="my-4 rounded-lg border bg-card p-3 text-card-foreground">
      {title ? (
        <figcaption className="mb-2 px-1 text-sm font-medium text-foreground">{title}</figcaption>
      ) : null}
      <div className="text-muted-foreground/70">
        <ResponsiveContainer width="100%" height={260}>
          {renderChart(type, data, x, series)}
        </ResponsiveContainer>
      </div>
    </figure>
  )
}

function renderChart(type: ChartProps['type'], data: ChartProps['data'], x: string, series: string[]) {
  const grid = <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.12} />
  const xa = <XAxis dataKey={x} {...AXIS} />
  const ya = <YAxis {...AXIS} width={40} />
  const tip = <Tooltip contentStyle={TOOLTIP} cursor={{ opacity: 0.1 }} />
  const legend = series.length > 1 ? <Legend wrapperStyle={{ fontSize: 12 }} /> : null

  switch (type) {
    case 'bar':
      return (
        <BarChart data={data}>
          {grid}
          {xa}
          {ya}
          {tip}
          {legend}
          {series.map((k, i) => (
            <Bar key={k} dataKey={k} fill={color(i)} radius={[3, 3, 0, 0]} />
          ))}
        </BarChart>
      )
    case 'line':
      return (
        <LineChart data={data}>
          {grid}
          {xa}
          {ya}
          {tip}
          {legend}
          {series.map((k, i) => (
            <Line key={k} type="monotone" dataKey={k} stroke={color(i)} strokeWidth={2} dot={false} />
          ))}
        </LineChart>
      )
    case 'area':
      return (
        <AreaChart data={data}>
          {grid}
          {xa}
          {ya}
          {tip}
          {legend}
          {series.map((k, i) => (
            <Area
              key={k}
              type="monotone"
              dataKey={k}
              stroke={color(i)}
              fill={color(i)}
              fillOpacity={0.18}
              strokeWidth={2}
            />
          ))}
        </AreaChart>
      )
    case 'scatter':
      return (
        <ScatterChart>
          {grid}
          <XAxis dataKey={x} {...AXIS} />
          {ya}
          {tip}
          {legend}
          {series.map((k, i) => (
            <Scatter key={k} name={k} data={data} dataKey={k} fill={color(i)} />
          ))}
        </ScatterChart>
      )
    case 'pie':
      return (
        <PieChart>
          {tip}
          <Pie data={data} dataKey={series[0]} nameKey={x} cx="50%" cy="50%" outerRadius={90} label>
            {data.map((_, i) => (
              <Cell key={i} fill={color(i)} />
            ))}
          </Pie>
        </PieChart>
      )
  }
}

const TOOLTIP = {
  background: 'var(--popover)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  color: 'var(--popover-foreground)',
  fontSize: 12,
} as const

function color(i: number) {
  return PALETTE[i % PALETTE.length]
}
