export function Logo({ size = 28 }: { size?: number }) {
  // Geometric P with a loop — suggests review/iteration.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="PeerMind"
    >
      <rect x="1" y="1" width="38" height="38" rx="3" stroke="currentColor" strokeWidth="2" />
      <path
        d="M11 10h10.5a7 7 0 110 14H16"
        stroke="currentColor"
        strokeWidth="2.3"
        strokeLinecap="square"
      />
      <path d="M16 10v20" stroke="currentColor" strokeWidth="2.3" strokeLinecap="square" />
      <path
        d="M28 20 l3 3 -3 3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
