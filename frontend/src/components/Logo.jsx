import { useState } from "react";

// CPC brand mark. Renders the logo image from /logo.png (served from the app's
// public/ folder). If that file isn't present it falls back to a self-contained
// SVG glyph so the brand always renders. Size via the `size` prop.
export default function Logo({ size = 28, className, style, ...props }) {
  const [broken, setBroken] = useState(false);

  if (!broken) {
    return (
      <img
        src="/logo.png"
        alt="Colruyt Private Cloud"
        className={className}
        onError={() => setBroken(true)}
        style={{ height: size, width: "auto", objectFit: "contain", borderRadius: 6, display: "block", ...style }}
        {...props}
      />
    );
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      role="img"
      aria-label="Colruyt Private Cloud"
      style={style}
      {...props}
    >
      <defs>
        <linearGradient id="cpc-badge" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--brand)" />
          <stop offset="1" stopColor="var(--accent)" />
        </linearGradient>
      </defs>

      {/* Gradient badge */}
      <rect width="32" height="32" rx="8" fill="url(#cpc-badge)" />

      {/* Private cloud */}
      <path
        d="M10.6 21.6h10.9a3.9 3.9 0 0 0 .6-7.78A5.4 5.4 0 0 0 11.7 12.2a4.2 4.2 0 0 0-1.1 9.4z"
        fill="#fff"
        fillOpacity="0.96"
      />

      {/* Neural network — connections + nodes, in brand colour on the cloud */}
      <g stroke="var(--brand)" strokeWidth="1" strokeLinecap="round" opacity="0.85">
        <line x1="16" y1="16.6" x2="12.4" y2="14.6" />
        <line x1="16" y1="16.6" x2="19.6" y2="14.6" />
        <line x1="16" y1="16.6" x2="16" y2="19.2" />
      </g>
      <g fill="var(--brand)">
        <circle cx="16" cy="16.6" r="1.55" />
        <circle cx="12.4" cy="14.6" r="1.15" />
        <circle cx="19.6" cy="14.6" r="1.15" />
        <circle cx="16" cy="19.2" r="1.15" />
      </g>

      {/* AI sparkle */}
      <path d="M23.4 6.6l.72 1.86 1.86.72-1.86.72-.72 1.86-.72-1.86-1.86-.72 1.86-.72z" fill="#fff" />
    </svg>
  );
}
