import { useId } from "react";

type LogoProps = {
  size?: number;
  /** Accessible name; an empty title hides the logo from assistive technology. */
  title?: string;
};

/** Brand mark: a waypoint pin under radar arcs. The same artwork is used for public/favicon.svg. */
export default function Logo({ size = 38, title = "Waypoint AI" }: LogoProps) {
  // Unique gradient IDs: the logo appears more than once on a page.
  const id = useId().replace(/:/g, "");
  const backgroundId = `${id}-bg`;
  const pinId = `${id}-pin`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label={title || undefined}
      aria-hidden={title ? undefined : true}
    >
      <defs>
        <linearGradient id={backgroundId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#1d3a35" />
          <stop offset="1" stopColor="#10191f" />
        </linearGradient>
        <linearGradient id={pinId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#b8f0d6" />
          <stop offset="1" stopColor="#58d9a0" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill={`url(#${backgroundId})`} />
      {/* Arcs span y 12–30 and the pin ends at y 50; shift by 1 to center the artwork. */}
      <g transform="translate(0 1)">
        <path
          d="M14 30a18 18 0 0 1 36 0"
          fill="none"
          stroke="#58d9a0"
          strokeOpacity=".35"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
        <path
          d="M20 30a12 12 0 0 1 24 0"
          fill="none"
          stroke="#58d9a0"
          strokeOpacity=".6"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
        <path
          d="M32 50c-7-8.5-10.5-14.4-10.5-19.2a10.5 10.5 0 0 1 21 0C42.5 35.6 39 41.5 32 50z"
          fill={`url(#${pinId})`}
        />
        <circle cx="32" cy="30.6" r="4.2" fill="#12241f" />
      </g>
    </svg>
  );
}
