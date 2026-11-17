import path from 'path';

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_PYTHON_API_URL:
      process.env.NEXT_PUBLIC_PYTHON_API_URL ||
      process.env.NEXT_PUBLIC_PYTHON_BACKEND_URL ||
      'http://127.0.0.1:8000',
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
  async rewrites() {
    const backendUrl = (
      process.env.NEXT_PUBLIC_PYTHON_API_URL ||
      process.env.NEXT_PUBLIC_PYTHON_BACKEND_URL ||
      'http://127.0.0.1:8000'
    ).replace(/\/+$/, '');
    return [
      {
        source: '/py-api/:path*',
        destination: `${backendUrl}/:path*`,
      },
    ];
  },
  experimental: {
    serverComponentsExternalPackages: [
      '@huggingface/transformers',
      'onnxruntime-node',
      'onnxruntime-web',
    ],
  },
  webpack: (config, { isServer }) => {
    config.module.parser = {
      ...config.module.parser,
      javascript: {
        ...(config.module.parser?.javascript || {}),
        url: false,
      },
    };
    config.resolve.alias = {
      ...config.resolve.alias,
      '@huggingface/transformers': path.resolve(
        process.cwd(),
        'node_modules/@huggingface/transformers/dist/transformers.web.js'
      ),
      'sharp$': false,
      'onnxruntime-node$': false,
      'fs': false,
      'path': false,
      'crypto': false,
    };

    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        crypto: false,
      };
    }

    config.watchOptions = {
      ...config.watchOptions,
      ignored: [
        '**/node_modules',
        '**/C:/System Volume Information/**',
        '**/C:/pagefile.sys',
        '**/C:/hiberfil.sys',
        '**/C:/swapfile.sys',
        'C:\\pagefile.sys',
        'C:\\hiberfil.sys',
        'C:\\swapfile.sys',
        'C:\\System Volume Information',
      ],
    };

    return config;
  },
};

export default nextConfig;
