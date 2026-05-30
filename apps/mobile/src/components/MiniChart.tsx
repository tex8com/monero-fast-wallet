import React from "react";
import Svg, { Path, Defs, LinearGradient, Stop } from "react-native-svg";

interface Props {
  width: number;
  height: number;
  color?: string;
}

export default function MiniChart({ width, height, color = "#FF6600" }: Props) {
  // Simulated XMR price movement
  const points = [
    40, 38, 42, 45, 43, 47, 50, 48, 52, 55, 53, 58, 56, 60, 57, 62,
    65, 63, 60, 58, 62, 66, 70, 68, 72, 75, 73, 70, 74, 78, 76, 80,
  ];

  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const padding = 4;
  const chartH = height - padding * 2;
  const stepX = (width - padding * 2) / (points.length - 1);

  let linePath = "";
  let areaPath = "";

  points.forEach((p, i) => {
    const x = padding + i * stepX;
    const y = padding + chartH - ((p - min) / range) * chartH;
    if (i === 0) {
      linePath += `M${x},${y}`;
      areaPath += `M${x},${height}L${x},${y}`;
    } else {
      const px = padding + (i - 1) * stepX;
      const py = padding + chartH - ((points[i - 1] - min) / range) * chartH;
      const cx1 = px + stepX * 0.4;
      const cx2 = x - stepX * 0.4;
      linePath += `C${cx1},${py} ${cx2},${y} ${x},${y}`;
      areaPath += `C${cx1},${py} ${cx2},${y} ${x},${y}`;
    }
  });

  areaPath += `L${padding + (points.length - 1) * stepX},${height}Z`;

  return (
    <Svg width={width} height={height} style={{ position: "absolute", bottom: 0, left: 0, right: 0 }}>
      <Defs>
        <LinearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={color} stopOpacity="0.15" />
          <Stop offset="1" stopColor={color} stopOpacity="0" />
        </LinearGradient>
      </Defs>
      <Path d={areaPath} fill="url(#chartGrad)" />
      <Path d={linePath} stroke={color} strokeWidth={1.5} fill="none" opacity={0.5} />
    </Svg>
  );
}
