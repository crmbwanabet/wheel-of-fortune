/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  async headers() {
    return [
      {
        // embed.js runs on a third-party page we do not control, so it is our
        // only lever for shipping a fix there. Keep the cache window short and
        // explicit rather than inheriting a CDN default, so the propagation
        // time for a future fix is a known quantity.
        source: '/embed.js',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=300, must-revalidate' },
        ],
      },
    ];
  },
};

export default nextConfig;
