import React from "react";
import Svg, { Path } from "react-native-svg";

interface Props {
  size?: number;
  color?: string;
}

export default function MoneroLogo({ size = 40, color = "#FF6600" }: Props) {
  return (
    <Svg width={size} height={size} viewBox="0 0 75 75">
      <Path
        d="M37.3 0.353c-20.377 0-36.903 16.524-36.903 36.902 0 4.074.66 7.992 1.88 11.657l11.036 0v-31.049l23.987 23.987 23.987-23.987v31.049l11.037 0c1.22-3.665 1.88-7.583 1.88-11.657C74.204 16.877 57.678 0.353 37.3 0.353"
        fill={color}
      />
      <Path
        d="M21.316 36.896v19.537H5.766c6.478 10.628 18.178 17.726 31.533 17.726 13.355 0 25.056-7.098 31.533-17.726H53.283V36.896L37.3 52.88 21.316 36.896z"
        fill="#FFFFFF"
        opacity={0.9}
      />
    </Svg>
  );
}
