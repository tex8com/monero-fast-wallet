import React from "react";
import Svg, { Path, Circle } from "react-native-svg";

interface Props {
  size?: number;
  color?: string;
}

export default function MoneroCoinGhost({ size = 70, color = "rgba(255,255,255,0.08)" }: Props) {
  return (
    <Svg width={size} height={size} viewBox="0 0 3756 3756">
      {/* Circle outline — centered */}
      <Circle cx="1878" cy="1878" r="1850" fill="none" stroke={color} strokeWidth={40} />
      {/* Orange M shape */}
      <Path
        d="M1878.04,0c-1036.89,0-1879.12,842.06-1877.8,1878,0.26,207.26,33.31,406.63,95.34,593.12h561.88V891.25l1220.52,1220.57L3098.56,891.25v1579.9h562c62.12-186.48,95-385.85,95.37-593.12C3757.7,840.79,2915.04,0.25,1878.04,0.25Z"
        fill={color}
      />
      {/* Grey bottom */}
      <Path
        d="M1597.34,2392.42l-532.67-532.7v994.14H657.42l-384.29.07c329.63,540.8,925.35,902.56,1604.91,902.56s1275.31-361.86,1605-902.56H2691.29V1859.72l-532.7,532.7-280.61,280.61-280.62-280.61h0Z"
        fill={color}
      />
    </Svg>
  );
}
