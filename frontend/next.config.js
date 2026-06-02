/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  // Ensure asset prefix works when served from FastAPI on same origin
  assetPrefix: "",
};

module.exports = nextConfig;