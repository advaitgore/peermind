import type { NextConfig } from "next";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8000";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Move Next.js dev overlay out of the reviewer panel corner. Users can
  // still toggle it via the N button; it just lives out of the way now.
  devIndicators: {
    position: "bottom-right",
  },
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${API_BASE}/api/:path*` },
    ];
  },
  webpack: (config) => {
    // pdfjs-dist uses a canvas worker at runtime; we don't need to polyfill it on the server.
    config.resolve.alias = {
      ...config.resolve.alias,
      canvas: false,
    };
    return config;
  },
};

export default nextConfig;
