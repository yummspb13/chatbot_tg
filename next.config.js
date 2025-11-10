/** @type {import('next').NextConfig} */
const nextConfig = {
  // Исключаем worker директорию из сборки Next.js
  webpack: (config, { isServer }) => {
    config.externals = config.externals || []
    if (isServer) {
      config.externals.push({
        'worker/src': 'commonjs worker/src',
      })
    }
    return config
  },
  // Исключаем worker из TypeScript проверки
  typescript: {
    ignoreBuildErrors: false,
  },
}

module.exports = nextConfig
