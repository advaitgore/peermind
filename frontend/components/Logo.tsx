export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="PeerMind"
    >
      <rect
        x="2"
        y="2"
        width="36"
        height="36"
        rx="4"
        stroke="currentColor"
        strokeWidth="1.5"
        opacity="0.55"
      />
      {/* Measurement ticks across the top — "instrument" motif */}
      <g stroke="currentColor" strokeWidth="1" opacity="0.35">
        <line x1="8" y1="2" x2="8" y2="5" />
        <line x1="14" y1="2" x2="14" y2="5" />
        <line x1="20" y1="2" x2="20" y2="5" />
        <line x1="26" y1="2" x2="26" y2="5" />
        <line x1="32" y1="2" x2="32" y2="5" />
      </g>
      {/* Stylized P with a refinement loop */}
      <path
        d="M12 11h10a6 6 0 110 12H16"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="square"
      />
      <path d="M16 11v19" stroke="currentColor" strokeWidth="2.2" strokeLinecap="square" />
      <path
        d="M25 19 l3 3 -3 3"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
