/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export — produces `out/` folder that FastAPI serves directly.
  // This means ONE Render service runs both the API and the frontend.
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
};

module.exports = nextConfig;