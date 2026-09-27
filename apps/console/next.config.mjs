/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: { unoptimized: true },
  transpilePackages: ["@nzi/ui", "@nzi/mock-data", "@nzi/charts", "@nzi/isolated-backend"],
};

export default nextConfig;
