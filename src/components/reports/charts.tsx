"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/**
 * The charts on the management dashboard.
 *
 * Colours come from the `--chart-1..5` tokens, so both themes are handled
 * by the stylesheet and nothing here hard-codes a hex. Where a bar means
 * "good" or "bad" rather than "series 3", it takes a semantic token
 * instead — a breach bar drawn in the fourth categorical colour is a bar
 * that reads as a category.
 */

const AXIS = {
  stroke: "var(--color-muted-foreground)",
  fontSize: 11,
  tickLine: false,
  axisLine: false,
} as const;

const TOOLTIP_STYLE = {
  backgroundColor: "var(--color-popover)",
  color: "var(--color-popover-foreground)",
  border: "1px solid var(--color-border)",
  borderRadius: "0.5rem",
  fontSize: "0.75rem",
  padding: "0.5rem 0.625rem",
} as const;

export type TrendPoint = {
  label: string;
  /** Delivered on time, as a percentage. Null where nothing was measured. */
  onTime: number | null;
  breached: number;
  delivered: number;
};

/**
 * On-time percentage over the window.
 *
 * `connectNulls` is off deliberately: a gap in the line is a day with
 * nothing to measure, and joining across it draws a trend through data
 * that does not exist.
 */
export function OnTimeTrend({ data }: { data: TrendPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
        <CartesianGrid
          strokeDasharray="3 3"
          stroke="var(--color-border)"
          vertical={false}
        />
        <XAxis dataKey="label" {...AXIS} />
        <YAxis domain={[0, 100]} unit="%" {...AXIS} />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          formatter={(value) => (value === null ? "no data" : `${value}%`)}
        />
        <Line
          type="monotone"
          dataKey="onTime"
          name="On time"
          stroke="var(--color-chart-1)"
          strokeWidth={2}
          dot={{ r: 2 }}
          connectNulls={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function VolumeTrend({ data }: { data: TrendPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
        <CartesianGrid
          strokeDasharray="3 3"
          stroke="var(--color-border)"
          vertical={false}
        />
        <XAxis dataKey="label" {...AXIS} />
        <YAxis allowDecimals={false} {...AXIS} />
        <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: "var(--color-muted)" }} />
        <Legend wrapperStyle={{ fontSize: "0.7rem" }} />
        <Bar
          dataKey="delivered"
          name="Delivered"
          fill="var(--color-chart-3)"
          radius={[3, 3, 0, 0]}
        />
        <Bar
          dataKey="breached"
          name="Breached"
          fill="var(--color-bad)"
          radius={[3, 3, 0, 0]}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

export type CutPoint = {
  label: string;
  value: number | null;
  /** Shipments behind the percentage — a 100% built on two is not a 100%. */
  volume: number;
};

/**
 * A KPI cut by lane, branch, customer or service.
 *
 * Each bar is coloured by how it is doing rather than by its position in
 * the list, so the eye lands on the branch that needs attention instead
 * of on whichever one happened to sort first.
 */
export function CutBars({
  data,
  unit = "%",
  good = 95,
  watch = 90,
}: {
  data: CutPoint[];
  unit?: string;
  good?: number;
  watch?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={Math.max(180, data.length * 30)}>
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 4, right: 16, bottom: 4, left: 8 }}
      >
        <CartesianGrid
          strokeDasharray="3 3"
          stroke="var(--color-border)"
          horizontal={false}
        />
        <XAxis type="number" domain={[0, 100]} unit={unit} {...AXIS} />
        <YAxis type="category" dataKey="label" width={130} {...AXIS} />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          cursor={{ fill: "var(--color-muted)" }}
          formatter={(value, _name, item) =>
            value === null
              ? "nothing measured"
              : `${value}${unit} of ${(item?.payload as CutPoint | undefined)?.volume ?? 0}`
          }
        />
        <Bar dataKey="value" name="Value" radius={[0, 3, 3, 0]} barSize={14}>
          {data.map((point) => (
            <Cell
              key={point.label}
              fill={
                point.value === null
                  ? "var(--color-muted)"
                  : point.value >= good
                    ? "var(--color-ok)"
                    : point.value >= watch
                      ? "var(--color-warn)"
                      : "var(--color-bad)"
              }
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export type ExceptionPoint = { label: string; count: number };

export function ExceptionMix({ data }: { data: ExceptionPoint[] }) {
  const palette = [
    "var(--color-chart-1)",
    "var(--color-chart-2)",
    "var(--color-chart-3)",
    "var(--color-chart-4)",
    "var(--color-chart-5)",
  ];

  return (
    <ResponsiveContainer width="100%" height={Math.max(180, data.length * 30)}>
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 4, right: 16, bottom: 4, left: 8 }}
      >
        <CartesianGrid
          strokeDasharray="3 3"
          stroke="var(--color-border)"
          horizontal={false}
        />
        <XAxis type="number" allowDecimals={false} {...AXIS} />
        <YAxis type="category" dataKey="label" width={150} {...AXIS} />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          cursor={{ fill: "var(--color-muted)" }}
        />
        <Bar dataKey="count" name="Open" radius={[0, 3, 3, 0]} barSize={14}>
          {data.map((point, index) => (
            <Cell key={point.label} fill={palette[index % palette.length]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
