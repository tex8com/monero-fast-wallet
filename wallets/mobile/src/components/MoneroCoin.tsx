import React from "react";
import Svg, { Circle, Path } from "react-native-svg";

interface Props {
  size?: number;
}

export default function MoneroCoin({ size = 60 }: Props) {
  return (
    <Svg width={size} height={size} viewBox="372 372 3756 3756">
      <Circle cx="2250" cy="2250" r="1878" fill="#FFF" />
      <Path
        d="M2250,371.75c-1036.89,0-1879.12,842.06-1877.8,1878,0.26,207.26,33.31,406.63,95.34,593.12h561.88V1263L2250,2483.57,3470.52,1263v1579.9h562c62.12-186.48,95-385.85,95.37-593.12C4129.66,1212.76,3287,372,2250,372Z"
        fill="#F26822"
      />
      <Path
        d="M1969.3,2764.17l-532.67-532.7v994.14H1029.38l-384.29.07c329.63,540.8,925.35,902.56,1604.91,902.56S3525.31,3766.4,3855,3225.6H3063.25V2231.47l-532.7,532.7-280.61,280.61-280.62-280.61h0Z"
        fill="#4D4D4D"
      />
    </Svg>
  );
}
