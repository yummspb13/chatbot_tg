/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },
  // Исключаем worker из TypeScript проверки
  typescript: {
    // Игнорируем ошибки в worker директории
    ignoreBuildErrors: false,
  },
  // Исключаем worker из сборки
  webpack: (config) => {
    // Игнорируем worker директорию при сборке
    config.watchOptions = {
      ...config.watchOptions,
      ignored: ['**/node_modules/**', '**/worker/**'],
    }
    return config
  },
}

module.exports = nextConfig
